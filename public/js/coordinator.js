// The coordinator panel: schedule, roster, people, places, teams, club.
//
// Kept out of app.js because most users never open it — a parent's job is to
// request a ride, and this is the machinery behind that.

import { get, post } from './api.js';
import { modal, notice } from './ui.js';
import { h, safeUrl, shortDate, clock, longDate, miles } from './util.js';

const ROLE_LABEL = {
  parent: 'Parent',
  coach: 'Coach',
  team_admin: 'Team coordinator',
  club_admin: 'Club administrator',
};

/**
 * @param context  { team, onChanged } — team is the active {teamId, clubId,
 *                 teamName, clubName, role}; onChanged reloads the main board.
 */
export async function openCoordinator(context) {
  const { host, close } = modal(
    'Coordinate',
    `<div class="coordBody"><p>Loading…</p></div>`,
    { wide: true, eyebrow: 'COORDINATOR TOOLS' },
  );

  const body = host.querySelector('.coordBody');
  const view = {
    tab: 'schedule',
    data: null,
    message: '',
    error: '',
    editingEvent: null,
  };

  async function load() {
    const params = new URLSearchParams({
      clubId: String(context.team.clubId),
      teamId: String(context.team.teamId),
    });
    view.data = await get(`/api/admin?${params}`);
  }

  /** Run an admin action, then reload and re-render with a result message. */
  async function act(payload, message) {
    view.message = '';
    view.error = '';
    try {
      const result = await post('/api/admin', payload);
      await load();
      view.message = typeof message === 'function' ? message(result) : message;
      context.onChanged?.();
    } catch (error) {
      view.error = error.message;
    }
    render();
  }

  /**
   * Tabs the caller can actually use.
   *
   * A team coordinator has no business in club settings, and showing them a
   * tab that only ever says "you cannot do this" is worse than not showing
   * it — it reads as something broken rather than something withheld. The
   * server decides via canManageClub; this only reflects that decision.
   */
  const tabsFor = data => {
    const tabs = [
      ['schedule', 'Schedule'],
      ['roster', 'Roster'],
      ['people', 'People'],
      ['carpools', 'Carpools'],
      ['places', 'Places'],
    ];
    if (data?.canManageClub) tabs.push(['teams', 'Teams'], ['club', 'Club']);
    return tabs;
  };

  function render() {
    const data = view.data;
    if (!data) return;
    const visible = tabsFor(data).map(([key]) => key);
    if (!visible.includes(view.tab)) view.tab = visible[0];

    const pending = data.counts.pendingMembers;
    body.innerHTML = `
      <div class="coordTabs" role="tablist">
        ${tabsFor(data).map(([key, label]) => `
          <button role="tab" aria-selected="${view.tab === key}"
                  class="${view.tab === key ? 'active' : ''}" data-tab="${key}">
            ${label}${key === 'people' && pending ? ` <span class="badgeCount">${pending}</span>` : ''}
          </button>`).join('')}
      </div>
      ${notice(view.error, 'error')}
      ${notice(view.message)}
      <div class="coordPanel">${panel()}</div>`;

    body.querySelectorAll('[data-tab]').forEach(button =>
      button.addEventListener('click', async () => {
        view.tab = button.dataset.tab;
        view.message = '';
        view.error = '';
        view.editingEvent = null;
        render();
        // Refetch on every tab change. Two coordinators often work the same
        // team the night before a game, and a panel that renders whatever it
        // happened to load on open will quietly show one of them a roster the
        // other already changed.
        try {
          await load();
          render();
        } catch (error) {
          view.error = error.message;
          render();
        }
      }));

    wire();
  }

  const panel = () => ({
    schedule: scheduleTab,
    roster: rosterTab,
    people: peopleTab,
    carpools: carpoolsTab,
    places: placesTab,
    teams: teamsTab,
    club: clubTab,
  }[view.tab]());

  // --- schedule ------------------------------------------------------------

  function scheduleTab() {
    const { events, locations } = view.data;
    const mine = events.filter(e => e.team_id === context.team.teamId);
    const editing = view.editingEvent;

    if (!locations.length) {
      return `<div class="empty"><h3>Add a location first</h3>
        <p>Events need somewhere to be. Add a field or park under <b>Places</b>,
           then come back here.</p></div>`;
    }

    return `
      <form class="coordForm" id="eventForm">
        <h3>${editing ? 'Edit event' : 'Add an event'}</h3>
        <input type="hidden" name="id" value="${editing?.id ?? ''}">
        <div class="two">
          <label>Type<select name="eventType">
            ${['practice', 'game', 'tournament'].map(t =>
              `<option value="${t}" ${editing?.event_type === t ? 'selected' : ''}>${t[0].toUpperCase() + t.slice(1)}</option>`).join('')}
          </select></label>
          <label>Title<input name="title" required maxlength="120"
            value="${h(editing?.title || '')}" placeholder="vs Kitsap Rangers"></label>
        </div>
        <div class="two">
          <label>Date<input name="eventDate" type="date" required value="${h(editing?.event_date || '')}"></label>
          <label>Start time<input name="startTime" type="time" required value="${h(clock(editing?.start_time) || '')}"></label>
        </div>
        <label>Location<select name="locationId" required>
          <option value="">Choose a location</option>
          ${locations.map(l => `<option value="${l.id}">${h(l.name)}</option>`).join('')}
        </select></label>
        <label>Notes<input name="notes" maxlength="300" value="${h(editing?.notes || '')}"
          placeholder="Arrive 30 minutes early"></label>
        <div class="formActions">
          <button class="primary submit">${editing ? 'Save changes' : 'Add event'}</button>
          ${editing ? `<button type="button" class="outline" data-cancel-edit>Cancel</button>` : ''}
        </div>
      </form>

      <h3>Scheduled (${mine.length})</h3>
      ${mine.length ? `<ul class="coordList">
        ${mine.map(e => `<li>
          <div><b>${h(e.title)}</b>
            <small>${h(longDate(e.event_date))} · ${h(clock(e.start_time))} · ${h(e.location_name || 'No location')}</small></div>
          <div class="rowActions">
            <button class="textButton" data-edit-event="${e.id}">Edit</button>
            <button class="dangerText" data-delete-event="${e.id}">Delete</button>
          </div></li>`).join('')}
      </ul>` : `<p class="muted">No events yet.</p>`}`;
  }

  // --- roster --------------------------------------------------------------

  function rosterTab() {
    const roster = view.data.roster.filter(r => r.team_id === context.team.teamId);
    return `
      <form class="coordForm" id="playerForm">
        <h3>Add a player</h3>
        <p class="muted">If this child is already in the club — a sibling, or a player
          moving up — reuse their exact name and they keep one household and one address.</p>
        <label>Player name<input name="name" required maxlength="120" placeholder="Avery Lee"></label>
        <button class="primary submit">Add to roster</button>
      </form>

      <h3>${h(context.team.teamName)} roster (${roster.length})</h3>
      ${roster.length ? `<ul class="coordList">
        ${roster.map(r => `<li>
          <div><b>${h(r.name)}</b>
            <small>${r.household_id ? 'Linked to a family' : 'No family linked yet'}</small></div>
          <button class="dangerText" data-remove-player="${r.person_id}">Remove</button>
        </li>`).join('')}
      </ul>` : `<p class="muted">Nobody on the roster yet.</p>`}`;
  }

  // --- people --------------------------------------------------------------

  function peopleTab() {
    const members = view.data.members.filter(m => m.team_id === context.team.teamId);
    const invites = view.data.invitations.filter(i => i.team_id === context.team.teamId);

    return `
      <form class="coordForm" id="inviteForm">
        <h3>Invite families</h3>
        <p class="muted">An invitation is the only way in. Paste as many addresses as you like —
          commas, spaces or new lines. Anyone who signs in without one sees nothing.</p>
        <label>Email addresses<textarea name="emails" rows="3" required
          placeholder="one@example.com, two@example.com"></textarea></label>
        <label>Role<select name="role">
          <option value="parent">Parent</option>
          <option value="coach">Coach — can see the roster</option>
          <option value="team_admin">Team coordinator — can do everything here</option>
        </select></label>
        <button class="primary submit">Send invitations</button>
      </form>

      ${invites.length ? `
        <h3>Invited, not signed in yet (${invites.length})</h3>
        <ul class="coordList">
          ${invites.map(i => `<li>
            <div><b>${h(i.email)}</b><small>${h(ROLE_LABEL[i.role] || i.role)} · invited ${h(shortDate(String(i.created_at).slice(0, 10)))}</small></div>
            <button class="dangerText" data-revoke="${i.id}">Revoke</button>
          </li>`).join('')}
        </ul>` : ''}

      <h3>Members (${members.length})</h3>
      ${members.length ? `<ul class="coordList">
        ${members.map(m => `<li>
          <div><b>${h(m.display_name || m.email)}</b>
            <small>${h(m.email)} · ${h(ROLE_LABEL[m.role] || m.role)}${m.status !== 'active' ? ` · ${h(m.status)}` : ''}</small></div>
          <div class="rowActions">
            <select data-role-for="${m.id}" aria-label="Role for ${h(m.display_name || m.email)}">
              ${['parent', 'coach', 'team_admin'].map(r =>
                `<option value="${r}" ${m.role === r ? 'selected' : ''}>${ROLE_LABEL[r]}</option>`).join('')}
            </select>
            <button class="outline small" data-status-for="${m.id}"
              data-status="${m.status === 'active' ? 'paused' : 'active'}">
              ${m.status === 'active' ? 'Pause' : 'Restore'}
            </button>
          </div></li>`).join('')}
      </ul>` : `<p class="muted">No members yet.</p>`}
      <p class="muted">Pausing revokes access immediately. Club administrators are managed
        under <b>Club</b>, not here — a team coordinator cannot promote anyone to club level.</p>`;
  }

  // --- carpools (route optimisation) ---------------------------------------

  function carpoolsTab() {
    const upcoming = view.data.events
      .filter(e => e.team_id === context.team.teamId)
      .sort((a, b) => `${a.event_date}${a.start_time}`.localeCompare(`${b.event_date}${b.start_time}`));

    if (!upcoming.length) return `<p class="muted">Add an event first, then plan carpools for it.</p>`;

    return `
      <h3>Suggest carpools</h3>
      <p class="muted">Works out who drives whom and the shortest pickup order.
        Nothing is saved until you accept it.</p>
      <div class="two">
        <label>Event<select data-plan-event>
          ${upcoming.map(e => `<option value="${e.id}">${h(e.title)} · ${h(shortDate(e.event_date))}</option>`).join('')}
        </select></label>
        <label>Leg<select data-plan-leg>
          <option value="to">To the event</option>
          <option value="from">Home afterwards</option>
        </select></label>
      </div>
      <button class="primary" data-suggest>Suggest carpools</button>
      <div data-plan-result></div>`;
  }

  // --- places --------------------------------------------------------------

  function placesTab() {
    const { locations, pickupAreas } = view.data;
    return `
      <form class="coordForm" id="locationForm">
        <h3>Add a location</h3>
        <p class="muted">Fields and parks everyone can see. Coordinates are optional but
          route planning needs them.</p>
        <label>Name<input name="name" required maxlength="120" placeholder="Battle Point Park"></label>
        <label>Google Maps link<input name="mapUrl" type="url" placeholder="https://maps.app.goo.gl/..."></label>
        <div class="two">
          <label>Latitude<input name="lat" type="number" step="any" placeholder="47.6631"></label>
          <label>Longitude<input name="lng" type="number" step="any" placeholder="-122.5615"></label>
        </div>
        <button class="primary submit">Add location</button>
      </form>
      ${locations.length ? `<ul class="coordList">
        ${locations.map(l => {
          const url = safeUrl(l.map_url);
          return `<li>
            <div><b>${h(l.name)}</b><small>${l.lat != null ? 'Has coordinates' : 'No coordinates — cannot be routed'}</small></div>
            <div class="rowActions">
              ${url ? `<a class="textButton" href="${h(url)}" target="_blank" rel="noreferrer noopener">Map</a>` : ''}
              <button class="dangerText" data-delete-location="${l.id}">Delete</button>
            </div></li>`;
        }).join('')}
      </ul>` : `<p class="muted">No locations yet.</p>`}

      <form class="coordForm" id="areaForm">
        <h3>Add a pickup area</h3>
        <p class="muted">Coarse neighbourhoods — "Winslow", "Rolling Bay". These are what
          other families see instead of an address.</p>
        <label>Area name<input name="name" required maxlength="80" placeholder="Winslow"></label>
        <button class="primary submit">Add area</button>
      </form>
      <div class="coordForm">
        <h3>Locate family addresses</h3>
        <p class="muted">Route planning needs coordinates. Families are located
          automatically when they save an address; this catches any that were added
          before, or whose lookup failed. Sends only the address, from the server,
          about one per second. Every run is logged.</p>
        <button class="outline" data-geocode>Locate addresses</button>
        <div data-geocode-result></div>
      </div>

      ${pickupAreas.length ? `<ul class="coordList compact">
        ${pickupAreas.map(a => `<li><div><b>${h(a.name)}</b></div>
          <button class="dangerText" data-delete-area="${a.id}">Delete</button></li>`).join('')}
      </ul>` : `<p class="muted">No pickup areas yet.</p>`}`;
  }

  // --- teams ---------------------------------------------------------------

  function teamsTab() {
    const { teams, canManageClub } = view.data;
    if (!canManageClub) {
      return `<p class="muted">Only a club administrator can add or rename teams.</p>`;
    }
    return `
      <form class="coordForm" id="teamForm">
        <h3>Add a team</h3>
        <label>Team name<input name="name" required maxlength="80" placeholder="Boys U11 Black"></label>
        <div class="two">
          <label>Season<input name="season" maxlength="40" placeholder="2026"></label>
          <label>Age group<input name="ageGroup" maxlength="40" placeholder="U11"></label>
        </div>
        <button class="primary submit">Create team</button>
      </form>

      <h3>Teams in ${h(context.team.clubName)} (${teams.length})</h3>
      <ul class="coordList">
        ${teams.map(t => `<li>
          <div><b>${h(t.name)}</b><small>${h(t.season || 'No season set')}</small></div>
          ${t.id === context.team.teamId ? '<span class="badge">Current</span>' : ''}
        </li>`).join('')}
      </ul>`;
  }

  // --- club ----------------------------------------------------------------

  function clubTab() {
    const { clubs, canManageClub, isPlatformAdmin } = view.data;
    const club = clubs.find(c => c.id === context.team.clubId);
    if (!canManageClub || !club) {
      return `<p class="muted">Only a club administrator can change club settings.</p>`;
    }

    return `
      <form class="coordForm" id="clubForm">
        <h3>Club settings</h3>
        <label>Club name<input name="name" required maxlength="120" value="${h(club.name)}"></label>
        <label class="checkboxRow">
          <input type="checkbox" name="allowCrossTeamPools" ${club.allow_cross_team_pools ? 'checked' : ''}>
          <span><b>Allow cross-team carpooling</b>
            <small>Lets two teams at the same venue share cars — for siblings on
            different teams. Even with this on, both teams must opt into each
            shared event, and the other team sees only a first name and a pickup
            area. Off by default.</small></span>
        </label>
        <button class="primary submit">Save club</button>
      </form>

      ${isPlatformAdmin ? `
        <form class="coordForm" id="newClubForm">
          <h3>Add another club</h3>
          <p class="muted">A separate club is a hard wall: its families, players and
            addresses are invisible from here, and from it. You become its first administrator.</p>
          <label>Club name<input name="name" required maxlength="120" placeholder="Second Club FC"></label>
          <button class="primary submit">Create club</button>
        </form>` : ''}

      <h3>Your clubs</h3>
      <ul class="coordList compact">
        ${clubs.map(c => `<li><div><b>${h(c.name)}</b>
          <small>${c.allow_cross_team_pools ? 'Cross-team carpooling on' : 'Cross-team carpooling off'}</small></div>
          ${c.id === context.team.clubId ? '<span class="badge">Current</span>' : ''}</li>`).join('')}
      </ul>`;
  }

  // --- wiring --------------------------------------------------------------

  const formData = form => Object.fromEntries(new FormData(form));

  function wire() {
    const on = (selector, handler, event = 'click') =>
      body.querySelectorAll(selector).forEach(el => el.addEventListener(event, handler));

    body.querySelector('#eventForm')?.addEventListener('submit', event => {
      event.preventDefault();
      const data = formData(event.target);
      act({
        action: 'upsert_event', teamId: context.team.teamId,
        id: data.id ? Number(data.id) : 0,
        eventType: data.eventType, title: data.title,
        eventDate: data.eventDate, startTime: data.startTime,
        locationId: Number(data.locationId), notes: data.notes,
      }, data.id ? 'Event updated.' : 'Event added.');
      view.editingEvent = null;
    });

    on('[data-edit-event]', e => {
      view.editingEvent = view.data.events.find(x => x.id === Number(e.currentTarget.dataset.editEvent));
      render();
    });
    on('[data-cancel-edit]', () => { view.editingEvent = null; render(); });
    on('[data-delete-event]', e =>
      act({ action: 'delete_record', kind: 'event', id: Number(e.currentTarget.dataset.deleteEvent) },
        'Event deleted.'));

    body.querySelector('#playerForm')?.addEventListener('submit', event => {
      event.preventDefault();
      act({ action: 'create_person', teamId: context.team.teamId, name: formData(event.target).name },
        result => result.reusedExisting
          ? 'Added — this child was already in the club, so their family details carry over.'
          : 'Player added.');
    });
    on('[data-remove-player]', e =>
      act({ action: 'unenroll_child', teamId: context.team.teamId,
            personId: Number(e.currentTarget.dataset.removePlayer) },
        'Removed from this roster. The child record is kept.'));

    body.querySelector('#inviteForm')?.addEventListener('submit', event => {
      event.preventDefault();
      const data = formData(event.target);
      act({ action: 'invite_members', teamId: context.team.teamId, role: data.role, emails: data.emails },
        result => {
          const parts = [`${result.invited.length} invited`];
          if (result.alreadyMembers.length) parts.push(`${result.alreadyMembers.length} already a member`);
          if (result.rejected.length) parts.push(`could not read: ${result.rejected.join(', ')}`);
          return parts.join(' · ');
        });
    });
    on('[data-revoke]', e =>
      act({ action: 'revoke_invite', inviteId: Number(e.currentTarget.dataset.revoke) }, 'Invitation revoked.'));
    on('[data-role-for]', e =>
      act({ action: 'set_member_role', membershipId: Number(e.currentTarget.dataset.roleFor),
            role: e.currentTarget.value }, 'Role updated.'), 'change');
    on('[data-status-for]', e =>
      act({ action: 'approve_member', membershipId: Number(e.currentTarget.dataset.statusFor),
            status: e.currentTarget.dataset.status },
        e.currentTarget.dataset.status === 'paused' ? 'Access paused.' : 'Access restored.'));

    body.querySelector('#locationForm')?.addEventListener('submit', event => {
      event.preventDefault();
      const data = formData(event.target);
      act({ action: 'upsert_location', clubId: context.team.clubId, name: data.name,
            mapUrl: data.mapUrl, lat: data.lat, lng: data.lng }, 'Location added.');
    });
    on('[data-delete-location]', e =>
      act({ action: 'delete_record', kind: 'location', id: Number(e.currentTarget.dataset.deleteLocation) },
        'Location deleted.'));

    body.querySelector('#areaForm')?.addEventListener('submit', event => {
      event.preventDefault();
      act({ action: 'upsert_pickup_area', clubId: context.team.clubId, name: formData(event.target).name },
        'Pickup area added.');
    });
    on('[data-delete-area]', e =>
      act({ action: 'delete_record', kind: 'pickup_area', id: Number(e.currentTarget.dataset.deleteArea) },
        'Pickup area deleted.'));

    body.querySelector('#teamForm')?.addEventListener('submit', event => {
      event.preventDefault();
      const data = formData(event.target);
      act({ action: 'create_team', clubId: context.team.clubId, name: data.name,
            season: data.season, ageGroup: data.ageGroup }, 'Team created.');
    });

    body.querySelector('#clubForm')?.addEventListener('submit', event => {
      event.preventDefault();
      const form = event.target;
      act({ action: 'update_club', clubId: context.team.clubId,
            name: form.name.value,
            allowCrossTeamPools: form.allowCrossTeamPools.checked }, 'Club settings saved.');
    });

    body.querySelector('#newClubForm')?.addEventListener('submit', event => {
      event.preventDefault();
      act({ action: 'create_club', name: formData(event.target).name },
        'Club created. Switch to it from the team menu once it has a team.');
    });

    body.querySelector('[data-geocode]')?.addEventListener('click', async event => {
      const button = event.currentTarget;
      const slot = body.querySelector('[data-geocode-result]');
      button.disabled = true;
      slot.innerHTML = '<p class="muted">Looking up addresses…</p>';
      try {
        const result = await post('/api/admin', {
          action: 'geocode_households', clubId: context.team.clubId,
        });
        slot.innerHTML = result.processed === 0
          ? notice('Every family with an address is already located.')
          : notice(`Located ${result.located} of ${result.processed}.` +
              (result.remaining ? ` ${result.remaining} still to do — run it again.` : ''));
      } catch (error) {
        slot.innerHTML = notice(error.message, 'error');
      }
      button.disabled = false;
    });

    body.querySelector('[data-suggest]')?.addEventListener('click', async () => {
      const eventId = Number(body.querySelector('[data-plan-event]').value);
      const leg = body.querySelector('[data-plan-leg]').value;
      const slot = body.querySelector('[data-plan-result]');
      slot.innerHTML = '<p class="muted">Working out the shortest routes…</p>';
      try {
        const plan = await post('/api/plan', { eventId, leg });
        slot.innerHTML = renderPlan(plan);
        slot.querySelector('[data-accept]')?.addEventListener('click', async () => {
          const assignments = plan.routes.flatMap(r =>
            r.riders.map(rider => ({ requestId: rider.requestId, offerId: r.offerId })));
          try {
            const result = await post('/api/plan/accept', { eventId, leg, assignments });
            view.message = `${result.written} assignments saved.`;
            context.onChanged?.();
            await load();
            render();
          } catch (error) {
            slot.innerHTML = notice(error.message, 'error');
          }
        });
      } catch (error) {
        slot.innerHTML = notice(error.message, 'error');
      }
    });
  }

  function renderPlan(plan) {
    if (!plan.routes.length) {
      return notice('No suggestions yet — this leg needs at least one driver and one rider.');
    }
    return `
      <div class="planSummary"><b>${plan.routes.length} cars</b> · ${miles(plan.totalKm)} total driving
        <small>Distances from ${plan.provider === 'haversine' ? 'straight-line estimates' : 'road routing'}.</small></div>
      ${plan.routes.map(route => `
        <article class="planCard">
          <h4>${h(route.driverName)}</h4>
          <p>${route.riders.length} riders · ${miles(route.distanceKm)} · about ${route.durationMin} min</p>
          <ol>${route.riders.map(r => `<li>${h(r.childName)}</li>`).join('')}</ol>
        </article>`).join('')}
      ${plan.unassigned.length ? notice(`No seat for: ${plan.unassigned.map(u => u.childName).join(', ')}. More drivers needed.`, 'error') : ''}
      ${plan.needsAddress.length ? notice(`Missing an address: ${plan.needsAddress.map(u => u.childName).join(', ')}. They cannot be routed yet.`) : ''}
      <button class="primary" data-accept>Accept these assignments</button>`;
  }

  try {
    await load();
    render();
  } catch (error) {
    body.innerHTML = notice(error.message, 'error');
  }

  return { close };
}
