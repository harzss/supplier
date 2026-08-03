#!/usr/bin/env node

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 30_000;

export function readAuthSessionConfiguration(environment = process.env) {
  const supabaseOrigin = requiredOrigin(
    environment.NEXT_PUBLIC_SUPABASE_URL,
    'NEXT_PUBLIC_SUPABASE_URL',
    true,
  );
  const bffOrigin = requiredOrigin(environment.BFF_URL, 'BFF_URL');
  const anonKey = requiredValue(
    environment.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  ).trim();
  if (anonKey.length < 20) throw new Error('NEXT_PUBLIC_SUPABASE_ANON_KEY is invalid.');

  const email = requiredValue(environment.AUTH_TEST_EMAIL, 'AUTH_TEST_EMAIL').trim();
  if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('AUTH_TEST_EMAIL is invalid.');
  }
  const password = requiredValue(environment.AUTH_TEST_PASSWORD, 'AUTH_TEST_PASSWORD');
  if (password.length < 8)
    throw new Error('AUTH_TEST_PASSWORD must contain at least 8 characters.');

  const timeoutMs = parseTimeout(environment.AUTH_TEST_TIMEOUT_MS);
  return { supabaseOrigin, bffOrigin, anonKey, email, password, timeoutMs };
}

export async function verifySupabaseAuthSession(configuration, fetcher = fetch) {
  const { supabaseOrigin, bffOrigin, anonKey, email, password, timeoutMs } = configuration;
  let logoutAccessToken;
  let logoutAttempted = false;

  try {
    const passwordGrant = await request(
      fetcher,
      `${supabaseOrigin}/auth/v1/token?grant_type=password`,
      {
        method: 'POST',
        headers: { apikey: anonKey, 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      },
      timeoutMs,
      'Password grant',
    );
    assertStatus(passwordGrant, 200, 'Password grant');
    const initialSession = await readSession(passwordGrant, 'Password grant');
    logoutAccessToken = initialSession.accessToken;

    const initialProtected = await request(
      fetcher,
      `${bffOrigin}/api/me/entitlements`,
      { headers: { authorization: `Bearer ${initialSession.accessToken}` } },
      timeoutMs,
      'Initial protected API',
    );
    assertStatus(initialProtected, 200, 'Initial protected API');

    const refreshGrant = await request(
      fetcher,
      `${supabaseOrigin}/auth/v1/token?grant_type=refresh_token`,
      {
        method: 'POST',
        headers: { apikey: anonKey, 'content-type': 'application/json' },
        body: JSON.stringify({ refresh_token: initialSession.refreshToken }),
      },
      timeoutMs,
      'Refresh grant',
    );
    assertStatus(refreshGrant, 200, 'Refresh grant');
    const refreshedSession = await readSession(refreshGrant, 'Refresh grant');
    logoutAccessToken = refreshedSession.accessToken;

    const refreshedProtected = await request(
      fetcher,
      `${bffOrigin}/api/me/entitlements`,
      { headers: { authorization: `Bearer ${refreshedSession.accessToken}` } },
      timeoutMs,
      'Refreshed protected API',
    );
    assertStatus(refreshedProtected, 200, 'Refreshed protected API');

    logoutAttempted = true;
    const logout = await request(
      fetcher,
      `${supabaseOrigin}/auth/v1/logout`,
      {
        method: 'POST',
        headers: {
          apikey: anonKey,
          authorization: `Bearer ${refreshedSession.accessToken}`,
        },
      },
      timeoutMs,
      'Logout',
    );
    assertStatus(logout, 204, 'Logout');

    const revokedRefreshGrant = await request(
      fetcher,
      `${supabaseOrigin}/auth/v1/token?grant_type=refresh_token`,
      {
        method: 'POST',
        headers: { apikey: anonKey, 'content-type': 'application/json' },
        body: JSON.stringify({ refresh_token: refreshedSession.refreshToken }),
      },
      timeoutMs,
      'Revoked refresh grant',
    );
    if (![400, 401].includes(revokedRefreshGrant.status)) {
      if (revokedRefreshGrant.status === 200) {
        const unexpectedAccessToken = await readAccessTokenForCleanup(revokedRefreshGrant);
        if (unexpectedAccessToken) {
          await bestEffortLogout(
            fetcher,
            supabaseOrigin,
            anonKey,
            unexpectedAccessToken,
            timeoutMs,
          );
        }
      }
      throw new Error(
        `Revoked refresh grant: expected HTTP 400 or 401, got ${revokedRefreshGrant.status}.`,
      );
    }

    const anonymousProtected = await request(
      fetcher,
      `${bffOrigin}/api/me/entitlements`,
      {},
      timeoutMs,
      'Protected API without token after logout',
    );
    assertStatus(anonymousProtected, 401, 'Protected API without token after logout');

    return {
      passwordGrantStatus: passwordGrant.status,
      initialProtectedStatus: initialProtected.status,
      refreshGrantStatus: refreshGrant.status,
      refreshedProtectedStatus: refreshedProtected.status,
      logoutStatus: logout.status,
      revokedRefreshStatus: revokedRefreshGrant.status,
      anonymousProtectedStatus: anonymousProtected.status,
    };
  } finally {
    if (logoutAccessToken && !logoutAttempted) {
      await bestEffortLogout(fetcher, supabaseOrigin, anonKey, logoutAccessToken, timeoutMs);
    }
  }
}

async function request(fetcher, url, init, timeoutMs, label) {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    return await fetcher(url, { ...init, signal });
  } catch {
    if (signal.aborted) throw new Error(`${label} timed out after ${timeoutMs}ms.`);
    throw new Error(`${label} request failed.`);
  }
}

