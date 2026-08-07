#!/usr/bin/env node

import { constants as fsConstants } from 'node:fs';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

import { requireSupabasePublicApiKey, supabasePublicApiKeyHeaders } from './supabase-api-keys.mjs';

const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 30_000;
const STAGING_ENV_FILE = resolve('apps/web/.env.staging.local');
const PINNED_SUPABASE_ORIGIN = 'https://bjeafpfffohtxqmfgtjq.supabase.co';
const PINNED_BFF_ORIGIN = 'https://supplier-staging-gateway.chenjie.workers.dev';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class TenantIsolationError extends Error {}

export async function readTenantIsolationEnvironmentFile(path = STAGING_ENV_FILE) {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    throw new Error('The staging tenant-isolation environment file is missing or unreadable.');
  }

  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      (metadata.mode & 0o777) !== 0o600 ||
      (typeof process.getuid === 'function' && metadata.uid !== process.getuid())
    ) {
      throw new Error(
        'The staging tenant-isolation environment file must be a current-user, owner-only regular file with mode 0600.',
      );
    }

    try {
      return parseEnv(await handle.readFile('utf8'));
    } catch {
      throw new Error('The staging tenant-isolation environment file could not be parsed.');
    }
  } finally {
    await handle.close();
  }
}

export function readTenantIsolationConfiguration(environment) {
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
  assertPinnedOrigins(supabaseOrigin, bffOrigin, Error);
  const anonKey = requireSupabasePublicApiKey(
    environment.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  );
  const tenantA = readCredentials(
    environment.AUTH_TENANT_A_EMAIL,
    environment.AUTH_TENANT_A_PASSWORD,
    'AUTH_TENANT_A',
  );
  const tenantB = readCredentials(
    environment.AUTH_TENANT_B_EMAIL,
    environment.AUTH_TENANT_B_PASSWORD,
    'AUTH_TENANT_B',
  );
  if (tenantA.email.toLowerCase() === tenantB.email.toLowerCase()) {
    throw new Error(
      'AUTH_TENANT_A_EMAIL and AUTH_TENANT_B_EMAIL must identify different accounts.',
    );
  }

  const productId1688 = requiredValue(
    environment.AUTH_TENANT_TEST_PRODUCT_ID,
    'AUTH_TENANT_TEST_PRODUCT_ID',
  ).trim();
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(productId1688)) {
    throw new Error(
      'AUTH_TENANT_TEST_PRODUCT_ID must contain 1 to 32 letters, digits, underscores, or hyphens.',
    );
  }

  return {
    supabaseOrigin,
    bffOrigin,
    anonKey,
    tenantA,
    tenantB,
    productId1688,
    timeoutMs: parseTimeout(environment.AUTH_TEST_TIMEOUT_MS),
  };
}

