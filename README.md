# Soccer Carpool Roster

A mobile-friendly, shared carpool board for soccer games and practices. This GitHub Pages frontend uses Google or verified email-and-password sign-in and connects to the hosted roster service so approved families see the same live data. Firebase stores passwords and provides password-reset emails; the roster never receives them.

## Family workflow

- Parents maintain a profile with a general pickup area, private home/alternate addresses, and every child who may need transportation. Existing unassigned roster players can be connected without creating duplicates.
- Approved families can see general pickup areas, offer seats, and request rides.
- Eligible drivers use **Add to my car**; the service verifies ownership, trip direction, and remaining capacity.
- Only the assigned driver can reveal an exact private pickup address. Each reveal and route opening is logged.
- A parent can request the same trip for one or several children at once. Each child consumes one seat and remains independently assignable.
- Households can save additional adult drivers and multiple vehicles. Either parent may select the actual driver and vehicle when offering seats.
- Approved parents land on a private **My rides** summary with upcoming child rides and household driving commitments.
- Pending accounts can complete their own profile but cannot retrieve the team player directory or connect themselves to an existing player.
- Parents can cancel their own requests, and drivers can remove riders or cancel empty driving offers.
- Administrators can review and correct parent-to-player connections, including linking two approved parents to the same child.

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
