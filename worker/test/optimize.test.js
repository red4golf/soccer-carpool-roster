import test from 'node:test';
import assert from 'node:assert/strict';
import { orderStops, assignRiders, planLeg } from '../src/lib/optimize.js';
import { haversineKm, haversineProvider, mapsDirectionsUrl } from '../src/lib/geo.js';

// --- helpers ---------------------------------------------------------------

function matrixFrom(points) {
  const n = points.length;
  const m = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++)
      m[i][j] = Math.hypot(points[i][0] - points[j][0], points[i][1] - points[j][1]);
  return m;
}

function pathCost(order, matrix) {
  let total = 0;
  for (let i = 0; i < order.length - 1; i++) total += matrix[order[i]][order[i + 1]];
  return total;
}

/** Ground truth by exhaustive permutation. Only usable for tiny n. */
function bruteForce(start, stops, end, matrix) {
  let best = Infinity;
  const permute = (rest, acc) => {
    if (!rest.length) {
      best = Math.min(best, pathCost([start, ...acc, end], matrix));
      return;
    }
    for (let i = 0; i < rest.length; i++)
      permute([...rest.slice(0, i), ...rest.slice(i + 1)], [...acc, rest[i]]);
  };
  permute(stops, []);
  return best;
}

// Deterministic PRNG so a failure is reproducible.
function rng(seed) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

// --- stop ordering ---------------------------------------------------------

test('trivial legs are handled without a solver', () => {
  const m = matrixFrom([[0, 0], [3, 4]]);
  const none = orderStops(0, [], 1, m);
  assert.deepEqual(none.order, [0, 1]);
  assert.equal(none.distanceKm, 5);
});

test('a deliberately bad input order is corrected', () => {
  // Four houses strung along a line between the driver (0,0) and field (10,0).
  // Handed to the solver back to front, it must return them front to back.
  const points = [[0, 0], [10, 0], [8, 0], [6, 0], [4, 0], [2, 0]];
  const m = matrixFrom(points);
  const solved = orderStops(0, [2, 3, 4, 5], 1, m);
  assert.deepEqual(solved.order, [0, 5, 4, 3, 2, 1]);
  assert.equal(solved.distanceKm, 10); // no backtracking at all
  assert.equal(solved.exact, true);
});

test('exact solver matches brute force across random instances', () => {
  const random = rng(20260822);
  for (let trial = 0; trial < 40; trial++) {
    const n = 3 + (trial % 6); // 3..8 stops
    const points = Array.from({ length: n + 2 }, () => [random() * 50, random() * 50]);
    const m = matrixFrom(points);
    const stops = Array.from({ length: n }, (_, i) => i + 2);
    const solved = orderStops(0, stops, 1, m);
    const truth = bruteForce(0, stops, 1, m);
    assert.ok(
      Math.abs(solved.distanceKm - truth) < 1e-9,
      `trial ${trial}: solver ${solved.distanceKm} vs optimal ${truth}`,
    );
    // The returned path must actually be a valid permutation of the stops.
    assert.equal(solved.order.length, n + 2);
    assert.equal(new Set(solved.order).size, n + 2);
    assert.equal(solved.order[0], 0);
    assert.equal(solved.order.at(-1), 1);
  }
});

