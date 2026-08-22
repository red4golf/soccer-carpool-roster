// Coordinator actions: invitations, club/team management, roster.

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScope } from '../src/lib/scope.js';
import { claimInvitations } from '../src/lib/auth.js';
import { adminRequest } from '../src/routes/admin.js';
import { getMe } from '../src/routes/me.js';
import { seedTwoClubs } from './helpers.js';

async function ctx(f, userId, body = {}, method = 'POST', query = '') {
  const user = f.userRow(userId);
  return {
    db: f.db,
    env: {},
    user,
    scope: await loadScope(f.db, user),
    body,
    ip: '127.0.0.1',
    request: { method },
    url: new URL(`https://example.test/api/admin${query}`),
  };
}
const admin = (f, userId, body) => ctx(f, userId, body).then(adminRequest);

// --- invitations -----------------------------------------------------------

test('inviting an unknown email stores an invitation, not a membership', async () => {
  const f = seedTwoClubs();
  const result = await admin(f, f.users.riversideAdmin, {
    action: 'invite_members', teamId: f.teams.red, role: 'parent',
    emails: 'newparent@example.com',
  });
  assert.deepEqual(result.invited, ['newparent@example.com']);
  assert.equal(f.db.rows(`SELECT COUNT(*) n FROM invitations`)[0].n, 1);
  // No user exists yet, so there is nothing to attach a membership to.
  assert.equal(f.db.rows(`SELECT COUNT(*) n FROM users WHERE email='newparent@example.com'`)[0].n, 0);
});

test('signing in claims the invitation and grants access', async () => {
  const f = seedTwoClubs();
  await admin(f, f.users.riversideAdmin, {
    action: 'invite_members', teamId: f.teams.red, role: 'parent',
    emails: 'newparent@example.com',
  });

  // The parent signs in for the first time; resolveUser would have created
  // this row, then the request path claims anything addressed to them.
  const userId = f.db.insert(
    `INSERT INTO users (firebase_uid, email, email_verified, display_name)
     VALUES ('uid-new','newparent@example.com',1,'New Parent')`,
  );
  const claimed = await claimInvitations(f.db, f.userRow(userId));
  assert.equal(claimed, 1);

  const scope = await loadScope(f.db, f.userRow(userId));
  assert.deepEqual(scope.visibleTeamIds, [f.teams.red]);
  assert.equal(scope.roleOnTeam(f.teams.red, f.clubs.riverside), 'parent');
  // Invited by an admin means already approved — no second queue.
  assert.equal(f.db.rows(`SELECT status FROM memberships WHERE user_id=?`, userId)[0].status, 'active');
  // And the invitation is spent, so it cannot be replayed.
  assert.ok(f.db.rows(`SELECT claimed_at FROM invitations`)[0].claimed_at);
});

test('signing in with no invitation grants nothing at all', async () => {
  const f = seedTwoClubs();
  const userId = f.db.insert(
    `INSERT INTO users (firebase_uid, email, email_verified, display_name)
     VALUES ('uid-stranger','stranger@example.com',1,'Stranger')`,
  );
  assert.equal(await claimInvitations(f.db, f.userRow(userId)), 0);

  const scope = await loadScope(f.db, f.userRow(userId));
  assert.deepEqual(scope.visibleTeamIds, []);
  assert.equal(scope.isPending, true);

  const me = await getMe({ db: f.db, user: f.userRow(userId), scope });
  assert.deepEqual(me.teams, []);
});

test('inviting someone who already has a login grants access immediately', async () => {
  const f = seedTwoClubs();
  const result = await admin(f, f.users.riversideAdmin, {
    action: 'invite_members', teamId: f.teams.gold, role: 'parent',
    emails: 'red.parent@example.com', // already a Red-team parent
  });
  assert.deepEqual(result.invited, ['red.parent@example.com']);

  const scope = await loadScope(f.db, f.userRow(f.users.redParent));
  assert.deepEqual(scope.visibleTeamIds.sort(), [f.teams.red, f.teams.gold].sort());
});

test('malformed addresses are reported back, not silently dropped', async () => {
  const f = seedTwoClubs();
  const result = await admin(f, f.users.riversideAdmin, {
    action: 'invite_members', teamId: f.teams.red, role: 'parent',
    emails: 'good@example.com, not-an-email, also bad@, second@example.com',
  });
  assert.deepEqual(result.invited.sort(), ['good@example.com', 'second@example.com']);
  assert.ok(result.rejected.includes('not-an-email'));
  assert.ok(result.rejected.includes('bad@'));
});