export async function verifySupabaseTenantIsolation(configuration, fetcher = fetch) {
  assertPinnedOrigins(configuration.supabaseOrigin, configuration.bffOrigin, TenantIsolationError);
  const accounts = [
    sessionState('Tenant A', configuration.tenantA),
    sessionState('Tenant B', configuration.tenantB),
  ];
  let favoriteCleanupArmed = false;
  const favoritePutOutcome = { uncertain: false };
  let failure;
  let verificationResult;

  try {
    await grantPasswordSession(accounts[0], configuration, fetcher);
    await grantPasswordSession(accounts[1], configuration, fetcher);
    if (accounts[0].userId.toLowerCase() === accounts[1].userId.toLowerCase()) {
      throw new TenantIsolationError(
        'The two password grants resolved to the same Supabase user; distinct identities were not proven.',
      );
    }

    const tenantAInitiallyHasProduct = await favoriteContainsProduct(
      accounts[0],
      configuration,
      fetcher,
      'Tenant A initial favorites',
    );
    if (tenantAInitiallyHasProduct) {
      throw new TenantIsolationError(
        'Tenant A already contains the test product before verification; existing favorites were left untouched.',
      );
    }
    const tenantBInitiallyHasProduct = await favoriteContainsProduct(
      accounts[1],
      configuration,
      fetcher,
      'Tenant B initial favorites',
    );
    if (tenantBInitiallyHasProduct) {
      throw new TenantIsolationError(
        'Tenant B already contains the test product before verification; existing favorites were left untouched.',
      );
    }

    // From this point onward, either PUT may have an uncertain outcome. Cleanup is
    // deliberately armed only after both accounts proved the test product absent.
    // DELETE plus immediate readback is only best-effort when a PUT outcome is
    // uncertain, because a delayed server-side commit can still race that cleanup.
    favoriteCleanupArmed = true;

    await addFavorite(
      accounts[0],
      configuration,
      fetcher,
      'Tenant A favorite add',
      favoritePutOutcome,
    );
    await assertFavoriteState(
      accounts[0],
      configuration,
      fetcher,
      true,
      'Tenant A visibility after Tenant A add',
    );
    await assertFavoriteState(
      accounts[1],
      configuration,
      fetcher,
      false,
      'Tenant B isolation after Tenant A add',
    );

    await mutateFavorite(accounts[0], configuration, fetcher, 'DELETE', 'Tenant A favorite remove');
    await assertFavoriteState(
      accounts[0],
      configuration,
      fetcher,
      false,
      'Tenant A absence after Tenant A remove',
    );
    await assertFavoriteState(
      accounts[1],
      configuration,
      fetcher,
      false,
      'Tenant B absence after Tenant A remove',
    );

    await addFavorite(
      accounts[1],
      configuration,
      fetcher,
      'Tenant B favorite add',
      favoritePutOutcome,
    );
    await assertFavoriteState(
      accounts[1],
      configuration,
      fetcher,
      true,
      'Tenant B visibility after Tenant B add',
    );
    await assertFavoriteState(
      accounts[0],
      configuration,
      fetcher,
      false,
      'Tenant A isolation after Tenant B add',
    );

    await mutateFavorite(accounts[1], configuration, fetcher, 'DELETE', 'Tenant B favorite remove');
    await assertFavoriteState(
      accounts[1],
      configuration,
      fetcher,
      false,
      'Tenant B absence after Tenant B remove',
    );
    await assertFavoriteState(
      accounts[0],
      configuration,
      fetcher,
      false,
      'Tenant A absence after Tenant B remove',
    );

    verificationResult = {
      passwordGrantStatuses: { tenantA: 200, tenantB: 200 },
      distinctSupabaseUsers: true,
      initialAbsenceProven: true,
      tenantAIsolationProven: true,
      tenantBIsolationProven: true,
    };
  } catch (error) {
    failure = safeRuntimeError(error);
  }

  const cleanup = await finalizeVerification(
    accounts,
    configuration,
    fetcher,
    favoriteCleanupArmed,
    favoritePutOutcome.uncertain,
  );
  if (cleanup.errors.length > 0) {
    const primary = failure ? `${failure.message} ` : '';
    throw new TenantIsolationError(
      `${primary}Final cleanup could not be proven. ${cleanup.errors.join(' ')}`,
    );
  }
  if (failure) throw failure;

  return {
    ...verificationResult,
    favoriteCleanupProven: cleanup.favoriteCleanupProven,
    logoutStatuses: cleanup.logoutStatuses,
    revokedRefreshStatuses: cleanup.revokedRefreshStatuses,
  };
}

function sessionState(label, credentials) {
  return {
    label,
    credentials,
    passwordGrantAccepted: false,
    passwordGrantOutcomeUncertain: false,
    accessToken: undefined,
    refreshToken: undefined,
    userId: undefined,
  };
}

async function grantPasswordSession(account, configuration, fetcher) {
  account.passwordGrantOutcomeUncertain = true;
  const response = await request(
    fetcher,
    `${configuration.supabaseOrigin}/auth/v1/token?grant_type=password`,
    {
      method: 'POST',
      headers: {
        ...supabasePublicApiKeyHeaders(configuration.anonKey),
        'content-type': 'application/json',
      },
      body: JSON.stringify(account.credentials),
    },
    configuration.timeoutMs,
    `${account.label} password grant`,
  );
  account.passwordGrantOutcomeUncertain = ![200, 400, 401].includes(response.status);
  account.passwordGrantAccepted = response.status === 200;

  let body;
  try {
    body = await response.json();
  } catch {
    if (response.status === 200) {
      throw new TenantIsolationError(`${account.label} password grant returned invalid JSON.`);
    }
  }
  registerSessionFields(account, body);
  assertStatus(response, 200, `${account.label} password grant`);
  if (
    !account.accessToken ||
    !account.refreshToken ||
    !account.userId ||
    !UUID.test(account.userId)
  ) {
    throw new TenantIsolationError(
      `${account.label} password grant did not return a complete session and user identity.`,
    );
  }
}

