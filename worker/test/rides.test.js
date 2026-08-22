// Integration tests: real handlers, real SQL, real constraints.
//
// These run the route modules directly against an in-memory SQLite database
// rather than through the HTTP layer, so they exercise the actual queries —
// including the conditional INSERT that guards the last seat in a car.

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScope } from '../src/lib/scope.js';
import { rideAction } from '../src/routes/rides.js';
import { getBoard } from '../src/routes/board.js';
import { planRoutes, openRoute } from '../src/routes/plan.js';
import { seedTwoClubs } from './helpers.js';

/** Build a full ride scenario on the Red team plus a Gold-team counterpart. */
function seedRides() {
  const f = seedTwoClubs();
  const { db, clubs, teams, users } = f;

  const area = db.insert(`INSERT INTO pickup_areas (club_id, name) VALUES (?, 'Winslow')`, clubs.riverside);
  const venue = db.insert(
    `INSERT INTO locations (club_id, name, lat, lng) VALUES (?, 'Battle Point Park', 47.6631, -122.5615)`,
    clubs.riverside,
  );

  const household = (userId, name, lat, lng) => {
    const id = db.insert(
      `INSERT INTO households (club_id, name, pickup_area_id, home_address, home_lat, home_lng)
       VALUES (?,?,?,?,?,?)`,
      clubs.riverside, name, area, `${name} address`, lat, lng,
    );
    db.insert(
      `INSERT INTO household_members (club_id, household_id, user_id, name) VALUES (?,?,?,?)`,
      clubs.riverside, id, userId, name,
    );
    return id;
  };

  const redHome = household(users.redParent, 'Red family', 47.6231, -122.5182);
  const goldHome = household(users.goldParent, 'Gold family', 47.6450, -122.5480);

  // A second Red-team family, used wherever a test needs a driver who is not
  // the requesting parent. (An earlier draft used the Gold parent here and the
  // scope check correctly rejected it — a driver must be on the team.)
  const redDriverUser = db.insert(
    `INSERT INTO users (firebase_uid, email, email_verified, display_name)
     VALUES ('uid-red-driver','red.driver@example.com',1,'Red Driver')`,
  );
  db.insert(
    `INSERT INTO memberships (club_id, team_id, user_id, role, status) VALUES (?,?,?, 'parent','active')`,
    clubs.riverside, teams.red, redDriverUser,
  );
  const redDriverHome = household(redDriverUser, 'Red driver family', 47.6300, -122.5300);

  const child = (householdId, name, teamId) => {
    const personId = db.insert(
      `INSERT INTO people (club_id, household_id, name) VALUES (?,?,?)`,
      clubs.riverside, householdId, name,
    );
    db.insert(
      `INSERT INTO enrollments (club_id, team_id, person_id) VALUES (?,?,?)`,
      clubs.riverside, teamId, personId,
    );
    return personId;
  };

  const redChild = child(redHome, 'Alex Red', teams.red);
  const goldChild = child(goldHome, 'Sam Gold', teams.gold);

  const event = (teamId, title) =>
    db.insert(
      `INSERT INTO events (club_id, team_id, location_id, event_type, title, event_date, start_time)
       VALUES (?,?,?,'game',?, '2026-09-12','09:00')`,
      clubs.riverside, teamId, venue, title,
    );

  return {
    ...f,
    area, venue, redHome, goldHome, redChild, goldChild,
    redDriverUser, redDriverHome,
    redEvent: event(teams.red, 'Red game'),
    goldEvent: event(teams.gold, 'Gold game'),
  };
}

async function ctx(f, userId, body = {}) {
  const user = f.userRow(userId);
  return {
    db: f.db,
    env: {},
    user,
    scope: await loadScope(f.db, user),
    body,
    ip: '127.0.0.1',
    url: new URL('https://example.test/api/rides'),
  };
}

const call = (f, userId, body) => ctx(f, userId, body).then(rideAction);

// --- requesting ------------------------------------------------------------

test('a parent can request a ride for their own child', async () => {
  const f = seedRides();
  const result = await call(f, f.users.redParent, {
    action: 'request_ride',
    eventId: f.redEvent,
    personIds: [f.redChild],
    direction: 'roundtrip',
    pickupKind: 'home',
  });
  assert.equal(result.ok, true);
  assert.equal(result.created.length, 1);
});

