import test from 'node:test';
import assert from 'node:assert/strict';
import { geocodeNominatim, geocoderFor, geocodeSequential } from '../src/lib/geocode.js';
import { loadScope } from '../src/lib/scope.js';
import { adminRequest } from '../src/routes/admin.js';
import { updateProfile } from '../src/routes/me.js';
import { seedTwoClubs } from './helpers.js';

/** Swap global fetch for the duration of one test. */
function withFetch(handler, run) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return Promise.resolve()
    .then(run)
    .finally(() => { globalThis.fetch = original; });
}

const jsonResponse = body => ({
  ok: true,
  status: 200,
  json: async () => body,
});

const HOUSE = [{
  lat: '47.6249', lon: '-122.5188', type: 'house', category: 'building',
  importance: 0.4, display_name: '100 Ericksen Ave NE, Bainbridge Island, WA 98110',
}];

// --- provider --------------------------------------------------------------

test('a house match returns coordinates and an exact confidence', async () => {
  await withFetch(async () => jsonResponse(HOUSE), async () => {
    const result = await geocodeNominatim('100 Ericksen Ave NE, Bainbridge Island, WA');
    assert.equal(result.confidence, 'exact');
    assert.ok(Math.abs(result.lat - 47.6249) < 1e-6);
    assert.ok(Math.abs(result.lng + 122.5188) < 1e-6);
    assert.match(result.label, /Ericksen/);
  });
});

test('a city-centre match is reported as an area, not silently accepted', async () => {
  // This is the dangerous case: the geocoder cannot find the street, returns
  // the middle of town, and looks exactly as confident as a real answer. It
  // must be distinguishable so the family can be asked to confirm.
  await withFetch(async () => jsonResponse([{
    lat: '47.6262', lon: '-122.5210', type: 'city', category: 'place',
    importance: 0.7, display_name: 'Bainbridge Island, Kitsap County, Washington',
  }]), async () => {
    const result = await geocodeNominatim('12345 Nonexistent Way, Bainbridge Island, WA');
    assert.equal(result.confidence, 'area');
  });
});

test('the request identifies itself and constrains the country', async () => {
  let seen = null;
  await withFetch(async (url, init) => {
    seen = { url: new URL(url), headers: init.headers };
    return jsonResponse(HOUSE);
  }, async () => {
    await geocodeNominatim('100 Ericksen Ave NE, Bainbridge Island, WA');
  });
  assert.equal(seen.url.searchParams.get('countrycodes'), 'us');
  assert.equal(seen.url.searchParams.get('limit'), '1');
  assert.match(seen.headers['user-agent'], /SoccerCarpool/);
});

test('nothing but the address is ever sent', async () => {
  // The address goes out; who lives there does not.
  let sent = '';
  await withFetch(async url => { sent = String(url); return jsonResponse(HOUSE); }, async () => {
    await geocodeNominatim('100 Ericksen Ave NE, Bainbridge Island, WA');
  });
  for (const secret of ['Okonkwo', 'household', 'club', 'team', 'child', 'parent']) {
    assert.ok(!sent.toLowerCase().includes(secret), `leaked ${secret}`);
  }
});

test('a failure is null, never an exception', async () => {
  await withFetch(async () => { throw new Error('network down'); }, async () => {
    assert.equal(await geocodeNominatim('100 Ericksen Ave NE'), null);
  });
  await withFetch(async () => ({ ok: false, status: 429 }), async () => {
    assert.equal(await geocodeNominatim('100 Ericksen Ave NE'), null);
  });
  await withFetch(async () => jsonResponse([]), async () => {
    assert.equal(await geocodeNominatim('100 Ericksen Ave NE'), null);
  });
});

test('an address too short to be real is not sent at all', async () => {
  let called = false;
  await withFetch(async () => { called = true; return jsonResponse(HOUSE); }, async () => {
    assert.equal(await geocodeNominatim('abc'), null);
  });
  assert.equal(called, false);
});

test('geocoding can be switched off entirely', async () => {
  let called = false;
  await withFetch(async () => { called = true; return jsonResponse(HOUSE); }, async () => {
    const geocoder = geocoderFor({ GEOCODER: 'off' });
    assert.equal(await geocoder('100 Ericksen Ave NE, Bainbridge Island, WA'), null);
  });
  assert.equal(called, false, 'no request leaves the worker when disabled');
});

test('bulk lookups are paced rather than fired all at once', async () => {
  const stamps = [];
  const geocoder = async () => { stamps.push(Date.now()); return null; };
  await geocodeSequential(
    [{ address: 'a' }, { address: 'b' }, { address: 'c' }],
    geocoder,
    { delayMs: 30 },
  );
  assert.equal(stamps.length, 3);
  assert.ok(stamps[1] - stamps[0] >= 25, 'second call waited');
  assert.ok(stamps[2] - stamps[1] >= 25, 'third call waited');
});

// --- profile save ----------------------------------------------------------

async function profileContext(f, userId, body) {
  const user = f.userRow(userId);
  return {
    db: f.db, env: {}, user, scope: await loadScope(f.db, user),
    body, ip: '127.0.0.1',
  };
}

