import { configureApi, get, post, once, ApiError } from './api.js';
import { modal } from './ui.js';
import { openCoordinator } from './coordinator.js';
import {
  h, safeUrl, initials, shortDate, longDate, clock,
  isUpcoming, directionLabel, usesLeg, miles,
} from './util.js';

// --- configuration ---------------------------------------------------------

const CONFIG = window.CARPOOL_CONFIG || {};
const firebaseConfig = CONFIG.firebase || {};

const root = document.querySelector('#app');

const state = {
  me: null,
  membership: null,   // the active team context
  board: null,
  notice: '',
  busy: false,
  online: navigator.onLine,
  plan: null,
};

// --- auth ------------------------------------------------------------------

firebase.initializeApp(firebaseConfig);

configureApi({
  base: CONFIG.apiBase,
  // Always ask Firebase for the token. It returns the cached one until it is
  // close to expiry, so this costs nothing and never serves a stale token.
  tokenProvider: async () => {
    const user = firebase.auth().currentUser;
    if (!user) throw new Error('signed out');
    return user.getIdToken();
  },
});

firebase.auth().onAuthStateChanged(async user => {
  if (!user) {
    state.me = null;
    renderSignIn();
    return;
  }
  if (!user.emailVerified) {
    try { await user.sendEmailVerification(); } catch { /* rate-limited; the message still stands */ }
    await firebase.auth().signOut();
    renderSignIn('Check your email and verify your address, then sign in again.');
    return;
  }
  await loadMe();
});

async function loadMe() {
  try {
    renderLoading();
    state.me = await get('/api/me');
    // Openable teams come from the server, not from membership rows: a club
    // admin's membership names no team at all, so deriving the list here
    // would strand them on the approval screen.
    const teams = state.me.teams || [];
    const remembered = Number(localStorage.getItem('carpool.team'));
    state.membership = teams.find(t => t.teamId === remembered) || teams[0] || null;
    if (!state.membership) {
      renderPending();
      return;
    }
    await loadBoard();
  } catch (error) {
    renderSignIn(error.message);
  }
}

async function loadBoard(eventId) {
  if (!state.membership?.teamId) return renderPending();
  const params = new URLSearchParams({ teamId: String(state.membership.teamId) });
  if (eventId) params.set('eventId', String(eventId));
  state.board = await get(`/api/board?${params}`);
  state.plan = null;
  render();
}

async function refresh(notice = '') {
  state.notice = notice;
  await loadBoard(state.board?.event?.id);
}

// --- sign-in ---------------------------------------------------------------

function renderSignIn(message = '', mode = 'signin') {
  const title = mode === 'create' ? 'Create account' : mode === 'reset' ? 'Reset password' : 'Team sign-in';
  root.innerHTML = `
    <main class="pinPage"><section class="pinCard authCard">
      <span class="brandMark">SC</span>
      <p class="eyebrow">SOCCER CARPOOL</p>
      <h1>${title}</h1>
      <p>${mode === 'create'
        ? 'Use any email address. You will verify it before a coordinator approves access.'
        : mode === 'reset'
          ? 'Enter your email and we will send a reset link.'
          : 'Sign in with Google or your verified email address.'}</p>
      ${message ? `<div class="notice error" role="alert">${h(message)}</div>` : ''}
      ${mode === 'signin'
        ? `<button class="googleButton" id="googleLogin"><span>G</span>Continue with Google</button>
           <div class="authDivider"><span>or</span></div>` : ''}
      <form class="emailAuthForm" id="emailAuth">
        <label>Email address<input name="email" type="email" autocomplete="email" required></label>
        ${mode !== 'reset'
          ? `<label>Password<input name="password" type="password" minlength="8"
               autocomplete="${mode === 'create' ? 'new-password' : 'current-password'}" required></label>` : ''}
        ${mode === 'create'
          ? `<label>Confirm password<input name="confirmPassword" type="password" minlength="8"
               autocomplete="new-password" required></label>` : ''}
        <button class="primary submit">${mode === 'create' ? 'Create account' : mode === 'reset' ? 'Send reset email' : 'Sign in'}</button>
      </form>
      <div class="authLinks">
        ${mode === 'signin'
          ? `<button class="textButton" data-mode="create">Create an account</button>
             <button class="textButton" data-mode="reset">Forgot password?</button>`
          : `<button class="textButton" data-mode="signin">← Back to sign in</button>`}
      </div>
      <small class="privacyNote">New accounts need approval from your team coordinator.</small>
    </section></main>`;

  root.querySelectorAll('[data-mode]').forEach(button =>
    button.addEventListener('click', () => renderSignIn('', button.dataset.mode)));

  root.querySelector('#googleLogin')?.addEventListener('click', async () => {
    const provider = new firebase.auth.GoogleAuthProvider();
    try {
      await firebase.auth().signInWithPopup(provider);
    } catch (error) {
      // Popups are routinely blocked in the in-app browsers parents open
      // links from (Messages, Facebook, Gmail). Redirect always works.
      if (['auth/popup-blocked', 'auth/popup-closed-by-user',
           'auth/operation-not-supported-in-this-environment',
           'auth/cancelled-popup-request'].includes(error.code)) {
        await firebase.auth().signInWithRedirect(provider);
        return;
      }
      renderSignIn(authMessage(error));
    }
  });

  const form = root.querySelector('#emailAuth');
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const data = new FormData(form);
    const email = String(data.get('email') || '').trim();
    const password = String(data.get('password') || '');
    const button = form.querySelector('button');
    button.disabled = true;
    try {
      if (mode === 'reset') {
        await firebase.auth().sendPasswordResetEmail(email);
        renderSignIn('Reset email sent. Check your inbox and spam folder.');
        return;
      }
      if (mode === 'create') {
        if (password !== String(data.get('confirmPassword') || '')) {
          throw Object.assign(new Error('Those passwords do not match.'), { code: 'mismatch' });
        }
        await firebase.auth().createUserWithEmailAndPassword(email, password);
        return;
      }
      await firebase.auth().signInWithEmailAndPassword(email, password);
    } catch (error) {
      // Re-render keeps the typed email so a phone user is not retyping it.
      renderSignIn(authMessage(error), mode);
      const retry = root.querySelector('input[name="email"]');
      if (retry) retry.value = email;
    }
  });
}

