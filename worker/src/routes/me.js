import { HttpError, audit } from '../lib/scope.js';
import { coordinate, integer, phone, text } from '../lib/validate.js';
import { geocoderFor } from '../lib/geocode.js';

/** The household this user belongs to within a given club, if any. */
export async function householdFor(db, userId, clubId) {
  return db
    .prepare(
      `SELECT h.* FROM households h
         JOIN household_members hm ON hm.household_id = h.id
        WHERE hm.user_id = ? AND h.club_id = ?`,
    )
    .bind(userId, clubId)
    .first();
}

async function ensureHousehold(db, user, clubId) {
  const existing = await householdFor(db, user.id, clubId);
  if (existing) return existing;

  const created = await db
    .prepare(`INSERT INTO households (club_id, name) VALUES (?, ?) RETURNING *`)
    .bind(clubId, user.display_name || user.email)
    .first();
  await db
    .prepare(
      `INSERT INTO household_members (club_id, household_id, user_id, name, phone)
       VALUES (?,?,?,?,?)`,
    )
    .bind(clubId, created.id, user.id, user.display_name || '', user.phone || '')
    .run();
  return created;
}

/**
 * Everything the signed-in user is entitled to know about themselves.
 *
 * Note this deliberately returns the user's OWN addresses in full — they are
 * theirs. No other endpoint ever returns a household address without going
 * through the reveal flow.
 */
export async function getMe({ db, user, scope }) {
  const memberships = await db
    .prepare(
      `SELECT m.id, m.club_id, m.team_id, m.role, m.status,
              c.name AS club_name, c.slug AS club_slug, c.allow_cross_team_pools,
              t.name AS team_name, t.season
         FROM memberships m
         JOIN clubs c ON c.id = m.club_id
         LEFT JOIN teams t ON t.id = m.team_id
        WHERE m.user_id = ?
        ORDER BY c.name, t.name`,
    )
    .bind(user.id)
    .all();

  const rows = memberships.results ?? memberships;
  const clubIds = [...new Set(rows.filter(r => r.status === 'active').map(r => r.club_id))];

  const households = [];
  for (const clubId of clubIds) {
    const household = await householdFor(db, user.id, clubId);
    if (!household) continue;

    const children = await db
      .prepare(
        `SELECT p.id, p.name,
                (SELECT group_concat(e.team_id) FROM enrollments e WHERE e.person_id = p.id) AS team_ids
           FROM people p WHERE p.household_id = ? ORDER BY p.name`,
      )
      .bind(household.id)
      .all();

    const vehicles = await db
      .prepare(`SELECT id, name, seat_capacity, notes FROM vehicles WHERE household_id = ? ORDER BY sort_order, id`)
      .bind(household.id)
      .all();

    const adults = await db
      .prepare(`SELECT id, user_id, name, phone, can_drive FROM household_members WHERE household_id = ? ORDER BY id`)
      .bind(household.id)
      .all();

    households.push({
      id: household.id,
      clubId: household.club_id,
      pickupAreaId: household.pickup_area_id,
      homeAddress: household.home_address,
      homeGeocoded: household.home_lat != null,
      homeGeocodeLabel: household.home_geocode_label || '',
      homeGeocodeConfidence: household.home_geocode_confidence || '',
      homeLat: household.home_lat,
      homeLng: household.home_lng,
      alternateAddress: household.alternate_address,
      children: (children.results ?? children).map(c => ({
        id: c.id,
        name: c.name,
        teamIds: String(c.team_ids || '').split(',').filter(Boolean).map(Number),
      })),
      vehicles: vehicles.results ?? vehicles,
      adults: adults.results ?? adults,
    });
  }

  // Teams the caller can actually open.
  //
  // This is NOT derivable from membership rows on the client: a club_admin
  // holds a single row with team_id NULL, which says "every team in this
  // club" without naming one. Deriving the list client-side stranded club
  // admins on the approval screen because they appeared to belong to no team.
  // The server already resolves this in scope.visibleTeamIds, so it is the
  // server's job to answer it.
  const teams = scope.visibleTeamIds?.length
    ? (
        await db
          .prepare(
            `SELECT t.id, t.club_id, t.name, t.season, c.name AS club_name,
                    c.allow_cross_team_pools
               FROM teams t
               JOIN clubs c ON c.id = t.club_id
              WHERE t.id IN (${scope.visibleTeamIds.map(() => '?').join(',')})
                AND t.archived = 0
              ORDER BY c.name, t.name`,
          )
          .bind(...scope.visibleTeamIds)
          .all()
      ).results
    : [];

  // Players on the caller's teams that no family has claimed yet.
  //
  // A coordinator builds the roster; parents then sign up and say which
  // children are theirs. Without this list those are two separate sets of
  // `people` rows that never meet — the roster copy is enrolled but belongs
  // to nobody, the parent's copy belongs to them but is on no roster, and
  // "request a ride" refuses because the child is not on the team.
  const claimablePlayers = scope.visibleTeamIds?.length
    ? (
        await db
          .prepare(
            `SELECT DISTINCT p.id, p.name, e.team_id
               FROM people p
               JOIN enrollments e ON e.person_id = p.id
              WHERE p.household_id IS NULL
                AND e.team_id IN (${scope.visibleTeamIds.map(() => '?').join(',')})
              ORDER BY p.name`,
          )
          .bind(...scope.visibleTeamIds)
          .all()
      ).results
    : [];

  const pickupAreas = clubIds.length
    ? (
        await db
          .prepare(
            `SELECT id, club_id, name FROM pickup_areas
              WHERE club_id IN (${clubIds.map(() => '?').join(',')}) ORDER BY name`,
          )
          .bind(...clubIds)
          .all()
      ).results
    : [];

  // Address-access history for the user's own household — transparency about
  // who has looked at their family's address, without them having to ask.
  const logs = households.length
    ? (
        await db
          .prepare(
            `SELECT action, actor_email, reason, created_at
               FROM audit_log
              WHERE subject_type = 'household'
                AND subject_id IN (${households.map(() => '?').join(',')})
              ORDER BY created_at DESC LIMIT 20`,
          )
          .bind(...households.map(h => h.id))
          .all()
      ).results
    : [];

  return {
    user: {
      id: user.id,
      email: user.email,
      displayName: user.display_name,
      phone: user.phone,
      isPlatformAdmin: Boolean(user.is_platform_admin),
    },
    memberships: rows.map(r => ({
      id: r.id,
      clubId: r.club_id,
      clubName: r.club_name,
      teamId: r.team_id,
      teamName: r.team_name,
      season: r.season,
      role: r.role,
      status: r.status,
      poolingEnabled: Boolean(r.allow_cross_team_pools),
    })),
    // Each entry carries the caller's EFFECTIVE role on that team, which for
    // a club admin comes from their club-wide row rather than a team one.
    teams: teams.map(t => ({
      teamId: t.id,
      teamName: t.name,
      season: t.season,
      clubId: t.club_id,
      clubName: t.club_name,
      role: scope.roleOnTeam(t.id, t.club_id),
      poolingEnabled: Boolean(t.allow_cross_team_pools),
    })),
    households,
    claimablePlayers,
    pickupAreas,
    addressAccessLog: logs,
    pending: scope.isPending,
  };
}

