// Tenant isolation.
//
// The rule this file exists to enforce: a request may touch a team's data if
// and only if the caller holds an ACTIVE membership row for that team, or a
// club_admin row for that team's club. There is no other path. Route handlers
// never filter by team themselves — they ask the Scope, and the Scope is the
// only thing that decides.
//
// Cross-team pooling is the single deliberate exception, and it is narrow:
// it grants a REDUCED projection of ride requests at a shared venue, never a
// roster, never contact details, never an address. See docs/TENANCY.md.

export class HttpError extends Error {
  constructor(status, message, code = '') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const ROLES = ['parent', 'coach', 'team_admin', 'club_admin'];

/** Ranked so a club_admin implies everything a team_admin can do, and so on. */
const RANK = { parent: 1, coach: 2, team_admin: 3, club_admin: 4 };

export const PERMISSIONS = {
  view_board: 'parent',
  request_ride: 'parent',
  offer_drive: 'parent',
  view_roster: 'coach',
  manage_events: 'team_admin',
  manage_roster: 'team_admin',
  approve_member: 'team_admin',
  override_assignment: 'team_admin',
  manage_teams: 'club_admin',
  manage_pools: 'club_admin',
  reveal_any_address: 'club_admin',
  export_backup: 'club_admin',
};

export class Scope {
  /**
   * @param user        { id, email, is_platform_admin }
   * @param memberships rows from `memberships` for this user (any status)
   */
  constructor(user, memberships) {
    this.user = user;
    this.isPlatformAdmin = Boolean(user?.is_platform_admin);

    this.all = memberships ?? [];
    this.active = this.all.filter(m => m.status === 'active');

    // team_id -> highest role held on that team
    this.byTeam = new Map();
    // club_id -> highest club-wide role (team_id IS NULL)
    this.byClub = new Map();

    for (const m of this.active) {
      if (m.team_id == null) {
        const current = this.byClub.get(m.club_id);
        if (!current || RANK[m.role] > RANK[current]) this.byClub.set(m.club_id, m.role);
      } else {
        const current = this.byTeam.get(m.team_id);
        if (!current || RANK[m.role] > RANK[current]) this.byTeam.set(m.team_id, m.role);
      }
    }
  }

  /** True when the user has no active membership anywhere — the pending state. */
  get isPending() {
    return this.active.length === 0;
  }

  get clubIds() {
    const ids = new Set(this.byClub.keys());
    for (const m of this.active) ids.add(m.club_id);
    return [...ids];
  }

  /** Teams with an explicit membership row. Club admins additionally get all
   *  teams in their club, but that needs a lookup, so it lives in loadScope. */
  get directTeamIds() {
    return [...this.byTeam.keys()];
  }

  isClubAdmin(clubId) {
    return this.byClub.get(clubId) === 'club_admin';
  }

  /** Effective role on a team, accounting for club-wide roles. */
  roleOnTeam(teamId, clubId) {
    // A platform operator holds no membership rows, but `can()` already
    // grants them everything; report the matching role so the UI agrees with
    // what the API will actually permit.
    if (this.isPlatformAdmin) return 'club_admin';
    const direct = this.byTeam.get(teamId);
    const viaClub = clubId != null ? this.byClub.get(clubId) : undefined;
    if (!direct && !viaClub) return null;
    if (!direct) return viaClub;
    if (!viaClub) return direct;
    return RANK[direct] >= RANK[viaClub] ? direct : viaClub;
  }

  can(permission, { teamId, clubId } = {}) {
    const required = PERMISSIONS[permission];
    if (!required) throw new Error(`Unknown permission: ${permission}`);
    if (this.isPlatformAdmin) return true;

    // Club-level permissions are satisfied only by a club-wide role.
    if (required === 'club_admin') return clubId != null && this.isClubAdmin(clubId);

    const role = this.roleOnTeam(teamId, clubId);
    if (!role) return false;
    return RANK[role] >= RANK[required];
  }

  require(permission, context = {}) {
    if (this.can(permission, context)) return;
    // Deliberately identical message whether the team is invisible or merely
    // forbidden — distinguishing them leaks which team ids exist.
    throw new HttpError(404, 'Not found.', 'out_of_scope');
  }