function authMessage(error) {
  switch (error.code) {
    case 'mismatch': return 'Those passwords do not match.';
    case 'auth/operation-not-allowed': return 'Email sign-in is not switched on yet. Contact your coordinator.';
    case 'auth/email-already-in-use': return 'That email already has an account. Sign in, or use Forgot password.';
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found': return 'That email or password was not recognised.';
    case 'auth/weak-password': return 'Choose a password of at least eight characters.';
    case 'auth/invalid-email': return 'Enter a valid email address.';
    case 'auth/too-many-requests': return 'Too many attempts. Wait a few minutes and try again.';
    case 'auth/network-request-failed': return 'No connection. Check your signal and try again.';
    default: return error.message || 'Sign-in failed. Please try again.';
  }
}

// --- shells ----------------------------------------------------------------

const renderLoading = () => {
  root.innerHTML = `<main class="pinPage"><section class="pinCard">
    <span class="brandMark">SC</span><h1>Loading your teams…</h1></section></main>`;
};

function renderPending() {
  const email = state.me?.user?.email ?? '';
  root.innerHTML = `<main class="pinPage"><section class="pinCard pendingCard">
    <span class="brandMark">SC</span>
    <p class="eyebrow">SIGNED IN AS ${h(email)}</p>
    <h1>You are not on a team yet</h1>
    <p>Access starts with an invitation. Ask your team coordinator to invite
       <b>${h(email)}</b> — the address you just signed in with. Once they do,
       reopen this page and your team will be here.</p>
    <p class="privacyNote">If you used a different address than the one they have,
       that is usually the reason.</p>
    <div class="pendingActions">
      <button class="primary" data-retry>Check again</button>
      <button class="textButton" data-signout>Sign out</button>
    </div>
  </section></main>`;
  root.querySelector('[data-retry]').addEventListener('click', () => loadMe());
  root.querySelector('[data-signout]').addEventListener('click', () => firebase.auth().signOut());
}

// --- main render -----------------------------------------------------------

