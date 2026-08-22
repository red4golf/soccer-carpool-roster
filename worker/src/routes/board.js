import { HttpError, pooledTeamIds, projectPooledRequest } from '../lib/scope.js';
import { householdFor } from './me.js';

/**
 * The ride board for one team.
 *
 * Two projections come back in one payload:
 *   `requests`        — the caller's own team, full detail (still no addresses)
 *   `pooledRequests`  — other teams sharing a pool, reduced to first name and
 *                       pickup area only
 * Keeping them as separate arrays rather than one merged list with a flag
 * means a UI bug cannot accidentally render a pooled row with team fields it
 * was never given.
 */
export async function getBoard({ db, user, scope, url }) {
  const teamId = Number(url.searchParams.get('teamId'));
  if (!Number.isInteger(teamId)) throw new HttpError(400, 'A team is required.');

  const team = await db
    .prepare(`SELECT id, club_id, name, season FROM teams WHERE id = ? AND archived = 0`)
    .bind(teamId)
    .first();
  if (!team) throw new HttpError(404, 'Not found.', 'out_of_scope');

  // The single gate. Everything below is already known to be in scope.
  scope.requireTeam(team.id, team.club_id);

  const events = (
    await db
      .prepare(
        `SELECT e.id, e.event_type, e.title, e.event_date, e.start_time, e.notes,
                e.arrive_minutes_before, e.pool_id,
                l.name AS location_name, l.map_url, l.lat AS location_lat, l.lng AS location_lng
           FROM events e
           LEFT JOIN locations l ON l.id = e.location_id
          WHERE e.team_id = ? AND e.club_id = ?
          ORDER BY e.event_date, e.start_time`,
      )
      .bind(team.id, team.club_id)
      .all()
  ).results;

  const requestedEventId = Number(url.searchParams.get('eventId'));
  const selected =
    events.find(e => e.id === requestedEventId) ||
    events.find(e => `${e.event_date}T${e.start_time}` >= new Date().toISOString().slice(0, 16)) ||
    events.at(-1) ||
    null;

  if (!selected) {
    return { team, events, event: null, offers: [], requests: [], pooledRequests: [], household: null };
  }

  const household = await householdFor(db, user.id, team.club_id);

  const offers = (
    await db
      .prepare(
        `SELECT o.id, o.event_id, o.household_id, o.driver_name, o.driver_phone,
                o.vehicle_name, o.capacity, o.direction, o.notes, o.team_id,
                (SELECT COUNT(*) FROM assignments a WHERE a.offer_id = o.id AND a.leg = 'to')   AS used_to,
                (SELECT COUNT(*) FROM assignments a WHERE a.offer_id = o.id AND a.leg = 'from') AS used_from
           FROM driver_offers o
          WHERE o.event_id = ? AND o.club_id = ?
          ORDER BY o.created_at`,
      )
      .bind(selected.id, team.club_id)
      .all()
  ).results;

  const requests = (
    await db
      .prepare(
        `SELECT r.id, r.event_id, r.direction, r.notes, r.household_id, r.person_id,
                p.name AS person_name,
                pa.name AS pickup_area_name,
                loc.name AS pickup_location_name, loc.map_url AS pickup_location_map,
                r.pickup_kind,
                (SELECT a.offer_id FROM assignments a WHERE a.request_id = r.id AND a.leg = 'to')   AS offer_to,
                (SELECT a.offer_id FROM assignments a WHERE a.request_id = r.id AND a.leg = 'from') AS offer_from
           FROM ride_requests r
           JOIN people p ON p.id = r.person_id
           LEFT JOIN pickup_areas pa ON pa.id = r.pickup_area_id
           LEFT JOIN locations loc ON loc.id = r.pickup_location_id
          WHERE r.event_id = ? AND r.club_id = ?
          ORDER BY p.name`,
      )
      .bind(selected.id, team.club_id)
      .all()
  ).results;

  // --- the pooled exception ------------------------------------------------
  let pooledRequests = [];
  const poolTeams = await pooledTeamIds(db, scope, selected.id);
  const others = poolTeams.filter(id => id !== team.id);
  if (others.length && selected.pool_id) {
    const placeholders = others.map(() => '?').join(',');
    const rows = (
      await db
        .prepare(
          `SELECT r.id, r.event_id, r.direction, p.name AS person_name,
                  pa.name AS pickup_area_name,
                  (SELECT a.offer_id FROM assignments a WHERE a.request_id = r.id LIMIT 1) AS offer_id
             FROM ride_requests r
             JOIN people p ON p.id = r.person_id
             JOIN events e ON e.id = r.event_id
             LEFT JOIN pickup_areas pa ON pa.id = r.pickup_area_id
            WHERE e.pool_id = ? AND r.team_id IN (${placeholders})`,
        )
        .bind(selected.pool_id, ...others)
        .all()
    ).results;
    pooledRequests = rows.map(projectPooledRequest);
  }

  const mine = household?.id ?? -1;

  return {
    team,
    events,
    event: selected,
    household: household ? { id: household.id, pickupAreaId: household.pickup_area_id } : null,
    offers: offers.map(o => ({
      id: o.id,
      driverName: o.driver_name,
      // A phone number is only useful once you are actually in someone's car.
      driverPhone: o.household_id === mine || hasSharedRide(requests, o.id, mine) ? o.driver_phone : '',
      vehicleName: o.vehicle_name,
      capacity: o.capacity,
      direction: o.direction,
      notes: o.notes,
      usedTo: o.used_to,
      usedFrom: o.used_from,
      isMine: o.household_id === mine,
    })),
    requests: requests.map(r => ({
      id: r.id,
      personId: r.person_id,
      childName: r.person_name,
      direction: r.direction,
      notes: r.notes,
      pickupArea: r.pickup_area_name,
      pickupLocation: r.pickup_location_name,
      pickupLocationMap: r.pickup_location_map,
      pickupKind: r.pickup_kind,
      offerTo: r.offer_to,
      offerFrom: r.offer_from,
      isMine: r.household_id === mine,
      pooled: false,
    })),
    pooledRequests,
  };
}

/** True when this household is driving or riding in the given offer. */
function hasSharedRide(requests, offerId, householdId) {
  return requests.some(
    r => r.household_id === householdId && (r.offer_to === offerId || r.offer_from === offerId),
  );
}
