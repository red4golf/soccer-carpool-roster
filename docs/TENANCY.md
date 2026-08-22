# Tenant isolation

How Team A is prevented from seeing Team B — and the one deliberate exception.

## The shape

```
club ──< team ──< event ──< ride_request >── assignment ──< driver_offer
            └──< membership >── user
club ──< household ──< person ──< enrollment >── team
```

Two things carry most of the weight:

**Membership is the only key.** A user can read a team's data if and only if a
row exists in `memberships` with `status = 'active'` for that team, or a
club-wide `club_admin` row for that team's club. Route handlers never write
their own team filter; they ask a `Scope` object, and `Scope` is the only thing
that decides. One place to audit, one place to get right.

**A child belongs to a household, not a team.** This is what makes siblings
work. `people` hang off `households`; `enrollments` attach a person to a team.
Two children in one family on two different teams are one household, one
address, one pickup — expressed naturally rather than as a special case.

## Fail closed

Every tenant table carries `club_id`, even where it is derivable through a
join. That redundancy is on purpose: it means every query can filter on
`club_id` directly, so a query that *forgets* its scope returns nothing rather
than returning another club's rows. The alternative — deriving scope through
three joins — fails open the moment someone writes a query that skips one.

A test asserts the column exists on every tenant table, so a future
migration cannot quietly drop it.

Two smaller decisions in the same spirit:

- **Out-of-scope reads return 404, not 403.** A 403 confirms the resource
  exists. Enumerating team ids against a 403/404 difference would map the whole
  club. Every refusal is an identical `404 Not found.`
- **An empty team list selects nothing.** `scope.visibleTeamIds` for a pending
  user is `[]`, and the query builder renders that as `IN (NULL)` — zero rows.
  The failure mode to avoid is an empty filter degrading to an unfiltered scan.

## Getting in

Access starts with a coordinator naming an email address. There is no
self-signup and no join code.

The previous design let anyone create an account and then wait for approval,
which meant an unbounded queue of strangers attached to a club full of
children's data, and an approval list nobody drains. Here, signing in without
an invitation gives you a club-less account that can see nothing at all and a
screen telling you to ask your coordinator.

Because an admin already vouched for the address, claiming an invite creates
an **active** membership rather than a pending one — a second approval step
would only add a queue. Invitations are claimed on the invitee's next request,
so inviting someone who signed in yesterday still works.

Two consequences worth stating:

- **The gate is the email address.** A parent who signs in with a different
  address than the one their coordinator typed sees nothing, and the pending
  screen says so explicitly, because "I signed up and nothing happened" is
  otherwise unanswerable.
- **`invite_members` cannot grant `club_admin`.** The role is restricted to
  parent / coach / team_admin at the endpoint, so a team coordinator cannot
  invite a confederate straight to club level.

## Roles

Per-team, ranked, so a higher role implies the lower ones.

| Role | Can |
|---|---|
| `parent` | See their team's board, request rides, offer seats |
| `coach` | Also see the team roster |
| `team_admin` | Also manage events, roster, approvals, override assignments |
| `club_admin` | All teams in their club; manage teams and pools; reveal addresses; export |

Three deliberate limits:

- **`team_admin` never implies `club_admin`**, even inside its own club. Club
  permissions are checked only against a club-wide role.
- **Nobody changes their own access.** Approving or re-roling yourself is
  rejected outright.
- **`set_member_role` cannot grant `club_admin`.** A team admin must not be
  able to escalate anyone — including a confederate — to club level.

This replaces the shared admin password. That password had no identity behind
it: the audit log could record *that* an address was revealed but not reliably
*who* did it, and revoking one admin meant changing the password for everyone.
Now rights are a row, revocable per person, and every sensitive read is
attributable.

## Addresses

Exact addresses live on `households` and are returned by exactly two endpoints:

- `reveal_pickup` — requires an existing assignment, and the caller must be
  either the assigned driver or the family themselves.
- `admin reveal_address` — `club_admin` only, and requires a typed reason.

Both write to `audit_log`. A family reading their own address is not logged as
a reveal; everyone else is, and the family sees that history in their own
profile without having to ask for it.

The route planner is the interesting case. It *needs* coordinates to work, but
the coordinator reading the result does not — so the geometry never leaves the
worker. `/api/plan` returns names and seat counts only. A test asserts no
address string and no coordinate appears anywhere in the response.

`audit_log` deliberately has no `ON DELETE CASCADE` to `clubs`. Deleting a club
must not erase the record of who looked at children's addresses.

## The exception: cross-team pools

The real-world case you raised: two siblings on different teams, both playing
at the same complex on the same morning. Forcing two separate car trips because
the software cannot express it would be a bad answer.

A **pool** joins events at one venue in one time window. Visibility requires
*all three*:

1. the club has `allow_cross_team_pools` switched on;
2. a pool exists and the event is attached to it;
3. **both** the event's team and one of the caller's teams have opted in.

Any one missing means no cross-team visibility. Opting in is a `team_admin`
action *on the joining team* — a club admin cannot opt a team in on its behalf,
and one team joining never enrols another. Consent is per-team and explicit.

What crosses the boundary is deliberately thin:

```js
{ id, eventId, direction, childName, pickupArea, assigned, pooled }
```

`childName` is a **first name only**. There is no household id, no phone, no
address, no team name, no notes. A driver from the other team learns that "Alex
from Winslow needs a ride to Battle Point" — enough to offer a seat, nothing
more. Pooled requests come back in a separate `pooledRequests` array rather
than merged with a flag, so a UI bug cannot render one with fields it was never
given.

Six tests attack this specifically: pooling off by default, one-sided opt-in,
the club switch overriding team consent, an outsider gaining nothing, a pending
user gaining nothing, and a field-by-field check that no personal data
survives the projection.

## What is not solved

Honest limits of the current design:

- **Cross-*club* pooling is impossible.** Two clubs at one tournament cannot
  share cars. That is the right default, but a real club may eventually want
  it, and it would need a new consent object above `club`.
- **A paused membership is checked at request time, not pushed.** Someone with
  a page already open keeps the data on their screen until their next request.
  Revocation is immediate for anything new, not retroactive to rendered pixels.
- **`club_admin` is broad.** It can reveal any address in the club. It is
  logged and it requires a reason, but there is no four-eyes requirement. For a
  volunteer club that is probably the right trade; for a large one it is worth
  revisiting.
- **The `people` table is club-scoped.** A family in two different clubs has
  two household records and enters their address twice. Deduplicating across
  clubs would mean a person identity above the tenant, which brings its own
  privacy questions.