function assertStatus(response, expectedStatus, label) {
  if (response.status !== expectedStatus) {
    throw new Error(`${label}: expected HTTP ${expectedStatus}, got ${response.status}.`);
  }
}

async function readSession(response, label) {
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(`${label} returned invalid JSON.`);
  }
  if (
    !body ||
    typeof body !== 'object' ||
    typeof body.access_token !== 'string' ||
    body.access_token.length === 0 ||
    typeof body.refresh_token !== 'string' ||
    body.refresh_token.length === 0
  ) {
    throw new Error(`${label} did not return a complete session.`);
  }
  return { accessToken: body.access_token, refreshToken: body.refresh_token };
}

async function readAccessTokenForCleanup(response) {
  try {
    const body = await response.json();
    return body && typeof body === 'object' && typeof body.access_token === 'string'
      ? body.access_token
      : undefined;
  } catch {
    return undefined;
  }
}

async function bestEffortLogout(fetcher, supabaseOrigin, anonKey, accessToken, timeoutMs) {
  try {
    await request(
      fetcher,
      `${supabaseOrigin}/auth/v1/logout`,
      { method: 'POST', headers: { apikey: anonKey, authorization: `Bearer ${accessToken}` } },
      timeoutMs,
      'Cleanup logout',
    );
  } catch {
    // Preserve the original verification failure without exposing session data.
  }
}

function requiredOrigin(rawValue, name, requireSupabaseProject = false) {
  const value = requiredValue(rawValue, name).trim();
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL.`);
  }
  if (
    url.protocol !== 'https:' ||
    url.origin !== value ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${name} must be an exact HTTPS origin without path, query, or hash.`);
  }
  if (requireSupabaseProject && !/^[a-z0-9]{20}\.supabase\.co$/.test(url.hostname)) {
    throw new Error(`${name} must be an exact Supabase project origin.`);
  }
  return url.origin;
}

function requiredValue(value, name) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} is required.`);
  return value;
}

function parseTimeout(value) {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < MIN_TIMEOUT_MS || parsed > MAX_TIMEOUT_MS) {
    throw new Error(`AUTH_TEST_TIMEOUT_MS must be an integer between 100 and 30000.`);
  }
  return parsed;
}

async function main() {
  const result = await verifySupabaseAuthSession(readAuthSessionConfiguration());
  console.log(
    `Supabase Auth session verified: password ${result.passwordGrantStatus}; protected ${result.initialProtectedStatus}; refresh ${result.refreshGrantStatus}; refreshed protected ${result.refreshedProtectedStatus}; logout ${result.logoutStatus}; revoked refresh ${result.revokedRefreshStatus}; no-token protected ${result.anonymousProtectedStatus}.`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(
      error instanceof Error ? error.message : 'Supabase Auth session verification failed.',
    );
    process.exitCode = 1;
  });
}