test('re-inviting the same address replaces rather than stacking', async () => {
  const f = seedTwoClubs();
  const body = { action: 'invite_members', teamId: f.teams.red, emails: 'dup@example.com' };
  await admin(f, f.users.riversideAdmin, { ...body, role: 'parent' });
  await admin(f, f.users.riversideAdmin, { ...body, role: 'coach' });
  const rows = f.db.rows(`SELECT role FROM invitations WHERE email='dup@example.com'`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].role, 'coach');
});

test('a coach cannot invite anyone', async () => {
  const f = seedTwoClubs();
  await assert.rejects(
    admin(f, f.users.coach, {
      action: 'invite_members', teamId: f.teams.red, emails: 'x@example.com',
    }),
    e => e.status === 404,
  );
});

test('an admin cannot invite into a team outside their club', async () => {
  const f = seedTwoClubs();
  await assert.rejects(
    admin(f, f.users.riversideAdmin, {
      action: 'invite_members', teamId: f.teams.blue, emails: 'x@example.com',
    }),
    e => e.status === 404,
  );
  assert.equal(f.db.rows(`SELECT COUNT(*) n FROM invitations`)[0].n, 0);
});

test('an invitation cannot smuggle in a club_admin role', async () => {
  const f = seedTwoClubs();
  await assert.rejects(
    admin(f, f.users.riversideAdmin, {
      action: 'invite_members', teamId: f.teams.red, role: 'club_admin',
      emails: 'x@example.com',
    }),
    e => e.status === 400,
  );
});

// --- clubs -----------------------------------------------------------------

test('only the platform operator can create a club', async () => {
  const f = seedTwoClubs();
  await assert.rejects(
    admin(f, f.users.riversideAdmin, { action: 'create_club', name: 'Sneaky FC' }),
    e => e.status === 404,
  );
  await assert.rejects(
    admin(f, f.users.redParent, { action: 'create_club', name: 'Sneaky FC' }),
    e => e.status === 404,
  );
  assert.equal(f.db.rows(`SELECT COUNT(*) n FROM clubs`)[0].n, 2);
});

test('creating a club makes the creator its administrator', async () => {
  const f = seedTwoClubs();
  const result = await admin(f, f.users.platform, {
    action: 'create_club', name: 'Second Club FC',
  });
  assert.equal(result.ok, true);
  assert.equal(result.slug, 'second-club-fc');

  const membership = f.db.rows(
    `SELECT role, status, team_id FROM memberships WHERE club_id = ? AND user_id = ?`,
    result.clubId, f.users.platform,
  )[0];
  assert.equal(membership.role, 'club_admin');
  assert.equal(membership.status, 'active');
  assert.equal(membership.team_id, null, 'a club-wide role names no team');
});

test('a duplicate club name is refused rather than silently shadowing', async () => {
  const f = seedTwoClubs();
  await admin(f, f.users.platform, { action: 'create_club', name: 'Third Club' });
  await assert.rejects(
    admin(f, f.users.platform, { action: 'create_club', name: 'Third Club' }),
    e => e.status === 409,
  );
});

test('turning cross-team pooling off is logged as its own event', async () => {
  const f = seedTwoClubs();
  await admin(f, f.users.riversideAdmin, {
    action: 'update_club', clubId: f.clubs.riverside,
    name: 'Riverside FC', allowCrossTeamPools: false,
  });
  const logs = f.db.rows(`SELECT action FROM audit_log WHERE action LIKE 'pooling%'`);
  assert.deepEqual(logs.map(l => l.action), ['pooling_disabled']);
});

// --- roster ----------------------------------------------------------------

test('adding a player creates and enrols them in one step', async () => {
  const f = seedTwoClubs();
  const result = await admin(f, f.users.riversideAdmin, {
    action: 'create_person', teamId: f.teams.red, name: 'Avery Lee',
  });
  assert.equal(result.ok, true);
  assert.equal(result.reusedExisting, false);
  assert.equal(f.db.rows(`SELECT COUNT(*) n FROM enrollments WHERE team_id=?`, f.teams.red)[0].n, 1);
});