function render() {
  const { board, me, membership } = state;
  if (!board) return;

  const upcoming = board.events.filter(isUpcoming);
  const event = board.event;
  const openableTeams = me.teams || [];
  const canCoordinate = ['team_admin', 'club_admin'].includes(membership.role);

  const needSeats = board.requests.filter(r => !r.offerTo && !r.offerFrom).length;
  const seatsOffered = board.offers.reduce((sum, o) => sum + o.capacity, 0);

  root.innerHTML = `
    <header class="topbar">
      <a class="brand" href="#my-rides"><span class="brandMark">SC</span>
        <span><b>${h(membership.clubName)}</b><small>${h(membership.teamName || 'Team ride board')}</small></span></a>
      <div class="topActions">
        ${openableTeams.length > 1 ? teamSwitcher(openableTeams) : ''}
        <button class="outline small" data-profile>My family</button>
        ${canCoordinate ? '<button class="outline small" data-coordinate>Coordinate</button>' : ''}
        <button class="outline small" data-signout>Sign out</button>
      </div>
    </header>

    ${state.online ? '' : '<div class="notice error" role="status">You are offline. Showing the last board that loaded.</div>'}
    ${state.notice ? `<div class="notice" role="status">${h(state.notice)}</div>` : ''}

    ${myRidesSection()}

    <section class="workspace" id="team-board">
      <div class="sectionHeading">
        <div><p class="eyebrow">CARPOOL BOARD</p><h2>${h(membership.teamName || 'Games & practices')}</h2></div>
        <div class="summaryPills">
          <span><b>${needSeats}</b> need a seat</span>
          <span><b>${seatsOffered}</b> seats offered</span>
        </div>
      </div>

      ${!board.events.length
        ? `<div class="empty"><div>⚽</div><h3>No schedule yet</h3>
             <p>Your coordinator will add the next game or practice.</p></div>`
        : `
        ${upcoming.length > 1 ? eventTabs(upcoming, event) : ''}
        ${event ? eventHeader(event) : ''}
        ${event ? boardColumns() : ''}`}
    </section>

    <footer><span>Soccer Carpool</span><p>Clear rides. Happy families. Players on the pitch.</p></footer>`;

  bind();
}

const teamSwitcher = teams => `
  <label class="teamSwitcher">
    <span class="visuallyHidden">Team</span>
    <select data-team>
      ${teams.map(m => `
        <option value="${m.teamId}" ${m.teamId === state.membership.teamId ? 'selected' : ''}>
          ${h(m.clubName)} · ${h(m.teamName)}
        </option>`).join('')}
    </select>
  </label>`;

const eventTabs = (events, selected) => `
  <div class="eventTabs" role="tablist" aria-label="Upcoming games and practices">
    ${events.map(item => `
      <button role="tab" id="event-tab-${item.id}" aria-controls="selected-event-panel"
              aria-selected="${item.id === selected?.id}" tabindex="${item.id === selected?.id ? 0 : -1}"
              data-event="${item.id}" class="${item.id === selected?.id ? 'active' : ''}">
        <small><span class="eventType ${h(item.event_type)}">${h(item.event_type)}</span>${h(shortDate(item.event_date))}</small>
        <b>${h(item.title)}</b><span>${h(clock(item.start_time))}</span>
      </button>`).join('')}
  </div>`;

function eventHeader(event) {
  const map = safeUrl(event.map_url);
  const pooled = Boolean(event.pool_id);
  return `
    <div class="eventHeader" id="selected-event-panel" role="tabpanel"
         ${event.id ? `aria-labelledby="event-tab-${event.id}"` : ''}>
      <div>
        <p>${h(longDate(event.event_date))} · Starts ${h(clock(event.start_time))}</p>
        <h3>${h(event.title)}</h3>
        ${map
          ? `<a class="mapLink" href="${h(map)}" target="_blank" rel="noreferrer noopener">📍 ${h(event.location_name || 'Location')}</a>`
          : `<span>${h(event.location_name || 'Location to be confirmed')}</span>`}
        ${pooled ? '<span class="poolBadge" title="Shared with another team at this venue">🤝 Shared carpool</span>' : ''}
      </div>
      ${isUpcoming(event) ? `
        <div class="eventButtons">
          <button class="outline" data-offer>Offer seats</button>
          <button class="primary" data-request>Request ride</button>
        </div>` : ''}
    </div>`;
}

function boardColumns() {
  const { board } = state;
  return `
    <div class="boardGrid">
      <section class="boardColumn boardDrivers">
        <div class="columnTitle"><div><span class="dot green"></span><h3>Drivers</h3></div><b>${board.offers.length}</b></div>
        ${board.offers.length ? board.offers.map(driverCard).join('')
          : '<div class="empty">No drivers yet. Be the first to offer seats.</div>'}
      </section>

      <section class="boardColumn boardRequests">
        <div class="columnTitle"><div><span class="dot amber"></span><h3>Needs a ride</h3></div>
          <b>${board.requests.length + board.pooledRequests.length}</b></div>
        ${board.requests.map(requestCard).join('')}
        ${board.pooledRequests.length ? `
          <div class="pooledGroup">
            <h4>Shared with another team</h4>
            <p class="privacyCallout">These families are at the same venue. You can offer them a seat; you cannot see their roster.</p>
            ${board.pooledRequests.map(pooledCard).join('')}
          </div>` : ''}
        ${!board.requests.length && !board.pooledRequests.length
          ? '<div class="empty">Everyone has transportation for this event.</div>' : ''}
      </section>
    </div>`;
}