/** Update the caller's own profile and household. Never touches anyone else. */
export async function updateProfile({ db, env, user, scope, body, ip }) {
  const clubId = integer(body.clubId, { field: 'clubId' });
  if (!scope.clubIds.includes(clubId) && !scope.all.some(m => m.club_id === clubId)) {
    // A pending member may still complete their profile for the club that
    // invited them — but only for that club.
    throw new HttpError(404, 'Not found.', 'out_of_scope');
  }

  const displayName = text(body.displayName, { field: 'Parent name', max: 120, required: true });
  const contact = phone(body.phone, { required: true });

  await db
    .prepare(`UPDATE users SET display_name = ?, phone = ? WHERE id = ?`)
    .bind(displayName, contact, user.id)
    .run();

  const household = await ensureHousehold(db, { ...user, display_name: displayName, phone: contact }, clubId);

  const homeAddress = text(body.homeAddress, { field: 'Home address', max: 300 });
  const alternateAddress = text(body.alternateAddress, { field: 'Alternate address', max: 300 });
  const home = coordinate(body.homeLat, body.homeLng);
  const alternate = coordinate(body.alternateLat, body.alternateLng);
  const pickupAreaId = integer(body.pickupAreaId, { field: 'Pickup area', required: false });

  if (pickupAreaId != null) {
    const area = await db
      .prepare(`SELECT id FROM pickup_areas WHERE id = ? AND club_id = ?`)
      .bind(pickupAreaId, clubId)
      .first();
    if (!area) throw new HttpError(400, 'That pickup area is not part of this club.');
  }

  const addressChanged = homeAddress && homeAddress !== household.home_address;

  // Resolve the address to coordinates so the route planner can include this
  // family. Skipped entirely when the parent supplied coordinates themselves,
  // and when the address has not changed there is nothing new to look up.
  //
  // A failed lookup is not an error: the family is saved without coordinates
  // and the planner reports them under `needsAddress`. Refusing the save
  // would make a third-party service a hard dependency of joining a team.
  let geo = null;
  if (home.lat == null && addressChanged) {
    geo = await geocoderFor(env)(homeAddress);
  }

  const homeLat = home.lat ?? geo?.lat ?? (addressChanged ? null : household.home_lat);
  const homeLng = home.lng ?? geo?.lng ?? (addressChanged ? null : household.home_lng);

  await db
    .prepare(
      `UPDATE households
          SET pickup_area_id = ?, home_address = ?, home_lat = ?, home_lng = ?,
              home_geocode_label = ?, home_geocode_confidence = ?,
              alternate_address = ?, alternate_lat = ?, alternate_lng = ?,
              geocoded_at = CASE WHEN ? IS NULL THEN geocoded_at ELSE datetime('now') END
        WHERE id = ? AND club_id = ?`,
    )
    .bind(
      pickupAreaId,
      homeAddress,
      homeLat,
      homeLng,
      geo?.label ?? (addressChanged ? '' : household.home_geocode_label ?? ''),
      geo?.confidence ?? (addressChanged ? '' : household.home_geocode_confidence ?? ''),
      alternateAddress,
      alternate.lat,
      alternate.lng,
      homeLat,
      household.id,
      clubId,
    )
    .run();

  if (addressChanged) {
    await audit(db, {
      clubId,
      actor: user,
      action: 'address_updated',
      subjectType: 'household',
      subjectId: household.id,
      reason: 'Parent updated their own address',
      ip,
    });
  }

  // Claiming a rostered player: "that one is mine".
  //
  // Only ever an UNCLAIMED player on a team the caller belongs to, so this
  // cannot be used to attach yourself to another family's child or to reach
  // into a team you are not on.
  const claimed = [];
  if (Array.isArray(body.claimPlayerIds) && scope.visibleTeamIds?.length) {
    const teamList = scope.visibleTeamIds.map(() => '?').join(',');
    for (const raw of body.claimPlayerIds.slice(0, 20)) {
      const personId = integer(raw, { field: 'Player', required: false });
      if (personId == null) continue;
      const person = await db
        .prepare(
          `SELECT p.id, p.name FROM people p
             JOIN enrollments e ON e.person_id = p.id
            WHERE p.id = ? AND p.club_id = ? AND p.household_id IS NULL
              AND e.team_id IN (${teamList}) LIMIT 1`,
        )
        .bind(personId, clubId, ...scope.visibleTeamIds)
        .first();
      if (!person) continue;
      await db
        .prepare(`UPDATE people SET household_id = ? WHERE id = ? AND household_id IS NULL`)
        .bind(household.id, personId)
        .run();
      claimed.push(person.name);
      await audit(db, {
        clubId, actor: user, action: 'player_claimed',
        subjectType: 'person', subjectId: personId,
        reason: `${person.name} linked to their family`, ip,
      });
    }
  }

  // Children the parent types in themselves. Enrolment onto a team stays an
  // admin action — a parent must not be able to add a child to a roster.
  //
  // If the name matches a player already on one of their teams and unclaimed,
  // link to that record instead of creating a second one. Two rows for one
  // child is how a family ends up unable to request the ride they can see.
  if (Array.isArray(body.newChildren)) {
    const teamList = scope.visibleTeamIds?.length
      ? scope.visibleTeamIds.map(() => '?').join(',')
      : null;

    for (const raw of body.newChildren.slice(0, 10)) {
      const name = text(raw, { field: 'Child name', max: 120 });
      if (!name) continue;

      const duplicate = await db
        .prepare(`SELECT id FROM people WHERE household_id = ? AND lower(name) = lower(?)`)
        .bind(household.id, name)
        .first();
      if (duplicate) continue;

      if (teamList) {
        const rostered = await db
          .prepare(
            `SELECT p.id, p.name FROM people p
               JOIN enrollments e ON e.person_id = p.id
              WHERE p.club_id = ? AND lower(p.name) = lower(?) AND p.household_id IS NULL
                AND e.team_id IN (${teamList}) LIMIT 1`,
          )
          .bind(clubId, name, ...scope.visibleTeamIds)
          .first();
        if (rostered) {
          await db
            .prepare(`UPDATE people SET household_id = ? WHERE id = ? AND household_id IS NULL`)
            .bind(household.id, rostered.id)
            .run();
          claimed.push(rostered.name);
          await audit(db, {
            clubId, actor: user, action: 'player_claimed',
            subjectType: 'person', subjectId: rostered.id,
            reason: `${rostered.name} matched by name and linked`, ip,
          });
          continue;
        }
      }

      await db
        .prepare(`INSERT INTO people (club_id, household_id, name) VALUES (?,?,?)`)
        .bind(clubId, household.id, name)
        .run();
    }
  }

  if (Array.isArray(body.vehicles)) {
    await db.prepare(`DELETE FROM vehicles WHERE household_id = ?`).bind(household.id).run();
    let order = 0;
    for (const raw of body.vehicles.slice(0, 8)) {
      const name = text(raw?.name, { field: 'Vehicle', max: 80 });
      if (!name) continue;
      await db
        .prepare(
          `INSERT INTO vehicles (club_id, household_id, name, seat_capacity, notes, sort_order)
           VALUES (?,?,?,?,?,?)`,
        )
        .bind(
          clubId,
          household.id,
          name,
          integer(raw?.seatCapacity ?? 3, { field: 'Seats', min: 1, max: 8 }),
          text(raw?.notes, { field: 'Notes', max: 200 }),
          order++,
        )
        .run();
    }
  }

  const me = await getMe({ db, user: { ...user, display_name: displayName, phone: contact }, scope });

  // Tell the family what we matched. A geocoder that cannot find a street
  // often returns the middle of the city without complaining, so the answer
  // is shown for confirmation rather than quietly treated as fact.
  return {
    ...me,
    claimed,
    geocode: geo
      ? { found: true, label: geo.label, confidence: geo.confidence }
      : addressChanged && home.lat == null
        ? { found: false }
        : null,
  };
}
