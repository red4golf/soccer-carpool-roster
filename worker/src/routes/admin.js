// Scoped administration.
//
// There is no admin password here. Every capability below is checked against
// the caller's membership row, which means: rights are per-person, revocable
// by pausing one membership, and every sensitive read is attributable to a
// real identity in the audit log.

import { HttpError, audit } from '../lib/scope.js';
import { clockTime, integer, isoDate, oneOf, safeUrl, text } from '../lib/validate.js';
import { geocoderFor, geocodeSequential } from '../lib/geocode.js';

export async function adminRequest(context) {
  if (context.request.method === 'GET') return overview(context);

  const action = String(context.body.action || '');
  const handlers = {
    approve_member: approveMember,
    set_member_role: setMemberRole,
    create_club: createClub,
    update_club: updateClub,
    create_team: createTeam,
    update_team: updateTeam,
    invite_members: inviteMembers,
    revoke_invite: revokeInvite,
    create_person: createPerson,
    unenroll_child: unenrollChild,
    upsert_event: upsertEvent,
    upsert_location: upsertLocation,
    upsert_pickup_area: upsertPickupArea,
    enroll_child: enrollChild,
    delete_record: deleteRecord,
    reveal_address: revealAddress,
    create_pool: createPool,
    join_pool: joinPool,
    leave_pool: leavePool,
    export_backup: exportBackup,
    geocode_households: geocodeHouseholds,
  };
  const handler = handlers[action];
  if (!handler) throw new HttpError(400, 'Unknown action.');
  return handler(context);
}

/** Resolve and authorise a club id from the request. */
function clubGate(scope, clubId, permission = 'manage_teams') {
  const id = integer(clubId, { field: 'Club' });
  if (!scope.can(permission, { clubId: id })) throw new HttpError(404, 'Not found.', 'out_of_scope');
  return id;
}

async function teamGate(db, scope, teamId, permission = 'manage_events') {
  const id = integer(teamId, { field: 'Team' });
  const team = await db.prepare(`SELECT id, club_id FROM teams WHERE id = ?`).bind(id).first();
  if (!team) throw new HttpError(404, 'Not found.', 'out_of_scope');
  if (!scope.can(permission, { teamId: team.id, clubId: team.club_id })) {
    throw new HttpError(404, 'Not found.', 'out_of_scope');
  }
  return team;
}

// ---------------------------------------------------------------------------

/**
 * An absent query parameter must read as "not supplied", not as zero.
 * `Number(null)` is 0 and `Number.isInteger(0)` is true, so the obvious
 * version treated a missing teamId as team 0 and 404'd every admin GET that
 * did not name a team.
 */
function optionalId(url, name) {
  const raw = url.searchParams.get(name);
  if (raw == null || raw === '') return null;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : null;
}