test('heuristic stays close to optimal past the exact threshold', () => {
  const random = rng(99);
  let worst = 0;
  for (let trial = 0; trial < 15; trial++) {
    const n = 14; // above EXACT_MAX_STOPS, so this exercises 2-opt/Or-opt
    const points = Array.from({ length: n + 2 }, () => [random() * 30, random() * 30]);
    const m = matrixFrom(points);
    const stops = Array.from({ length: n }, (_, i) => i + 2);
    const solved = orderStops(0, stops, 1, m);
    assert.equal(solved.exact, false);
    assert.equal(new Set(solved.order).size, n + 2, 'every stop visited exactly once');

    // Compare against the nearest-neighbour seed it started from.
    const greedy = [];
    const remaining = new Set(stops);
    let cursor = 0;
    while (remaining.size) {
      let best = null;
      let bestCost = Infinity;
      for (const c of remaining) if (m[cursor][c] < bestCost) { bestCost = m[cursor][c]; best = c; }
      greedy.push(best); remaining.delete(best); cursor = best;
    }
    const greedyCost = pathCost([0, ...greedy, 1], m);
    assert.ok(solved.distanceKm <= greedyCost + 1e-9, 'local search never makes it worse');
    worst = Math.max(worst, solved.distanceKm / greedyCost);
  }
  assert.ok(worst <= 1.0, 'heuristic improves on or matches its seed every time');
});

// --- assignment ------------------------------------------------------------

test('seat capacity is never exceeded', () => {
  const random = rng(7);
  const points = [[0, 0], ...Array.from({ length: 12 }, () => [random() * 20, random() * 20])];
  const m = matrixFrom(points);
  const drivers = [
    { id: 'a', capacity: 2, startIndex: 1 },
    { id: 'b', capacity: 3, startIndex: 2 },
  ];
  const riders = [3, 4, 5, 6, 7, 8, 9].map(i => ({ id: `r${i}`, stopIndex: i }));
  const result = assignRiders(drivers, riders, 0, m);

  for (const route of result.routes) {
    const driver = drivers.find(d => d.id === route.driverId);
    assert.ok(route.riderIds.length <= driver.capacity, `${route.driverId} overloaded`);
  }
  // 5 seats, 7 children — exactly 2 must be left for a human to sort out.
  assert.equal(result.unassigned.length, 2);
  const placed = result.routes.flatMap(r => r.riderIds);
  assert.equal(placed.length, 5);
  assert.equal(new Set(placed).size, 5, 'no child assigned to two cars');
});

test('every child is placed when there are enough seats', () => {
  const random = rng(31337);
  const points = [[25, 25], ...Array.from({ length: 14 }, () => [random() * 50, random() * 50])];
  const m = matrixFrom(points);
  const drivers = [
    { id: 'a', capacity: 4, startIndex: 1 },
    { id: 'b', capacity: 4, startIndex: 2 },
    { id: 'c', capacity: 4, startIndex: 3 },
  ];
  const riders = Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, stopIndex: i + 4 }));
  const result = assignRiders(drivers, riders, 0, m);
  assert.equal(result.unassigned.length, 0);
  assert.equal(result.routes.flatMap(r => r.riderIds).length, 10);
});

/** Optimal total distance over every capacity-feasible assignment. */
function bruteForceAssignment(drivers, riders, endIndex, matrix) {
  let best = Infinity;
  const buckets = drivers.map(() => []);
  const recurse = index => {
    if (index === riders.length) {
      let total = 0;
      for (let d = 0; d < drivers.length; d++) {
        if (!buckets[d].length) continue;
        total += orderStops(drivers[d].startIndex, buckets[d], endIndex, matrix).distanceKm;
      }
      best = Math.min(best, total);
      return;
    }
    for (let d = 0; d < drivers.length; d++) {
      if (buckets[d].length >= drivers[d].capacity) continue;
      buckets[d].push(riders[index].stopIndex);
      recurse(index + 1);
      buckets[d].pop();
    }
  };
  recurse(0);
  return best;
}

