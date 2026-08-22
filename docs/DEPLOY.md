# Running and deploying

## Cost

Nothing, at club scale.

| | Free allowance | A 300-family club |
|---|---|---|
| Workers | 100,000 requests/day | ~5,000/day (5%) |
| D1 | 5 GB, 5M row-reads/day | a few MB |
| Pages | unlimited static | — |
| Firebase Auth | unlimited Google + email | — |

The only optional spend is a domain (~$12/year). `*.workers.dev` is free.

## Try it locally — no account, no cost

```bash
cd worker && npm install
```

```bash
npx wrangler d1 create carpool --local
```

Put the printed id into `wrangler.toml`, then load the schema and demo data:

```bash
npm run db:local && npm run db:seed
```

```bash
npm run dev
```

The API is on `http://localhost:8787`. Serve the front end from `public/` with
any static server; `index.html` points at localhost automatically.

The seed contains two clubs — Riverside FC and Harbor United — precisely so
isolation is visible: sign in as a Riverside parent and Harbor does not exist.
It also seeds Riley Okonkwo, who has one child on each Riverside team, so the
sibling/pooling path is exercisable straight away.

To sign in as a seeded user, replace the `seed-*` placeholders in `seed.sql`
with real Firebase UIDs from your Firebase console.

## Tests

```bash
cd worker && node --test test/*.test.js
```

53 tests, no dependencies — `node:test` and `node:sqlite` only, so there is
nothing to install or audit. They cover tenant isolation adversarially, the
optimizer against brute force, and the ride handlers against real SQL.

## Deploying

```bash
npx wrangler d1 create carpool
```

Update `database_id` in `wrangler.toml`, then:

```bash
npx wrangler d1 execute carpool --remote --file=./schema.sql
```

```bash
npx wrangler deploy
```

Set `ALLOWED_ORIGINS` in `wrangler.toml` to your Pages URL. It is an explicit
allowlist and never `*` — these endpoints carry credentials, and a wildcard
would make the board readable from any origin.

Optional real road distances:

```bash
npx wrangler secret put ORS_API_KEY
```

The front end deploys itself: pushing to `main` publishes `public/` to GitHub
Pages. Update `apiBase` in `index.html` to your Worker URL.

## Bootstrapping the first club

There is no self-service club creation yet, and no admin password to fall back
on — which means the first `club_admin` has to be inserted by hand. That is
deliberate: the alternative is a public endpoint that mints administrators.

```bash
npx wrangler d1 execute carpool --remote --command \
  "INSERT INTO clubs (name, slug) VALUES ('Your Club','your-club')"
```

Sign in through the app once so your user row is created, then:

```bash
npx wrangler d1 execute carpool --remote --command \
  "INSERT INTO memberships (club_id, team_id, user_id, role, status, approved_at) SELECT 1, NULL, id, 'club_admin', 'active', datetime('now') FROM users WHERE email = 'you@example.com'"
```

From there everything else — teams, locations, pickup areas, approving
parents — is doable in the UI.

## Migrating off the current backend

The existing data lives in a service whose source is not in any repository.
Before anything else, use **Download JSON backup** in the current admin panel;
that export is the only copy you control.

The old shape maps onto the new one like this:

| Old | New |
|---|---|
| (implicit single team) | `clubs` + `teams` + `memberships` |
| `players` | `people` + `enrollments` |
| profile `homePickup` | `households.home_address` |
| `drivers` | `driver_offers` (per event) + `vehicles` (per household) |
| `rides.driverId` | `assignments` (one row per leg) |
| admin password | `memberships.role = 'club_admin'` |

Two are not one-to-one and need a decision:

- **Households.** The old model had no household; each parent stood alone.
  Grouping two parents of one child into a single household is a judgement
  call, easiest made by matching on address.
- **Round trips.** `rides.driverId` was a single column, so a round trip could
  not be split between two drivers. Each old ride becomes up to two
  `assignments` rows, both pointing at the same offer.

An importer is not written yet — it should be, once you have the export in hand
and we can see the real field names.