async function overview({ db, scope, url }) {
  const clubId = optionalId(url, 'clubId');
  const teamId = optionalId(url, 'teamId');

  // A team admin gets their team; a club admin gets the whole club.
  const isClubAdmin = clubId != null && (scope.isClubAdmin(clubId) || scope.isPlatformAdmin);
  let teamIds = scope.visibleTeamIds;

  // Narrow to the requested club. Without this, someone who administers two
  // clubs — or the platform operator, who is in every club — got every team
  // they can see regardless of which club the UI asked about, silently
  // blending two organisations' rosters into one screen.
  if (clubId != null && teamIds.length) {
    const owned = (
      await db
        .prepare(
          `SELECT id FROM teams
            WHERE club_id = ? AND id IN (${teamIds.map(() => '?').join(',')})`,
        )
        .bind(clubId, ...teamIds)
        .all()
    ).results;
    teamIds = owned.map(row => row.id);
  }

  if (teamId != null) {
    const team = await teamGate(db, scope, teamId, 'manage_events');
    teamIds = [team.id];
  } else if (!isClubAdmin) {
    const manageable = [];
    for (const id of scope.visibleTeamIds) {
      const team = await db.prepare(`SELECT id, club_id FROM teams WHERE id = ?`).bind(id).first();
      if (team && scope.can('manage_events', { teamId: team.id, clubId: team.club_id })) manageable.push(id);
    }
    teamIds = manageable;
  }

  // Clubs this caller administers. Needed before any team exists, which is
  // exactly the state a brand-new club is in — returning 404 here would make
  // a club impossible to set up through the UI that is supposed to set it up.
  const adminClubIds = scope.isPlatformAdmin
    ? ((await db.prepare(`SELECT id FROM clubs`).all()).results ?? []).map(r => r.id)
    : [...scope.byClub.entries()].filter(([, role]) => role === 'club_admin').map(([id]) => id);

  const clubs = adminClubIds.length
    ? (
        await db
          .prepare(
            `SELECT id, name, slug, timezone, allow_cross_team_pools
               FROM clubs WHERE id IN (${adminClubIds.map(() => '?').join(',')}) ORDER BY name`,
          )
          .bind(...adminClubIds)
          .all()
      ).results
    : [];

  if (!teamIds.length) {
    if (!clubs.length) throw new HttpError(404, 'Not found.', 'out_of_scope');
    return {
      teams: [], events: [], roster: [], members: [], invitations: [],
      locations: [], pickupAreas: [], clubs,
      canManageClub: true,
      isPlatformAdmin: scope.isPlatformAdmin,
      counts: { teams: 0, events: 0, players: 0, pendingMembers: 0, openInvites: 0 },
    };
  }
  const list = teamIds.map(() => '?').join(',');

  const teams = (
    await db.prepare(`SELECT id, club_id, name, season FROM teams WHERE id IN (${list})`).bind(...teamIds).all()
  ).results;

  const events = (
    await db
      .prepare(
        `SELECT e.id, e.team_id, e.event_type, e.title, e.event_date, e.start_time, e.pool_id,
                l.name AS location_name
           FROM events e LEFT JOIN locations l ON l.id = e.location_id
          WHERE e.team_id IN (${list}) ORDER BY e.event_date DESC LIMIT 200`,
      )
      .bind(...teamIds)
      .all()
  ).results;

  const roster = (
    await db
      .prepare(
        `SELECT en.id, en.team_id, p.id AS person_id, p.name, p.household_id
           FROM enrollments en JOIN people p ON p.id = en.person_id
          WHERE en.team_id IN (${list}) ORDER BY p.name`,
      )
      .bind(...teamIds)
      .all()
  ).results;

  const members = (
    await db
      .prepare(
        `SELECT m.id, m.team_id, m.club_id, m.role, m.status, u.display_name, u.email, u.phone
           FROM memberships m JOIN users u ON u.id = m.user_id
          WHERE m.team_id IN (${list}) ORDER BY m.status, u.display_name`,
      )
      .bind(...teamIds)
      .all()
  ).results;

  const clubIds = [...new Set(teams.map(t => t.club_id))];
  const clubList = clubIds.map(() => '?').join(',');
  const locations = clubIds.length
    ? (await db.prepare(`SELECT id, club_id, name, map_url, lat, lng FROM locations WHERE club_id IN (${clubList})`).bind(...clubIds).all()).results
    : [];
  const areas = clubIds.length
    ? (await db.prepare(`SELECT id, club_id, name FROM pickup_areas WHERE club_id IN (${clubList})`).bind(...clubIds).all()).results
    : [];

  // Invitations that have not yet been taken up — the coordinator's list of
  // "who have I asked but who has not signed in yet".
  const invitations = (
    await db
      .prepare(
        `SELECT i.id, i.team_id, i.club_id, i.email, i.role, i.created_at, u.display_name AS invited_by_name
           FROM invitations i LEFT JOIN users u ON u.id = i.invited_by
          WHERE i.team_id IN (${list}) AND i.claimed_at IS NULL
          ORDER BY i.created_at DESC`,
      )
      .bind(...teamIds)
      .all()
  ).results;

  return {
    teams,
    events,
    roster,
    members,
    invitations,
    locations,
    pickupAreas: areas,
    clubs,
    canManageClub: isClubAdmin || scope.isPlatformAdmin,
    isPlatformAdmin: scope.isPlatformAdmin,
    counts: {
      teams: teams.length,
      events: events.length,
      players: roster.length,
      pendingMembers: members.filter(m => m.status === 'pending').length,
      openInvites: invitations.length,
    },
  };
}

// ---------------------------------------------------------------------------

