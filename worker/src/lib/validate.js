// Input validation. Every one of these exists because the original version
// trusted the value and something downstream broke or leaked.

import { HttpError } from './scope.js';

export const bad = (message, code = 'invalid') => new HttpError(400, message, code);

/**
 * Only http(s) URLs survive. `type="url"` in a browser happily accepts
 * `javascript:alert(1)` and `data:text/html,...` — verified in Chrome — so a
 * map link pasted by an admin (or loaded from a CSV) was a stored-XSS vector
 * the moment it was rendered into an href.
 */
export function safeUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw bad('Enter a complete link starting with https://');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw bad('Links must start with https:// or http://');
  }
  return url.href;
}

/** Strict YYYY-MM-DD, and it must be a real calendar date. */
export function isoDate(value, field = 'date') {
  const raw = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw bad(`Enter ${field} as YYYY-MM-DD.`);
  const [y, m, d] = raw.split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    throw bad(`${raw} is not a real date.`);
  }
  return raw;
}

/** Strict HH:MM, 24-hour. The old code accepted "17:15:00" and produced NaN. */
export function clockTime(value, field = 'time') {
  const raw = String(value ?? '').trim();
  const match = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(raw);
  if (!match) throw bad(`Enter ${field} as HH:MM.`);
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) throw bad(`${raw} is not a real time.`);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

export function oneOf(value, allowed, field) {
  const raw = String(value ?? '').trim();
  if (!allowed.includes(raw)) throw bad(`${field} must be one of: ${allowed.join(', ')}.`);
  return raw;
}

export function text(value, { field = 'value', max = 200, required = false } = {}) {
  const raw = String(value ?? '').trim();
  if (required && !raw) throw bad(`${field} is required.`);
  if (raw.length > max) throw bad(`${field} must be ${max} characters or fewer.`);
  return raw;
}

export function integer(value, { field = 'value', min = -Infinity, max = Infinity, required = true } = {}) {
  if (value === '' || value == null) {
    if (required) throw bad(`${field} is required.`);
    return null;
  }
  const number = Number(value);
  if (!Number.isInteger(number)) throw bad(`${field} must be a whole number.`);
  if (number < min || number > max) throw bad(`${field} must be between ${min} and ${max}.`);
  return number;
}

/** Latitude/longitude pair, or null when absent. Rejects the (0,0) placeholder. */
export function coordinate(lat, lng) {
  if (lat == null || lng == null || lat === '' || lng === '') return { lat: null, lng: null };
  const latitude = Number(lat);
  const longitude = Number(lng);
  if (!Number.isFinite(latitude) || Math.abs(latitude) > 90) throw bad('Latitude is out of range.');
  if (!Number.isFinite(longitude) || Math.abs(longitude) > 180) throw bad('Longitude is out of range.');
  if (latitude === 0 && longitude === 0) return { lat: null, lng: null };
  return { lat: latitude, lng: longitude };
}

/** US-ish phone normalisation: keep digits, format when it looks standard. */
export function phone(value, { required = false } = {}) {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (!digits) {
    if (required) throw bad('A contact number is required.');
    return '';
  }
  if (digits.length === 11 && digits.startsWith('1')) return formatUs(digits.slice(1));
  if (digits.length === 10) return formatUs(digits);
  return String(value).trim().slice(0, 40);
}

const formatUs = d => `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;

/** Parse a JSON body, refusing anything that is not a plain object. */
export async function jsonBody(request) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    throw bad('Expected a JSON body.');
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw bad('Expected a JSON object.');
  }
  return payload;
}