test('a parent cannot request a ride for another family\'s child', async () => {
  const f = seedRides();
  await assert.rejects(
    call(f, f.users.redParent, {
      action: 'request_ride',
      eventId: f.redEvent,
      personIds: [f.goldChild], // not in this household, not on this team
      direction: 'to',
      pickupKind: 'home',
    }),
    e => e.status === 400 && /not on this team/i.test(e.message),
  );
});

test('a parent from another team cannot touch this event at all', async () => {
  const f = seedRides();
  await assert.rejects(
    call(f, f.users.goldParent, {
      action: 'request_ride',
      eventId: f.redEvent,
      personIds: [f.goldChild],
      direction: 'to',
      pickupKind: 'home',
    }),
    e => e.status === 404,
  );
});

test('a duplicate request for the same child and leg is a no-op', async () => {
  const f = seedRides();
  const body = {
    action: 'request_ride', eventId: f.redEvent, personIds: [f.redChild],
    direction: 'to', pickupKind: 'home',
  };
  await call(f, f.users.redParent, body);
  const second = await call(f, f.users.redParent, body);
  assert.equal(second.created.length, 0);
  assert.equal(f.db.rows(`SELECT COUNT(*) n FROM ride_requests`)[0].n, 1);
});

// --- seats -----------------------------------------------------------------

test('the last seat cannot be sold twice', async () => {
  const f = seedRides();
  // Three more children in the Red team, all requesting.
  const extras = [];
  for (let i = 0; i < 3; i++) {
    const hh = f.db.insert(
      `INSERT INTO households (club_id, name, home_address, home_lat, home_lng) VALUES (?,?,?,?,?)`,
      f.clubs.riverside, `Family ${i}`, `addr ${i}`, 47.62 + i * 0.01, -122.52,
    );
    const person = f.db.insert(
      `INSERT INTO people (club_id, household_id, name) VALUES (?,?,?)`,
      f.clubs.riverside, hh, `Kid ${i}`,
    );
    f.db.insert(
      `INSERT INTO enrollments (club_id, team_id, person_id) VALUES (?,?,?)`,
      f.clubs.riverside, f.teams.red, person,
    );
    extras.push(
      f.db.insert(
        `INSERT INTO ride_requests (club_id, team_id, event_id, person_id, household_id, requested_by, direction, pickup_kind)
         VALUES (?,?,?,?,?,?, 'to','home')`,
        f.clubs.riverside, f.teams.red, f.redEvent, person, hh, f.users.redParent,
      ),
    );
  }

  const offer = await call(f, f.users.redParent, {
    action: 'offer_drive', eventId: f.redEvent, capacity: 2,
    direction: 'to', driverName: 'Red Parent', driverPhone: '2065550142', vehicleName: 'Van',
  });

  const results = await Promise.allSettled(
    extras.map(requestId =>
      call(f, f.users.redParent, { action: 'claim', requestId, offerId: offer.offerId }),
    ),
  );
  const accepted = results.filter(r => r.status === 'fulfilled').length;
  assert.equal(accepted, 2, 'exactly the two available seats were filled');

  const seated = f.db.rows(`SELECT COUNT(*) n FROM assignments WHERE offer_id = ?`, offer.offerId)[0].n;
  assert.equal(seated, 2, 'the database never exceeded capacity');
});

test('one child is never in two cars for the same leg', async () => {
  const f = seedRides();
  const request = await call(f, f.users.redParent, {
    action: 'request_ride', eventId: f.redEvent, personIds: [f.redChild],
    direction: 'to', pickupKind: 'home',
  });
  const requestId = request.created[0];

  const first = await call(f, f.users.redParent, {
    action: 'offer_drive', eventId: f.redEvent, capacity: 3, direction: 'to',
    driverName: 'A', driverPhone: '2065550001', vehicleName: 'Car A',
  });
  // A second offer from the same household, to keep the ownership check happy.
  const second = await call(f, f.users.redParent, {
    action: 'offer_drive', eventId: f.redEvent, capacity: 3, direction: 'to',
    driverName: 'B', driverPhone: '2065550002', vehicleName: 'Car B',
  });

  await call(f, f.users.redParent, { action: 'claim', requestId, offerId: first.offerId });
  await assert.rejects(
    call(f, f.users.redParent, { action: 'claim', requestId, offerId: second.offerId }),
    e => e.status === 409,
  );
  assert.equal(f.db.rows(`SELECT COUNT(*) n FROM assignments WHERE request_id = ?`, requestId)[0].n, 1);
});