function registerSessionFields(account, body) {
  if (!body || typeof body !== 'object') return;
  if (isNonEmptyString(body.access_token)) account.accessToken = body.access_token;
  if (isNonEmptyString(body.refresh_token)) account.refreshToken = body.refresh_token;
  if (body.user && typeof body.user === 'object' && isNonEmptyString(body.user.id)) {
    account.userId = body.user.id;
  }
}

async function mutateFavorite(account, configuration, fetcher, method, label) {
  const response = await request(
    fetcher,
    favoriteUrl(configuration),
    {
      method,
      headers: { authorization: `Bearer ${account.accessToken}` },
    },
    configuration.timeoutMs,
    label,
  );
  await consumeResponseBody(response, label);
  assertStatus(response, 200, label);
}

async function addFavorite(account, configuration, fetcher, label, putOutcome) {
  putOutcome.uncertain = true;
  const response = await request(
    fetcher,
    favoriteUrl(configuration),
    {
      method: 'PUT',
      headers: { authorization: `Bearer ${account.accessToken}` },
    },
    configuration.timeoutMs,
    label,
  );
  if (response.status === 200) putOutcome.uncertain = false;
  await consumeResponseBody(response, label);
  assertStatus(response, 200, label);
}

async function favoriteContainsProduct(account, configuration, fetcher, label) {
  const response = await request(
    fetcher,
    `${configuration.bffOrigin}/api/favorites`,
    { headers: { authorization: `Bearer ${account.accessToken}` } },
    configuration.timeoutMs,
    label,
  );
  assertStatus(response, 200, label);

  let body;
  try {
    body = await response.json();
  } catch {
    throw new TenantIsolationError(`${label} returned invalid JSON.`);
  }
  if (
    !body ||
    typeof body !== 'object' ||
    !Number.isInteger(body.total) ||
    body.total < 0 ||
    !Array.isArray(body.items) ||
    body.total !== body.items.length ||
    !body.items.every(
      (item) => item && typeof item === 'object' && typeof item.productId1688 === 'string',
    )
  ) {
    throw new TenantIsolationError(`${label} did not return a valid favorite list.`);
  }
  return body.items.some((item) => item.productId1688 === configuration.productId1688);
}

async function assertFavoriteState(account, configuration, fetcher, expected, label) {
  const actual = await favoriteContainsProduct(account, configuration, fetcher, label);
  if (actual !== expected) {
    throw new TenantIsolationError(`${label} did not match the required visibility state.`);
  }
}

