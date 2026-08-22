import { HttpError, audit, pooledTeamIds } from '../lib/scope.js';
import { integer, oneOf, phone, text } from '../lib/validate.js';
import { householdFor } from './me.js';

const LEGS = { to: ['to'], from: ['from'], roundtrip: ['to', 'from'] };

/** Load an event and prove the caller may act on it. */
async function scopedEvent(db, scope, eventId) {
  const event = await db
    .prepare(
      `SELECT e.*, l.lat AS location_lat, l.lng AS location_lng, l.name AS location_name
         FROM events e LEFT JOIN locations l ON l.id = e.location_id
        WHERE e.id = ?`,
    )
    .bind(eventId)
    .first();
  if (!event) throw new HttpError(404, 'Not found.', 'out_of_scope');
  scope.requireTeam(event.team_id, event.club_id);
  return event;
}

export async function rideAction(context) {
  const action = String(context.body.action || '');
  const handlers = {
    request_ride: requestRide,
    cancel_ride: cancelRide,
    offer_drive: offerDrive,
    cancel_offer: cancelOffer,
    claim: claim,
    unclaim: unclaim,
    reveal_pickup: revealPickup,
  };
  const handler = handlers[action];
  if (!handler) throw new HttpError(400, 'Unknown action.');
  return handler(context);
}

// ---------------------------------------------------------------------------

async function requestRide({ db, user, scope, body }) {
  const event = await scopedEvent(db, scope, integer(body.eventId, { field: 'Event' }));
  scope.require('request_ride', { teamId: event.team_id, clubId: event.club_id });

  const household = await householdFor(db, user.id, event.club_id);
  if (!household) throw new HttpError(400, 'Complete your family profile first.');

  const direction = oneOf(body.direction, ['to', 'from', 'roundtrip'], 'Trip');
  const pickupKind = oneOf(body.pickupKind ?? 'home', ['home', 'alternate', 'location', 'override'], 'Pickup');

  const personIds = (Array.isArray(body.personIds) ? body.personIds : [body.personId])
    .map(id => integer(id, { field: 'Child' }))
    .filter(Boolean);
  if (!personIds.length) throw new HttpError(400, 'Choose at least one child.');

  const created = [];
  for (const personId of personIds) {
    // A parent may only request rides for a child in their own household who
    // is actually rostered on this event's team.
    const person = await db
      .prepare(
        `SELECT p.id, p.name FROM people p
           JOIN enrollments en ON en.person_id = p.id AND en.team_id = ?
          WHERE p.id = ? AND p.household_id = ? AND p.club_id = ?`,
      )
      .bind(event.team_id, personId, household.id, event.club_id)
      .first();
    if (!person) throw new HttpError(400, 'That child is not on this team.');

    let pickupLocationId = null;
    if (pickupKind === 'location') {
      pickupLocationId = integer(body.pickupLocationId, { field: 'Pickup location' });
      const location = await db
        .prepare(`SELECT id FROM locations WHERE id = ? AND club_id = ?`)
        .bind(pickupLocationId, event.club_id)
        .first();
      if (!location) throw new HttpError(400, 'That pickup location is not part of this club.');
    }
    if (pickupKind === 'home' && !household.home_address) {
      throw new HttpError(400, 'Add your home address before requesting a home pickup.');
    }

    const result = await db
      .prepare(
        `INSERT INTO ride_requests
           (club_id, team_id, event_id, person_id, household_id, requested_by, direction,
            pickup_kind, pickup_location_id, pickup_area_id, override_address, notes)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT (event_id, person_id, direction) DO NOTHING
         RETURNING id`,
      )
      .bind(
        event.club_id,
        event.team_id,
        event.id,
        personId,
        household.id,
        user.id,
        direction,
        pickupKind,
        pickupLocationId,
        household.pickup_area_id,
        pickupKind === 'override' ? text(body.overrideAddress, { field: 'Address', max: 300, required: true }) : '',
        text(body.notes, { field: 'Notes', max: 200 }),
      )
      .first();
    if (result) created.push(result.id);
  }

  return { ok: true, created };
}

async function cancelRide({ db, user, scope, body }) {
  const requestId = integer(body.requestId, { field: 'Request' });
  const request = await db
    .prepare(`SELECT * FROM ride_requests WHERE id = ?`)
    .bind(requestId)
    .first();
  if (!request) throw new HttpError(404, 'Not found.', 'out_of_scope');
  scope.requireTeam(request.team_id, request.club_id);

  const household = await householdFor(db, user.id, request.club_id);
  const isOwner = household && household.id === request.household_id;
  const isAdmin = scope.can('override_assignment', { teamId: request.team_id, clubId: request.club_id });
  if (!isOwner && !isAdmin) throw new HttpError(404, 'Not found.', 'out_of_scope');

  await db.prepare(`DELETE FROM ride_requests WHERE id = ? AND club_id = ?`).bind(requestId, request.club_id).run();
  return { ok: true };
}