async function approveMember({ db, scope, user, body, ip }) {
  const membershipId = integer(body.membershipId, { field: 'Membership' });
  const membership = await db.prepare(`SELECT * FROM memberships WHERE id = ?`).bind(membershipId).first();
  if (!membership) throw new HttpError(404, 'Not found.', 'out_of_scope');

  if (!scope.can('approve_member', { teamId: membership.team_id, clubId: membership.club_id })) {
    throw new HttpError(404, 'Not found.', 'out_of_scope');
  }
  // Nobody promotes themselves.
  if (membership.user_id === user.id) throw new HttpError(403, 'You cannot change your own access.');

  const status = oneOf(body.status, ['active', 'paused', 'pending'], 'Status');
  await db
    .prepare(
      `UPDATE memberships
          SET status = ?, approved_at = CASE WHEN ? = 'active' THEN datetime('now') ELSE approved_at END,
              approved_by = ?
        WHERE id = ?`,
    )
    .bind(status, status, user.id, membershipId)
    .run();

  await audit(db, {
    clubId: membership.club_id,
    actor: user,
    action: 'membership_status_changed',
    subjectType: 'membership',
    subjectId: membershipId,
    reason: `Set to ${status}`,
    ip,
  });
  return { ok: true };
}

async function setMemberRole({ db, scope, user, body, ip }) {
  const membershipId = integer(body.membershipId, { field: 'Membership' });
  const role = oneOf(body.role, ['parent', 'coach', 'team_admin'], 'Role');

  const membership = await db.prepare(`SELECT * FROM memberships WHERE id = ?`).bind(membershipId).first();
  if (!membership) throw new HttpError(404, 'Not found.', 'out_of_scope');
  // Granting club_admin is deliberately not possible through this endpoint —
  // a team admin must never be able to escalate anyone to club level.
  if (!scope.can('approve_member', { teamId: membership.team_id, clubId: membership.club_id })) {
    throw new HttpError(404, 'Not found.', 'out_of_scope');
  }
  if (membership.user_id === user.id) throw new HttpError(403, 'You cannot change your own role.');

  await db.prepare(`UPDATE memberships SET role = ? WHERE id = ?`).bind(role, membershipId).run();
  await audit(db, {
    clubId: membership.club_id, actor: user, action: 'membership_role_changed',
    subjectType: 'membership', subjectId: membershipId, reason: `Set to ${role}`, ip,
  });
  return { ok: true };
}

async function createTeam({ db, scope, user, body, ip }) {
  const clubId = clubGate(scope, body.clubId, 'manage_teams');
  const created = await db
    .prepare(`INSERT INTO teams (club_id, name, season, age_group) VALUES (?,?,?,?) RETURNING id`)
    .bind(
      clubId,
      text(body.name, { field: 'Team name', max: 80, required: true }),
      text(body.season, { field: 'Season', max: 40 }),
      text(body.ageGroup, { field: 'Age group', max: 40 }),
    )
    .first();
  await audit(db, { clubId, actor: user, action: 'team_created', subjectType: 'team', subjectId: created.id, ip });
  return { ok: true, teamId: created.id };
}

async function upsertEvent({ db, scope, body }) {
  const team = await teamGate(db, scope, body.teamId, 'manage_events');
  const id = integer(body.id, { field: 'Event', required: false });

  const locationId = integer(body.locationId, { field: 'Location', required: false });
  if (locationId != null) {
    const location = await db
      .prepare(`SELECT id FROM locations WHERE id = ? AND club_id = ?`)
      .bind(locationId, team.club_id)
      .first();
    if (!location) throw new HttpError(400, 'That location is not part of this club.');
  }

  const fields = [
    team.club_id,
    team.id,
    locationId,
    oneOf(body.eventType ?? 'practice', ['practice', 'game', 'tournament'], 'Event type'),
    text(body.title, { field: 'Title', max: 120, required: true }),
    isoDate(body.eventDate, 'the event date'),
    clockTime(body.startTime, 'the start time'),
    integer(body.arriveMinutesBefore ?? 15, { field: 'Arrival buffer', min: 0, max: 180 }),
    text(body.notes, { field: 'Notes', max: 300 }),
  ];

  if (id) {
    await db
      .prepare(
        `UPDATE events SET location_id = ?, event_type = ?, title = ?, event_date = ?,
                start_time = ?, arrive_minutes_before = ?, notes = ?
          WHERE id = ? AND team_id = ? AND club_id = ?`,
      )
      .bind(...fields.slice(2), id, team.id, team.club_id)
      .run();
    return { ok: true, eventId: id };
  }

  const created = await db
    .prepare(
      `INSERT INTO events (club_id, team_id, location_id, event_type, title, event_date,
                           start_time, arrive_minutes_before, notes)
       VALUES (?,?,?,?,?,?,?,?,?) RETURNING id`,
    )
    .bind(...fields)
    .first();
  return { ok: true, eventId: created.id };
}

