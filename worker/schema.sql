-- Soccer Carpool — club-scale multi-tenant schema
--
-- ISOLATION MODEL (see docs/TENANCY.md for the full rationale)
--
--   club ──< team ──< event ──< ride_request
--                 └──< membership >── user
--   club ──< household ──< person ──< enrollment >── team
--
-- Every tenant-scoped row carries club_id even when it is derivable through a
-- join. That redundancy is deliberate: it lets every query filter on club_id
-- directly, so a query that forgets its scope returns nothing rather than
-- returning another club's data. Fail closed, not open.
--
-- The three tables that DO NOT carry club_id are users, sessions and
-- audit_log — identity and forensics are deliberately cross-club so that one
-- person has one login across every club their kids play in.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Identity (global, not club-scoped)
-- ---------------------------------------------------------------------------

CREATE TABLE users (
  id             INTEGER PRIMARY KEY,
  firebase_uid   TEXT NOT NULL UNIQUE,
  email          TEXT NOT NULL,
  email_verified INTEGER NOT NULL DEFAULT 0,
  display_name   TEXT NOT NULL DEFAULT '',
  phone          TEXT NOT NULL DEFAULT '',
  is_platform_admin INTEGER NOT NULL DEFAULT 0,  -- reserved for the operator
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at   TEXT
);
CREATE INDEX idx_users_email ON users(email);

-- ---------------------------------------------------------------------------
-- Tenants
-- ---------------------------------------------------------------------------

CREATE TABLE clubs (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  slug       TEXT NOT NULL UNIQUE,
  timezone   TEXT NOT NULL DEFAULT 'America/Los_Angeles',
  -- Club-wide policy switches. Pooling is OFF by default: cross-team
  -- visibility must be a deliberate act, never a default.
  allow_cross_team_pools INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE teams (
  id         INTEGER PRIMARY KEY,
  club_id    INTEGER NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  season     TEXT NOT NULL DEFAULT '',
  age_group  TEXT NOT NULL DEFAULT '',
  archived   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (club_id, name, season)
);
CREATE INDEX idx_teams_club ON teams(club_id, archived);

-- ---------------------------------------------------------------------------
-- Membership — THE isolation primitive
--
-- A user sees a team's data if and only if a row exists here. There is no
-- other path to team data anywhere in the API. Roles are per-team, so the
-- same person can be a parent on one team and an admin on another.
-- ---------------------------------------------------------------------------

CREATE TABLE memberships (
  id         INTEGER PRIMARY KEY,
  club_id    INTEGER NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  team_id    INTEGER REFERENCES teams(id) ON DELETE CASCADE,  -- NULL = club-wide role
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('parent','coach','team_admin','club_admin')),
  status     TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','active','paused')),
  invited_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  approved_at TEXT,
  approved_by INTEGER REFERENCES users(id)
);
-- A club_admin has team_id NULL; a parent/coach/team_admin must name a team.
CREATE UNIQUE INDEX idx_membership_unique
  ON memberships(user_id, club_id, IFNULL(team_id, 0), role);
CREATE INDEX idx_membership_lookup ON memberships(user_id, status);
CREATE INDEX idx_membership_team ON memberships(team_id, status);

-- ---------------------------------------------------------------------------
-- Households and children
--
-- A child belongs to a HOUSEHOLD, not to a team. This is what makes the
-- sibling case work: two kids on two different teams share one household,
-- one address, one pickup. Team association is the enrollment table.
-- ---------------------------------------------------------------------------

