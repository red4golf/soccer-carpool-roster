// Adversarial tests for tenant isolation.
//
// These are written from the attacker's side: each one is an attempt to see
// something that belongs to another team or another club. A passing suite
// means the attempt failed, not that the happy path worked.

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScope, pooledTeamIds, projectPooledRequest, Scope, HttpError } from '../src/lib/scope.js';
import { seedTwoClubs, seedPooledEvent } from './helpers.js';

const scopeFor = async (fixture, userId) =>
  loadScope(fixture.db, fixture.userRow(userId));

// --- basic containment -----------------------------------------------------

test('a parent sees only their own team', async () => {
  const f = seedTwoClubs();
  const scope = await scopeFor(f, f.users.redParent);

  assert.deepEqual(scope.visibleTeamIds, [f.teams.red]);
  assert.equal(scope.roleOnTeam(f.teams.red, f.clubs.riverside), 'parent');
  assert.equal(scope.roleOnTeam(f.teams.gold, f.clubs.riverside), null);
  assert.equal(scope.roleOnTeam(f.teams.blue, f.clubs.harbor), null);
});

test('a parent cannot read a sibling team in the same club', async () => {
  const f = seedTwoClubs();
  const scope = await scopeFor(f, f.users.redParent);
  assert.equal(scope.can('view_board', { teamId: f.teams.gold, clubId: f.clubs.riverside }), false);
  assert.throws(
    () => scope.requireTeam(f.teams.gold, f.clubs.riverside),
    e => e instanceof HttpError && e.status === 404,
  );
});

test('a parent cannot read across clubs', async () => {
  const f = seedTwoClubs();
  const scope = await scopeFor(f, f.users.redParent);
  assert.equal(scope.can('view_board', { teamId: f.teams.blue, clubId: f.clubs.harbor }), false);
});

test('out-of-scope reads report 404, not 403, so team ids stay unguessable', async () => {
  const f = seedTwoClubs();
  const scope = await scopeFor(f, f.users.redParent);
  try {
    scope.require('view_board', { teamId: f.teams.blue, clubId: f.clubs.harbor });
    assert.fail('should have thrown');
  } catch (error) {
    assert.equal(error.status, 404);
    assert.equal(error.message, 'Not found.');
    assert.doesNotMatch(error.message, /forbidden|permission|team/i);
  }
});

// --- membership status -----------------------------------------------------

test('a pending membership grants nothing at all', async () => {
  const f = seedTwoClubs();
  const scope = await scopeFor(f, f.users.pendingParent);
  assert.equal(scope.isPending, true);
  assert.deepEqual(scope.visibleTeamIds, []);
  assert.equal(scope.can('view_board', { teamId: f.teams.red, clubId: f.clubs.riverside }), false);
});

test('a paused membership is revoked immediately, not merely hidden', async () => {
  const f = seedTwoClubs();
  const scope = await scopeFor(f, f.users.pausedParent);
  assert.deepEqual(scope.visibleTeamIds, []);
  assert.equal(scope.can('view_board', { teamId: f.teams.red, clubId: f.clubs.riverside }), false);
  assert.equal(scope.can('request_ride', { teamId: f.teams.red, clubId: f.clubs.riverside }), false);
});

// --- roles -----------------------------------------------------------------

test('role ranking gates each permission at the right level', async () => {
  const f = seedTwoClubs();
  const parent = await scopeFor(f, f.users.redParent);
  const coach = await scopeFor(f, f.users.coach);
  const admin = await scopeFor(f, f.users.riversideAdmin);
  const context = { teamId: f.teams.red, clubId: f.clubs.riverside };

  assert.equal(parent.can('request_ride', context), true);
  assert.equal(parent.can('view_roster', context), false);
  assert.equal(parent.can('manage_events', context), false);

  assert.equal(coach.can('view_roster', context), true);
  assert.equal(coach.can('manage_events', context), false);
  assert.equal(coach.can('approve_member', context), false);

  assert.equal(admin.can('manage_events', context), true);
  assert.equal(admin.can('approve_member', context), true);
  assert.equal(admin.can('manage_teams', context), true);
});

