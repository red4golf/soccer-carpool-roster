// Route optimization for carpool legs.
//
// There are two separate problems here and it is worth keeping them apart:
//
//   1. ORDERING  — one driver, a known set of children: what order do I
//                  collect them in? This is an open-path TSP with a fixed
//                  start (driver's home) and fixed end (the field).
//
//   2. ASSIGNMENT — several drivers, several children, limited seats: who
//                  takes whom? This is a capacitated vehicle-routing problem.
//
// Carpool instances are tiny — a big club event might be 30 children and 10
// drivers, and a single car is almost never more than 6 stops. That size is
// what makes an exact answer affordable for (1), and makes a good heuristic
// effectively optimal for (2).

import { estimateMinutes, haversineProvider, isPoint } from './geo.js';

/** Above this many stops, exact Held-Karp stops being worth the memory. */
const EXACT_MAX_STOPS = 12;

// ---------------------------------------------------------------------------
// 1. Stop ordering
// ---------------------------------------------------------------------------

function pathCost(order, matrix) {
  let total = 0;
  for (let i = 0; i < order.length - 1; i++) total += matrix[order[i]][order[i + 1]];
  return total;
}

/**
 * Exact open-path TSP by Held-Karp dynamic programming.
 *
 * dp[mask][i] = cheapest way to leave `start`, visit exactly the stops in
 * `mask`, and be standing at stop i. Answer is min over i of
 * dp[full][i] + d(i, end).
 *
 * Cost is O(2^n · n^2) time and O(2^n · n) memory, which at n=12 is 49k
 * states — microseconds. Guarded by EXACT_MAX_STOPS.
 */
function solveExact(start, stops, end, matrix) {
  const n = stops.length;
  const size = 1 << n;
  const INF = Infinity;
  const dp = Array.from({ length: size }, () => new Float64Array(n).fill(INF));
  const parent = Array.from({ length: size }, () => new Int16Array(n).fill(-1));

  for (let i = 0; i < n; i++) dp[1 << i][i] = matrix[start][stops[i]];

  for (let mask = 1; mask < size; mask++) {
    for (let i = 0; i < n; i++) {
      const cost = dp[mask][i];
      if (cost === INF || !(mask & (1 << i))) continue;
      for (let j = 0; j < n; j++) {
        if (mask & (1 << j)) continue;
        const next = mask | (1 << j);
        const candidate = cost + matrix[stops[i]][stops[j]];
        if (candidate < dp[next][j]) {
          dp[next][j] = candidate;
          parent[next][j] = i;
        }
      }
    }
  }

  const full = size - 1;
  let best = INF;
  let last = -1;
  for (let i = 0; i < n; i++) {
    const total = dp[full][i] + matrix[stops[i]][end];
    if (total < best) {
      best = total;
      last = i;
    }
  }

  const reversed = [];
  let mask = full;
  let cursor = last;
  while (cursor !== -1) {
    reversed.push(stops[cursor]);
    const previous = parent[mask][cursor];
    mask ^= 1 << cursor;
    cursor = previous;
  }
  reversed.reverse();
  return { order: [start, ...reversed, end], distanceKm: best, exact: true };
}