async function upsertLocation({ db, scope, body }) {
  const clubId = clubGate(scope, body.clubId, 'manage_teams');
  const id = integer(body.id, { field: 'Location', required: false });
  const name = text(body.name, { field: 'Location name', max: 120, required: true });
  const mapUrl = safeUrl(body.mapUrl); // rejects javascript: and data:
  const lat = body.lat == null || body.lat === '' ? null : Number(body.lat);
  const lng = body.lng == null || body.lng === '' ? null : Number(body.lng);

  if (id) {
    await db
      .prepare(`UPDATE locations SET name = ?, map_url = ?, lat = ?, lng = ? WHERE id = ? AND club_id = ?`)
      .bind(name, mapUrl, lat, lng, id, clubId)
      .run();
    return { ok: true, locationId: id };
  }
  const created = await db
    .prepare(`INSERT INTO locations (club_id, name, map_url, lat, lng) VALUES (?,?,?,?,?) RETURNING id`)
    .bind(clubId, name, mapUrl, lat, lng)
    .first();
  return { ok: true, locationId: created.id };
}

async function upsertPickupArea({ db, scope, body }) {
  const clubId = clubGate(scope, body.clubId, 'manage_teams');
  const created = await db
    .prepare(`INSERT INTO pickup_areas (club_id, name, lat, lng) VALUES (?,?,?,?)
              ON CONFLICT (club_id, name) DO UPDATE SET lat = excluded.lat, lng = excluded.lng
              RETURNING id`)
    .bind(
      clubId,
      text(body.name, { field: 'Area name', max: 80, required: true }),
      body.lat == null || body.lat === '' ? null : Number(body.lat),
      body.lng == null || body.lng === '' ? null : Number(body.lng),
    )
    .first();
  return { ok: true, areaId: created.id };
}

async function enrollChild({ db, scope, body }) {
  const team = await teamGate(db, scope, body.teamId, 'manage_roster');
  const personId = integer(body.personId, { field: 'Child' });
  const person = await db
    .prepare(`SELECT id FROM people WHERE id = ? AND club_id = ?`)
    .bind(personId, team.club_id)
    .first();
  if (!person) throw new HttpError(400, 'That child is not in this club.');

  await db
    .prepare(`INSERT INTO enrollments (club_id, team_id, person_id) VALUES (?,?,?)
              ON CONFLICT (team_id, person_id) DO NOTHING`)
    .bind(team.club_id, team.id, personId)
    .run();
  return { ok: true };
}

const DELETABLE = {
  event: { table: 'events', scope: 'team' },
  enrollment: { table: 'enrollments', scope: 'team' },
  location: { table: 'locations', scope: 'club' },
  pickup_area: { table: 'pickup_areas', scope: 'club' },
  driver_offer: { table: 'driver_offers', scope: 'team' },
  ride_request: { table: 'ride_requests', scope: 'team' },
};

async function deleteRecord({ db, scope, user, body, ip }) {
  const kind = oneOf(body.kind, Object.keys(DELETABLE), 'Record type');
  const id = integer(body.id, { field: 'Record' });
  const spec = DELETABLE[kind];

  const row = await db.prepare(`SELECT * FROM ${spec.table} WHERE id = ?`).bind(id).first();
  if (!row) throw new HttpError(404, 'Not found.', 'out_of_scope');

  if (spec.scope === 'team') {
    if (!scope.can('manage_events', { teamId: row.team_id, clubId: row.club_id })) {
      throw new HttpError(404, 'Not found.', 'out_of_scope');
    }
  } else if (!scope.can('manage_teams', { clubId: row.club_id })) {
    throw new HttpError(404, 'Not found.', 'out_of_scope');
  }

  await db.prepare(`DELETE FROM ${spec.table} WHERE id = ? AND club_id = ?`).bind(id, row.club_id).run();
  await audit(db, {
    clubId: row.club_id, actor: user, action: 'record_deleted',
    subjectType: kind, subjectId: id, ip,
  });
  return { ok: true };
}