function driverCard(offer) {
  const seatsOut = Math.max(0, offer.capacity - offer.usedTo);
  const seatsBack = Math.max(0, offer.capacity - offer.usedFrom);
  const availability = offer.direction === 'to' ? `${seatsOut} out`
    : offer.direction === 'from' ? `${seatsBack} back`
    : `${seatsOut} out · ${seatsBack} back`;
  const riders = state.board.requests.filter(r => r.offerTo === offer.id || r.offerFrom === offer.id);

  return `
    <article class="card">
      <div class="cardTop">
        <div class="avatar">${h(initials(offer.driverName))}</div>
        <div><h4>${h(offer.driverName)}</h4>
          <p>${h(directionLabel(offer.direction))}${offer.vehicleName ? ` · ${h(offer.vehicleName)}` : ''}</p></div>
        <span class="badge">${h(availability)}</span>
      </div>
      ${riders.length ? `
        <div class="passengers">
          <small>RIDING WITH ${h(String(offer.driverName).split(' ')[0].toUpperCase())}</small>
          ${riders.map(r => `<span>✓ ${h(r.childName)}</span>`).join('')}
        </div>` : ''}
      ${offer.driverPhone ? `<p class="contact"><a href="tel:${h(offer.driverPhone)}">${h(offer.driverPhone)}</a></p>` : ''}
      ${offer.notes ? `<p>“${h(offer.notes)}”</p>` : ''}
      ${offer.isMine && riders.length ? `<button class="routeButton" data-route="${offer.id}">🧭 Open my pickup route</button>` : ''}
      ${offer.isMine && !riders.length ? `<button class="dangerText" data-cancel-offer="${offer.id}">Cancel driving offer</button>` : ''}
    </article>`;
}

function requestCard(request) {
  const matched = Boolean(request.offerTo || request.offerFrom);
  const myOffer = state.board.offers.find(
    o => o.isMine && usesLeg(o.direction, request.direction === 'roundtrip' ? 'to' : request.direction),
  );
  const assignedToMe = state.board.offers.some(
    o => o.isMine && (o.id === request.offerTo || o.id === request.offerFrom),
  );
  const map = safeUrl(request.pickupLocationMap);

  return `
    <article class="card ${matched ? 'assigned' : ''}">
      <div class="cardTop">
        <div class="avatar player">${h(initials(request.childName))}</div>
        <div><h4>${h(request.childName)}</h4><p>${h(directionLabel(request.direction))}</p></div>
        <span class="badge ${matched ? '' : 'waiting'}">${matched ? 'Matched' : 'Needs ride'}</span>
      </div>
      ${request.pickupLocation && map
        ? `<a class="mapLink rideLocation" href="${h(map)}" target="_blank" rel="noreferrer noopener">📍 ${h(request.pickupLocation)}</a>`
        : `<div class="privatePickup">🔒 <span>${h(request.pickupArea || 'Pickup area not set')}</span> · exact address stays private</div>`}
      ${request.notes ? `<p>“${h(request.notes)}”</p>` : ''}
      <div class="rideActions">
        ${!matched && myOffer ? `<button class="primary small" data-claim="${request.id}" data-offer="${myOffer.id}">Add to my car</button>` : ''}
        ${assignedToMe ? `<button class="outline small" data-reveal="${request.id}">View pickup details</button>` : ''}
        ${assignedToMe || request.isMine ? `<button class="dangerText" data-unclaim="${request.id}">${request.isMine ? 'Remove driver' : 'Remove from my car'}</button>` : ''}
        ${request.isMine ? `<button class="dangerText" data-cancel-ride="${request.id}">Cancel request</button>` : ''}
      </div>
      <div class="revealSlot" data-reveal-slot="${request.id}"></div>
    </article>`;
}

function pooledCard(request) {
  const myOffer = state.board.offers.find(o => o.isMine && usesLeg(o.direction, request.direction === 'roundtrip' ? 'to' : request.direction));
  return `
    <article class="card pooled ${request.assigned ? 'assigned' : ''}">
      <div class="cardTop">
        <div class="avatar player">${h(initials(request.childName))}</div>
        <div><h4>${h(request.childName)}</h4><p>${h(directionLabel(request.direction))} · another team</p></div>
        <span class="badge ${request.assigned ? '' : 'waiting'}">${request.assigned ? 'Matched' : 'Needs ride'}</span>
      </div>
      <div class="privatePickup">🔒 <span>${h(request.pickupArea || 'Pickup area not set')}</span></div>
      <div class="rideActions">
        ${!request.assigned && myOffer ? `<button class="primary small" data-claim="${request.id}" data-offer="${myOffer.id}">Add to my car</button>` : ''}
      </div>
    </article>`;
}