/** Nearest-neighbour seed followed by 2-opt and Or-opt local search. */
function solveHeuristic(start, stops, end, matrix) {
  const remaining = new Set(stops);
  const order = [start];
  let cursor = start;
  while (remaining.size) {
    let best = null;
    let bestCost = Infinity;
    for (const candidate of remaining) {
      const cost = matrix[cursor][candidate];
      if (cost < bestCost) {
        bestCost = cost;
        best = candidate;
      }
    }
    order.push(best);
    remaining.delete(best);
    cursor = best;
  }
  order.push(end);

  // 2-opt: reverse an interior segment when it shortens the path. Endpoints
  // are pinned, so i starts at 1 and j stops before the final node.
  let improved = true;
  let guard = 0;
  while (improved && guard++ < 200) {
    improved = false;
    for (let i = 1; i < order.length - 2; i++) {
      for (let j = i + 1; j < order.length - 1; j++) {
        const before =
          matrix[order[i - 1]][order[i]] + matrix[order[j]][order[j + 1]];
        const after =
          matrix[order[i - 1]][order[j]] + matrix[order[i]][order[j + 1]];
        if (after < before - 1e-9) {
          let lo = i;
          let hi = j;
          while (lo < hi) {
            const tmp = order[lo];
            order[lo] = order[hi];
            order[hi] = tmp;
            lo++;
            hi--;
          }
          improved = true;
        }
      }
    }
    // Or-opt: lift a single stop and reinsert it elsewhere. Catches the
    // "one house badly out of sequence" case that 2-opt alone can miss.
    for (let i = 1; i < order.length - 1; i++) {
      const node = order[i];
      const removalGain =
        matrix[order[i - 1]][node] +
        matrix[node][order[i + 1]] -
        matrix[order[i - 1]][order[i + 1]];
      if (removalGain <= 1e-9) continue;
      for (let j = 1; j < order.length - 1; j++) {
        if (j === i || j === i - 1) continue;
        const insertCost =
          matrix[order[j]][node] +
          matrix[node][order[j + 1]] -
          matrix[order[j]][order[j + 1]];
        if (insertCost < removalGain - 1e-9) {
          order.splice(i, 1);
          // Removing index i shifts everything after it down by one, so a
          // target to the right of i lands at j, and one to the left at j+1.
          order.splice(j > i ? j : j + 1, 0, node);
          improved = true;
          break;
        }
      }
      if (improved) break;
    }
  }

  return { order, distanceKm: pathCost(order, matrix), exact: false };
}

/**
 * Order a single driver's stops.
 *
 * @param start  matrix index the driver begins at
 * @param stops  matrix indices that must be visited, any order
 * @param end    matrix index the driver finishes at
 * @param matrix symmetric km distance matrix
 */
export function orderStops(start, stops, end, matrix) {
  if (!stops.length) {
    return { order: [start, end], distanceKm: matrix[start][end], exact: true };
  }
  if (stops.length === 1) {
    const d = matrix[start][stops[0]] + matrix[stops[0]][end];
    return { order: [start, stops[0], end], distanceKm: d, exact: true };
  }
  return stops.length <= EXACT_MAX_STOPS
    ? solveExact(start, stops, end, matrix)
    : solveHeuristic(start, stops, end, matrix);
}

// ---------------------------------------------------------------------------
// 2. Driver assignment
// ---------------------------------------------------------------------------

/** Cheapest place to slot `stop` into an existing ordered route. */
function bestInsertion(route, stop, matrix) {
  let bestCost = Infinity;
  let bestIndex = -1;
  for (let i = 0; i < route.length - 1; i++) {
    const delta =
      matrix[route[i]][stop] +
      matrix[stop][route[i + 1]] -
      matrix[route[i]][route[i + 1]];
    if (delta < bestCost) {
      bestCost = delta;
      bestIndex = i + 1;
    }
  }
  return { cost: bestCost, index: bestIndex };
}

/**
 * Assign riders to drivers, then order each driver's stops.
 *
 * Uses regret-2 insertion: at each step, score every unassigned child by how
 * much worse their SECOND-best driver is than their best. Place the child
 * with the most to lose. Plain greedy insertion — always taking the globally
 * cheapest placement — reliably strands the child who only ever fitted well
 * in one car, because it fills that car with cheaper riders first.
 *
 * A relocate/swap local search then cleans up whatever the construction
 * heuristic got wrong.
 *
 * @param drivers  [{ id, capacity, startIndex }]
 * @param riders   [{ id, stopIndex }]
 * @param endIndex matrix index every driver finishes at (the venue)
 * @param matrix   symmetric km distance matrix
 */