test('the same child on a second team reuses one person record', async () => {
  // This is the sibling / multi-team case: one child, one household, one
  // address — two enrolments. Creating a second person would fork their
  // address and break pooling.
  const f = seedTwoClubs();
  await admin(f, f.users.riversideAdmin, {
    action: 'create_person', teamId: f.teams.red, name: 'Devon Okonkwo',
  });
  const second = await admin(f, f.users.riversideAdmin, {
    action: 'create_person', teamId: f.teams.gold, name: 'devon okonkwo', // different case
  });
  assert.equal(second.reusedExisting, true);
  assert.equal(f.db.rows(`SELECT COUNT(*) n FROM people`)[0].n, 1);
  assert.equal(f.db.rows(`SELECT COUNT(*) n FROM enrollments`)[0].n, 2);
});

test('unenrolling removes the roster spot but keeps the child', async () => {
  const f = seedTwoClubs();
  const created = await admin(f, f.users.riversideAdmin, {
    action: 'create_person', teamId: f.teams.red, name: 'Casey Delgado',
  });
  await admin(f, f.users.riversideAdmin, {
    action: 'unenroll_child', teamId: f.teams.red, personId: created.personId,
  });
  assert.equal(f.db.rows(`SELECT COUNT(*) n FROM enrollments`)[0].n, 0);
  assert.equal(f.db.rows(`SELECT COUNT(*) n FROM people`)[0].n, 1, 'the child record survives');
});

// --- platform operator -----------------------------------------------------

test('the platform operator resolves to every team without a membership row', async () => {
  const f = seedTwoClubs();
  const scope = await loadScope(f.db, f.userRow(f.users.platform));
  assert.equal(f.db.rows(`SELECT COUNT(*) n FROM memberships WHERE user_id=?`, f.users.platform)[0].n, 0);
  assert.deepEqual(
    scope.visibleTeamIds.sort(),
    [f.teams.red, f.teams.gold, f.teams.blue, f.teams.green].sort(),
  );

  // And is not stranded on the approval screen, which is what an empty team
  // list would have produced.
  const me = await getMe({ db: f.db, user: f.userRow(f.users.platform), scope });
  assert.equal(me.teams.length, 4);
  assert.ok(me.teams.every(t => t.role === 'club_admin'));
});

test('the admin overview works for a club with no teams yet', async () => {
  const f = seedTwoClubs();
  const created = await admin(f, f.users.platform, { action: 'create_club', name: 'Fresh Club' });
  const context = await ctx(f, f.users.platform, {}, 'GET', `?clubId=${created.clubId}`);
  const overview = await adminRequest(context);
  assert.deepEqual(overview.teams, []);
  assert.ok(overview.clubs.some(c => c.id === created.clubId));
  assert.equal(overview.canManageClub, true);
});

test('an admin GET without a teamId does not resolve to team zero', async () => {
  // Regression: Number(null) is 0 and Number.isInteger(0) is true, so a
  // missing query parameter was treated as team 0 and 404'd every overview
  // request that did not happen to name a team.
  const f = seedTwoClubs();
  const overview = await adminRequest(await ctx(f, f.users.riversideAdmin, {}, 'GET', ''));
  assert.equal(overview.teams.length, 2, 'falls back to every team in scope');
  assert.ok(Array.isArray(overview.invitations));
});

test('the overview narrows to the club that was asked about', async () => {
  // Regression: an admin of two clubs (or the platform operator, who is in
  // every club) received every team they could see regardless of the clubId
  // in the request, blending two organisations onto one screen.
  const f = seedTwoClubs();
  const riverside = await adminRequest(
    await ctx(f, f.users.platform, {}, 'GET', `?clubId=${f.clubs.riverside}`),
  );
  assert.deepEqual(riverside.teams.map(t => t.name).sort(), ['Gold', 'Red']);

  const harbor = await adminRequest(
    await ctx(f, f.users.platform, {}, 'GET', `?clubId=${f.clubs.harbor}`),
  );
  assert.deepEqual(harbor.teams.map(t => t.name).sort(), ['Blue', 'Green']);
});

// --- role masking is cosmetic; the API is the real gate --------------------