// --- my rides --------------------------------------------------------------

function myRidesSection() {
  const { board } = state;
  const mine = board.requests.filter(r => r.isMine);
  const driving = board.offers.filter(o => o.isMine);
  if (!mine.length && !driving.length) {
    return `<section class="myRides" id="my-rides">
      <div class="myRidesHead"><div><p class="eyebrow">YOUR FAMILY</p><h1>My rides</h1>
        <p>Nothing booked for this event yet.</p></div>
        <div class="myRidesActions">
          <button class="outline" data-offer>Offer seats</button>
          <button class="primary" data-request>Request ride</button>
        </div></div>
    </section>`;
  }

  return `<section class="myRides" id="my-rides">
    <div class="myRidesHead"><div><p class="eyebrow">YOUR FAMILY</p><h1>My rides</h1></div>
      <div class="myRidesActions">
        <button class="outline" data-offer>Offer seats</button>
        <button class="primary" data-request>Request ride</button>
      </div></div>
    <div class="myRidesGrid">
      ${mine.map(r => {
        const driver = board.offers.find(o => o.id === r.offerTo || o.id === r.offerFrom);
        return `<article class="myRideCard">
          <div class="myRideCardTop"><span class="myRideKind">CHILD RIDE</span>
            <span class="badge ${driver ? '' : 'waiting'}">${driver ? 'Matched' : 'Needs driver'}</span></div>
          <h2>${h(r.childName)}</h2>
          <dl><dt>Trip</dt><dd>${h(directionLabel(r.direction))}</dd>
            ${driver ? `<dt>Driver</dt><dd>${h(driver.driverName)}</dd>` : ''}
            ${driver?.driverPhone ? `<dt>Contact</dt><dd><a href="tel:${h(driver.driverPhone)}">${h(driver.driverPhone)}</a></dd>` : ''}
          </dl></article>`;
      }).join('')}
      ${driving.map(o => {
        const riders = board.requests.filter(r => r.offerTo === o.id || r.offerFrom === o.id);
        return `<article class="myRideCard driving">
          <div class="myRideCardTop"><span class="myRideKind">YOU'RE DRIVING</span>
            <span class="badge">${o.capacity - o.usedTo} seats left</span></div>
          <h2>${h(o.vehicleName || 'Your car')}</h2>
          <dl><dt>Trip</dt><dd>${h(directionLabel(o.direction))}</dd>
            <dt>Riders</dt><dd>${riders.length ? h(riders.map(r => r.childName).join(', ')) : 'None yet'}</dd></dl>
          ${riders.length ? `<button class="outline small" data-route="${o.id}">Open route</button>` : ''}
        </article>`;
      }).join('')}
    </div>
  </section>`;
}

// --- events ----------------------------------------------------------------

