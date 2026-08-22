// Linking a rostered player to the family who owns them.
//
// Regression suite for a blocking bug: a coordinator building the roster and
// a parent naming their own children produced two disconnected `people` rows.
// The roster copy was enrolled but belonged to nobody; the parent's copy
// belonged to them but was on no roster — so "request a ride" refused for a
// child the parent could see on the board. In the most natural setup order,
// no parent could request a ride at all.

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScope } from '../src/lib/scope.js';
import { adminRequest } from '../src/routes/admin.js';
import { getMe, updateProfile } from '../src/routes/me.js';
import { rideAction } from '../src/routes/rides.js';
import { seedTwoClubs } from './helpers.js';

const NO_GEOCODE = { GEOCODER: 'off' };

async function addPlayer(f, teamId, name) {
  const user = f.userRow(f.users.riversideAdmin);
  return adminRequest({
    db: f.db, env: {}, user, scope: await loadScope(f.db, user),
    body: { action: 'create_person', teamId, name },
    ip: '', request: { method: 'POST' }, url: new URL('https://x.test/api/admin'),
  });
}

async function saveProfile(f, userId, body) {
  const user = f.userRow(userId);
  return updateProfile({
    db: f.db, env: NO_GEOCODE, user, scope: await loadScope(f.db, user),
    body: { clubId: f.clubs.riverside, displayName: 'A Parent', phone: '2065550111', ...body },
    ip: '',
  });
}

test('a parent can claim their child off the roster', async () => {
  const f = seedTwoClubs();
  await addPlayer(f, f.teams.red, 'Avery Lee');

  const user = f.userRow(f.users.redParent);
  const before = await getMe({ db: f.db, user, scope: await loadScope(f.db, user) });
  assert.deepEqual(before.claimablePlayers.map(p => p.name), ['Avery Lee']);

  const saved = await saveProfile(f, f.users.redParent, {
    claimPlayerIds: [before.claimablePlayers[0].id],
  });

  assert.deepEqual(saved.claimed, ['Avery Lee']);
  assert.equal(f.db.rows(`SELECT COUNT(*) n FROM people`)[0].n, 1, 'no duplicate child created');
  assert.deepEqual(saved.claimablePlayers, [], 'no longer offered once taken');
  assert.deepEqual(saved.households[0].children.map(c => c.name), ['Avery Lee']);
});

test('typing a name that matches the roster links instead of duplicating', async () => {
  const f = seedTwoClubs();
  await addPlayer(f, f.teams.red, 'Avery Lee');

  const saved = await saveProfile(f, f.users.redParent, { newChildren: ['avery lee'] });
  assert.deepEqual(saved.claimed, ['Avery Lee'], 'matched despite the different case');
  assert.equal(f.db.rows(`SELECT COUNT(*) n FROM people`)[0].n, 1);
});

test('a child nobody rostered is still created normally', async () => {
  const f = seedTwoClubs();
  const saved = await saveProfile(f, f.users.redParent, { newChildren: ['Brand New Child'] });
  assert.deepEqual(saved.claimed, []);
  assert.deepEqual(saved.households[0].children.map(c => c.name), ['Brand New Child']);
});

test('a claimed child cannot be taken by another family', async () => {
  const f = seedTwoClubs();
  await addPlayer(f, f.teams.red, 'Avery Lee');
  const personId = f.db.rows(`SELECT id FROM people`)[0].id;

  await saveProfile(f, f.users.redParent, { claimPlayerIds: [personId] });

  const other = f.db.insert(
    `INSERT INTO users (firebase_uid, email, email_verified, display_name)
     VALUES ('uid-other','other@example.com',1,'Other Parent')`,
  );
  f.db.insert(
    `INSERT INTO memberships (club_id, team_id, user_id, role, status) VALUES (?,?,?,'parent','active')`,
    f.clubs.riverside, f.teams.red, other,
  );

  const saved = await saveProfile(f, other, { claimPlayerIds: [personId] });
  assert.deepEqual(saved.claimed, [], 'already claimed, so not reassigned');

  const owner = f.db.rows(`SELECT household_id FROM people WHERE id = ?`, personId)[0];
  const firstHousehold = f.db.rows(
    `SELECT household_id FROM household_members WHERE user_id = ?`, f.users.redParent,
  )[0];
  assert.equal(owner.household_id, firstHousehold.household_id, 'still the first family');
});