test('a club admin covers every team in their club and none outside it', async () => {
  const f = seedTwoClubs();
  const scope = await scopeFor(f, f.users.riversideAdmin);

  assert.deepEqual(scope.visibleTeamIds.sort(), [f.teams.red, f.teams.gold].sort());
  assert.equal(scope.can('manage_events', { teamId: f.teams.red, clubId: f.clubs.riverside }), true);
  assert.equal(scope.can('manage_events', { teamId: f.teams.gold, clubId: f.clubs.riverside }), true);

  // The other club is completely invisible, admin or not.
  assert.equal(scope.can('manage_events', { teamId: f.teams.blue, clubId: f.clubs.harbor }), false);
  assert.equal(scope.can('reveal_any_address', { clubId: f.clubs.harbor }), false);
  assert.equal(scope.can('export_backup', { clubId: f.clubs.harbor }), false);
});

test('club-level permissions reject a team-level admin', () => {
  const scope = new Scope(
    { id: 1, email: 'a@b.c' },
    [{ club_id: 10, team_id: 99, role: 'team_admin', status: 'active' }],
  );
  assert.equal(scope.can('manage_events', { teamId: 99, clubId: 10 }), true);
  // team_admin must not imply club_admin, even inside their own club.
  assert.equal(scope.can('manage_teams', { clubId: 10 }), false);
  assert.equal(scope.can('reveal_any_address', { clubId: 10 }), false);
  assert.equal(scope.can('export_backup', { clubId: 10 }), false);
});

test('a user holding roles in two clubs keeps them separate', () => {
  const scope = new Scope({ id: 5, email: 'two@clubs.example' }, [
    { club_id: 1, team_id: null, role: 'club_admin', status: 'active' },
    { club_id: 2, team_id: 200, role: 'parent', status: 'active' },
  ]);
  assert.equal(scope.can('manage_teams', { clubId: 1 }), true);
  assert.equal(scope.can('manage_teams', { clubId: 2 }), false);
  assert.equal(scope.can('manage_events', { teamId: 200, clubId: 2 }), false);
  assert.equal(scope.can('request_ride', { teamId: 200, clubId: 2 }), true);
});

test('a stale club role cannot be borrowed for a team in another club', () => {
  // club_admin on club 1; the caller supplies a team from club 1 but names
  // club 2 (or vice versa). Neither mismatch may grant access.
  const scope = new Scope({ id: 6, email: 'x@y.z' }, [
    { club_id: 1, team_id: null, role: 'club_admin', status: 'active' },
  ]);
  assert.equal(scope.can('manage_events', { teamId: 500, clubId: 2 }), false);
  assert.equal(scope.can('view_board', { teamId: 500, clubId: 2 }), false);
});

// --- pooling: the deliberate exception -------------------------------------

test('pooling is off unless every precondition holds', async () => {
  const f = seedTwoClubs();
  const scope = await scopeFor(f, f.users.redParent);
  const { events } = seedPooledEvent(f, {
    clubId: f.clubs.riverside,
    teams: { red: f.teams.red, gold: f.teams.gold },
    optInTeams: [], // nobody opted in
  });
  assert.deepEqual(await pooledTeamIds(f.db, scope, events.gold), []);
});

test('one team opting in does not enrol the other', async () => {
  const f = seedTwoClubs();
  const scope = await scopeFor(f, f.users.redParent);
  const { events } = seedPooledEvent(f, {
    clubId: f.clubs.riverside,
    teams: { red: f.teams.red, gold: f.teams.gold },
    optInTeams: [f.teams.red], // Red opted in; Gold did not
  });
  // Red's parent must not see Gold's event: Gold never consented.
  assert.deepEqual(await pooledTeamIds(f.db, scope, events.gold), []);
});

test('both teams opting in shares exactly those teams', async () => {
  const f = seedTwoClubs();
  const scope = await scopeFor(f, f.users.redParent);
  const { events } = seedPooledEvent(f, {
    clubId: f.clubs.riverside,
    teams: { red: f.teams.red, gold: f.teams.gold },
    optInTeams: [f.teams.red, f.teams.gold],
  });
  const shared = await pooledTeamIds(f.db, scope, events.gold);
  assert.deepEqual(shared.sort(), [f.teams.red, f.teams.gold].sort());
});

test('the club switch overrides team consent', async () => {
  const f = seedTwoClubs();
  // Turn pooling off club-wide; both teams still opted in.
  f.db.exec(`UPDATE clubs SET allow_cross_team_pools = 0 WHERE id = ${f.clubs.riverside}`);
  const scope = await scopeFor(f, f.users.redParent);
  const { events } = seedPooledEvent(f, {
    clubId: f.clubs.riverside,
    teams: { red: f.teams.red, gold: f.teams.gold },
    optInTeams: [f.teams.red, f.teams.gold],
  });
  assert.deepEqual(await pooledTeamIds(f.db, scope, events.gold), []);
});

