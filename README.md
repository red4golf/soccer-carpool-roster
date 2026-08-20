# Soccer Carpool Roster

A mobile-friendly, shared carpool board for soccer games and practices. This GitHub Pages frontend uses Google sign-in and connects to the hosted roster service so approved families see the same live data.

## Family workflow

- Parents maintain a profile with a general pickup area and private home/alternate addresses.
- Approved families can see general pickup areas, offer seats, and request rides.
- Eligible drivers use **Add to my car**; the service verifies ownership, trip direction, and remaining capacity.
- Only the assigned driver can reveal an exact private pickup address. Each reveal and route opening is logged.
- Parents can cancel their own requests, and drivers can remove riders or cancel empty driving offers.

Common locations such as schools and parks remain visible through Google Maps links. Private addresses are sent to Google Maps only when an assigned driver opens pickup details or a route.

## Administration

The existing separate administrator password remains in place. Admin tools provide:

- Manual entry, editing, removal, and CSV import for events, players, drivers, locations, and pickup areas
- Parent approval and access pausing
- Ride-assignment review and override
- Logged private-address review
- Plaintext JSON backup export

Backup files include private addresses and should be stored in a secure location with restricted access. Recovery currently requires a controlled service/database restore; there is no browser-based restore button.

CSV headers:

- Schedule: `type,title,date,start_time,location,notes`
- Players: `player,guardian,phone`
- Drivers: `driver,phone,capacity,notes`
- Locations: `name,map_url`
- Pickup areas: `name`

## Live site

https://red4golf.github.io/soccer-carpool-roster/