function bind() {
  const on = (selector, handler, event = 'click') =>
    root.querySelectorAll(selector).forEach(el => el.addEventListener(event, handler));

  on('[data-signout]', () => firebase.auth().signOut());
  on('[data-profile]', openProfile);
  on('[data-coordinate]', () => openCoordinator({
    team: state.membership,
    onChanged: () => { refresh().catch(showError); },
  }));

  root.querySelector('[data-team]')?.addEventListener('change', async event => {
    const teamId = Number(event.target.value);
    state.membership = (state.me.teams || []).find(t => t.teamId === teamId) || state.membership;
    localStorage.setItem('carpool.team', String(teamId));
    await guard(() => loadBoard());
  });

  on('[data-event]', async event => {
    await guard(() => loadBoard(Number(event.currentTarget.dataset.event)));
  });

  on('[data-request]', () => openRideModal());
  on('[data-offer]', () => openDriverModal());

  on('[data-claim]', event => {
    const { claim, offer } = event.currentTarget.dataset;
    guard(() => once(() => post('/api/rides', { action: 'claim', requestId: Number(claim), offerId: Number(offer) })
      .then(() => refresh('Added to your car.'))));
  });

  on('[data-unclaim]', event => {
    if (!confirm('Remove this rider? Their request returns to the open board.')) return;
    const id = Number(event.currentTarget.dataset.unclaim);
    guard(() => once(() => post('/api/rides', { action: 'unclaim', requestId: id })
      .then(() => refresh('Returned to the open board.'))));
  });

  on('[data-cancel-ride]', event => {
    if (!confirm('Cancel this ride request?')) return;
    const id = Number(event.currentTarget.dataset.cancelRide);
    guard(() => once(() => post('/api/rides', { action: 'cancel_ride', requestId: id })
      .then(() => refresh('Ride request cancelled.'))));
  });

  on('[data-cancel-offer]', event => {
    if (!confirm('Cancel your driving offer for this event?')) return;
    const id = Number(event.currentTarget.dataset.cancelOffer);
    guard(() => once(() => post('/api/rides', { action: 'cancel_offer', offerId: id })
      .then(() => refresh('Driving offer cancelled.'))));
  });

  on('[data-reveal]', async event => {
    const id = Number(event.currentTarget.dataset.reveal);
    const slot = root.querySelector(`[data-reveal-slot="${id}"]`);
    await guard(async () => {
      const result = await post('/api/rides', { action: 'reveal_pickup', requestId: id });
      const map = safeUrl(`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(result.address)}`);
      slot.innerHTML = `<div class="revealedPickup"><b>Pickup address</b>
        <a href="${h(map)}" target="_blank" rel="noreferrer noopener">📍 ${h(result.address)}</a>
        ${result.logged ? '<small>This family was told you viewed it.</small>' : ''}</div>`;
    });
  });

  on('[data-route]', async event => {
    const id = Number(event.currentTarget.dataset.route);
    // Open the tab synchronously so mobile Safari does not treat the later
    // navigation as a blocked popup.
    const tab = window.open('', '_blank');
    try {
      const result = await post('/api/route', { offerId: id, leg: 'to' });
      const url = safeUrl(result.url);
      if (!url) throw new ApiError('That route link was not usable.', 400);
      if (tab) tab.location.href = url;
      else window.location.href = url;
      state.notice = `Route ready: ${result.stops.length} stops, about ${result.durationMin} min${result.distanceKm ? ` · ${miles(result.distanceKm)}` : ''}.`;
      render();
    } catch (error) {
      tab?.close();
      showError(error);
    }
  });
}

/** Run an action, turning any failure into a visible, human message. */
async function guard(action) {
  if (state.busy) return;
  state.busy = true;
  try {
    await action();
  } catch (error) {
    showError(error);
  } finally {
    state.busy = false;
  }
}

function showError(error) {
  if (error instanceof ApiError && error.status === 401) {
    firebase.auth().signOut();
    return;
  }
  state.notice = error.message || 'Something went wrong.';
  if (state.board) render();
  else renderSignIn(state.notice);
}

// --- modals ----------------------------------------------------------------

function openRideModal() {
  const household = state.me.households.find(hh => hh.clubId === state.membership.clubId);
  const teamId = state.membership.teamId;
  const children = (household?.children || []).filter(c => c.teamIds.includes(teamId));
  const event = state.board.event;

  if (!children.length) {
    const { close } = modal('Request a ride', `<p>None of your children are on this team's roster yet.
      Ask your coordinator to add them, then request a ride.</p>
      <button class="primary" data-ok>Got it</button>`);
    document.querySelector('[data-ok]').addEventListener('click', close);
    return;
  }

  const { host, close } = modal('Request a ride', `
    <form id="rideForm">
      <fieldset class="rideChildren"><legend>Who needs a ride?</legend>
        ${children.map((c, i) => `<label class="${i === 0 ? 'selected' : ''}">
          <input type="checkbox" name="personIds" value="${c.id}" ${i === 0 ? 'checked' : ''}>
          <span>${h(c.name)}</span></label>`).join('')}
      </fieldset>
      <label>Trip<select name="direction">
        <option value="roundtrip">Round trip</option>
        <option value="to">To the event</option>
        <option value="from">Home afterwards</option>
      </select></label>
      <label>Pickup<select name="pickupKind">
        <option value="home">My home address — private</option>
        ${household?.alternateAddress ? '<option value="alternate">My alternate address — private</option>' : ''}
      </select></label>
      <label>Notes<input name="notes" placeholder="Booster seat, timing, gear" maxlength="200"></label>
      <small class="privateNote">Everyone sees your general pickup area. Only your assigned driver
        ever sees the exact address, and you are told each time they look.</small>
      <button class="primary submit">Request ride</button>
    </form>`);

  host.querySelectorAll('[name="personIds"]').forEach(input =>
    input.addEventListener('change', () => input.closest('label').classList.toggle('selected', input.checked)));

  host.querySelector('#rideForm').addEventListener('submit', async submitEvent => {
    submitEvent.preventDefault();
    const data = new FormData(submitEvent.target);
    const personIds = data.getAll('personIds').map(Number);
    if (!personIds.length) return;
    submitEvent.target.querySelector('.submit').disabled = true;
    await guard(async () => {
      await post('/api/rides', {
        action: 'request_ride',
        eventId: event.id,
        personIds,
        direction: data.get('direction'),
        pickupKind: data.get('pickupKind'),
        notes: data.get('notes'),
      });
      close();
      await refresh('Ride requested.');
    });
  });
}

