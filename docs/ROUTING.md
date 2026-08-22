# Route optimization

Two problems that look like one, and are worth keeping apart.

## 1. Ordering — one driver, known children

*In what order do I collect them?* An open-path travelling-salesman problem
with a fixed start (the driver's house) and fixed end (the field).

Carpool instances are tiny. A single car is almost never more than six stops,
so an **exact** answer is affordable: Held-Karp dynamic programming, where
`dp[mask][i]` is the cheapest way to leave the start, visit exactly the stops
in `mask`, and be standing at stop `i`. That is `O(2ⁿ·n²)` — at the n=12 cutoff
it is about 49,000 states, which resolves in microseconds.

Above twelve stops it falls back to nearest-neighbour plus 2-opt and Or-opt
local search. 2-opt fixes crossed paths; Or-opt lifts a single badly-sequenced
house and reinserts it, which 2-opt alone can miss.

The exact solver is verified against brute-force permutation on 40 random
instances. Not "close to" — identical to nine decimal places.

## 2. Assignment — several drivers, limited seats

*Who takes whom?* A capacitated vehicle-routing problem.

Construction is **regret-2 insertion**. At each step, score every unplaced
child by how much worse their *second*-best car is than their best, and place
the child with the most to lose. Plain greedy — always taking the globally
cheapest placement — reliably strands the child who only ever fitted well in
one car, because it fills that car with cheaper riders first. On a carpool
board that is not a rounding error; it is one family repeatedly told there is
no seat.

A relocate-and-swap local search then cleans up. Relocate moves one child
between cars; swap trades two, which reaches arrangements relocate cannot when
both cars are already full.

Verified against exhaustive enumeration of every capacity-feasible assignment
on small instances: within 2%, and in practice exactly optimal.

### One bug worth recording

The first local search mutated routes by value — `filter` to remove, `push` to
add. Move a child twice in one pass and they end up in two cars at once; reject
the second move and they are restored to a car they had already left. Ten
children went in, eight came out, and `unassigned` was empty — the system was
confident every child had a seat while two had silently evaporated.

It is now index-based (`splice` at a known position, restore at the same
position), and an invariant test across 30 randomised instances asserts that
placed + unassigned always equals the input, that nobody is duplicated, and
that the routes and the assignment map agree.

For software that decides which car a child gets into, "silently lost" is the
worst available failure mode. It is worth a dedicated test.

## Distance

Pluggable, free by default.

```js
provider.matrix(points) -> number[][]   // kilometres
```

**`haversineProvider`** (default) is pure geometry: no API key, no network, no
cost, works offline. Straight-line distance is wrong wherever water, one-ways
or bridges matter — which on Bainbridge is most places — but it is
*consistently* wrong, and a constant multiplier cannot change which of two
routes is shorter. It gets the ordering right and the ETA approximately right.

**`openRouteServiceProvider`** swaps in real road distances on 2,000 free
requests a day. Set `ORS_API_KEY` as a Worker secret and it activates; with no
key it silently returns the haversine provider, so the system degrades to
"slightly less precise", never to "broken".

Google Routes would be better still — live traffic, and the same Maps handoff
parents already use — but it requires billing, and this needs to cost nothing.

The seam is one line at the call site. Nothing in the solver knows or cares
which provider produced the matrix.

## Getting to the car

`/api/route` returns a Google Maps directions URL with waypoints already in
solved order and `dir_action=navigate`, so Maps does not re-order them. It is
the one place addresses become a map link, so it is the one place that logs a
reveal for every household in the car.

The return leg is the same problem read backwards — venue as start, driver's
house as finish. With a symmetric matrix the solved order simply reverses,
which a test asserts.

## Honest limits

- **Time windows are not modelled.** Everyone is assumed collectable in one
  sweep before kickoff. Real constraints — a child not home until 8:15 — would
  need a VRPTW solver, which is a materially harder problem.
- **Symmetry is assumed.** True for straight lines, not quite true for real
  roads with one-ways. ORS returns an asymmetric matrix; the solver reads it
  correctly, but the return-leg reversal shortcut is only exactly right when
  the matrix is symmetric.
- **Geocoding accuracy is only as good as what a parent types.** Addresses are
  resolved once via Nominatim when a family saves them (see below). A lookup
  that fails leaves the family without coordinates, and they are reported in
  `needsAddress` rather than dropped — they surface instead of vanishing.
- **Suggestions are advisory.** Nothing is written until a coordinator presses
  Accept. Deciding which adult drives someone's child is not a decision to
  automate silently.


## Geocoding

Route optimization needs coordinates; a parent typing "100 Ericksen Ave NE"
cannot supply them. Addresses are resolved once, on save, via Nominatim
(OpenStreetMap) — free, no key, no account.

This is the one place the system deliberately sends a home address to a third
party, so the trade is made as narrow as it can be:

- The lookup runs **on the Worker**, never in the browser, so the family's IP
  and browser fingerprint are never exposed — only an address string, arriving
  from a datacentre.
- Nothing identifying travels with it: no child name, no parent name, no club,
  no team, no household id. A test asserts this.
- The result is stored, so an address is looked up **once**. Re-saving an
  unchanged address does not re-query — also asserted by a test.
- It is optional. Coordinates can be typed manually instead, and a family who
  does neither is simply reported under `needsAddress`.
- The UI says all of this in plain language above the address field, before
  anything is sent.

### Confidence matters more than it looks

A geocoder that cannot find a street will often return the **centre of the
city** instead, with no error. Stored as bare coordinates that is
indistinguishable from a correct answer, and the first anyone knows is a
driver parked a mile from the child.

So every match is classified — `exact`, `street`, `area`, `approximate` — and
the matched label is stored alongside the coordinates. Anything vaguer than a
street keeps the profile dialog open and asks the family to confirm or refine,
rather than closing on a quiet maybe.

Verified against the live service:

| Query | Result |
|---|---|
| `100 Ericksen Ave NE, Bainbridge Island, WA` | `exact`, 47.6250 / -122.5169 |
| `Battle Point Dr NE, Bainbridge Island, WA` | `street` |
| `99999 Completely Fake Street, Bainbridge Island, WA` | not found — no bogus fallback |

### Limits

- **Nominatim's usage policy discourages bulk or systematic queries.** One
  lookup per family, once, is within the spirit of it; the admin backfill is
  paced at roughly one per second and capped per run. A club large enough to
  geocode hundreds of addresses regularly should self-host Nominatim or pay for
  a geocoder — `geocoderFor()` is the seam, and `GEOCODER=off` disables it
  entirely.
- **Results are biased to one country** (`GEOCODE_COUNTRIES`, default `us`).
  Wrong-country matches are the most common way a geocoder confidently returns
  a house three thousand miles from the right one.
- **Nothing re-geocodes on its own.** If a family moves and edits their
  address, that counts as a change and is looked up again; a street that gets
  renamed underneath them does not.