async function finalizeVerification(
  accounts,
  configuration,
  fetcher,
  favoriteCleanupArmed,
  favoritePutOutcomeUncertain,
) {
  const errors = [];
  const logoutStatuses = {};
  const revokedRefreshStatuses = {};
  let favoriteCleanupProven = !favoriteCleanupArmed;

  if (favoriteCleanupArmed) {
    let favoriteCleanupFailed = false;
    for (const account of accounts) {
      try {
        if (!account.accessToken) {
          throw new TenantIsolationError(
            `${account.label} favorite cleanup could not run because its access token was unavailable.`,
          );
        }
        await mutateFavorite(
          account,
          configuration,
          fetcher,
          'DELETE',
          `${account.label} final favorite delete`,
        );
      } catch (error) {
        favoriteCleanupFailed = true;
        errors.push(safeCleanupMessage(error, `${account.label} final favorite delete failed.`));
      }
    }
    for (const account of accounts) {
      try {
        if (!account.accessToken) {
          throw new TenantIsolationError(
            `${account.label} final favorite readback could not run because its access token was unavailable.`,
          );
        }
        await assertFavoriteState(
          account,
          configuration,
          fetcher,
          false,
          `${account.label} final favorite readback`,
        );
      } catch (error) {
        favoriteCleanupFailed = true;
        errors.push(safeCleanupMessage(error, `${account.label} final favorite readback failed.`));
      }
    }
    favoriteCleanupProven = !favoriteCleanupFailed;
  }

  if (favoritePutOutcomeUncertain) {
    favoriteCleanupProven = false;
    errors.push(
      'A favorite PUT outcome remained uncertain; final DELETE and readback were best-effort and cannot prove cleanup against a delayed commit.',
    );
  }

  for (const account of accounts) {
    if (!account.accessToken) {
      if (account.passwordGrantOutcomeUncertain) {
        errors.push(
          `${account.label} session cleanup could not be proven because the password-grant result was uncertain.`,
        );
      } else if (account.passwordGrantAccepted) {
        errors.push(
          `${account.label} logout could not be proven because an accepted password grant did not yield an access token.`,
        );
      } else if (account.refreshToken) {
        errors.push(
          `${account.label} logout could not run because its access token was unavailable.`,
        );
      }
      continue;
    }
    try {
      const response = await logout(
        account.accessToken,
        configuration,
        fetcher,
        `${account.label} logout`,
      );
      await consumeResponseBody(response, `${account.label} logout`);
      assertStatus(response, 204, `${account.label} logout`);
      logoutStatuses[accountKey(account)] = response.status;
    } catch (error) {
      errors.push(safeCleanupMessage(error, `${account.label} logout failed.`));
    }
  }

  for (const account of accounts) {
    if (!account.refreshToken) continue;
    try {
      const status = await proveRefreshRevoked(account, configuration, fetcher);
      revokedRefreshStatuses[accountKey(account)] = status;
    } catch (error) {
      errors.push(
        safeCleanupMessage(error, `${account.label} refresh-token revocation could not be proven.`),
      );
    }
  }

  return {
    errors,
    favoriteCleanupProven,
    logoutStatuses,
    revokedRefreshStatuses,
  };
}

async function proveRefreshRevoked(account, configuration, fetcher) {
  const response = await refreshGrant(
    account.refreshToken,
    configuration,
    fetcher,
    `${account.label} revoked refresh grant`,
  );
  if ([400, 401].includes(response.status)) {
    await consumeResponseBody(response, `${account.label} revoked refresh grant`);
    return response.status;
  }

  if (response.status === 200) {
    const cleanupProven = await cleanupUnexpectedRefreshSession(
      response,
      account.label,
      configuration,
      fetcher,
    );
    if (!cleanupProven) {
      throw new TenantIsolationError(
        `${account.label} refresh token remained usable after logout, and unexpected-session cleanup could not be proven.`,
      );
    }
    throw new TenantIsolationError(`${account.label} refresh token remained usable after logout.`);
  }

  throw new TenantIsolationError(
    `${account.label} revoked refresh grant: expected HTTP 400 or 401, got ${response.status}.`,
  );
}

async function cleanupUnexpectedRefreshSession(response, label, configuration, fetcher) {
  let body;
  try {
    body = await response.json();
  } catch {
    return false;
  }
  if (!body || typeof body !== 'object' || !isNonEmptyString(body.access_token)) return false;

  try {
    const logoutResponse = await logout(
      body.access_token,
      configuration,
      fetcher,
      `${label} unexpected refresh cleanup logout`,
    );
    await consumeResponseBody(logoutResponse, `${label} unexpected refresh cleanup logout`);
    if (logoutResponse.status !== 204) return false;
  } catch {
    return false;
  }

  if (!isNonEmptyString(body.refresh_token)) return true;
  let proof;
  try {
    proof = await refreshGrant(
      body.refresh_token,
      configuration,
      fetcher,
      `${label} unexpected refresh cleanup proof`,
    );
  } catch {
    return false;
  }
  if ([400, 401].includes(proof.status)) {
    try {
      await consumeResponseBody(proof, `${label} unexpected refresh cleanup proof`);
      return true;
    } catch {
      return false;
    }
  }
  if (proof.status === 200)
    await bestEffortLogoutFromResponse(proof, label, configuration, fetcher);
  return false;
}

async function bestEffortLogoutFromResponse(response, label, configuration, fetcher) {
  try {
    const body = await response.json();
    if (!body || typeof body !== 'object' || !isNonEmptyString(body.access_token)) return false;
    const logoutResponse = await logout(
      body.access_token,
      configuration,
      fetcher,
      `${label} bounded recovery logout`,
    );
    await consumeResponseBody(logoutResponse, `${label} bounded recovery logout`);
    return logoutResponse.status === 204;
  } catch {
    return false;
  }
}

