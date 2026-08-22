// API client.
//
// Two fixes over the previous version live here, both of which produced
// user-visible failures:
//
//   1. The old code cached one ID token in a module variable and only ever
//      refreshed it inside refresh(). Firebase tokens expire after an hour,
//      so a phone left open on the touchline during a game started 401-ing on
//      every tap. `getIdToken()` is cheap — Firebase caches it and refreshes
//      only when needed — so we simply ask every time.
//
//   2. The old code called response.json() BEFORE checking response.ok, so a
//      502 HTML error page threw a SyntaxError that surfaced as
//      "Unexpected token '<'" and bounced the parent back to the sign-in
//      screen. Status is checked first, and a non-JSON body is reported as a
//      connection problem.

export class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

let baseUrl = '';
let getToken = async () => '';

export function configureApi({ base, tokenProvider }) {
  baseUrl = String(base || '').replace(/\/$/, '');
  getToken = tokenProvider;
}

async function readBody(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return null; // not JSON — an upstream error page, not an API response
  }
}

export async function api(path, { method = 'GET', body, signal } = {}) {
  let token = '';
  try {
    token = await getToken();
  } catch {
    throw new ApiError('Your session expired. Sign in again.', 401, 'unauthenticated');
  }

  let response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method,
      signal,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError('No connection. Check your signal and try again.', 0, 'offline');
  }

  const payload = await readBody(response);

  if (!response.ok) {
    if (payload === null) {
      throw new ApiError('The carpool service is temporarily unavailable.', response.status, 'upstream');
    }
    throw new ApiError(payload.error || 'That did not work. Please try again.', response.status, payload.code);
  }
  if (payload === null) {
    throw new ApiError('The carpool service returned an unexpected response.', response.status, 'upstream');
  }
  return payload;
}

export const get = (path, options) => api(path, { ...options, method: 'GET' });
export const post = (path, body, options) => api(path, { ...options, method: 'POST', body });

/**
 * Serialise mutating actions so a double-tap on a phone cannot fire the same
 * request twice. Returns whatever the action returns.
 */
let inFlight = null;
export async function once(action) {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      return await action();
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}