/** Club-admin address reveal. Requires a stated reason and is always logged. */
async function revealAddress({ db, scope, user, body, ip }) {
  const householdId = integer(body.householdId, { field: 'Household' });
  const household = await db.prepare(`SELECT * FROM households WHERE id = ?`).bind(householdId).first();
  if (!household) throw new HttpError(404, 'Not found.', 'out_of_scope');

  if (!scope.can('reveal_any_address', { clubId: household.club_id })) {
    throw new HttpError(404, 'Not found.', 'out_of_scope');
  }
  const reason = text(body.reason, { field: 'Reason', max: 200, required: true });

  await audit(db, {
    clubId: household.club_id, actor: user, action: 'admin_revealed',
    subjectType: 'household', subjectId: householdId, reason, ip,
  });

  return {
    ok: true,
    homeAddress: household.home_address,
    alternateAddress: household.alternate_address,
    logged: true,
  };
}

// --- pooling ---------------------------------------------------------------

async function createPool({ db, scope, user, body, ip }) {
  const clubId = clubGate(scope, body.clubId, 'manage_pools');
  const club = await db.prepare(`SELECT allow_cross_team_pools FROM clubs WHERE id = ?`).bind(clubId).first();
  if (!club.allow_cross_team_pools) {
    throw new HttpError(400, 'Cross-team carpooling is switched off for this club.');
  }

  const locationId = integer(body.locationId, { field: 'Location' });
  const location = await db
    .prepare(`SELECT id FROM locations WHERE id = ? AND club_id = ?`)
    .bind(locationId, clubId)
    .first();
  if (!location) throw new HttpError(400, 'That location is not part of this club.');

  const created = await db
    .prepare(
      `INSERT INTO carpool_pools (club_id, location_id, pool_date, window_start, window_end, created_by)
       VALUES (?,?,?,?,?,?) RETURNING id`,
    )
    .bind(clubId, locationId, isoDate(body.poolDate, 'the pool date'),
      clockTime(body.windowStart ?? '00:00', 'the window start'),
      clockTime(body.windowEnd ?? '23:59', 'the window end'), user.id)
    .first();

  await audit(db, { clubId, actor: user, action: 'pool_created', subjectType: 'pool', subjectId: created.id, ip });
  return { ok: true, poolId: created.id };
}

/**
 * A team opts INTO a pool. Deliberately a team-admin action on the joining
 * team: no club admin, and certainly no other team, can enrol a team into
 * cross-team visibility on its behalf.
 */
async function joinPool({ db, scope, user, body, ip }) {
  const team = await teamGate(db, scope, body.teamId, 'manage_events');
  const poolId = integer(body.poolId, { field: 'Pool' });

  const pool = await db
    .prepare(`SELECT p.*, c.allow_cross_team_pools FROM carpool_pools p
                JOIN clubs c ON c.id = p.club_id WHERE p.id = ? AND p.club_id = ?`)
    .bind(poolId, team.club_id)
    .first();
  if (!pool) throw new HttpError(404, 'Not found.', 'out_of_scope');
  if (!pool.allow_cross_team_pools) throw new HttpError(400, 'Cross-team carpooling is switched off for this club.');

  await db
    .prepare(`INSERT INTO pool_teams (pool_id, team_id, club_id, opted_in_by) VALUES (?,?,?,?)
              ON CONFLICT (pool_id, team_id) DO NOTHING`)
    .bind(poolId, team.id, team.club_id, user.id)
    .run();

  const eventId = integer(body.eventId, { field: 'Event', required: false });
  if (eventId != null) {
    await db
      .prepare(`UPDATE events SET pool_id = ? WHERE id = ? AND team_id = ? AND club_id = ?`)
      .bind(poolId, eventId, team.id, team.club_id)
      .run();
  }

  await audit(db, {
    clubId: team.club_id, actor: user, action: 'pool_joined',
    subjectType: 'pool', subjectId: poolId, reason: `Team ${team.id} opted in`, ip,
  });
  return { ok: true };
}

async function leavePool({ db, scope, user, body, ip }) {
  const team = await teamGate(db, scope, body.teamId, 'manage_events');
  const poolId = integer(body.poolId, { field: 'Pool' });

  await db.prepare(`DELETE FROM pool_teams WHERE pool_id = ? AND team_id = ?`).bind(poolId, team.id).run();
  await db
    .prepare(`UPDATE events SET pool_id = NULL WHERE pool_id = ? AND team_id = ?`)
    .bind(poolId, team.id)
    .run();

  await audit(db, {
    clubId: team.club_id, actor: user, action: 'pool_left',
    subjectType: 'pool', subjectId: poolId, reason: `Team ${team.id} opted out`, ip,
  });
  return { ok: true };
}