  requireTeam(teamId, clubId) {
    if (!this.isPlatformAdmin && !this.roleOnTeam(teamId, clubId)) {
      throw new HttpError(404, 'Not found.', 'out_of_scope');
    }
  }
}

/**
 * Build a Scope from the database, expanding club_admin rows into concrete
 * team ids so downstream queries always have an explicit team id list to
 * filter on (an empty list must produce an empty result, never "all").
 */
export async function loadScope(db, user) {
  const memberships = await db
    .prepare(
      `SELECT id, club_id, team_id, role, status
         FROM memberships
        WHERE user_id = ?`,
    )
    .bind(user.id)
    .all();

  const scope = new Scope(user, memberships.results ?? memberships);

  // The platform operator sees every team without holding a membership row.
  // Without this they would resolve to an empty team list and land on the
  // approval screen — the same failure that stranded club admins.
  if (scope.isPlatformAdmin) {
    const all = await db.prepare(`SELECT id FROM teams WHERE archived = 0`).all();
    scope.visibleTeamIds = (all.results ?? all).map(row => row.id);
    return scope;
  }

  const teamIds = new Set(scope.directTeamIds);
  const adminClubs = [...scope.byClub.entries()]
    .filter(([, role]) => role === 'club_admin')
    .map(([clubId]) => clubId);

  if (adminClubs.length) {
    const placeholders = adminClubs.map(() => '?').join(',');
    const rows = await db
      .prepare(`SELECT id FROM teams WHERE club_id IN (${placeholders}) AND archived = 0`)
      .bind(...adminClubs)
      .all();
    for (const row of rows.results ?? rows) teamIds.add(row.id);
  }

  scope.visibleTeamIds = [...teamIds];
  return scope;
}

/**
 * Teams whose ride requests the caller may see for a given event, because
 * that event has been pooled with theirs.
 *
 * Pooling requires, in order:
 *   1. the club has cross-team pooling switched on at all,
 *   2. a pool exists for the event,
 *   3. BOTH the event's team and one of the caller's teams opted into it.
 *
 * Any one of those missing means no cross-team visibility. Opting in is
 * always an explicit act by a team admin — never implied by the venue, the
 * date, or another team's decision.
 */
export async function pooledTeamIds(db, scope, eventId) {
  if (!scope.visibleTeamIds?.length) return [];

  const event = await db
    .prepare(
      `SELECT e.id, e.team_id, e.club_id, e.pool_id, c.allow_cross_team_pools
         FROM events e
         JOIN clubs c ON c.id = e.club_id
        WHERE e.id = ?`,
    )
    .bind(eventId)
    .first();

  if (!event || !event.pool_id || !event.allow_cross_team_pools) return [];

  const rows = await db
    .prepare(`SELECT team_id FROM pool_teams WHERE pool_id = ?`)
    .bind(event.pool_id)
    .all();
  const members = (rows.results ?? rows).map(r => r.team_id);

  // The event's own team must itself have opted in; a pool row is not enough.
  if (!members.includes(event.team_id)) return [];

  // And the caller must have a team in the same pool.
  const mine = scope.visibleTeamIds.filter(id => members.includes(id));
  if (!mine.length) return [];

  return members;
}

/**
 * The reduced shape a pooled ride request is exposed as. Anything not listed
 * here never crosses a team boundary.
 *
 * Note `childName` is a first name only, and there is no household id, no
 * phone, no address and no team name — a driver from another team learns that
 * "Alex from Winslow needs a ride to Battle Point", which is exactly enough
 * to offer a seat and nothing more.
 */
export function projectPooledRequest(row) {
  return {
    id: row.id,
    eventId: row.event_id,
    direction: row.direction,
    childName: String(row.person_name ?? '').trim().split(/\s+/)[0] || 'Player',
    pickupArea: row.pickup_area_name ?? null,
    assigned: Boolean(row.offer_id),
    pooled: true,
  };
}

/** Append-only record of anything sensitive. Never fails the caller's request. */
export async function audit(db, { clubId, actor, action, subjectType, subjectId, reason = '', ip = '' }) {
  try {
    await db
      .prepare(
        `INSERT INTO audit_log (club_id, actor_user_id, actor_email, action, subject_type, subject_id, reason, ip)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        clubId ?? null,
        actor?.id ?? null,
        actor?.email ?? '',
        action,
        subjectType ?? '',
        subjectId ?? null,
        reason,
        ip,
      )
      .run();
  } catch {
    // An audit write must never break the user-facing action, but it must
    // also never be silently invisible to the operator.
    console.error('audit write failed', { action, subjectType, subjectId });
  }
}