test('only the driver may add riders to their car', async () => {
  const f = seedRides();
  // Give the coach a household so they are a plausible actor.
  const coachHome = f.db.insert(
    `INSERT INTO households (club_id, name, home_address) VALUES (?, 'Coach', 'x')`,
    f.clubs.riverside,
  );
  f.db.insert(
    `INSERT INTO household_members (club_id, household_id, user_id, name) VALUES (?,?,?, 'Coach')`,
    f.clubs.riverside, coachHome, f.users.coach,
  );

  const request = await call(f, f.users.redParent, {
    action: 'request_ride', eventId: f.redEvent, personIds: [f.redChild],
    direction: 'to', pickupKind: 'home',
  });
  const offer = await call(f, f.users.redParent, {
    action: 'offer_drive', eventId: f.redEvent, capacity: 3, direction: 'to',
    driverName: 'Red', driverPhone: '2065550003', vehicleName: 'Van',
  });

  await assert.rejects(
    call(f, f.users.coach, { action: 'claim', requestId: request.created[0], offerId: offer.offerId }),
    e => e.status === 403,
  );
});

test('a driver with riders cannot silently vanish', async () => {
  const f = seedRides();
  const request = await call(f, f.users.redParent, {
    action: 'request_ride', eventId: f.redEvent, personIds: [f.redChild],
    direction: 'to', pickupKind: 'home',
  });
  const offer = await call(f, f.users.redParent, {
    action: 'offer_drive', eventId: f.redEvent, capacity: 3, direction: 'to',
    driverName: 'Red', driverPhone: '2065550004', vehicleName: 'Van',
  });
  await call(f, f.users.redParent, { action: 'claim', requestId: request.created[0], offerId: offer.offerId });

  await assert.rejects(
    call(f, f.users.redParent, { action: 'cancel_offer', offerId: offer.offerId }),
    e => e.status === 409 && /remove your riders/i.test(e.message),
  );
});

// --- cross-team ------------------------------------------------------------

test('a driver cannot pick up another team\'s child without a pool', async () => {
  const f = seedRides();
  const goldRequest = f.db.insert(
    `INSERT INTO ride_requests (club_id, team_id, event_id, person_id, household_id, requested_by, direction, pickup_kind)
     VALUES (?,?,?,?,?,?, 'to','home')`,
    f.clubs.riverside, f.teams.gold, f.goldEvent, f.goldChild, f.goldHome, f.users.goldParent,
  );
  const offer = await call(f, f.users.redParent, {
    action: 'offer_drive', eventId: f.redEvent, capacity: 3, direction: 'to',
    driverName: 'Red', driverPhone: '2065550005', vehicleName: 'Van',
  });

  await assert.rejects(
    call(f, f.users.redParent, { action: 'claim', requestId: goldRequest, offerId: offer.offerId }),
    e => e.status === 404,
  );
});

test('with both teams pooled, a cross-team pickup is allowed', async () => {
  const f = seedRides();
  const poolId = f.db.insert(
    `INSERT INTO carpool_pools (club_id, location_id, pool_date, created_by) VALUES (?,?, '2026-09-12', ?)`,
    f.clubs.riverside, f.venue, f.users.riversideAdmin,
  );
  for (const teamId of [f.teams.red, f.teams.gold]) {
    f.db.insert(
      `INSERT INTO pool_teams (pool_id, team_id, club_id, opted_in_by) VALUES (?,?,?,?)`,
      poolId, teamId, f.clubs.riverside, f.users.riversideAdmin,
    );
  }
  f.db.exec(`UPDATE events SET pool_id = ${poolId} WHERE id IN (${f.redEvent}, ${f.goldEvent})`);

  const goldRequest = f.db.insert(
    `INSERT INTO ride_requests (club_id, team_id, event_id, person_id, household_id, requested_by, direction, pickup_kind)
     VALUES (?,?,?,?,?,?, 'to','home')`,
    f.clubs.riverside, f.teams.gold, f.goldEvent, f.goldChild, f.goldHome, f.users.goldParent,
  );
  const offer = await call(f, f.users.redParent, {
    action: 'offer_drive', eventId: f.redEvent, capacity: 3, direction: 'to',
    driverName: 'Red', driverPhone: '2065550006', vehicleName: 'Van',
  });

  const result = await call(f, f.users.redParent, {
    action: 'claim', requestId: goldRequest, offerId: offer.offerId,
  });
  assert.deepEqual(result.legs, ['to']);
});