/** Full club export, including addresses. Club admin only, always logged. */
async function exportBackup({ db, scope, user, body, ip }) {
  const clubId = clubGate(scope, body.clubId, 'export_backup');

  const tables = [
    'teams', 'memberships', 'households', 'household_members', 'vehicles', 'people',
    'enrollments', 'pickup_areas', 'locations', 'events', 'carpool_pools', 'pool_teams',
    'driver_offers', 'ride_requests', 'assignments',
  ];
  const backup = { club: await db.prepare(`SELECT * FROM clubs WHERE id = ?`).bind(clubId).first() };
  for (const table of tables) {
    backup[table] = (await db.prepare(`SELECT * FROM ${table} WHERE club_id = ?`).bind(clubId).all()).results;
  }

  await audit(db, {
    clubId, actor: user, action: 'backup_exported', subjectType: 'club', subjectId: clubId,
    reason: text(body.reason, { field: 'Reason', max: 200 }) || 'Club backup downloaded', ip,
  });

  return { ok: true, exportedAt: new Date().toISOString(), backup };
}

// ---------------------------------------------------------------------------
// Clubs and teams
// ---------------------------------------------------------------------------

const slugify = value =>
  String(value).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

/**
 * Create a club. Platform operator only.
 *
 * Deliberately not self-service: a club is a tenant boundary, and anyone who
 * can mint one can mint a container for other people's children. The creator
 * becomes its first club_admin, because a club with no administrator cannot
 * be administered.
 */
async function createClub({ db, scope, user, body, ip }) {
  if (!scope.isPlatformAdmin) throw new HttpError(404, 'Not found.', 'out_of_scope');

  const name = text(body.name, { field: 'Club name', max: 120, required: true });
  const slug = slugify(body.slug || name);
  if (!slug) throw new HttpError(400, 'That club name cannot be turned into a web address.');

  const clash = await db.prepare(`SELECT id FROM clubs WHERE slug = ?`).bind(slug).first();
  if (clash) throw new HttpError(409, 'A club with a similar name already exists.');

  const club = await db
    .prepare(
      `INSERT INTO clubs (name, slug, timezone, allow_cross_team_pools)
       VALUES (?,?,?,?) RETURNING id`,
    )
    .bind(
      name,
      slug,
      text(body.timezone, { max: 60 }) || 'America/Los_Angeles',
      body.allowCrossTeamPools ? 1 : 0,
    )
    .first();

  await db
    .prepare(
      `INSERT INTO memberships (club_id, team_id, user_id, role, status, approved_at, approved_by)
       VALUES (?, NULL, ?, 'club_admin', 'active', datetime('now'), ?)`,
    )
    .bind(club.id, user.id, user.id)
    .run();

  await audit(db, {
    clubId: club.id, actor: user, action: 'club_created',
    subjectType: 'club', subjectId: club.id, reason: name, ip,
  });
  return { ok: true, clubId: club.id, slug };
}

async function updateClub({ db, scope, user, body, ip }) {
  const clubId = clubGate(scope, body.clubId, 'manage_teams');
  const name = text(body.name, { field: 'Club name', max: 120, required: true });
  const pooling = body.allowCrossTeamPools ? 1 : 0;

  const before = await db
    .prepare(`SELECT allow_cross_team_pools FROM clubs WHERE id = ?`)
    .bind(clubId)
    .first();

  await db
    .prepare(`UPDATE clubs SET name = ?, allow_cross_team_pools = ? WHERE id = ?`)
    .bind(name, pooling, clubId)
    .run();

  // Flipping pooling is privacy-relevant either way: it grants or withdraws
  // cross-team visibility of children. It gets its own log line rather than
  // being folded into a generic "club updated".
  if (before && before.allow_cross_team_pools !== pooling) {
    await audit(db, {
      clubId, actor: user, action: pooling ? 'pooling_enabled' : 'pooling_disabled',
      subjectType: 'club', subjectId: clubId, ip,
    });
  }
  return { ok: true };
}