test('a non-member of the pool gains nothing from it', async () => {
  const f = seedTwoClubs();
  const outsider = await scopeFor(f, f.users.blueParent); // different club entirely
  const { events } = seedPooledEvent(f, {
    clubId: f.clubs.riverside,
    teams: { red: f.teams.red, gold: f.teams.gold },
    optInTeams: [f.teams.red, f.teams.gold],
  });
  assert.deepEqual(await pooledTeamIds(f.db, outsider, events.gold), []);
});

test('a pending user gets nothing from pooling either', async () => {
  const f = seedTwoClubs();
  const scope = await scopeFor(f, f.users.pendingParent);
  const { events } = seedPooledEvent(f, {
    clubId: f.clubs.riverside,
    teams: { red: f.teams.red, gold: f.teams.gold },
    optInTeams: [f.teams.red, f.teams.gold],
  });
  assert.deepEqual(await pooledTeamIds(f.db, scope, events.gold), []);
});

test('the pooled projection carries no personal data across the boundary', () => {
  const projected = projectPooledRequest({
    id: 42,
    event_id: 7,
    direction: 'to',
    person_name: 'Alexandra Rivera-Thompson',
    pickup_area_name: 'Winslow',
    offer_id: null,
    // Everything below is present in the source row and must NOT survive.
    household_id: 3,
    home_address: '123 Private Lane, Bainbridge Island, WA',
    home_lat: 47.62,
    home_lng: -122.51,
    guardian_phone: '206-555-0142',
    guardian_email: 'parent@example.com',
    team_id: 99,
    team_name: 'Gold',
    notes: 'Booster seat, back door code 1234',
  });

  assert.deepEqual(projected, {
    id: 42,
    eventId: 7,
    direction: 'to',
    childName: 'Alexandra', // first name only
    pickupArea: 'Winslow',  // coarse zone, never an address
    assigned: false,
    pooled: true,
  });

  const serialized = JSON.stringify(projected);
  for (const secret of ['Rivera-Thompson', 'Private Lane', '206-555', '47.62', '-122.51', 'Gold', 'Booster', '1234', 'parent@example.com']) {
    assert.ok(!serialized.includes(secret), `leaked ${secret}`);
  }
});

// --- platform operator -----------------------------------------------------

test('the platform operator is the only cross-club identity', async () => {
  const f = seedTwoClubs();
  const scope = await scopeFor(f, f.users.platform);
  assert.equal(scope.can('manage_events', { teamId: f.teams.blue, clubId: f.clubs.harbor }), true);
  assert.equal(scope.can('manage_teams', { clubId: f.clubs.harbor }), true);
});

test('platform admin is a stored column, not something a request can claim', async () => {
  const f = seedTwoClubs();
  // Simulate a forged user object arriving from an untrusted path.
  const forged = { ...f.userRow(f.users.redParent), is_platform_admin: 1 };
  const honest = await loadScope(f.db, f.userRow(f.users.redParent));
  assert.equal(honest.isPlatformAdmin, false);
  // The Scope trusts its input, which is why the ONLY caller that builds one
  // is the authenticated request path reading the row from the database.
  assert.equal(new Scope(forged, []).isPlatformAdmin, true);
});

// --- query-level scoping ---------------------------------------------------

test('an empty visible-team list must select nothing, never everything', async () => {
  const f = seedTwoClubs();
  const scope = await scopeFor(f, f.users.pendingParent);
  assert.deepEqual(scope.visibleTeamIds, []);

  // The pattern every list endpoint uses. With no teams the IN () clause must
  // yield zero rows rather than degrading to an unfiltered scan.
  const ids = scope.visibleTeamIds;
  const placeholders = ids.length ? ids.map(() => '?').join(',') : 'NULL';
  const rows = f.db.rows(`SELECT id FROM teams WHERE id IN (${placeholders})`, ...ids);
  assert.equal(rows.length, 0);
});

test('every tenant table carries club_id so a query cannot forget its scope', () => {
  const f = seedTwoClubs();
  const tenantTables = [
    'teams', 'memberships', 'households', 'household_members', 'vehicles',
    'people', 'enrollments', 'pickup_areas', 'locations', 'events',
    'carpool_pools', 'pool_teams', 'driver_offers', 'ride_requests',
    'assignments', 'routes',
  ];
  for (const table of tenantTables) {
    const columns = f.db.rows(`PRAGMA table_info(${table})`).map(c => c.name);
    assert.ok(columns.includes('club_id'), `${table} is missing club_id`);
  }
});