function openDriverModal() {
  const household = state.me.households.find(hh => hh.clubId === state.membership.clubId);
  const vehicles = household?.vehicles || [];
  const event = state.board.event;

  if (!vehicles.length) {
    const { close } = modal('Offer seats', `<p>Add a vehicle to your family profile first, so other
      parents can see what your child will be riding in.</p>
      <button class="primary" data-go>Open my family</button>`);
    document.querySelector('[data-go]').addEventListener('click', () => { close(); openProfile(); });
    return;
  }

  const { host, close } = modal('Offer seats', `
    <form id="driverForm">
      <label>Vehicle<select name="vehicleId" data-vehicle>
        ${vehicles.map((v, i) => `<option value="${v.id}" data-seats="${v.seat_capacity}">
          ${h(v.name)}${i === 0 ? ' (preferred)' : ''} · ${v.seat_capacity} seats</option>`).join('')}
      </select></label>
      <div class="two">
        <label>Trip<select name="direction">
          <option value="roundtrip">Round trip</option>
          <option value="to">To the event</option>
          <option value="from">Home afterwards</option>
        </select></label>
        <label>Seats today<input name="capacity" data-capacity type="number" min="1" max="8"
          value="${vehicles[0].seat_capacity}" required></label>
      </div>
      <small class="privateNote">Adjust the seat count for gear, car seats, or your own children.</small>
      <label>Notes<input name="notes" placeholder="Can meet at school, room for gear" maxlength="200"></label>
      <button class="primary submit">Offer seats</button>
    </form>`);

  host.querySelector('[data-vehicle]').addEventListener('change', changeEvent => {
    host.querySelector('[data-capacity]').value =
      changeEvent.target.selectedOptions[0]?.dataset.seats || 3;
  });

  host.querySelector('#driverForm').addEventListener('submit', async submitEvent => {
    submitEvent.preventDefault();
    const data = new FormData(submitEvent.target);
    submitEvent.target.querySelector('.submit').disabled = true;
    await guard(async () => {
      await post('/api/rides', {
        action: 'offer_drive',
        eventId: event.id,
        vehicleId: Number(data.get('vehicleId')),
        capacity: Number(data.get('capacity')),
        direction: data.get('direction'),
        notes: data.get('notes'),
      });
      close();
      await refresh('Thanks for driving.');
    });
  });
}