test('a parent is refused every coordinator action, not merely shown no button', async () => {
  // Hiding the Coordinate button stops an honest parent wandering in. It does
  // nothing about someone who opens devtools, so every action is checked
  // server-side too. This walks the whole action table as a parent.
  const f = seedTwoClubs();
  const actions = [
    { action: 'invite_members', teamId: f.teams.red, emails: 'x@example.com' },
    { action: 'revoke_invite', inviteId: 1 },
    { action: 'upsert_event', teamId: f.teams.red, title: 'Sneaky', eventDate: '2026-09-12', startTime: '09:00' },
    { action: 'upsert_location', clubId: f.clubs.riverside, name: 'Sneaky Park' },
    { action: 'upsert_pickup_area', clubId: f.clubs.riverside, name: 'Sneaky' },
    { action: 'create_person', teamId: f.teams.red, name: 'Ghost Player' },
    { action: 'unenroll_child', teamId: f.teams.red, personId: 1 },
    { action: 'enroll_child', teamId: f.teams.red, personId: 1 },
    { action: 'create_team', clubId: f.clubs.riverside, name: 'Sneaky Team' },
    { action: 'update_team', teamId: f.teams.red, name: 'Renamed' },
    { action: 'create_club', name: 'Sneaky FC' },
    { action: 'update_club', clubId: f.clubs.riverside, name: 'Renamed FC' },
    { action: 'approve_member', membershipId: 1, status: 'active' },
    { action: 'set_member_role', membershipId: 1, role: 'team_admin' },
    { action: 'delete_record', kind: 'event', id: 1 },
    { action: 'reveal_address', householdId: 1, reason: 'curiosity' },
    { action: 'create_pool', clubId: f.clubs.riverside, locationId: 1, poolDate: '2026-09-12' },
    { action: 'join_pool', teamId: f.teams.red, poolId: 1 },
    { action: 'leave_pool', teamId: f.teams.red, poolId: 1 },
    { action: 'export_backup', clubId: f.clubs.riverside },
  ];

  for (const payload of actions) {
    await assert.rejects(
      admin(f, f.users.redParent, payload),
      error => error.status === 404 || error.status === 403,
      `parent was not refused: ${payload.action}`,
    );
  }

  // And nothing leaked through as a side effect.
  assert.equal(f.db.rows(`SELECT COUNT(*) n FROM invitations`)[0].n, 0);
  assert.equal(f.db.rows(`SELECT COUNT(*) n FROM events`)[0].n, 0);
  assert.equal(f.db.rows(`SELECT COUNT(*) n FROM clubs`)[0].n, 2);
  assert.equal(f.db.rows(`SELECT name FROM teams WHERE id = ?`, f.teams.red)[0].name, 'Red');
});

test('a coach is refused coordinator actions but may still read the roster', async () => {
  const f = seedTwoClubs();
  await assert.rejects(
    admin(f, f.users.coach, { action: 'upsert_event', teamId: f.teams.red, title: 'x',
      eventDate: '2026-09-12', startTime: '09:00' }),
    e => e.status === 404,
  );
  const scope = await loadScope(f.db, f.userRow(f.users.coach));
  assert.equal(scope.can('view_roster', { teamId: f.teams.red, clubId: f.clubs.riverside }), true);
  assert.equal(scope.can('manage_events', { teamId: f.teams.red, clubId: f.clubs.riverside }), false);
});

test('a team coordinator cannot reach club-level settings', async () => {
  const f = seedTwoClubs();
  const teamAdmin = f.db.insert(
    `INSERT INTO users (firebase_uid, email, email_verified, display_name)
     VALUES ('uid-ta','ta@example.com',1,'Team Coordinator')`,
  );
  f.db.insert(
    `INSERT INTO memberships (club_id, team_id, user_id, role, status) VALUES (?,?,?,'team_admin','active')`,
    f.clubs.riverside, f.teams.red, teamAdmin,
  );

  // Can run their own team...
  const ok = await admin(f, teamAdmin, {
    action: 'upsert_event', teamId: f.teams.red, title: 'Practice',
    eventDate: '2026-09-15', startTime: '17:15',
  });
  assert.equal(ok.ok, true);

  // ...but not the club, and not a sibling team.
  for (const payload of [
    { action: 'create_team', clubId: f.clubs.riverside, name: 'New Team' },
    { action: 'update_club', clubId: f.clubs.riverside, name: 'Renamed' },
    { action: 'export_backup', clubId: f.clubs.riverside },
    { action: 'reveal_address', householdId: 1, reason: 'because' },
    { action: 'upsert_event', teamId: f.teams.gold, title: 'x', eventDate: '2026-09-12', startTime: '09:00' },
  ]) {
    await assert.rejects(admin(f, teamAdmin, payload), e => e.status === 404,
      `team coordinator was not refused: ${payload.action}`);
  }

  // The overview reflects that, so the UI can hide what it cannot use.
  const overview = await adminRequest(await ctx(f, teamAdmin, {}, 'GET', ''));
  assert.equal(overview.canManageClub, false);
  assert.equal(overview.isPlatformAdmin, false);
});