// --- address reveal --------------------------------------------------------

test('an address is released only to the assigned driver, and it is logged', async () => {
  const f = seedRides();
  const request = await call(f, f.users.redParent, {
    action: 'request_ride', eventId: f.redEvent, personIds: [f.redChild],
    direction: 'to', pickupKind: 'home',
  });
  const requestId = request.created[0];

  // Before assignment, even a teammate cannot reveal anything.
  await assert.rejects(
    call(f, f.redDriverUser, { action: 'reveal_pickup', requestId }),
    e => e.status === 404,
  );

  const driverOffer = f.db.insert(
    `INSERT INTO driver_offers (club_id, team_id, event_id, household_id, driver_user_id, driver_name, capacity, direction)
     VALUES (?,?,?,?,?, 'Red Driver', 3, 'to')`,
    f.clubs.riverside, f.teams.red, f.redEvent, f.redDriverHome, f.redDriverUser,
  );
  f.db.insert(
    `INSERT INTO assignments (club_id, request_id, offer_id, leg, assigned_by) VALUES (?,?,?, 'to', ?)`,
    f.clubs.riverside, requestId, driverOffer, f.redDriverUser,
  );

  // A teammate who is NOT the assigned driver still gets nothing.
  await assert.rejects(
    call(f, f.users.coach, { action: 'reveal_pickup', requestId }),
    e => e.status === 403 || e.status === 404,
  );

  // The assigned driver may now see it...
  const revealed = await call(f, f.redDriverUser, { action: 'reveal_pickup', requestId });
  assert.equal(revealed.address, 'Red family address');
  assert.equal(revealed.logged, true);

  const logs = f.db.rows(
    `SELECT * FROM audit_log WHERE action = 'address_revealed' AND subject_id = ?`, f.redHome,
  );
  assert.equal(logs.length, 1);
  assert.equal(logs[0].actor_email, 'red.driver@example.com');

  // ...and the family reading their own address is not logged as a reveal.
  const own = await call(f, f.users.redParent, { action: 'reveal_pickup', requestId });
  assert.equal(own.logged, false);
  assert.equal(
    f.db.rows(`SELECT COUNT(*) n FROM audit_log WHERE action = 'address_revealed'`)[0].n,
    1,
  );
});

// --- board projection ------------------------------------------------------

test('the board never returns an address to anyone', async () => {
  const f = seedRides();
  await call(f, f.users.redParent, {
    action: 'request_ride', eventId: f.redEvent, personIds: [f.redChild],
    direction: 'to', pickupKind: 'home',
  });

  const context = await ctx(f, f.users.redParent);
  context.url = new URL(`https://example.test/api/board?teamId=${f.teams.red}`);
  const board = await getBoard(context);

  const serialized = JSON.stringify(board);
  assert.ok(!serialized.includes('Red family address'), 'a home address leaked onto the board');
  assert.equal(board.requests[0].childName, 'Alex Red');
  assert.equal(board.requests[0].pickupArea, 'Winslow');
});

test('a team admin cannot pull another team\'s board', async () => {
  const f = seedRides();
  const context = await ctx(f, f.users.redParent);
  context.url = new URL(`https://example.test/api/board?teamId=${f.teams.blue}`);
  await assert.rejects(getBoard(context), e => e.status === 404);
});

// --- planning --------------------------------------------------------------

