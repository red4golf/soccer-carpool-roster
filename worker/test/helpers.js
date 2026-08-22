import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const schemaPath = fileURLToPath(new URL('../schema.sql', import.meta.url));

/**
 * Minimal D1-compatible wrapper over node:sqlite, so the tenancy logic can be
 * exercised without a Cloudflare runtime. Mirrors the subset of the D1 API the
 * worker actually uses: prepare().bind().all() / .first() / .run().
 */
class Statement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.params = [];
  }
  bind(...params) {
    this.params = params.map(p => (p === undefined ? null : p));
    return this;
  }
  async all() {
    return { results: this.db.prepare(this.sql).all(...this.params) };
  }
  async first() {
    return this.db.prepare(this.sql).get(...this.params) ?? null;
  }
  async run() {
    const result = this.db.prepare(this.sql).run(...this.params);
    return {
      success: true,
      meta: {
        last_row_id: Number(result.lastInsertRowid),
        changes: Number(result.changes),
      },
    };
  }
}

export class TestDb {
  constructor() {
    this.raw = new DatabaseSync(':memory:');
    this.raw.exec(readFileSync(schemaPath, 'utf8'));
  }
  prepare(sql) {
    return new Statement(this.raw, sql);
  }
  exec(sql) {
    this.raw.exec(sql);
  }
  /** Synchronous insert helper returning the new row id. */
  insert(sql, ...params) {
    return Number(this.raw.prepare(sql).run(...params).lastInsertRowid);
  }
  rows(sql, ...params) {
    return this.raw.prepare(sql).all(...params);
  }
}

/**
 * Two clubs that must never see each other, each with two teams.
 *
 *   Riverside FC          Harbor United
 *     Team Red              Team Blue
 *     Team Gold             Team Green
 */
export function seedTwoClubs() {
  const db = new TestDb();

  const riverside = db.insert(
    `INSERT INTO clubs (name, slug, allow_cross_team_pools) VALUES ('Riverside FC','riverside',1)`,
  );
  const harbor = db.insert(
    `INSERT INTO clubs (name, slug, allow_cross_team_pools) VALUES ('Harbor United','harbor',0)`,
  );

  const red = db.insert(`INSERT INTO teams (club_id, name, season) VALUES (?, 'Red','2026')`, riverside);
  const gold = db.insert(`INSERT INTO teams (club_id, name, season) VALUES (?, 'Gold','2026')`, riverside);
  const blue = db.insert(`INSERT INTO teams (club_id, name, season) VALUES (?, 'Blue','2026')`, harbor);
  const green = db.insert(`INSERT INTO teams (club_id, name, season) VALUES (?, 'Green','2026')`, harbor);

  const user = (uid, email, platform = 0) =>
    db.insert(
      `INSERT INTO users (firebase_uid, email, email_verified, display_name, is_platform_admin)
       VALUES (?, ?, 1, ?, ?)`,
      uid,
      email,
      email,
      platform,
    );

  const users = {
    redParent: user('uid-red-parent', 'red.parent@example.com'),
    goldParent: user('uid-gold-parent', 'gold.parent@example.com'),
    blueParent: user('uid-blue-parent', 'blue.parent@example.com'),
    riversideAdmin: user('uid-riverside-admin', 'admin@riverside.example.com'),
    harborAdmin: user('uid-harbor-admin', 'admin@harbor.example.com'),
    pendingParent: user('uid-pending', 'pending@example.com'),
    pausedParent: user('uid-paused', 'paused@example.com'),
    coach: user('uid-coach', 'coach@riverside.example.com'),
    platform: user('uid-platform', 'operator@example.com', 1),
  };

  const member = (userId, clubId, teamId, role, status = 'active') =>
    db.insert(
      `INSERT INTO memberships (club_id, team_id, user_id, role, status) VALUES (?,?,?,?,?)`,
      clubId,
      teamId,
      userId,
      role,
      status,
    );

  member(users.redParent, riverside, red, 'parent');
  member(users.goldParent, riverside, gold, 'parent');
  member(users.blueParent, harbor, blue, 'parent');
  member(users.riversideAdmin, riverside, null, 'club_admin');
  member(users.harborAdmin, harbor, null, 'club_admin');
  member(users.pendingParent, riverside, red, 'parent', 'pending');
  member(users.pausedParent, riverside, red, 'parent', 'paused');
  member(users.coach, riverside, red, 'coach');

  return {
    db,
    clubs: { riverside, harbor },
    teams: { red, gold, blue, green },
    users,
    userRow(id) {
      return db.rows(`SELECT * FROM users WHERE id = ?`, id)[0];
    },
  };
}

/** Attach an event with a location so pooling tests have something to pool. */
export function seedPooledEvent(fixture, { optInTeams = [], clubId, teams: teamIds }) {
  const { db } = fixture;
  const locationId = db.insert(
    `INSERT INTO locations (club_id, name, lat, lng) VALUES (?, 'Battle Point Park', 47.6631, -122.5615)`,
    clubId,
  );
  const poolId = db.insert(
    `INSERT INTO carpool_pools (club_id, location_id, pool_date, created_by) VALUES (?,?,?,?)`,
    clubId,
    locationId,
    '2026-09-12',
    fixture.users.riversideAdmin,
  );
  for (const teamId of optInTeams) {
    db.insert(
      `INSERT INTO pool_teams (pool_id, team_id, club_id, opted_in_by) VALUES (?,?,?,?)`,
      poolId,
      teamId,
      clubId,
      fixture.users.riversideAdmin,
    );
  }
  const events = {};
  for (const [key, teamId] of Object.entries(teamIds)) {
    events[key] = db.insert(
      `INSERT INTO events (club_id, team_id, location_id, event_type, title, event_date, start_time, pool_id)
       VALUES (?,?,?,'game',?, '2026-09-12','09:00', ?)`,
      clubId,
      teamId,
      locationId,
      `${key} game`,
      poolId,
    );
  }
  return { locationId, poolId, events };
}
