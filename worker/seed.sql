-- Demo data for local development.
--
-- Two clubs so tenant isolation is visible immediately: sign in as a Riverside
-- parent and Harbor United should not exist as far as the app is concerned.
--
-- Every address here is fictional. Coordinates are real Bainbridge Island
-- locations so the route optimiser produces sensible-looking results.

INSERT INTO clubs (id, name, slug, allow_cross_team_pools) VALUES
  (1, 'Riverside FC', 'riverside', 1),
  (2, 'Harbor United', 'harbor', 0);

INSERT INTO teams (id, club_id, name, season, age_group) VALUES
  (1, 1, 'Riverside 2014 Red',  '2026', 'U12'),
  (2, 1, 'Riverside 2014 Gold', '2026', 'U12'),
  (3, 2, 'Harbor 2013 Blue',    '2026', 'U13');

INSERT INTO pickup_areas (id, club_id, name, lat, lng) VALUES
  (1, 1, 'Winslow',      47.6237, -122.5199),
  (2, 1, 'Rolling Bay',  47.6702, -122.4869),
  (3, 1, 'Lynwood',      47.5931, -122.5350),
  (4, 2, 'Poulsbo',      47.7362, -122.6465);

INSERT INTO locations (id, club_id, name, address, map_url, lat, lng) VALUES
  (1, 1, 'Battle Point Park', 'Battle Point Dr NE, Bainbridge Island, WA',
      'https://www.google.com/maps/search/?api=1&query=47.6631,-122.5615', 47.6631, -122.5615),
  (2, 1, 'Strawberry Hill Park', 'Madison Ave N, Bainbridge Island, WA',
      'https://www.google.com/maps/search/?api=1&query=47.6376,-122.5296', 47.6376, -122.5296),
  (3, 2, 'Poulsbo Fields', 'Poulsbo, WA',
      'https://www.google.com/maps/search/?api=1&query=47.7362,-122.6465', 47.7362, -122.6465);

-- Users. firebase_uid values are placeholders; replace them with real UIDs
-- (Firebase console > Authentication) to sign in as these people locally.
INSERT INTO users (id, firebase_uid, email, email_verified, display_name, phone, is_platform_admin) VALUES
  (1, 'seed-admin',  'admin@riverside.example',  1, 'Club Administrator', '206-555-0100', 0),
  (2, 'seed-parent1','morgan@example.com',       1, 'Morgan Lee',         '206-555-0111', 0),
  (3, 'seed-parent2','sam@example.com',          1, 'Sam Delgado',        '206-555-0122', 0),
  (4, 'seed-parent3','riley@example.com',        1, 'Riley Okonkwo',      '206-555-0133', 0),
  (5, 'seed-harbor', 'jordan@example.com',       1, 'Jordan Vance',       '206-555-0144', 0);

INSERT INTO memberships (club_id, team_id, user_id, role, status, approved_at) VALUES
  (1, NULL, 1, 'club_admin', 'active', datetime('now')),
  (1, 1,    2, 'parent',     'active', datetime('now')),
  (1, 1,    3, 'parent',     'active', datetime('now')),
  -- Riley has a child on each Riverside team: the sibling case.
  (1, 1,    4, 'parent',     'active', datetime('now')),
  (1, 2,    4, 'parent',     'active', datetime('now')),
  (2, 3,    5, 'parent',     'active', datetime('now'));

INSERT INTO households (id, club_id, name, pickup_area_id, home_address, home_lat, home_lng) VALUES
  (1, 1, 'Lee household',     1, '100 Ericksen Ave NE, Bainbridge Island, WA',  47.6249, -122.5188),
  (2, 1, 'Delgado household', 2, '900 NE Valley Rd, Bainbridge Island, WA',     47.6688, -122.4901),
  (3, 1, 'Okonkwo household', 3, '500 Lynwood Center Rd NE, Bainbridge, WA',    47.5943, -122.5341),
  (4, 2, 'Vance household',   4, '200 Front St, Poulsbo, WA',                   47.7350, -122.6450);

INSERT INTO household_members (club_id, household_id, user_id, name, phone) VALUES
  (1, 1, 2, 'Morgan Lee',    '206-555-0111'),
  (1, 2, 3, 'Sam Delgado',   '206-555-0122'),
  (1, 3, 4, 'Riley Okonkwo', '206-555-0133'),
  (2, 4, 5, 'Jordan Vance',  '206-555-0144');

INSERT INTO vehicles (club_id, household_id, name, seat_capacity, sort_order) VALUES
  (1, 1, 'Blue Subaru Outback', 3, 0),
  (1, 2, 'Grey Honda Odyssey',  5, 0),
  (1, 3, 'White VW Atlas',      4, 0),
  (2, 4, 'Red Toyota Sienna',   5, 0);

INSERT INTO people (id, club_id, household_id, name) VALUES
  (1, 1, 1, 'Avery Lee'),
  (2, 1, 2, 'Casey Delgado'),
  (3, 1, 3, 'Devon Okonkwo'),
  (4, 1, 3, 'Elliot Okonkwo'),   -- Devon's sibling, on the other team
  (5, 2, 4, 'Frankie Vance');

INSERT INTO enrollments (club_id, team_id, person_id) VALUES
  (1, 1, 1),
  (1, 1, 2),
  (1, 1, 3),
  (1, 2, 4),   -- sibling on Riverside Gold
  (2, 3, 5);

INSERT INTO events (id, club_id, team_id, location_id, event_type, title, event_date, start_time, notes) VALUES
  (1, 1, 1, 1, 'game',     'Red vs Kitsap Rangers',  '2026-09-12', '09:00', 'Arrive 30 minutes early'),
  (2, 1, 1, 2, 'practice', 'Tuesday practice',       '2026-09-15', '17:15', ''),
  (3, 1, 2, 1, 'game',     'Gold vs Kitsap Rangers', '2026-09-12', '11:00', 'Same field as Red'),
  (4, 2, 3, 3, 'game',     'Blue vs Silverdale',     '2026-09-12', '10:00', '');

-- A pool joining the two Riverside games at Battle Point on the same morning.
-- Both teams have opted in, which is what makes the sibling case work: Riley
-- can put Devon and Elliot in one car even though they play for different
-- teams. Harbor United is a different club and cannot participate at all.
INSERT INTO carpool_pools (id, club_id, location_id, pool_date, window_start, window_end, created_by)
VALUES (1, 1, 1, '2026-09-12', '08:00', '13:00', 1);

INSERT INTO pool_teams (pool_id, team_id, club_id, opted_in_by) VALUES
  (1, 1, 1, 1),
  (1, 2, 1, 1);

UPDATE events SET pool_id = 1 WHERE id IN (1, 3);

INSERT INTO ride_requests (club_id, team_id, event_id, person_id, household_id, requested_by, direction, pickup_kind, pickup_area_id) VALUES
  (1, 1, 1, 1, 1, 2, 'roundtrip', 'home', 1),
  (1, 1, 1, 3, 3, 4, 'roundtrip', 'home', 3),
  (1, 2, 3, 4, 3, 4, 'roundtrip', 'home', 3);

INSERT INTO driver_offers (club_id, team_id, event_id, household_id, driver_user_id, driver_name, driver_phone, vehicle_name, capacity, direction) VALUES
  (1, 1, 1, 2, 3, 'Sam Delgado', '206-555-0122', 'Grey Honda Odyssey', 4, 'roundtrip');