// ---------------------------------------------------------------------------

async function offerDrive({ db, user, scope, body }) {
  const event = await scopedEvent(db, scope, integer(body.eventId, { field: 'Event' }));
  scope.require('offer_drive', { teamId: event.team_id, clubId: event.club_id });

  const household = await householdFor(db, user.id, event.club_id);
  if (!household) throw new HttpError(400, 'Complete your family profile first.');

  let vehicleName = text(body.vehicleName, { field: 'Vehicle', max: 80 });
  const vehicleId = integer(body.vehicleId, { field: 'Vehicle', required: false });
  if (vehicleId != null) {
    const vehicle = await db
      .prepare(`SELECT id, name, seat_capacity FROM vehicles WHERE id = ? AND household_id = ?`)
      .bind(vehicleId, household.id)
      .first();
    if (!vehicle) throw new HttpError(400, 'That vehicle is not in your household.');
    vehicleName = vehicle.name;
  }

  const offer = await db
    .prepare(
      `INSERT INTO driver_offers
         (club_id, team_id, event_id, household_id, driver_user_id, driver_name, driver_phone,
          vehicle_id, vehicle_name, capacity, direction, notes)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
    )
    .bind(
      event.club_id,
      event.team_id,
      event.id,
      household.id,
      user.id,
      text(body.driverName || user.display_name, { field: 'Driver', max: 120, required: true }),
      phone(body.driverPhone || user.phone, { required: true }),
      vehicleId,
      vehicleName,
      integer(body.capacity, { field: 'Seats', min: 1, max: 8 }),
      oneOf(body.direction, ['to', 'from', 'roundtrip'], 'Trip'),
      text(body.notes, { field: 'Notes', max: 200 }),
    )
    .first();

  return { ok: true, offerId: offer.id };
}

async function cancelOffer({ db, user, scope, body }) {
  const offerId = integer(body.offerId, { field: 'Offer' });
  const offer = await db.prepare(`SELECT * FROM driver_offers WHERE id = ?`).bind(offerId).first();
  if (!offer) throw new HttpError(404, 'Not found.', 'out_of_scope');
  scope.requireTeam(offer.team_id, offer.club_id);

  const household = await householdFor(db, user.id, offer.club_id);
  const isOwner = household && household.id === offer.household_id;
  const isAdmin = scope.can('override_assignment', { teamId: offer.team_id, clubId: offer.club_id });
  if (!isOwner && !isAdmin) throw new HttpError(404, 'Not found.', 'out_of_scope');

  const riders = await db
    .prepare(`SELECT COUNT(*) AS n FROM assignments WHERE offer_id = ?`)
    .bind(offerId)
    .first();
  if (riders.n > 0 && !isAdmin) {
    throw new HttpError(
      409,
      'Remove your riders first so their families are told they need another ride.',
    );
  }

  await db.prepare(`DELETE FROM driver_offers WHERE id = ? AND club_id = ?`).bind(offerId, offer.club_id).run();
  return { ok: true };
}

// ---------------------------------------------------------------------------

/**
 * Put a child in a car.
 *
 * Capacity is enforced by a conditional INSERT rather than a read-then-write,
 * so two parents tapping "add to my car" at the same moment cannot both win
 * the last seat. The UNIQUE(request_id, leg) constraint separately guarantees
 * one child is never in two cars for the same leg.
 */
async function claim({ db, user, scope, body, ip }) {
  const requestId = integer(body.requestId, { field: 'Request' });
  const offerId = integer(body.offerId, { field: 'Offer' });

  const request = await db.prepare(`SELECT * FROM ride_requests WHERE id = ?`).bind(requestId).first();
  const offer = await db.prepare(`SELECT * FROM driver_offers WHERE id = ?`).bind(offerId).first();
  if (!request || !offer) throw new HttpError(404, 'Not found.', 'out_of_scope');
  if (request.club_id !== offer.club_id) throw new HttpError(404, 'Not found.', 'out_of_scope');

  scope.requireTeam(offer.team_id, offer.club_id);

  // Cross-team claims are allowed only through an active pool.
  if (request.team_id !== offer.team_id) {
    const pool = await pooledTeamIds(db, scope, request.event_id);
    if (!pool.includes(request.team_id) || !pool.includes(offer.team_id)) {
      throw new HttpError(404, 'Not found.', 'out_of_scope');
    }
  }

  const household = await householdFor(db, user.id, offer.club_id);
  const isDriver = household && household.id === offer.household_id;
  const isAdmin = scope.can('override_assignment', { teamId: offer.team_id, clubId: offer.club_id });
  if (!isDriver && !isAdmin) throw new HttpError(403, 'Only the driver can add riders to their car.');

  const legs = LEGS[request.direction].filter(leg => LEGS[offer.direction].includes(leg));
  if (!legs.length) throw new HttpError(400, 'That car is not going the same way.');

  const claimed = [];
  for (const leg of legs) {
    const result = await db
      .prepare(
        `INSERT INTO assignments (club_id, request_id, offer_id, leg, assigned_by, source)
         SELECT ?, ?, ?, ?, ?, ?
          WHERE (SELECT COUNT(*) FROM assignments WHERE offer_id = ? AND leg = ?)
                < (SELECT capacity FROM driver_offers WHERE id = ?)
         ON CONFLICT (request_id, leg) DO NOTHING
         RETURNING id`,
      )
      .bind(offer.club_id, requestId, offerId, leg, user.id, isAdmin && !isDriver ? 'admin' : 'manual', offerId, leg, offerId)
      .first();
    if (result) claimed.push(leg);
  }

  if (!claimed.length) throw new HttpError(409, 'That car is already full for this trip.');

  await audit(db, {
    clubId: offer.club_id,
    actor: user,
    action: 'ride_assigned',
    subjectType: 'ride_request',
    subjectId: requestId,
    reason: `Assigned to offer ${offerId} (${claimed.join(', ')})`,
    ip,
  });

  return { ok: true, legs: claimed };
}

async function unclaim({ db, user, scope, body }) {
  const requestId = integer(body.requestId, { field: 'Request' });
  const request = await db.prepare(`SELECT * FROM ride_requests WHERE id = ?`).bind(requestId).first();
  if (!request) throw new HttpError(404, 'Not found.', 'out_of_scope');
  scope.requireTeam(request.team_id, request.club_id);

  const household = await householdFor(db, user.id, request.club_id);
  const rows = (
    await db
      .prepare(
        `SELECT a.id, a.leg, o.household_id
           FROM assignments a JOIN driver_offers o ON o.id = a.offer_id
          WHERE a.request_id = ?`,
      )
      .bind(requestId)
      .all()
  ).results;

  const isAdmin = scope.can('override_assignment', { teamId: request.team_id, clubId: request.club_id });
  const removable = rows.filter(
    r => isAdmin || (household && (r.household_id === household.id || request.household_id === household.id)),
  );
  if (!removable.length) throw new HttpError(404, 'Not found.', 'out_of_scope');

  for (const row of removable) {
    await db.prepare(`DELETE FROM assignments WHERE id = ?`).bind(row.id).run();
  }
  return { ok: true, removed: removable.length };
}

// ---------------------------------------------------------------------------

/**
 * Release one household's exact address to the driver actually carrying the
 * child — the single most sensitive operation in the system. Requires an
 * existing assignment, and is always logged with the driver's identity.
 */
async function revealPickup({ db, user, scope, body, ip }) {
  const requestId = integer(body.requestId, { field: 'Request' });

  const row = await db
    .prepare(
      `SELECT r.*, h.home_address, h.home_lat, h.home_lng,
              h.alternate_address, h.alternate_lat, h.alternate_lng,
              o.household_id AS driver_household_id, p.name AS person_name
         FROM ride_requests r
         JOIN households h ON h.id = r.household_id
         JOIN people p ON p.id = r.person_id
         JOIN assignments a ON a.request_id = r.id
         JOIN driver_offers o ON o.id = a.offer_id
        WHERE r.id = ? LIMIT 1`,
    )
    .bind(requestId)
    .first();

  if (!row) throw new HttpError(404, 'Not found.', 'out_of_scope');
  scope.requireTeam(row.team_id, row.club_id);

  const household = await householdFor(db, user.id, row.club_id);
  const isAssignedDriver = household && household.id === row.driver_household_id;
  const isOwnFamily = household && household.id === row.household_id;
  if (!isAssignedDriver && !isOwnFamily) {
    throw new HttpError(403, 'Only the assigned driver can see this pickup address.');
  }

  const useAlternate = row.pickup_kind === 'alternate';
  const address = row.pickup_kind === 'override'
    ? row.override_address
    : useAlternate
      ? row.alternate_address
      : row.home_address;

  if (!isOwnFamily) {
    await audit(db, {
      clubId: row.club_id,
      actor: user,
      action: 'address_revealed',
      subjectType: 'household',
      subjectId: row.household_id,
      reason: `Assigned driver opened pickup for ${row.person_name}`,
      ip,
    });
  }

  return {
    ok: true,
    address,
    lat: useAlternate ? row.alternate_lat : row.home_lat,
    lng: useAlternate ? row.alternate_lng : row.home_lng,
    logged: !isOwnFamily,
  };
}
