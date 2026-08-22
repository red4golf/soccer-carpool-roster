// Scoped administration.
//
// There is no admin password here. Every capability below is checked against
// the caller's membership row, which means: rights are per-person, revocable
// by pausing one membership, and every sensitive read is attributable to a
// real identity in the audit log.

import { HttpError, audit } from '../lib/scope.js';
import { clockTime, integer, isoDate, oneOf, safeUrl, text } from '../lib/validate.js';

export async function adminRequest(context) {
  if (context.request.method === 'GET') return overview(context);

  const action = String(context.body.action || '');
  const handlers = {
    approve_member: approveMember,
    set_member_role: setMemberRole,
    create_team: createTeam,
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

async function overview({ db, scope, url }) {
  const clubId = Number(url.searchParams.get('clubId'));
  const teamId = Number(url.searchParams.get('teamId'));

  // A team admin gets their team; a club admin gets the whole club.
  const isClubAdmin = Number.isInteger(clubId) && scope.isClubAdmin(clubId);
  let teamIds = scope.visibleTeamIds;
  if (Number.isInteger(teamId)) {
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

  if (!teamIds.length) throw new HttpError(404, 'Not found.', 'out_of_scope');
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

  return {
    teams,
    events,
    roster,
    members,
    locations,
    pickupAreas: areas,
    canManageClub: isClubAdmin,
    counts: {
      teams: teams.length,
      events: events.length,
      players: roster.length,
      pendingMembers: members.filter(m => m.status === 'pending').length,
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