test('planning suggests carpools without exposing any coordinate', async () => {
  const f = seedRides();
  // Three families needing rides, two drivers.
  const requestIds = [];
  for (let i = 0; i < 3; i++) {
    const hh = f.db.insert(
      `INSERT INTO households (club_id, name, home_address, home_lat, home_lng) VALUES (?,?,?,?,?)`,
      f.clubs.riverside, `Family ${i}`, `secret address ${i}`, 47.62 + i * 0.005, -122.52 - i * 0.005,
    );
    const person = f.db.insert(
      `INSERT INTO people (club_id, household_id, name) VALUES (?,?,?)`,
      f.clubs.riverside, hh, `Kid ${i}`,
    );
    f.db.insert(`INSERT INTO enrollments (club_id, team_id, person_id) VALUES (?,?,?)`,
      f.clubs.riverside, f.teams.red, person);
    requestIds.push(f.db.insert(
      `INSERT INTO ride_requests (club_id, team_id, event_id, person_id, household_id, requested_by, direction, pickup_kind)
       VALUES (?,?,?,?,?,?, 'to','home')`,
      f.clubs.riverside, f.teams.red, f.redEvent, person, hh, f.users.redParent,
    ));
  }
  f.db.insert(
    `INSERT INTO driver_offers (club_id, team_id, event_id, household_id, driver_name, capacity, direction)
     VALUES (?,?,?,?, 'Driver One', 2, 'to')`,
    f.clubs.riverside, f.teams.red, f.redEvent, f.redHome,
  );
  f.db.insert(
    `INSERT INTO driver_offers (club_id, team_id, event_id, household_id, driver_name, capacity, direction)
     VALUES (?,?,?,?, 'Driver Two', 2, 'to')`,
    f.clubs.riverside, f.teams.red, f.redEvent, f.goldHome,
  );

  // A parent may not run the planner.
  await assert.rejects(
    planRoutes(await ctx(f, f.users.redParent, { eventId: f.redEvent, leg: 'to' })),
    e => e.status === 404,
  );

  const plan = await planRoutes(await ctx(f, f.users.riversideAdmin, { eventId: f.redEvent, leg: 'to' }));
  assert.equal(plan.ok, true);
  assert.equal(plan.unassigned.length, 0);
  assert.equal(plan.routes.flatMap(r => r.riders).length, 3);

  const serialized = JSON.stringify(plan);
  assert.ok(!serialized.includes('secret address'), 'an address leaked into the plan');
  assert.ok(!/47\.6[0-9]{3}/.test(serialized), 'a coordinate leaked into the plan');
  assert.ok(plan.routes.every(r => r.driverName && r.riders.every(x => x.childName)));
});

test('a driver route link is ordered and logs a reveal per household', async () => {
  const f = seedRides();
  const request = await call(f, f.users.redParent, {
    action: 'request_ride', eventId: f.redEvent, personIds: [f.redChild],
    direction: 'to', pickupKind: 'home',
  });
  const offer = f.db.insert(
    `INSERT INTO driver_offers (club_id, team_id, event_id, household_id, driver_user_id, driver_name, capacity, direction)
     VALUES (?,?,?,?,?, 'Red Driver', 3, 'to')`,
    f.clubs.riverside, f.teams.red, f.redEvent, f.redDriverHome, f.redDriverUser,
  );
  f.db.insert(
    `INSERT INTO assignments (club_id, request_id, offer_id, leg, assigned_by) VALUES (?,?,?, 'to', ?)`,
    f.clubs.riverside, request.created[0], offer, f.redDriverUser,
  );

  const result = await openRoute(await ctx(f, f.redDriverUser, { offerId: offer, leg: 'to' }));
  assert.match(result.url, /^https:\/\/www\.google\.com\/maps\/dir\/\?/);
  assert.equal(result.stops.length, 1);
  assert.equal(result.stops[0].childName, 'Alex Red');

  const logs = f.db.rows(`SELECT * FROM audit_log WHERE action = 'route_opened'`);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].subject_id, f.redHome);

  // A non-driver cannot open it.
  await assert.rejects(
    openRoute(await ctx(f, f.users.redParent, { offerId: offer, leg: 'to' })),
    e => e.status === 403,
  );
});