async function updateTeam({ db, scope, user, body, ip }) {
  const team = await teamGate(db, scope, body.teamId, 'manage_events');
  const name = text(body.name, { field: 'Team name', max: 80, required: true });
  const archived = body.archived ? 1 : 0;

  await db
    .prepare(
      `UPDATE teams SET name = ?, season = ?, age_group = ?, archived = ?
        WHERE id = ? AND club_id = ?`,
    )
    .bind(
      name,
      text(body.season, { max: 40 }),
      text(body.ageGroup, { max: 40 }),
      archived,
      team.id,
      team.club_id,
    )
    .run();

  await audit(db, {
    clubId: team.club_id, actor: user, action: archived ? 'team_archived' : 'team_updated',
    subjectType: 'team', subjectId: team.id, reason: name, ip,
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Invitations — the only way into a club
// ---------------------------------------------------------------------------

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Invite one or many people to a team by email address.
 *
 * Bulk, because a club is hundreds of families and inviting them one at a
 * time is how a coordinator gives up. Invalid addresses come back in the
 * response rather than being silently skipped: a mistyped invite is a parent
 * who never gets access and has no way to find out why.
 */
async function inviteMembers({ db, scope, user, body, ip }) {
  const team = await teamGate(db, scope, body.teamId, 'approve_member');
  const role = oneOf(body.role ?? 'parent', ['parent', 'coach', 'team_admin'], 'Role');

  const raw = Array.isArray(body.emails)
    ? body.emails
    : String(body.emails ?? '').split(/[\s,;]+/);

  const emails = [...new Set(raw.map(e => String(e).toLowerCase().trim()).filter(Boolean))];
  if (!emails.length) throw new HttpError(400, 'Enter at least one email address.');
  if (emails.length > 200) throw new HttpError(400, 'Invite at most 200 people at a time.');

  const invited = [];
  const rejected = [];
  const alreadyMembers = [];

  for (const email of emails) {
    if (!EMAIL.test(email)) {
      rejected.push(email);
      continue;
    }

    // Someone who already has a login gets their membership immediately —
    // there is nothing to wait for.
    const existingUser = await db
      .prepare(`SELECT id FROM users WHERE lower(email) = ?`)
      .bind(email)
      .first();

    if (existingUser) {
      const already = await db
        .prepare(`SELECT id FROM memberships WHERE user_id = ? AND team_id = ?`)
        .bind(existingUser.id, team.id)
        .first();
      if (already) {
        alreadyMembers.push(email);
        continue;
      }
      await db
        .prepare(
          `INSERT INTO memberships (club_id, team_id, user_id, role, status, invited_by, approved_at, approved_by)
           VALUES (?,?,?,?, 'active', ?, datetime('now'), ?) ON CONFLICT DO NOTHING`,
        )
        .bind(team.club_id, team.id, existingUser.id, role, user.id, user.id)
        .run();
      invited.push(email);
      continue;
    }

    await db
      .prepare(
        `INSERT INTO invitations (club_id, team_id, email, role, invited_by)
         VALUES (?,?,?,?,?)
         ON CONFLICT (club_id, IFNULL(team_id, 0), email)
         DO UPDATE SET role = excluded.role, invited_by = excluded.invited_by,
                       created_at = datetime('now'), claimed_at = NULL, claimed_by = NULL`,
      )
      .bind(team.club_id, team.id, email, role, user.id)
      .run();
    invited.push(email);
  }

  await audit(db, {
    clubId: team.club_id, actor: user, action: 'members_invited',
    subjectType: 'team', subjectId: team.id,
    reason: `${invited.length} invited as ${role}`, ip,
  });

  return { ok: true, invited, rejected, alreadyMembers };
}

async function revokeInvite({ db, scope, user, body, ip }) {
  const inviteId = integer(body.inviteId, { field: 'Invitation' });
  const invite = await db.prepare(`SELECT * FROM invitations WHERE id = ?`).bind(inviteId).first();
  if (!invite) throw new HttpError(404, 'Not found.', 'out_of_scope');
  if (!scope.can('approve_member', { teamId: invite.team_id, clubId: invite.club_id })) {
    throw new HttpError(404, 'Not found.', 'out_of_scope');
  }

  await db.prepare(`DELETE FROM invitations WHERE id = ?`).bind(inviteId).run();
  await audit(db, {
    clubId: invite.club_id, actor: user, action: 'invite_revoked',
    subjectType: 'team', subjectId: invite.team_id, reason: invite.email, ip,
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Roster
// ---------------------------------------------------------------------------

/** Add a child to the club roster and enrol them on a team in one step. */
async function createPerson({ db, scope, user, body, ip }) {
  const team = await teamGate(db, scope, body.teamId, 'manage_roster');
  const name = text(body.name, { field: 'Player name', max: 120, required: true });

  // Reuse an existing child of the same name rather than creating a second
  // record: this is exactly how a sibling ends up on two teams, and how a
  // player who moves teams keeps one household and one address.
  const existing = await db
    .prepare(`SELECT id FROM people WHERE club_id = ? AND lower(name) = lower(?)`)
    .bind(team.club_id, name)
    .first();

  const personId = existing
    ? existing.id
    : (
        await db
          .prepare(`INSERT INTO people (club_id, name) VALUES (?,?) RETURNING id`)
          .bind(team.club_id, name)
          .first()
      ).id;

  await db
    .prepare(
      `INSERT INTO enrollments (club_id, team_id, person_id) VALUES (?,?,?)
       ON CONFLICT (team_id, person_id) DO NOTHING`,
    )
    .bind(team.club_id, team.id, personId)
    .run();

  await audit(db, {
    clubId: team.club_id, actor: user, action: 'player_enrolled',
    subjectType: 'team', subjectId: team.id, reason: name, ip,
  });
  return { ok: true, personId, reusedExisting: Boolean(existing) };
}

/**
 * Take a child off a team roster.
 *
 * Removes the enrolment, not the person: the same child may be rostered on
 * another team, and their household, address and ride history must survive.
 */
async function unenrollChild({ db, scope, user, body, ip }) {
  const team = await teamGate(db, scope, body.teamId, 'manage_roster');
  const personId = integer(body.personId, { field: 'Child' });

  await db
    .prepare(`DELETE FROM enrollments WHERE team_id = ? AND person_id = ? AND club_id = ?`)
    .bind(team.id, personId, team.club_id)
    .run();

  await audit(db, {
    clubId: team.club_id, actor: user, action: 'player_unenrolled',
    subjectType: 'team', subjectId: team.id, reason: `person ${personId}`, ip,
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Geocoding backfill
// ---------------------------------------------------------------------------

/**
 * Resolve coordinates for households that have an address but no location.
 *
 * Only reaches families who typed an address before geocoding existed, or
 * whose lookup failed at the time. Deliberately club_admin only and always
 * logged: it sends home addresses to a third party, and that should be a
 * decision somebody made, not a background job nobody remembers enabling.
 *
 * Paced at roughly one per second to respect the geocoder's rate limit, and
 * capped per run so a Worker invocation cannot run past its time budget.
 */
async function geocodeHouseholds({ db, env, scope, user, body, ip }) {
  const clubId = clubGate(scope, body.clubId, 'manage_teams');
  const limit = integer(body.limit ?? 20, { field: 'Limit', min: 1, max: 40 });

  const pending = (
    await db
      .prepare(
        `SELECT id, home_address FROM households
          WHERE club_id = ? AND home_address <> '' AND home_lat IS NULL
          ORDER BY id LIMIT ?`,
      )
      .bind(clubId, limit)
      .all()
  ).results;

  if (!pending.length) {
    const remaining = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM households
          WHERE club_id = ? AND home_address <> '' AND home_lat IS NULL`,
      )
      .bind(clubId)
      .first();
    return { ok: true, processed: 0, located: 0, remaining: remaining.n };
  }

  const geocoder = geocoderFor(env);
  const results = await geocodeSequential(
    pending.map(row => ({ id: row.id, address: row.home_address })),
    geocoder,
    { delayMs: Number(env?.GEOCODE_DELAY_MS ?? 1100) },
  );

  let located = 0;
  for (const { id, result } of results) {
    if (!result) continue;
    located++;
    await db
      .prepare(
        `UPDATE households
            SET home_lat = ?, home_lng = ?, home_geocode_label = ?,
                home_geocode_confidence = ?, geocoded_at = datetime('now')
          WHERE id = ? AND club_id = ?`,
      )
      .bind(result.lat, result.lng, result.label, result.confidence, id, clubId)
      .run();
  }

  const remaining = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM households
        WHERE club_id = ? AND home_address <> '' AND home_lat IS NULL`,
    )
    .bind(clubId)
    .first();

  await audit(db, {
    clubId, actor: user, action: 'households_geocoded',
    subjectType: 'club', subjectId: clubId,
    reason: `${located} of ${results.length} addresses located`, ip,
  });

  return { ok: true, processed: results.length, located, remaining: remaining.n };
}
