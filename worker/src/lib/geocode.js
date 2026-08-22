// Turning a street address into coordinates.
//
// PRIVACY NOTE, because this is the one place the system deliberately sends a
// family's home address to a third party.
//
// Route optimization needs coordinates, and a parent typing "100 Ericksen Ave
// NE" cannot supply them. Somebody has to resolve it. The trade is made as
// narrow as we can:
//
//   * The lookup happens on the WORKER, never in the browser, so the family's
//     IP address and browser fingerprint are never exposed to the geocoder —
//     only an address string, arriving from a datacentre.
//   * Nothing identifying goes with it. No child name, no parent name, no
//     club, no team, no household id. The geocoder sees an address and
//     nothing that connects it to a person.
//   * The result is stored, so an address is looked up once and never again.
//   * It is optional. A family that declines simply has no coordinates, and
//     the planner reports them under `needsAddress` rather than guessing.
//
// The UI says this in plain language before the address is saved. Quietly
// shipping children's home addresses to a third party would not be defensible
// just because it is convenient.

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';

/**
 * Nominatim asks for a real User-Agent identifying the application, and rate
 * limits to roughly one request per second. Both are honoured below. Their
 * policy also discourages bulk/systematic use — see docs/ROUTING.md for when
 * a club outgrows this and should self-host or pay for a geocoder.
 */
const USER_AGENT = 'SoccerCarpool/1.0 (club carpool coordination; contact via repository)';

export class GeocodeResult {
  constructor({ lat, lng, label, confidence }) {
    this.lat = lat;
    this.lng = lng;
    this.label = label;
    this.confidence = confidence;
  }
}

/**
 * Nominatim (OpenStreetMap). Free, no key, no account.
 *
 * @param address    free-text street address
 * @param options.timeoutMs  give up rather than holding a parent's save open
 * @param options.countryCodes  bias results; wrong-country matches are the
 *                              most common way a geocoder confidently returns
 *                              a house 3,000 miles from the right one
 */
export async function geocodeNominatim(address, { timeoutMs = 4000, countryCodes = 'us' } = {}) {
  const query = String(address ?? '').trim();
  if (query.length < 6) return null;

  const url = new URL(NOMINATIM);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', '1');
  url.searchParams.set('addressdetails', '0');
  if (countryCodes) url.searchParams.set('countrycodes', countryCodes);

  let response;
  try {
    response = await fetch(url, {
      headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return null; // timeout or network failure — treated as "not found"
  }
  if (!response.ok) return null;

  let payload;
  try {
    payload = await response.json();
  } catch {
    return null;
  }
  if (!Array.isArray(payload) || !payload.length) return null;

  const hit = payload[0];
  const lat = Number(hit.lat);
  const lng = Number(hit.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  return new GeocodeResult({
    lat,
    lng,
    label: String(hit.display_name || '').slice(0, 300),
    confidence: classify(hit),
  });
}

/**
 * How much to trust the match.
 *
 * This matters more than it looks: a geocoder that confidently returns the
 * centre of a city for an unrecognised street produces a pickup pin a mile
 * from the actual house, and a driver who cannot find the child. A low
 * confidence is surfaced to the family for confirmation rather than silently
 * stored as fact.
 */
function classify(hit) {
  const type = String(hit.type || '');
  const category = String(hit.category || '');
  const importance = Number(hit.importance ?? 0);

  // A specific building or address point is what we actually want.
  if (['house', 'building', 'residential'].includes(type) || category === 'building') return 'exact';
  if (type === 'road' || category === 'highway') return 'street';
  // Anything that resolved to a whole place is too coarse for a doorstep.
  if (['city', 'town', 'village', 'suburb', 'neighbourhood', 'administrative'].includes(type)) return 'area';
  return importance > 0.5 ? 'street' : 'approximate';
}

/** Pluggable, so a club can swap in a paid geocoder without touching callers. */
export function geocoderFor(env) {
  if (env?.GEOCODER === 'off') return async () => null;
  return address => geocodeNominatim(address, { countryCodes: env?.GEOCODE_COUNTRIES || 'us' });
}

/**
 * Geocode several addresses while respecting the one-per-second limit.
 * Used only by the admin backfill, never on a parent's request path.
 */
export async function geocodeSequential(items, geocoder, { delayMs = 1100, onResult } = {}) {
  const results = [];
  for (let i = 0; i < items.length; i++) {
    if (i > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
    const result = await geocoder(items[i].address);
    results.push({ ...items[i], result });
    onResult?.(items[i], result);
  }
  return results;
}
