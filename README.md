# Soccer Carpool Roster

A mobile-friendly shared carpool board for soccer games and practices.

Families can offer seats, request rides, and assign players to drivers. The public GitHub Pages interface connects to a PIN-protected shared roster service so updates synchronize across devices.

The separate Admin area accepts CSV files for the team schedule, player/guardian records, and reusable driver information. Administrator access remains disabled until the hosted service has an `ADMIN_PASSWORD` secret configured.

CSV headers:

- Schedule: `type,title,date,departure,location,meet_at,notes`
- Players: `player,guardian,phone`
- Drivers: `driver,phone,capacity,notes`

## Live site

https://red4golf.github.io/soccer-carpool-roster/