test('saving an address stores the coordinates it resolved to', async () => {
  const f = seedTwoClubs();
  await withFetch(async () => jsonResponse(HOUSE), async () => {
    const result = await updateProfile(await profileContext(f, f.users.redParent, {
      clubId: f.clubs.riverside,
      displayName: 'Red Parent',
      phone: '2065550111',
      homeAddress: '100 Ericksen Ave NE, Bainbridge Island, WA',
    }));
    assert.equal(result.geocode.found, true);
    assert.equal(result.geocode.confidence, 'exact');
    assert.match(result.geocode.label, /Ericksen/);
  });

  const row = f.db.rows(`SELECT home_lat, home_lng, home_geocode_confidence FROM households`)[0];
  assert.ok(Math.abs(row.home_lat - 47.6249) < 1e-6);
  assert.equal(row.home_geocode_confidence, 'exact');
});

test('a failed lookup still saves the family, flagged as unlocated', async () => {
  // Refusing the save would make a third-party service a hard dependency of
  // joining a team.
  const f = seedTwoClubs();
  await withFetch(async () => jsonResponse([]), async () => {
    const result = await updateProfile(await profileContext(f, f.users.redParent, {
      clubId: f.clubs.riverside,
      displayName: 'Red Parent',
      phone: '2065550111',
      homeAddress: '9999 Imaginary Road, Nowhere, WA',
    }));
    assert.deepEqual(result.geocode, { found: false });
  });
  const row = f.db.rows(`SELECT home_address, home_lat FROM households`)[0];
  assert.equal(row.home_address, '9999 Imaginary Road, Nowhere, WA');
  assert.equal(row.home_lat, null);
});

test('coordinates typed by the parent win, and skip the lookup', async () => {
  const f = seedTwoClubs();
  let called = false;
  await withFetch(async () => { called = true; return jsonResponse(HOUSE); }, async () => {
    await updateProfile(await profileContext(f, f.users.redParent, {
      clubId: f.clubs.riverside,
      displayName: 'Red Parent', phone: '2065550111',
      homeAddress: '100 Ericksen Ave NE, Bainbridge Island, WA',
      homeLat: 47.5, homeLng: -122.5,
    }));
  });
  assert.equal(called, false, 'no lookup when the parent supplied coordinates');
  const row = f.db.rows(`SELECT home_lat FROM households`)[0];
  assert.equal(row.home_lat, 47.5);
});

test('resaving an unchanged address does not re-query the geocoder', async () => {
  const f = seedTwoClubs();
  let calls = 0;
  await withFetch(async () => { calls++; return jsonResponse(HOUSE); }, async () => {
    const body = {
      clubId: f.clubs.riverside, displayName: 'Red Parent', phone: '2065550111',
      homeAddress: '100 Ericksen Ave NE, Bainbridge Island, WA',
    };
    await updateProfile(await profileContext(f, f.users.redParent, body));
    await updateProfile(await profileContext(f, f.users.redParent, body));
    await updateProfile(await profileContext(f, f.users.redParent, body));
  });
  assert.equal(calls, 1, 'an address is resolved once, not on every save');
  const row = f.db.rows(`SELECT home_lat FROM households`)[0];
  assert.ok(row.home_lat != null, 'and the coordinates survive the later saves');
});

// --- backfill --------------------------------------------------------------

test('the backfill locates households that have an address but no position', async () => {
  const f = seedTwoClubs();
  for (let i = 0; i < 3; i++) {
    f.db.insert(
      `INSERT INTO households (club_id, name, home_address) VALUES (?,?,?)`,
      f.clubs.riverside, `Family ${i}`, `${100 + i} Ericksen Ave NE, Bainbridge Island, WA`,
    );
  }
  // One in the other club, which must not be touched.
  f.db.insert(
    `INSERT INTO households (club_id, name, home_address) VALUES (?, 'Harbor', '1 Front St, Poulsbo, WA')`,
    f.clubs.harbor,
  );

  const user = f.userRow(f.users.riversideAdmin);
  const context = {
    db: f.db, env: { GEOCODE_DELAY_MS: 0 }, user,
    scope: await loadScope(f.db, user),
    body: { action: 'geocode_households', clubId: f.clubs.riverside },
    ip: '127.0.0.1', request: { method: 'POST' },
    url: new URL('https://example.test/api/admin'),
  };

  const result = await withFetch(async () => jsonResponse(HOUSE), () => adminRequest(context));
  assert.equal(result.processed, 3);
  assert.equal(result.located, 3);
  assert.equal(result.remaining, 0);

  const other = f.db.rows(`SELECT home_lat FROM households WHERE club_id = ?`, f.clubs.harbor)[0];
  assert.equal(other.home_lat, null, 'the other club was not geocoded');
});

test('only a club administrator can run the backfill', async () => {
  const f = seedTwoClubs();
  const user = f.userRow(f.users.redParent);
  const context = {
    db: f.db, env: {}, user, scope: await loadScope(f.db, user),
    body: { action: 'geocode_households', clubId: f.clubs.riverside },
    ip: '', request: { method: 'POST' },
    url: new URL('https://example.test/api/admin'),
  };
  await assert.rejects(adminRequest(context), e => e.status === 404);
});