CREATE TABLE households (
  id            INTEGER PRIMARY KEY,
  club_id       INTEGER NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  name          TEXT NOT NULL DEFAULT '',
  pickup_area_id INTEGER REFERENCES pickup_areas(id) ON DELETE SET NULL,

  -- Private. Never included in any list endpoint. Released only to an
  -- assigned driver, through reveal_pickup, and every release is logged.
  home_address       TEXT NOT NULL DEFAULT '',
  home_lat           REAL,
  home_lng           REAL,
  alternate_address  TEXT NOT NULL DEFAULT '',
  alternate_lat      REAL,
  alternate_lng      REAL,
  geocoded_at        TEXT,

  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_households_club ON households(club_id);

-- Adults attached to a household. Either may drive.
CREATE TABLE household_members (
  id           INTEGER PRIMARY KEY,
  club_id      INTEGER NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,  -- NULL = no login yet
  name         TEXT NOT NULL DEFAULT '',
  phone        TEXT NOT NULL DEFAULT '',
  can_drive    INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_hm_household ON household_members(household_id);
CREATE INDEX idx_hm_user ON household_members(user_id);

CREATE TABLE vehicles (
  id           INTEGER PRIMARY KEY,
  club_id      INTEGER NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  seat_capacity INTEGER NOT NULL DEFAULT 3 CHECK (seat_capacity BETWEEN 1 AND 8),
  notes        TEXT NOT NULL DEFAULT '',
  sort_order   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_vehicles_household ON vehicles(household_id);

CREATE TABLE people (
  id           INTEGER PRIMARY KEY,
  club_id      INTEGER NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  household_id INTEGER REFERENCES households(id) ON DELETE SET NULL,
  name         TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_people_household ON people(household_id);
CREATE INDEX idx_people_club ON people(club_id);

-- A child rostered on a team. Multiple rows = multiple teams.
CREATE TABLE enrollments (
  id         INTEGER PRIMARY KEY,
  club_id    INTEGER NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  team_id    INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  person_id  INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  jersey     TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (team_id, person_id)
);
CREATE INDEX idx_enroll_team ON enrollments(team_id);
CREATE INDEX idx_enroll_person ON enrollments(person_id);

-- ---------------------------------------------------------------------------
-- Places
-- ---------------------------------------------------------------------------

-- Coarse pickup zones shown to everyone ("Winslow"). Never an exact address.
CREATE TABLE pickup_areas (
  id      INTEGER PRIMARY KEY,
  club_id INTEGER NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  name    TEXT NOT NULL,
  lat     REAL,   -- centroid, used for coarse routing before an address is revealed
  lng     REAL,
  UNIQUE (club_id, name)
);

-- Public destinations: fields, schools, parks.
CREATE TABLE locations (
  id      INTEGER PRIMARY KEY,
  club_id INTEGER NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  name    TEXT NOT NULL,
  address TEXT NOT NULL DEFAULT '',
  map_url TEXT NOT NULL DEFAULT '',
  lat     REAL,
  lng     REAL,
  UNIQUE (club_id, name)
);

-- ---------------------------------------------------------------------------
-- Schedule
-- ---------------------------------------------------------------------------

CREATE TABLE events (
  id          INTEGER PRIMARY KEY,
  club_id     INTEGER NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  team_id     INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  location_id INTEGER REFERENCES locations(id) ON DELETE SET NULL,
  event_type  TEXT NOT NULL DEFAULT 'practice' CHECK (event_type IN ('practice','game','tournament')),
  title       TEXT NOT NULL,
  event_date  TEXT NOT NULL,              -- strict YYYY-MM-DD, validated at the API
  start_time  TEXT NOT NULL DEFAULT '00:00',  -- strict HH:MM
  arrive_minutes_before INTEGER NOT NULL DEFAULT 15,
  notes       TEXT NOT NULL DEFAULT '',
  -- Opt-in cross-team carpooling. NULL = this event is private to its team.
  pool_id     INTEGER REFERENCES carpool_pools(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_events_team_date ON events(team_id, event_date);
CREATE INDEX idx_events_club_date ON events(club_id, event_date);
CREATE INDEX idx_events_pool ON events(pool_id);

-- ---------------------------------------------------------------------------
-- Cross-team pooling — the deliberate, narrow exception to isolation
--
-- A pool joins events at the same venue in the same time window so drivers
-- from the participating teams can carry each other's players. It exposes a
-- REDUCED projection (first name, pickup area, direction) — never the team
-- roster, never contact details, never addresses. See docs/TENANCY.md.
-- ---------------------------------------------------------------------------

CREATE TABLE carpool_pools (
  id          INTEGER PRIMARY KEY,
  club_id     INTEGER NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  pool_date   TEXT NOT NULL,
  window_start TEXT NOT NULL DEFAULT '00:00',
  window_end   TEXT NOT NULL DEFAULT '23:59',
  created_by  INTEGER NOT NULL REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_pools_club_date ON carpool_pools(club_id, pool_date);

-- Each team must opt in individually. One team joining does not enroll another.
CREATE TABLE pool_teams (
  pool_id    INTEGER NOT NULL REFERENCES carpool_pools(id) ON DELETE CASCADE,
  team_id    INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  club_id    INTEGER NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  opted_in_by INTEGER NOT NULL REFERENCES users(id),
  opted_in_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (pool_id, team_id)
);

-- ---------------------------------------------------------------------------
-- Rides
-- ---------------------------------------------------------------------------

CREATE TABLE driver_offers (
  id          INTEGER PRIMARY KEY,
  club_id     INTEGER NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  team_id     INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  event_id    INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  driver_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  driver_name TEXT NOT NULL,
  driver_phone TEXT NOT NULL DEFAULT '',
  vehicle_id  INTEGER REFERENCES vehicles(id) ON DELETE SET NULL,
  vehicle_name TEXT NOT NULL DEFAULT '',
  capacity    INTEGER NOT NULL CHECK (capacity BETWEEN 1 AND 8),
  direction   TEXT NOT NULL CHECK (direction IN ('to','from','roundtrip')),
  notes       TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_offers_event ON driver_offers(event_id);
CREATE INDEX idx_offers_household ON driver_offers(household_id);

CREATE TABLE ride_requests (
  id          INTEGER PRIMARY KEY,
  club_id     INTEGER NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  team_id     INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  event_id    INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  person_id   INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  requested_by INTEGER NOT NULL REFERENCES users(id),
  direction   TEXT NOT NULL CHECK (direction IN ('to','from','roundtrip')),

  -- Which address this pickup resolves to. Kept as a reference plus an
  -- optional one-time override so we never copy the home address around.
  pickup_kind TEXT NOT NULL DEFAULT 'home'
                CHECK (pickup_kind IN ('home','alternate','location','override')),
  pickup_location_id INTEGER REFERENCES locations(id) ON DELETE SET NULL,
  pickup_area_id     INTEGER REFERENCES pickup_areas(id) ON DELETE SET NULL,
  override_address   TEXT NOT NULL DEFAULT '',
  override_lat REAL,
  override_lng REAL,

  notes       TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (event_id, person_id, direction)
);
CREATE INDEX idx_requests_event ON ride_requests(event_id);
CREATE INDEX idx_requests_household ON ride_requests(household_id);

-- Assignment is its own table so a round trip can be split across two
-- drivers, which the original single driver_id column could not express.
CREATE TABLE assignments (
  id         INTEGER PRIMARY KEY,
  club_id    INTEGER NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  request_id INTEGER NOT NULL REFERENCES ride_requests(id) ON DELETE CASCADE,
  offer_id   INTEGER NOT NULL REFERENCES driver_offers(id) ON DELETE CASCADE,
  leg        TEXT NOT NULL CHECK (leg IN ('to','from')),
  assigned_by INTEGER NOT NULL REFERENCES users(id),
  source     TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','suggested','admin')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (request_id, leg)
);
CREATE INDEX idx_assignments_offer ON assignments(offer_id, leg);

-- ---------------------------------------------------------------------------
-- Audit — deliberately NOT club-scoped-deletable
--
-- Address reveals are the highest-sensitivity action in the system. The log
-- has no ON DELETE CASCADE to clubs: removing a club must not erase the
-- record of who looked at children's addresses.
-- ---------------------------------------------------------------------------

CREATE TABLE audit_log (
  id           INTEGER PRIMARY KEY,
  club_id      INTEGER,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_email  TEXT NOT NULL DEFAULT '',
  action       TEXT NOT NULL,
  subject_type TEXT NOT NULL DEFAULT '',
  subject_id   INTEGER,
  reason       TEXT NOT NULL DEFAULT '',
  ip           TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_audit_subject ON audit_log(subject_type, subject_id, created_at);
CREATE INDEX idx_audit_actor ON audit_log(actor_user_id, created_at);
CREATE INDEX idx_audit_club ON audit_log(club_id, created_at);

-- ---------------------------------------------------------------------------
-- Saved optimized routes (a cached solve, so a driver's link is stable)
-- ---------------------------------------------------------------------------

CREATE TABLE routes (
  id          INTEGER PRIMARY KEY,
  club_id     INTEGER NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  offer_id    INTEGER NOT NULL REFERENCES driver_offers(id) ON DELETE CASCADE,
  leg         TEXT NOT NULL CHECK (leg IN ('to','from')),
  stop_order  TEXT NOT NULL,             -- JSON array of request_ids in visit order
  distance_km REAL,
  duration_min REAL,
  provider    TEXT NOT NULL DEFAULT 'haversine',
  computed_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (offer_id, leg)
);