test('a parent is not offered players from a team they are not on', async () => {
  const f = seedTwoClubs();
  await addPlayer(f, f.teams.gold, 'Gold Kid');
  const goldKid = f.db.rows(`SELECT id FROM people WHERE name = 'Gold Kid'`)[0].id;

  const user = f.userRow(f.users.redParent);
  const me = await getMe({ db: f.db, user, scope: await loadScope(f.db, user) });
  assert.deepEqual(me.claimablePlayers, [], 'players from another team are not listed');

  // And asking for one directly is refused rather than merely hidden.
  const saved = await saveProfile(f, f.users.redParent, { claimPlayerIds: [goldKid] });
  assert.deepEqual(saved.claimed, []);
  assert.equal(
    f.db.rows(`SELECT household_id FROM people WHERE id = ?`, goldKid)[0].household_id,
    null,
  );
});

test('claiming is recorded in the audit log', async () => {
  const f = seedTwoClubs();
  await addPlayer(f, f.teams.red, 'Avery Lee');
  const personId = f.db.rows(`SELECT id FROM people`)[0].id;
  await saveProfile(f, f.users.redParent, { claimPlayerIds: [personId] });

  const logs = f.db.rows(`SELECT actor_email, subject_id FROM audit_log WHERE action = 'player_claimed'`);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].actor_email, 'red.parent@example.com');
  assert.equal(logs[0].subject_id, personId);
});

test('after claiming, the parent can actually request the ride', async () => {
  // The end-to-end shape of the original bug.
  const f = seedTwoClubs();
  await addPlayer(f, f.teams.red, 'Avery Lee');

  const saved = await saveProfile(f, f.users.redParent, {
    homeAddress: '1 Main St, Bainbridge Island, WA',
    homeLat: 47.62, homeLng: -122.51,
    claimPlayerIds: [f.db.rows(`SELECT id FROM people`)[0].id],
  });

  const eventId = f.db.insert(
    `INSERT INTO events (club_id, team_id, event_type, title, event_date, start_time)
     VALUES (?,?, 'game','Game','2026-09-12','09:00')`,
    f.clubs.riverside, f.teams.red,
  );

  const user = f.userRow(f.users.redParent);
  const result = await rideAction({
    db: f.db, env: {}, user, scope: await loadScope(f.db, user),
    body: {
      action: 'request_ride', eventId,
      personIds: [saved.households[0].children[0].id],
      direction: 'roundtrip', pickupKind: 'home',
    },
    ip: '',
  });
  assert.equal(result.created.length, 1, 'the ride request finally goes through');
});

test('a parent can save cars, which is what unlocks offering seats', async () => {
  // Second blocking gap: the profile form had no vehicle input at all, so
  // "Offer seats" sent people to a screen that could not do what it asked.
  const f = seedTwoClubs();
  const saved = await saveProfile(f, f.users.redParent, {
    vehicles: [
      { name: 'Blue Subaru Outback', seatCapacity: 3, notes: 'Room for gear' },
      { name: 'Grey Odyssey', seatCapacity: 5, notes: '' },
    ],
  });

  assert.deepEqual(
    saved.households[0].vehicles.map(v => `${v.name}:${v.seat_capacity}`),
    ['Blue Subaru Outback:3', 'Grey Odyssey:5'],
  );

  // And that is enough for the offer_drive path to accept the vehicle.
  const eventId = f.db.insert(
    `INSERT INTO events (club_id, team_id, event_type, title, event_date, start_time)
     VALUES (?,?, 'game','Game','2026-09-12','09:00')`,
    f.clubs.riverside, f.teams.red,
  );
  const user = f.userRow(f.users.redParent);
  const offer = await rideAction({
    db: f.db, env: {}, user, scope: await loadScope(f.db, user),
    body: {
      action: 'offer_drive', eventId,
      vehicleId: saved.households[0].vehicles[0].id,
      capacity: 3, direction: 'roundtrip',
    },
    ip: '',
  });
  assert.equal(offer.ok, true);
  assert.equal(
    f.db.rows(`SELECT vehicle_name FROM driver_offers WHERE id = ?`, offer.offerId)[0].vehicle_name,
    'Blue Subaru Outback',
  );
});
