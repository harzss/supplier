#!/usr/bin/env node

import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

import { requireSupabasePublicApiKey, supabasePublicApiKeyHeaders } from './supabase-api-keys.mjs';

const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 30_000;
const STAGING_ENV_FILE = resolve('apps/web/.env.staging.local');

export async function readAuthSessionEnvironmentFile(path = STAGING_ENV_FILE) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch {
    throw new Error('The staging Auth environment file is missing or unreadable.');
  }
  if (
    !metadata.isFile() ||
    (metadata.mode & 0o777) !== 0o600 ||
    (typeof process.getuid === 'function' && metadata.uid !== process.getuid())
  ) {
    throw new Error(
      'The staging Auth environment file must be an owner-only regular file with mode 0600.',
    );
  }

  try {
    return parseEnv(await readFile(path, 'utf8'));
  } catch {
    throw new Error('The staging Auth environment file could not be parsed.');
  }
}

export function readAuthSessionConfiguration(
  environment,
  { expectPreviousPasswordRejected = false } = {},
) {
  if (environment.NEXT_PUBLIC_AUTH_MODE !== 'supabase') {
    throw new Error('NEXT_PUBLIC_AUTH_MODE must be supabase.');
  }
  if (environment.NEXT_PUBLIC_SIGNUP_ENABLED !== 'false') {
    throw new Error('NEXT_PUBLIC_SIGNUP_ENABLED must be false.');
  }
  const supabaseOrigin = requiredOrigin(
    environment.NEXT_PUBLIC_SUPABASE_URL,
    'NEXT_PUBLIC_SUPABASE_URL',
    true,
  );
  const bffOrigin = requiredOrigin(environment.NEXT_PUBLIC_BFF_URL, 'NEXT_PUBLIC_BFF_URL');
  const anonKey = requireSupabasePublicApiKey(
    environment.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  );

  const email = requiredValue(environment.AUTH_TEST_EMAIL, 'AUTH_TEST_EMAIL').trim();
  if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('AUTH_TEST_EMAIL is invalid.');
  }
  const password = requiredValue(environment.AUTH_TEST_PASSWORD, 'AUTH_TEST_PASSWORD');
  if (password.length < 8)
    throw new Error('AUTH_TEST_PASSWORD must contain at least 8 characters.');

  let previousPassword;
  if (expectPreviousPasswordRejected) {
    previousPassword = requiredValue(
      environment.AUTH_TEST_PREVIOUS_PASSWORD,
      'AUTH_TEST_PREVIOUS_PASSWORD',
    );
    if (previousPassword.length < 8) {
      throw new Error('AUTH_TEST_PREVIOUS_PASSWORD must contain at least 8 characters.');
    }
    if (previousPassword === password) {
      throw new Error('AUTH_TEST_PREVIOUS_PASSWORD must differ from AUTH_TEST_PASSWORD.');
    }
  }

  const timeoutMs = parseTimeout(environment.AUTH_TEST_TIMEOUT_MS);
  return {
    supabaseOrigin,
    bffOrigin,
    anonKey,
    email,
    password,
    timeoutMs,
    ...(previousPassword ? { previousPassword } : {}),
  };
}

