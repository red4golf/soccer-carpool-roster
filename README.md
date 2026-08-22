# Soccer Carpool

A shared carpool board for club soccer — offer seats, request rides, and see
who is riding with whom. Built for a whole club rather than a single team, and
designed so children's home addresses stay private by default.

Runs free: Cloudflare Workers + D1 + GitHub Pages, with Firebase for sign-in.

```
public/   installable web app (GitHub Pages)
worker/   API, database schema, route optimizer (Cloudflare Workers + D1)
docs/     design notes
```

## What it does

**For parents.** Request a ride for one child or several. Offer seats from any
household vehicle. Add a teammate to your car. Everything works on a phone and
installs to the home screen.

**For coordinators.** A single **Coordinate** panel covering schedule, roster,
people, places, teams and club settings — plus **Suggest carpools**, which
proposes a driver-to-child assignment with routes already in the shortest
order. Nothing is saved until you accept it.

Access is invite-only: paste a list of email addresses and those families are
in. Anyone who signs in without an invitation sees nothing, and is told to ask
their coordinator. Unreadable addresses are reported back rather than silently
skipped.

**For a club.** Many teams, isolated from each other by default, with an
opt-in way to share cars between two teams at the same venue.

## Privacy

The core design constraint: **a home address is released only to the driver
actually carrying that child, and the family is told every time.**

- Everyone sees a coarse pickup area ("Winslow"). Nobody browses addresses.
- Exact addresses come from two endpoints only, both of which require either an
  active assignment or a club admin with a typed reason. Both are logged.
- The route planner needs coordinates; the coordinator reading its output does
  not, so geometry never leaves the server. A test asserts no address or
  coordinate appears in a plan response.
- Families see their own access history in their profile, unprompted.
- The service worker caches the app shell but **never** API responses — roster
  data is not written to disk on the device.

## Multi-team

A child belongs to a *household*, not a team, which is what makes siblings on
different teams work naturally. Access is a single primitive: a `membership`
row. No row, no data — and out-of-scope reads return `404`, never `403`, so
team ids cannot be enumerated.

Cross-team carpooling is off by default and needs three separate consents to
turn on. What crosses the line is a first name and a pickup area — nothing
else. See [docs/TENANCY.md](docs/TENANCY.md).

## Route optimization

Exact Held-Karp for a single car (verified against brute force), regret-2
insertion plus local search for assigning children to drivers (verified against
exhaustive enumeration). Distance is pluggable: free straight-line geometry by
default, real road routing if you add an OpenRouteService key.

See [docs/ROUTING.md](docs/ROUTING.md).

## Getting started

```bash
cd worker && npm install && npm run db:local && npm run db:seed && npm run dev
```

Full instructions, costs, and deployment in [docs/DEPLOY.md](docs/DEPLOY.md).

## Tests

```bash
cd worker && node --test test/*.test.js
```

76 tests with no third-party dependencies. Isolation is tested adversarially —
each case is an *attempt* to read another team's data, and passing means the
attempt failed.

## Notable changes from the single-team version

- One front door. The shared admin password is gone; admin rights are a
  revocable, per-person membership row, so the audit log can name who revealed
  an address.
- Map URLs are scheme-checked. `<input type="url">` accepts
  `javascript:alert(1)` in Chrome, so admin-supplied links were a stored-XSS
  vector when rendered into an `href`.
- ID tokens are fetched per request. The old client cached one for the session,
  so a phone left open on the touchline started failing after an hour.
- Response status is checked before parsing. A 502 HTML page used to surface as
  `Unexpected token '<'` and log the parent out.
- Dates are validated. `new Date('9/8/2026T12:00:00')` is `Invalid Date`, which
  previously made an event silently disappear from the board.
- Seat capacity is enforced by a conditional `INSERT`, so two parents tapping
  "add to my car" at the same moment cannot both take the last seat.
- Google sign-in falls back to redirect when popups are blocked — the norm in
  the in-app browsers parents open links from.
