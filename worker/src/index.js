// Cloudflare Worker entry point.
//
// Every request follows the same shape:
//   verify token -> resolve user -> build Scope -> dispatch -> serialise
// A handler never sees an unauthenticated request and never sees a Scope it
// did not earn. Public routes are listed explicitly and are the exception.

import { bearerToken, claimInvitations, resolveUser, verifyIdToken } from './lib/auth.js';
import { HttpError, loadScope } from './lib/scope.js';
import { jsonBody } from './lib/validate.js';

import { getMe, updateProfile } from './routes/me.js';
import { getBoard } from './routes/board.js';
import { rideAction } from './routes/rides.js';
import { planRoutes, acceptPlan, openRoute } from './routes/plan.js';
import { adminRequest } from './routes/admin.js';

const PUBLIC_ROUTES = new Set(['GET /api/health']);

function corsHeaders(request, env) {
  const allowed = String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const origin = request.headers.get('origin') || '';

  // An explicit allowlist, never `*`. Credentials-bearing requests to a
  // wildcard origin are exactly how a carpool board becomes public.
  const headers = {
    'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
  if (allowed.includes(origin)) headers['access-control-allow-origin'] = origin;
  return headers;
}

const json = (data, status, headers) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      ...headers,
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    },
  });

export default {
  async fetch(request, env, ctx) {
    const cors = corsHeaders(request, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;

    try {
      if (route === 'GET /api/health') {
        return json({ ok: true }, 200, cors);
      }
      if (!url.pathname.startsWith('/api/')) {
        throw new HttpError(404, 'Not found.');
      }
      if (!env.DB) {
        throw new HttpError(500, 'The service is not configured yet.');
      }

      const claims = await verifyIdToken(bearerToken(request), env.FIREBASE_PROJECT_ID);
      const user = await resolveUser(env.DB, claims);
      let scope = await loadScope(env.DB, user);

      // Only look for invitations when the caller currently belongs nowhere.
      // Established users skip the query entirely, and someone invited after
      // they first signed in still picks it up on their next request.
      if (scope.isPending && !scope.isPlatformAdmin) {
        if (await claimInvitations(env.DB, user)) scope = await loadScope(env.DB, user);
      }

      const context = {
        env,
        ctx,
        url,
        request,
        db: env.DB,
        user,
        scope,
        ip: request.headers.get('cf-connecting-ip') || '',
        body: request.method === 'GET' ? {} : await jsonBody(request),
      };

      const result = await dispatch(route, url, context);
      return json(result, 200, cors);
    } catch (error) {
      if (error instanceof HttpError) {
        return json({ error: error.message, code: error.code || undefined }, error.status, cors);
      }
      // Never leak an internal message to a parent's phone.
      console.error('unhandled', route, error?.stack || error);
      return json({ error: 'Something went wrong on our side. Please try again.' }, 500, cors);
    }
  },
};

async function dispatch(route, url, context) {
  switch (route) {
    case 'GET /api/me':
      return getMe(context);
    case 'POST /api/me':
      return updateProfile(context);

    case 'GET /api/board':
      return getBoard(context);

    case 'POST /api/rides':
      return rideAction(context);

    case 'POST /api/plan':
      return planRoutes(context);
    case 'POST /api/plan/accept':
      return acceptPlan(context);
    case 'POST /api/route':
      return openRoute(context);

    default:
      if (url.pathname.startsWith('/api/admin')) return adminRequest(context);
      throw new HttpError(404, 'Not found.');
  }
}

export { PUBLIC_ROUTES };