test('assignment matches the true optimum on small instances', () => {
  const random = rng(4242);
  for (let trial = 0; trial < 12; trial++) {
    const points = [[25, 25], ...Array.from({ length: 6 }, () => [random() * 50, random() * 50])];
    const m = matrixFrom(points);
    const drivers = [
      { id: 'A', capacity: 2, startIndex: 1 },
      { id: 'B', capacity: 2, startIndex: 2 },
    ];
    const riders = [3, 4, 5, 6].map(i => ({ id: `r${i}`, stopIndex: i }));

    const result = assignRiders(drivers, riders, 0, m);
    const optimal = bruteForceAssignment(drivers, riders, 0, m);

    assert.equal(result.unassigned.length, 0, `trial ${trial}: nobody may be stranded`);
    // Heuristic, so allow a small gap — but on instances this size it should
    // essentially always land exactly on the optimum.
    assert.ok(
      result.totalKm <= optimal * 1.02 + 1e-9,
      `trial ${trial}: got ${result.totalKm.toFixed(3)} vs optimal ${optimal.toFixed(3)}`,
    );
  }
});

test('no child is ever lost or duplicated by the local search', () => {
  // This is the invariant that a value-based (filter/push) local search
  // violated: riders vanished from their car while still marked assigned.
  const random = rng(20260101);
  for (let trial = 0; trial < 30; trial++) {
    const riderCount = 4 + (trial % 9);
    const driverCount = 2 + (trial % 3);
    const points = [
      [25, 25],
      ...Array.from({ length: driverCount + riderCount }, () => [random() * 60, random() * 60]),
    ];
    const m = matrixFrom(points);
    const drivers = Array.from({ length: driverCount }, (_, i) => ({
      id: `d${i}`,
      capacity: 4,
      startIndex: i + 1,
    }));
    const riders = Array.from({ length: riderCount }, (_, i) => ({
      id: `r${i}`,
      stopIndex: driverCount + 1 + i,
    }));

    const result = assignRiders(drivers, riders, 0, m);
    const placed = result.routes.flatMap(r => r.riderIds);

    assert.equal(
      placed.length + result.unassigned.length,
      riderCount,
      `trial ${trial}: ${riderCount} children in, ${placed.length + result.unassigned.length} accounted for`,
    );
    assert.equal(new Set(placed).size, placed.length, `trial ${trial}: a child was duplicated`);
    // The routes and the assignment map must tell the same story.
    for (const route of result.routes)
      for (const riderId of route.riderIds)
        assert.equal(result.assignment[riderId], route.driverId, `trial ${trial}: ${riderId} disagrees`);
  }
});

test('siblings at one address both get seats in the same car', () => {
  // Two children share stopIndex 3 — one household, one doorstep.
  const points = [[10, 0], [0, 0], [5, 1]];
  points.push([5, 1]);
  const m = matrixFrom(points);
  const drivers = [{ id: 'A', capacity: 2, startIndex: 1 }];
  const riders = [
    { id: 'kid1', stopIndex: 2 },
    { id: 'kid2', stopIndex: 2 },
  ];
  const result = assignRiders(drivers, riders, 0, m);
  assert.equal(result.unassigned.length, 0);
  assert.deepEqual(result.routes[0].riderIds.sort(), ['kid1', 'kid2']);
  assert.equal(result.routes[0].riderIds.length, 2, 'both siblings kept, no dropped duplicate');
});

// --- end to end ------------------------------------------------------------

test('planLeg produces usable routes from real coordinates', async () => {
  // Bainbridge Island: field at Battle Point Park, homes around Winslow.
  const venue = { lat: 47.6631, lng: -122.5615 };
  const offers = [
    { id: 'd1', capacity: 3, origin: { lat: 47.6231, lng: -122.5182 } },
    { id: 'd2', capacity: 3, origin: { lat: 47.6450, lng: -122.5480 } },
  ];
  const requests = [
    { id: 'k1', pickup: { lat: 47.6260, lng: -122.5210 } },
    { id: 'k2', pickup: { lat: 47.6290, lng: -122.5250 } },
    { id: 'k3', pickup: { lat: 47.6470, lng: -122.5500 } },
    { id: 'k4', pickup: { lat: 47.6480, lng: -122.5520 } },
  ];
  const plan = await planLeg({ leg: 'to', venue, offers, requests });

  assert.equal(plan.ok, true);
  assert.equal(plan.provider, 'haversine');
  assert.equal(plan.unassigned.length, 0);
  assert.equal(plan.routes.flatMap(r => r.riderIds).length, 4);
  for (const route of plan.routes) {
    assert.ok(route.distanceKm > 0);
    assert.ok(route.durationMin > 0);
  }
  // Children should land with their geographically nearer driver.
  assert.equal(plan.assignment.k1, plan.assignment.k2);
  assert.equal(plan.assignment.k3, plan.assignment.k4);
  assert.notEqual(plan.assignment.k1, plan.assignment.k3);
});