function refreshGrant(refreshToken, configuration, fetcher, label) {
  return request(
    fetcher,
    `${configuration.supabaseOrigin}/auth/v1/token?grant_type=refresh_token`,
    {
      method: 'POST',
      headers: {
        ...supabasePublicApiKeyHeaders(configuration.anonKey),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ refresh_token: refreshToken }),
    },
    configuration.timeoutMs,
    label,
  );
}

function logout(accessToken, configuration, fetcher, label) {
  return request(
    fetcher,
    `${configuration.supabaseOrigin}/auth/v1/logout`,
    {
      method: 'POST',
      headers: {
        ...supabasePublicApiKeyHeaders(configuration.anonKey),
        authorization: `Bearer ${accessToken}`,
      },
    },
    configuration.timeoutMs,
    label,
  );
}

async function request(fetcher, url, init, timeoutMs, label) {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    return await fetcher(url, { ...init, redirect: 'error', signal });
  } catch {
    if (signal.aborted) throw new TenantIsolationError(`${label} timed out after ${timeoutMs}ms.`);
    throw new TenantIsolationError(`${label} request failed.`);
  }
}

async function consumeResponseBody(response, label) {
  try {
    await response.arrayBuffer();
  } catch {
    throw new TenantIsolationError(`${label} response body could not be consumed.`);
  }
}

function favoriteUrl(configuration) {
  return `${configuration.bffOrigin}/api/favorites/${encodeURIComponent(configuration.productId1688)}`;
}

function assertStatus(response, expectedStatus, label) {
  if (response.status !== expectedStatus) {
    throw new TenantIsolationError(
      `${label}: expected HTTP ${expectedStatus}, got ${response.status}.`,
    );
  }
}

function safeRuntimeError(error) {
  return error instanceof TenantIsolationError
    ? error
    : new TenantIsolationError('Supabase tenant-isolation verification failed.');
}

function safeCleanupMessage(error, fallback) {
  return error instanceof TenantIsolationError ? error.message : fallback;
}

function accountKey(account) {
  return account.label === 'Tenant A' ? 'tenantA' : 'tenantB';
}

function readCredentials(rawEmail, rawPassword, prefix) {
  const email = requiredValue(rawEmail, `${prefix}_EMAIL`).trim();
  if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error(`${prefix}_EMAIL is invalid.`);
  }
  const password = requiredValue(rawPassword, `${prefix}_PASSWORD`);
  if (password.length < 8) {
    throw new Error(`${prefix}_PASSWORD must contain at least 8 characters.`);
  }
  return { email, password };
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

function assertPinnedOrigins(supabaseOrigin, bffOrigin, ErrorType) {
  if (supabaseOrigin !== PINNED_SUPABASE_ORIGIN) {
    throw new ErrorType(
      'NEXT_PUBLIC_SUPABASE_URL must match the pinned tenant-isolation staging project.',
    );
  }
  if (bffOrigin !== PINNED_BFF_ORIGIN) {
    throw new ErrorType(
      'NEXT_PUBLIC_BFF_URL must match the pinned tenant-isolation staging gateway.',
    );
  }
}

function requiredValue(value, name) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} is required.`);
  return value;
}

function parseTimeout(value) {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < MIN_TIMEOUT_MS || parsed > MAX_TIMEOUT_MS) {
    throw new Error('AUTH_TEST_TIMEOUT_MS must be an integer between 100 and 30000.');
  }
  return parsed;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

async function main() {
  if (process.argv.length !== 2) throw new Error('Unsupported command-line argument.');
  const result = await verifySupabaseTenantIsolation(
    readTenantIsolationConfiguration(await readTenantIsolationEnvironmentFile()),
  );
  console.log(
    `Supabase tenant isolation verified: password grants ${result.passwordGrantStatuses.tenantA}/${result.passwordGrantStatuses.tenantB}; distinct identities; initial absence; bidirectional favorite isolation; final cleanup; logout ${result.logoutStatuses.tenantA}/${result.logoutStatuses.tenantB}; revoked refresh ${result.revokedRefreshStatuses.tenantA}/${result.revokedRefreshStatuses.tenantB}.`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(
      error instanceof Error ? error.message : 'Supabase tenant-isolation verification failed.',
    );
    process.exitCode = 1;
  });
}