function openProfile() {
  const clubId = state.membership?.clubId ?? state.me.memberships[0]?.clubId;
  const household = state.me.households.find(hh => hh.clubId === clubId);
  const areas = state.me.pickupAreas.filter(a => a.club_id === clubId);
  const user = state.me.user;

  const { host, close } = modal('My family', `
    <p class="privacyCallout">Your pickup area is visible to your team. Your exact address is released
      only to a driver actually carrying your child, and every release is logged below.</p>
    <form id="profileForm">
      <label>Your name<input name="displayName" value="${h(user.displayName)}" required maxlength="120"></label>
      <label>Mobile number<input name="phone" type="tel" value="${h(user.phone)}" required></label>
      <label>General pickup area<select name="pickupAreaId" required>
        <option value="">Choose an area</option>
        ${areas.map(a => `<option value="${a.id}" ${a.id === household?.pickupAreaId ? 'selected' : ''}>${h(a.name)}</option>`).join('')}
      </select></label>
      <label>Home address<input name="homeAddress" value="${h(household?.homeAddress || '')}"
        placeholder="Street, city, state, ZIP" maxlength="300"></label>
      <small class="privateNote">To plan pickup routes we look this address up on
        OpenStreetMap once, from our server. Only the address is sent — never your
        name, your children's names, or your team. You can skip it and type
        coordinates yourself below; without either, route planning will leave your
        family out rather than guess.</small>
      ${household?.homeGeocoded ? `<div class="geoConfirmed">📍 Located${household.homeGeocodeLabel
        ? ` at <b>${h(household.homeGeocodeLabel)}</b>` : ''}</div>` : ''}
      <details class="manualCoords"><summary>Enter coordinates manually</summary>
        <div class="two">
          <label>Latitude<input name="homeLat" type="number" step="any"
            value="${household?.homeLat ?? ''}" placeholder="47.6249"></label>
          <label>Longitude<input name="homeLng" type="number" step="any"
            value="${household?.homeLng ?? ''}" placeholder="-122.5188"></label>
        </div>
      </details>
      <label>Alternate address (optional)<input name="alternateAddress"
        value="${h(household?.alternateAddress || '')}" placeholder="Grandparent, second home" maxlength="300"></label>
      <fieldset class="childrenEditor"><legend>My children</legend>
        ${household?.children?.length
          ? `<div class="linkedChildren">${household.children.map(c => `<span>✓ ${h(c.name)}</span>`).join('')}</div>`
          : '<p>No children yet.</p>'}
        <p class="childSubhead">Add a child</p>
        <div data-child-rows><div class="childRow"><input data-new-child placeholder="Child's full name" maxlength="120"></div></div>
        <button type="button" class="outline small" data-add-child>+ Add another child</button>
        <small class="privateNote">A coordinator adds children to a team roster; you cannot do that yourself.</small>
      </fieldset>
      <div id="profileNotice"></div>
      <button class="primary submit">Save</button>
    </form>
    ${accessHistory()}`);

  host.querySelector('[data-add-child]').addEventListener('click', () => {
    host.querySelector('[data-child-rows]').insertAdjacentHTML('beforeend',
      `<div class="childRow"><input data-new-child placeholder="Another child's name" maxlength="120"></div>`);
  });

  host.querySelector('#profileForm').addEventListener('submit', async submitEvent => {
    submitEvent.preventDefault();
    const data = new FormData(submitEvent.target);
    const button = submitEvent.target.querySelector('.submit');
    button.disabled = true;
    try {
      const saved = await post('/api/me', {
        clubId,
        displayName: data.get('displayName'),
        phone: data.get('phone'),
        pickupAreaId: data.get('pickupAreaId') || null,
        homeAddress: data.get('homeAddress'),
        alternateAddress: data.get('alternateAddress'),
        homeLat: data.get('homeLat') || null,
        homeLng: data.get('homeLng') || null,
        newChildren: [...host.querySelectorAll('[data-new-child]')].map(i => i.value.trim()).filter(Boolean),
      });
      state.me = saved;

      // A vague match is worse than none: a pin on the middle of town sends a
      // driver to the wrong place while looking perfectly correct. Stay open
      // and ask, rather than closing on a quiet maybe.
      const geo = saved.geocode;
      if (geo && (geo.found === false || geo.confidence === 'area' || geo.confidence === 'approximate')) {
        host.querySelector('#profileNotice').innerHTML = geo.found
          ? `<div class="notice error">We could only place that address roughly —
               we matched <b>${h(geo.label)}</b>. If that is not your street, add more
               detail (or open <b>Enter coordinates manually</b>), then save again.
               Your details are already saved.</div>`
          : `<div class="notice error">We could not find that address on the map.
               Your details are saved, but route planning will skip your family until
               it can be located. Try adding the city and ZIP, or enter coordinates
               manually.</div>`;
        button.disabled = false;
        return;
      }

      close();
      const located = geo?.found ? ' Address located for route planning.' : '';
      if (state.board) await refresh('Family profile saved.' + located);
      else await loadMe();
    } catch (error) {
      host.querySelector('#profileNotice').innerHTML = `<div class="notice error">${h(error.message)}</div>`;
      button.disabled = false;
    }
  });
}

const accessHistory = () => {
  const logs = state.me.addressAccessLog || [];
  if (!logs.length) return '';
  return `<section class="accessHistory"><h3>Who has seen your address</h3>
    ${logs.map(log => `<div><b>${h(describeAction(log.action))}</b>
      <span>${h(log.actor_email)} · ${h(formatLogTime(log.created_at))}</span>
      <small>${h(log.reason)}</small></div>`).join('')}</section>`;
};

const describeAction = action => ({
  route_opened: 'Driver opened your pickup route',
  address_revealed: 'Assigned driver viewed your address',
  admin_revealed: 'Club administrator viewed your address',
  address_updated: 'You updated your address',
}[action] || action);

/** The API returns SQLite datetimes in UTC ("YYYY-MM-DD HH:MM:SS"). */
function formatLogTime(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const iso = raw.includes('T') ? raw : `${raw.replace(' ', 'T')}Z`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? raw : date.toLocaleString();
}

// --- lifecycle -------------------------------------------------------------

window.addEventListener('online', () => { state.online = true; if (state.board) refresh().catch(showError); });
window.addEventListener('offline', () => { state.online = false; if (state.board) render(); });

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.board) refresh().catch(showError);
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}