export function assignRiders(drivers, riders, endIndex, matrix) {
  const routes = new Map(
    drivers.map(d => [
      d.id,
      { driver: d, stops: [], startIndex: d.startIndex, endIndex, route: [d.startIndex, endIndex] },
    ]),
  );
  const riderById = new Map(riders.map(r => [r.id, r]));
  const unassigned = new Set(riders.map(r => r.id));
  const assignment = new Map();

  while (unassigned.size) {
    let choice = null;

    for (const riderId of unassigned) {
      const rider = riderById.get(riderId);
      const options = [];
      for (const state of routes.values()) {
        if (state.stops.length >= state.driver.capacity) continue;
        const { cost, index } = bestInsertion(state.route, rider.stopIndex, matrix);
        if (Number.isFinite(cost)) options.push({ cost, index, driverId: state.driver.id });
      }
      if (!options.length) continue;
      options.sort((a, b) => a.cost - b.cost);
      const regret = options.length > 1 ? options[1].cost - options[0].cost : Infinity;
      if (!choice || regret > choice.regret || (regret === choice.regret && options[0].cost < choice.best.cost)) {
        choice = { riderId, regret, best: options[0] };
      }
    }

    // Nobody left has a seat anywhere.
    if (!choice) break;

    const state = routes.get(choice.best.driverId);
    state.route.splice(choice.best.index, 0, riderById.get(choice.riderId).stopIndex);
    state.stops.push(choice.riderId);
    assignment.set(choice.riderId, choice.best.driverId);
    unassigned.delete(choice.riderId);
  }

  localSearch(routes, riderById, assignment, matrix);

  // Final exact ordering per car now that membership has settled.
  const solved = [];
  for (const state of routes.values()) {
    const stopIndices = state.stops.map(id => riderById.get(id).stopIndex);
    const ordered = orderStops(state.driver.startIndex, stopIndices, endIndex, matrix);
    const byIndex = new Map();
    for (const id of state.stops) {
      const key = riderById.get(id).stopIndex;
      if (!byIndex.has(key)) byIndex.set(key, []);
      byIndex.get(key).push(id);
    }
    // Interior nodes only, mapped back to rider ids (several children can
    // share one address — siblings, or two families at one meeting point).
    const riderOrder = [];
    for (const node of ordered.order.slice(1, -1)) {
      const bucket = byIndex.get(node);
      if (bucket && bucket.length) riderOrder.push(bucket.shift());
    }
    solved.push({
      driverId: state.driver.id,
      riderIds: riderOrder,
      distanceKm: ordered.distanceKm,
      durationMin: estimateMinutes(ordered.distanceKm, riderOrder.length),
      exact: ordered.exact,
    });
  }

  return {
    routes: solved,
    assignment: Object.fromEntries(assignment),
    unassigned: [...unassigned],
    totalKm: solved.reduce((sum, r) => sum + (r.riderIds.length ? r.distanceKm : 0), 0),
  };
}

/**
 * Relocate-then-swap descent to a local optimum.
 *
 * Every mutation here is index-based (splice at a known position, restore at
 * the same position) rather than value-based. An earlier value-based version
 * using `filter`/`push` duplicated and then dropped children whenever a rider
 * was moved twice in one pass — the array said one thing and the assignment
 * map said another. With cars full of real kids, "silently lost" is the worst
 * possible failure mode, so the invariant is asserted in the tests.
 */