test('the return leg reverses the outbound order', async () => {
  const venue = { lat: 47.6631, lng: -122.5615 };
  const offers = [{ id: 'd1', capacity: 4, origin: { lat: 47.6231, lng: -122.5182 } }];
  const requests = [
    { id: 'k1', pickup: { lat: 47.6260, lng: -122.5210 } },
    { id: 'k2', pickup: { lat: 47.6350, lng: -122.5330 } },
    { id: 'k3', pickup: { lat: 47.6450, lng: -122.5450 } },
  ];
  const to = await planLeg({ leg: 'to', venue, offers, requests });
  const from = await planLeg({ leg: 'from', venue, offers, requests });
  assert.deepEqual(from.routes[0].riderIds, [...to.routes[0].riderIds].reverse());
});

test('missing coordinates are reported, not silently dropped', async () => {
  const venue = { lat: 47.6631, lng: -122.5615 };
  const offers = [{ id: 'd1', capacity: 4, origin: { lat: 47.62, lng: -122.51 } }];
  const requests = [
    { id: 'ok', pickup: { lat: 47.63, lng: -122.52 } },
    { id: 'nogeo', pickup: null },
  ];
  const plan = await planLeg({ leg: 'to', venue, offers, requests });
  assert.deepEqual(plan.missingCoordinates, ['nogeo']);
  assert.deepEqual(plan.routes[0].riderIds, ['ok']);
});

test('an unlocatable venue fails loudly instead of guessing', async () => {
  const plan = await planLeg({
    leg: 'to',
    venue: null,
    offers: [{ id: 'd1', capacity: 4, origin: { lat: 47.6, lng: -122.5 } }],
    requests: [{ id: 'k1', pickup: { lat: 47.63, lng: -122.52 } }],
  });
  assert.equal(plan.ok, false);
  assert.match(plan.error, /no coordinates/);
});

// --- geo -------------------------------------------------------------------

test('haversine matches a known distance', () => {
  // Seattle to Portland is ~233 km.
  const d = haversineKm({ lat: 47.6062, lng: -122.3321 }, { lat: 45.5152, lng: -122.6784 });
  assert.ok(Math.abs(d - 233) < 5, `got ${d}`);
});

test('haversine provider returns a symmetric matrix with a zero diagonal', async () => {
  const pts = [
    { lat: 47.6, lng: -122.5 },
    { lat: 47.7, lng: -122.4 },
    { lat: 47.5, lng: -122.6 },
  ];
  const m = await haversineProvider.matrix(pts);
  for (let i = 0; i < 3; i++) {
    assert.equal(m[i][i], 0);
    for (let j = 0; j < 3; j++) assert.ok(Math.abs(m[i][j] - m[j][i]) < 1e-12);
  }
});

test('maps url keeps the solved waypoint order', () => {
  const url = mapsDirectionsUrl(
    { lat: 47.62, lng: -122.51 },
    [{ lat: 47.63, lng: -122.52 }, { lat: 47.64, lng: -122.53 }],
    { lat: 47.66, lng: -122.56 },
  );
  assert.match(url, /^https:\/\/www\.google\.com\/maps\/dir\/\?/);
  const params = new URL(url).searchParams;
  assert.equal(params.get('waypoints'), '47.630000,-122.520000|47.640000,-122.530000');
  assert.equal(params.get('travelmode'), 'driving');
});
