import { HttpError, audit } from '../lib/scope.js';
import { integer, oneOf } from '../lib/validate.js';
import { planLeg } from '../lib/optimize.js';
import { haversineProvider, mapsDirectionsUrl, openRouteServiceProvider } from '../lib/geo.js';
import { householdFor } from './me.js';

const providerFor = env =>
  env.ORS_API_KEY ? openRouteServiceProvider(env.ORS_API_KEY) : haversineProvider;

/** Resolve the pickup point for a request without exposing it. */
function pickupPoint(row) {
  if (row.pickup_kind === 'override') return { lat: row.override_lat, lng: row.override_lng };
  if (row.pickup_kind === 'alternate') return { lat: row.alternate_lat, lng: row.alternate_lng };
  if (row.pickup_kind === 'location') return { lat: row.location_lat, lng: row.location_lng };
  return { lat: row.home_lat, lng: row.home_lng };
}

async function loadLegData(db, eventId) {
  const event = await db
    .prepare(
      `SELECT e.*, l.lat AS venue_lat, l.lng AS venue_lng, l.name AS venue_name
         FROM events e LEFT JOIN locations l ON l.id = e.location_id
        WHERE e.id = ?`,
    )
    .bind(eventId)
    .first();
  if (!event) throw new HttpError(404, 'Not found.', 'out_of_scope');

  const offers = (
    await db
      .prepare(
        `SELECT o.id, o.capacity, o.direction, o.driver_name, o.household_id,
                h.home_lat, h.home_lng
           FROM driver_offers o JOIN households h ON h.id = o.household_id
          WHERE o.event_id = ?`,
      )
      .bind(eventId)
      .all()
  ).results;

  const requests = (
    await db
      .prepare(
        `SELECT r.id, r.direction, r.pickup_kind, r.override_lat, r.override_lng,
                p.name AS person_name,
                h.home_lat, h.home_lng, h.alternate_lat, h.alternate_lng,
                loc.lat AS location_lat, loc.lng AS location_lng
           FROM ride_requests r
           JOIN people p ON p.id = r.person_id
           JOIN households h ON h.id = r.household_id
           LEFT JOIN locations loc ON loc.id = r.pickup_location_id
          WHERE r.event_id = ?`,
      )
      .bind(eventId)
      .all()
  ).results;

  return { event, offers, requests };
}

/**
 * Suggest who drives whom, for a whole event.
 *
 * Returns names and seat counts only — never a coordinate, never an address.
 * The optimiser needs the geometry; the coordinator reading the result does
 * not, so it never leaves the worker. Suggestions are advisory: nothing is
 * written until a human accepts them.
 */
export async function planRoutes({ db, env, scope, user, body, ip }) {
  const eventId = integer(body.eventId, { field: 'Event' });
  const leg = oneOf(body.leg ?? 'to', ['to', 'from'], 'Leg');

  const { event, offers, requests } = await loadLegData(db, eventId);
  scope.requireTeam(event.team_id, event.club_id);
  scope.require('override_assignment', { teamId: event.team_id, clubId: event.club_id });

  const relevantOffers = offers.filter(o => o.direction === leg || o.direction === 'roundtrip');
  const relevantRequests = requests.filter(r => r.direction === leg || r.direction === 'roundtrip');

  const plan = await planLeg({
    leg,
    venue: { lat: event.venue_lat, lng: event.venue_lng },
    offers: relevantOffers.map(o => ({
      id: o.id,
      capacity: o.capacity,
      origin: { lat: o.home_lat, lng: o.home_lng },
    })),
    requests: relevantRequests.map(r => ({ id: r.id, pickup: pickupPoint(r) })),
    provider: providerFor(env),
  });

  if (!plan.ok) throw new HttpError(400, plan.error);

  const driverName = new Map(relevantOffers.map(o => [o.id, o.driver_name]));
  const childName = new Map(relevantRequests.map(r => [r.id, r.person_name]));

  await audit(db, {
    clubId: event.club_id,
    actor: user,
    action: 'plan_computed',
    subjectType: 'event',
    subjectId: eventId,
    reason: `Suggested ${leg} routes using ${plan.provider}`,
    ip,
  });

  return {
    ok: true,
    leg,
    provider: plan.provider,
    totalKm: Number(plan.totalKm.toFixed(2)),
    routes: plan.routes.map(r => ({
      offerId: r.driverId,
      driverName: driverName.get(r.driverId) || 'Driver',
      distanceKm: Number(r.distanceKm.toFixed(2)),
      durationMin: Math.round(r.durationMin),
      exact: r.exact,
      riders: r.riderIds.map(id => ({ requestId: id, childName: childName.get(id) || 'Player' })),
    })),
    unassigned: plan.unassigned.map(id => ({ requestId: id, childName: childName.get(id) || 'Player' })),
    needsAddress: plan.missingCoordinates.map(id => ({
      requestId: id,
      childName: childName.get(id) || 'Player',
    })),
  };
}

