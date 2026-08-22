// Shared helpers. Each one exists because the previous version had a bug here.

/** HTML-escape for interpolation into markup. */
export const h = (value = '') =>
  String(value ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));

/**
 * Escaping a URL stops it breaking OUT of an href attribute; it does nothing
 * about the scheme. `javascript:alert(1)` passes an <input type="url">
 * validity check in Chrome, so an admin-supplied map link was a stored-XSS
 * vector the moment it was rendered. Anything not http(s) becomes inert.
 */
export function safeUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '';
  } catch {
    return '';
  }
}

/** Initials that survive a missing or single-word name instead of throwing. */
export function initials(name) {
  const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '??';
  return parts.map(p => p[0]).join('').slice(0, 2).toUpperCase();
}

// --- dates -----------------------------------------------------------------
// The old code did `new Date(dateString + 'T12:00:00')`, which silently
// produced Invalid Date for anything not exactly YYYY-MM-DD — and in the
// "is this event upcoming?" check an Invalid Date made the event vanish from
// the board rather than raising anything.

function parseDate(value, time = '12:00') {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? '').trim());
  if (!match) return null;
  const [hours, minutes] = String(time).split(':').map(Number);
  const date = new Date(
    Number(match[1]), Number(match[2]) - 1, Number(match[3]),
    Number.isFinite(hours) ? hours : 12,
    Number.isFinite(minutes) ? minutes : 0,
  );
  return Number.isNaN(date.getTime()) ? null : date;
}

export function shortDate(value) {
  const date = parseDate(value);
  return date ? date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : String(value ?? '');
}

export function longDate(value) {
  const date = parseDate(value);
  return date
    ? date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
    : String(value ?? '');
}

/** Normalise a time to HH:MM; tolerate HH:MM:SS from the database. */
export function clock(value) {
  const match = /^(\d{1,2}):(\d{2})/.exec(String(value ?? '').trim());
  if (!match) return '';
  return `${match[1].padStart(2, '0')}:${match[2]}`;
}

/** An event stays on the board until three hours after it starts. */
export function isUpcoming(event) {
  if (!event) return false;
  const start = parseDate(event.event_date ?? event.eventDate, clock(event.start_time ?? event.startTime) || '00:00');
  if (!start) return false; // unparseable dates are surfaced, not hidden
  return start.getTime() + 3 * 60 * 60 * 1000 >= Date.now();
}

export const directionLabel = value =>
  value === 'to' ? 'To the event' : value === 'from' ? 'Home after' : 'Round trip';

export const usesLeg = (value, leg) => value === 'roundtrip' || value === leg;

/** Format kilometres for a US audience. */
export const miles = km => (km == null ? '' : `${(km * 0.621371).toFixed(1)} mi`);