function localSearch(routes, riderById, assignment, matrix) {
  const states = [...routes.values()];
  const cost = state =>
    orderStops(
      state.startIndex,
      state.stops.map(id => riderById.get(id).stopIndex),
      state.endIndex,
      matrix,
    ).distanceKm;

  const costOf = new Map(states.map(s => [s, cost(s)]));

  let improved = true;
  let guard = 0;
  while (improved && guard++ < 100) {
    improved = false;

    // Relocate: lift one child out of a car and try them in every other car.
    relocate: for (const from of states) {
      for (let i = 0; i < from.stops.length; i++) {
        const riderId = from.stops[i];
        for (const to of states) {
          if (to === from || to.stops.length >= to.driver.capacity) continue;
          const before = costOf.get(from) + costOf.get(to);
          from.stops.splice(i, 1);
          to.stops.push(riderId);
          const fromCost = cost(from);
          const toCost = cost(to);
          if (fromCost + toCost < before - 1e-9) {
            costOf.set(from, fromCost);
            costOf.set(to, toCost);
            assignment.set(riderId, to.driver.id);
            improved = true;
            continue relocate;
          }
          to.stops.pop();
          from.stops.splice(i, 0, riderId);
        }
      }
    }
    if (improved) continue;

    // Swap: trade one child between two cars. Capacity is unchanged by a
    // swap, so this reaches arrangements relocate alone cannot when both
    // cars are already full.
    for (let a = 0; a < states.length; a++) {
      for (let b = a + 1; b < states.length; b++) {
        const first = states[a];
        const second = states[b];
        for (let i = 0; i < first.stops.length; i++) {
          for (let j = 0; j < second.stops.length; j++) {
            const before = costOf.get(first) + costOf.get(second);
            const x = first.stops[i];
            const y = second.stops[j];
            first.stops[i] = y;
            second.stops[j] = x;
            const firstCost = cost(first);
            const secondCost = cost(second);
            if (firstCost + secondCost < before - 1e-9) {
              costOf.set(first, firstCost);
              costOf.set(second, secondCost);
              assignment.set(x, second.driver.id);
              assignment.set(y, first.driver.id);
              improved = true;
            } else {
              first.stops[i] = x;
              second.stops[j] = y;
            }
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Plan one leg of one event.
 *
 * @param leg      'to' (homes -> venue) or 'from' (venue -> homes)
 * @param venue    {lat, lng}
 * @param offers   [{ id, capacity, origin: {lat,lng} }]
 * @param requests [{ id, pickup: {lat,lng} }]
 * @param provider distance-matrix provider, defaults to haversine
 */
export async function planLeg({ leg, venue, offers, requests, provider = haversineProvider }) {
  const usableOffers = offers.filter(o => isPoint(o.origin) && o.capacity > 0);
  const usableRequests = requests.filter(r => isPoint(r.pickup));
  const missingCoordinates = requests.filter(r => !isPoint(r.pickup)).map(r => r.id);

  if (!isPoint(venue)) {
    return { ok: false, error: 'The event location has no coordinates yet.', routes: [], unassigned: requests.map(r => r.id), missingCoordinates };
  }
  if (!usableOffers.length || !usableRequests.length) {
    return { ok: true, provider: provider.name, leg, routes: [], assignment: {}, unassigned: usableRequests.map(r => r.id), missingCoordinates, totalKm: 0 };
  }

  // Point 0 is the venue; then one point per driver origin; then pickups.
  const points = [venue];
  const driverIndex = new Map();
  for (const offer of usableOffers) {
    driverIndex.set(offer.id, points.length);
    points.push(offer.origin);
  }
  const riderIndex = new Map();
  for (const request of usableRequests) {
    riderIndex.set(request.id, points.length);
    points.push(request.pickup);
  }

  const matrix = await provider.matrix(points);

  // Going home is the same problem read backwards: the venue becomes the
  // start and the driver's house the finish. With a symmetric matrix the
  // solved order is simply reversed, so we solve 'to' and flip.
  const result = assignRiders(
    usableOffers.map(o => ({ id: o.id, capacity: o.capacity, startIndex: driverIndex.get(o.id) })),
    usableRequests.map(r => ({ id: r.id, stopIndex: riderIndex.get(r.id) })),
    0,
    matrix,
  );

  return {
    ok: true,
    provider: provider.name,
    leg,
    totalKm: result.totalKm,
    assignment: result.assignment,
    unassigned: result.unassigned,
    missingCoordinates,
    routes: result.routes
      .filter(r => r.riderIds.length)
      .map(r => ({ ...r, riderIds: leg === 'from' ? [...r.riderIds].reverse() : r.riderIds })),
  };
}