/** Accept a suggested plan, writing the assignments a coordinator approved. */
export async function acceptPlan({ db, scope, user, body, ip }) {
  const eventId = integer(body.eventId, { field: 'Event' });
  const leg = oneOf(body.leg ?? 'to', ['to', 'from'], 'Leg');
  const pairs = Array.isArray(body.assignments) ? body.assignments : [];

  const { event } = await loadLegData(db, eventId);
  scope.requireTeam(event.team_id, event.club_id);
  scope.require('override_assignment', { teamId: event.team_id, clubId: event.club_id });

  let written = 0;
  for (const pair of pairs.slice(0, 200)) {
    const requestId = integer(pair.requestId, { field: 'Request' });
    const offerId = integer(pair.offerId, { field: 'Offer' });
    const result = await db
      .prepare(
        `INSERT INTO assignments (club_id, request_id, offer_id, leg, assigned_by, source)
         SELECT ?, ?, ?, ?, ?, 'suggested'
          WHERE EXISTS (SELECT 1 FROM ride_requests WHERE id = ? AND event_id = ? AND club_id = ?)
            AND EXISTS (SELECT 1 FROM driver_offers  WHERE id = ? AND event_id = ? AND club_id = ?)
            AND (SELECT COUNT(*) FROM assignments WHERE offer_id = ? AND leg = ?)
                < (SELECT capacity FROM driver_offers WHERE id = ?)
         ON CONFLICT (request_id, leg) DO NOTHING
         RETURNING id`,
      )
      .bind(
        event.club_id, requestId, offerId, leg, user.id,
        requestId, eventId, event.club_id,
        offerId, eventId, event.club_id,
        offerId, leg, offerId,
      )
      .first();
    if (result) written++;
  }

  await audit(db, {
    clubId: event.club_id,
    actor: user,
    action: 'plan_accepted',
    subjectType: 'event',
    subjectId: eventId,
    reason: `Accepted ${written} suggested ${leg} assignments`,
    ip,
  });

  return { ok: true, written };
}

/**
 * The driver's own turn-by-turn link, with stops already in the right order.
 *
 * This is the one place addresses are converted into a map URL, so it is the
 * one place that logs a reveal for every household in the car.
 */
export async function openRoute({ db, env, scope, user, body, ip }) {
  const offerId = integer(body.offerId, { field: 'Offer' });
  const leg = oneOf(body.leg ?? 'to', ['to', 'from'], 'Leg');

  const offer = await db
    .prepare(
      `SELECT o.*, h.home_lat, h.home_lng, h.home_address,
              e.team_id AS event_team, e.club_id AS event_club,
              l.lat AS venue_lat, l.lng AS venue_lng, l.name AS venue_name
         FROM driver_offers o
         JOIN households h ON h.id = o.household_id
         JOIN events e ON e.id = o.event_id
         LEFT JOIN locations l ON l.id = e.location_id
        WHERE o.id = ?`,
    )
    .bind(offerId)
    .first();
  if (!offer) throw new HttpError(404, 'Not found.', 'out_of_scope');
  scope.requireTeam(offer.team_id, offer.club_id);

  const household = await householdFor(db, user.id, offer.club_id);
  const isDriver = household && household.id === offer.household_id;
  if (!isDriver) throw new HttpError(403, 'Only the driver can open this route.');

  const riders = (
    await db
      .prepare(
        `SELECT r.id, r.pickup_kind, r.override_lat, r.override_lng, r.household_id,
                p.name AS person_name,
                h.home_lat, h.home_lng, h.alternate_lat, h.alternate_lng,
                loc.lat AS location_lat, loc.lng AS location_lng
           FROM assignments a
           JOIN ride_requests r ON r.id = a.request_id
           JOIN people p ON p.id = r.person_id
           JOIN households h ON h.id = r.household_id
           LEFT JOIN locations loc ON loc.id = r.pickup_location_id
          WHERE a.offer_id = ? AND a.leg = ?`,
      )
      .bind(offerId, leg)
      .all()
  ).results;

  if (!riders.length) throw new HttpError(400, 'No riders are assigned to this trip yet.');

  const venue = { lat: offer.venue_lat, lng: offer.venue_lng };
  const plan = await planLeg({
    leg,
    venue,
    offers: [{ id: offer.id, capacity: riders.length, origin: { lat: offer.home_lat, lng: offer.home_lng } }],
    requests: riders.map(r => ({ id: r.id, pickup: pickupPoint(r) })),
    provider: providerFor(env),
  });
  if (!plan.ok) throw new HttpError(400, plan.error);

  const byId = new Map(riders.map(r => [r.id, r]));
  const ordered = (plan.routes[0]?.riderIds ?? riders.map(r => r.id)).map(id => byId.get(id)).filter(Boolean);
  const points = ordered.map(pickupPoint);

  const url =
    leg === 'to'
      ? mapsDirectionsUrl({ lat: offer.home_lat, lng: offer.home_lng }, points, venue)
      : mapsDirectionsUrl(venue, points, { lat: offer.home_lat, lng: offer.home_lng });

  for (const rider of ordered) {
    if (rider.household_id === household.id) continue;
    await audit(db, {
      clubId: offer.club_id,
      actor: user,
      action: 'route_opened',
      subjectType: 'household',
      subjectId: rider.household_id,
      reason: `Driver opened the ${leg === 'to' ? 'pickup' : 'drop-off'} route`,
      ip,
    });
  }

  await db
    .prepare(
      `INSERT INTO routes (club_id, offer_id, leg, stop_order, distance_km, duration_min, provider)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT (offer_id, leg) DO UPDATE SET
         stop_order = excluded.stop_order, distance_km = excluded.distance_km,
         duration_min = excluded.duration_min, provider = excluded.provider,
         computed_at = datetime('now')`,
    )
    .bind(
      offer.club_id,
      offerId,
      leg,
      JSON.stringify(ordered.map(r => r.id)),
      plan.routes[0]?.distanceKm ?? null,
      plan.routes[0]?.durationMin ?? null,
      plan.provider,
    )
    .run();

  return {
    ok: true,
    url,
    leg,
    venueName: offer.venue_name,
    distanceKm: plan.routes[0] ? Number(plan.routes[0].distanceKm.toFixed(2)) : null,
    durationMin: plan.routes[0] ? Math.round(plan.routes[0].durationMin) : null,
    stops: ordered.map(r => ({ requestId: r.id, childName: r.person_name })),
  };
}
