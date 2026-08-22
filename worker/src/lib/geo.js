// Geographic primitives and the pluggable distance-provider interface.
//
// The default provider is pure geometry: no API key, no network, no cost, and
// it works offline. That is the right default for a volunteer-run club — but
// straight-line distance is wrong wherever water, one-ways or bridges matter
// (on Bainbridge, that is most places). `MatrixProvider` is the seam where a
// real road-distance service slots in without touching the solver.

const EARTH_RADIUS_KM = 6371.0088;

const toRad = deg => (deg * Math.PI) / 180;

/** Great-circle distance in kilometres between two {lat, lng} points. */
export function haversineKm(a, b) {
  if (!isPoint(a) || !isPoint(b)) return Infinity;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function isPoint(p) {
  return (
    p != null &&
    Number.isFinite(p.lat) &&
    Number.isFinite(p.lng) &&
    Math.abs(p.lat) <= 90 &&
    Math.abs(p.lng) <= 180
  );
}

/**
 * Straight-line distance under-states real driving by a fairly predictable
 * factor. 1.3 is the usual planar-road rule of thumb; it is only used to make
 * the ETA readable, never to choose between routes (a constant multiplier
 * cannot change the ordering of candidate routes).
 */
export const ROAD_WINDING_FACTOR = 1.3;

/** Rough drive time in minutes, including a dwell allowance at each stop. */
export function estimateMinutes(distanceKm, stopCount, { avgSpeedKph = 40, dwellMinutes = 2 } = {}) {
  if (!Number.isFinite(distanceKm)) return null;
  return (distanceKm * ROAD_WINDING_FACTOR) / avgSpeedKph * 60 + stopCount * dwellMinutes;
}

/**
 * Distance-matrix provider contract.
 *
 *   matrix(points) -> number[][]   // km, [from][to], symmetric for haversine
 *
 * Implementations may be async. The solver only ever reads the matrix, so a
 * provider backed by OpenRouteService or Google Routes is a drop-in.
 */
export const haversineProvider = {
  name: 'haversine',
  async matrix(points) {
    const n = points.length;
    const m = Array.from({ length: n }, () => new Array(n).fill(0));
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const d = haversineKm(points[i], points[j]);
        m[i][j] = d;
        m[j][i] = d;
      }
    }
    return m;
  },
};

/**
 * OpenRouteService provider. Kept here rather than in a separate file so the
 * swap is a one-line change at the call site. Falls back to haversine when no
 * key is configured, so the system degrades to "works, slightly less precise"
 * instead of "breaks".
 */
export function openRouteServiceProvider(apiKey, { profile = 'driving-car' } = {}) {
  if (!apiKey) return haversineProvider;
  return {
    name: 'openrouteservice',
    async matrix(points) {
      const response = await fetch(
        `https://api.openrouteservice.org/v2/matrix/${profile}`,
        {
          method: 'POST',
          headers: { Authorization: apiKey, 'content-type': 'application/json' },
          // ORS takes [lng, lat] — the reverse of everything else here.
          body: JSON.stringify({
            locations: points.map(p => [p.lng, p.lat]),
            metrics: ['distance'],
            units: 'km',
          }),
        },
      );
      if (!response.ok) throw new Error(`Routing provider returned ${response.status}`);
      const payload = await response.json();
      if (!Array.isArray(payload.distances)) throw new Error('Routing provider returned no matrix');
      return payload.distances;
    },
  };
}

/**
 * Build a Google Maps directions URL for a driver to actually follow.
 * Waypoints are already in solved order, so `dir_action=navigate` opens turn
 * by turn without Google re-ordering anything.
 */
export function mapsDirectionsUrl(origin, stops, destination) {
  const fmt = p => (isPoint(p) ? `${p.lat.toFixed(6)},${p.lng.toFixed(6)}` : String(p ?? '').trim());
  const params = new URLSearchParams({
    api: '1',
    origin: fmt(origin),
    destination: fmt(destination),
    travelmode: 'driving',
  });
  const waypoints = stops.map(fmt).filter(Boolean);
  if (waypoints.length) params.set('waypoints', waypoints.join('|'));
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}