export async function verifySupabaseAuthSession(configuration, fetcher = fetch) {
  const { supabaseOrigin, bffOrigin, anonKey, email, password, previousPassword, timeoutMs } =
    configuration;
  const publicApiHeaders = supabasePublicApiKeyHeaders(anonKey);
  let logoutAccessToken;
  let logoutCompleted = false;
  let previousPasswordStatus;

  try {
    if (previousPassword) {
      const previousPasswordGrant = await request(
        fetcher,
        `${supabaseOrigin}/auth/v1/token?grant_type=password`,
        {
          method: 'POST',
          headers: { ...publicApiHeaders, 'content-type': 'application/json' },
          body: JSON.stringify({ email, password: previousPassword }),
        },
        timeoutMs,
        'Previous password grant',
      );
      previousPasswordStatus = previousPasswordGrant.status;
      if (![400, 401].includes(previousPasswordStatus)) {
        if (previousPasswordStatus === 200) {
          const unexpectedAccessToken = await readAccessTokenForCleanup(previousPasswordGrant);
          if (
            !unexpectedAccessToken ||
            !(await cleanupLogout(
              fetcher,
              supabaseOrigin,
              anonKey,
              unexpectedAccessToken,
              timeoutMs,
            ))
          ) {
            throw new Error(
              'Previous password grant unexpectedly created a session. Cleanup logout could not be proven.',
            );
          }
        }
        throw new Error(
          `Previous password grant: expected HTTP 400 or 401, got ${previousPasswordStatus}.`,
        );
      }
    }

    const passwordGrant = await request(
      fetcher,
      `${supabaseOrigin}/auth/v1/token?grant_type=password`,
      {
        method: 'POST',
        headers: { ...publicApiHeaders, 'content-type': 'application/json' },
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
        headers: { ...publicApiHeaders, 'content-type': 'application/json' },
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

    const logout = await request(
      fetcher,
      `${supabaseOrigin}/auth/v1/logout`,
      {
        method: 'POST',
        headers: {
          ...publicApiHeaders,
          authorization: `Bearer ${refreshedSession.accessToken}`,
        },
      },
      timeoutMs,
      'Logout',
    );
    assertStatus(logout, 204, 'Logout');
    logoutCompleted = true;

    const revokedRefreshGrant = await request(
      fetcher,
      `${supabaseOrigin}/auth/v1/token?grant_type=refresh_token`,
      {
        method: 'POST',
        headers: { ...publicApiHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({ refresh_token: refreshedSession.refreshToken }),
      },
      timeoutMs,
      'Revoked refresh grant',
    );
    if (![400, 401].includes(revokedRefreshGrant.status)) {
      if (revokedRefreshGrant.status === 200) {
        const unexpectedAccessToken = await readAccessTokenForCleanup(revokedRefreshGrant);
        if (
          !unexpectedAccessToken ||
          !(await cleanupLogout(fetcher, supabaseOrigin, anonKey, unexpectedAccessToken, timeoutMs))
        ) {
          throw new Error(
            'Revoked refresh grant unexpectedly created a session. Cleanup logout could not be proven.',
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
      ...(previousPasswordStatus ? { previousPasswordStatus } : {}),
      passwordGrantStatus: passwordGrant.status,
      initialProtectedStatus: initialProtected.status,
      refreshGrantStatus: refreshGrant.status,
      refreshedProtectedStatus: refreshedProtected.status,
      logoutStatus: logout.status,
      revokedRefreshStatus: revokedRefreshGrant.status,
      anonymousProtectedStatus: anonymousProtected.status,
    };
  } catch (error) {
    if (
      logoutAccessToken &&
      !logoutCompleted &&
      !(await cleanupLogout(fetcher, supabaseOrigin, anonKey, logoutAccessToken, timeoutMs))
    ) {
      throw new Error(`${safeMessage(error)} Cleanup logout could not be proven.`);
    }
    throw error;
  }
}

async function request(fetcher, url, init, timeoutMs, label) {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    return await fetcher(url, { ...init, redirect: 'error', signal });
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

async function cleanupLogout(fetcher, supabaseOrigin, anonKey, accessToken, timeoutMs) {
  try {
    const response = await request(
      fetcher,
      `${supabaseOrigin}/auth/v1/logout`,
      {
        method: 'POST',
        headers: {
          ...supabasePublicApiKeyHeaders(anonKey),
          authorization: `Bearer ${accessToken}`,
        },
      },
      timeoutMs,
      'Cleanup logout',
    );
    return response.status === 204;
  } catch {
    return false;
  }
}

function safeMessage(error) {
  return error instanceof Error ? error.message : 'Supabase Auth session verification failed.';
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
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--expect-previous-password-rejected')) {
    throw new Error('Unsupported command-line argument.');
  }
  const result = await verifySupabaseAuthSession(
    readAuthSessionConfiguration(await readAuthSessionEnvironmentFile(), {
      expectPreviousPasswordRejected: args.includes('--expect-previous-password-rejected'),
    }),
  );
  const previousPasswordSummary = result.previousPasswordStatus
    ? `previous password rejected ${result.previousPasswordStatus}; `
    : '';
  console.log(
    `Supabase Auth session verified: ${previousPasswordSummary}password ${result.passwordGrantStatus}; protected ${result.initialProtectedStatus}; refresh ${result.refreshGrantStatus}; refreshed protected ${result.refreshedProtectedStatus}; logout ${result.logoutStatus}; revoked refresh ${result.revokedRefreshStatus}; no-token protected ${result.anonymousProtectedStatus}.`,
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
