// Firebase ID-token verification, done properly at the edge.
//
// The previous system had two separate front doors: Firebase for parents, and
// a single shared password for administrators. The password door had no
// identity behind it, so the audit log could record *that* an address was
// revealed but never reliably *who* did it, and the only way to revoke an
// admin was to change the password for everybody.
//
// Here there is one door. Admin rights are a row in `memberships`, tied to a
// Firebase UID, revocable per person, and attributable in the audit log.

import { HttpError } from './scope.js';

const JWK_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

// Google rotates these daily; honour the response's own cache lifetime.
let keyCache = { keys: null, expiresAt: 0 };

async function firebaseKeys() {
  const now = Date.now();
  if (keyCache.keys && now < keyCache.expiresAt) return keyCache.keys;

  const response = await fetch(JWK_URL);
  if (!response.ok) throw new HttpError(503, 'Could not reach the sign-in service. Try again shortly.');
  const payload = await response.json();

  const cacheControl = response.headers.get('cache-control') || '';
  const maxAge = Number(/max-age=(\d+)/.exec(cacheControl)?.[1] ?? 3600);

  const keys = new Map();
  for (const jwk of payload.keys ?? []) {
    keys.set(
      jwk.kid,
      await crypto.subtle.importKey(
        'jwk',
        jwk,
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['verify'],
      ),
    );
  }
  keyCache = { keys, expiresAt: now + maxAge * 1000 };
  return keys;
}

const b64urlToBytes = value => {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, c => c.charCodeAt(0));
};

const decodeJson = segment => JSON.parse(new TextDecoder().decode(b64urlToBytes(segment)));

/**
 * Verify a Firebase ID token and return its claims.
 * Throws HttpError(401) for anything that does not check out — deliberately
 * with the same message, so a probe cannot distinguish "expired" from
 * "forged" from "wrong project".
 */
export async function verifyIdToken(token, projectId) {
  const reject = () => new HttpError(401, 'Sign in to continue.', 'unauthenticated');
  if (!token || typeof token !== 'string') throw reject();

  const parts = token.split('.');
  if (parts.length !== 3) throw reject();

  let header;
  let claims;
  try {
    header = decodeJson(parts[0]);
    claims = decodeJson(parts[1]);
  } catch {
    throw reject();
  }

  if (header.alg !== 'RS256' || !header.kid) throw reject();

  const keys = await firebaseKeys();
  const key = keys.get(header.kid);
  if (!key) throw reject();

  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    b64urlToBytes(parts[2]),
    signed,
  );
  if (!valid) throw reject();

  const now = Math.floor(Date.now() / 1000);
  const skew = 60; // tolerate a minute of clock drift on parents' phones
  if (claims.aud !== projectId) throw reject();
  if (claims.iss !== `https://securetoken.google.com/${projectId}`) throw reject();
  if (!claims.sub) throw reject();
  if (typeof claims.exp !== 'number' || claims.exp + skew < now) throw reject();
  if (typeof claims.iat !== 'number' || claims.iat - skew > now) throw reject();
  if (typeof claims.auth_time === 'number' && claims.auth_time - skew > now) throw reject();

  return claims;
}

/**
 * Resolve the verified token to a row in `users`, creating it on first sight.
 *
 * Email verification is required before any record is created at all: an
 * unverified address is not yet evidence of anything, and we do not want
 * half-real users accumulating against club invitations.
 */
export async function resolveUser(db, claims) {
  if (!claims.email_verified) {
    throw new HttpError(403, 'Verify your email address, then sign in again.', 'email_unverified');
  }

  const email = String(claims.email || '').toLowerCase().trim();
  const existing = await db
    .prepare(`SELECT * FROM users WHERE firebase_uid = ?`)
    .bind(claims.sub)
    .first();

  if (existing) {
    // Keep the mutable bits fresh without a write on every request.
    if (existing.email !== email || !existing.email_verified) {
      await db
        .prepare(`UPDATE users SET email = ?, email_verified = 1, last_seen_at = datetime('now') WHERE id = ?`)
        .bind(email, existing.id)
        .run();
      return { ...existing, email, email_verified: 1 };
    }
    return existing;
  }

  const displayName = String(claims.name || email.split('@')[0] || '').slice(0, 120);
  const inserted = await db
    .prepare(
      `INSERT INTO users (firebase_uid, email, email_verified, display_name, last_seen_at)
       VALUES (?, ?, 1, ?, datetime('now'))
       RETURNING *`,
    )
    .bind(claims.sub, email, displayName)
    .first();

  return inserted;
}

/** Extract the bearer token from a request. */
export function bearerToken(request) {
  const header = request.headers.get('authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1] : '';
}
