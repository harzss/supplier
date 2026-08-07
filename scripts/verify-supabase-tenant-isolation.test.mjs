import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  readTenantIsolationConfiguration,
  readTenantIsolationEnvironmentFile,
  verifySupabaseTenantIsolation,
} from './verify-supabase-tenant-isolation.mjs';

const SUPABASE_ORIGIN = 'https://bjeafpfffohtxqmfgtjq.supabase.co';
const BFF_ORIGIN = 'https://supplier-staging-gateway.chenjie.workers.dev';
const ANON_KEY = 'sb_publishable_test_key_that_is_long_enough';
const EMAIL_A = 'tenant-a@example.com';
const EMAIL_B = 'tenant-b@example.com';
const PASSWORD_A = 'tenant-a-password-secret';
const PASSWORD_B = 'tenant-b-password-secret';
const PRODUCT_ID = 'tenant-test-product-1001';
const ACCESS_A = 'sensitive-access-a';
const ACCESS_B = 'sensitive-access-b';
const REFRESH_A = 'sensitive-refresh-a';
const REFRESH_B = 'sensitive-refresh-b';
const USER_A = '00000000-0000-4000-8000-00000000000a';
const USER_B = '00000000-0000-4000-8000-00000000000b';
const UNEXPECTED_ACCESS_A = 'unexpected-sensitive-access-a';
const UNEXPECTED_REFRESH_A = 'unexpected-sensitive-refresh-a';

test('reads only a current-user 0600 regular file and rejects a symlink', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'supplier-tenant-isolation-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const privateFile = join(directory, 'private.env');
  const publicFile = join(directory, 'public.env');
  const symlinkFile = join(directory, 'linked.env');
  const contents = Object.entries(environment())
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  await writeFile(privateFile, contents, { mode: 0o600 });
  await writeFile(publicFile, contents, { mode: 0o644 });
  await chmod(privateFile, 0o600);
  await chmod(publicFile, 0o644);
  await symlink(privateFile, symlinkFile);

  assert.deepEqual(
    readTenantIsolationConfiguration(await readTenantIsolationEnvironmentFile(privateFile)),
    configuration({ timeoutMs: 1234 }),
  );
  await assert.rejects(
    readTenantIsolationEnvironmentFile(publicFile),
    /current-user, owner-only regular file with mode 0600/,
  );
  await assert.rejects(readTenantIsolationEnvironmentFile(symlinkFile), /missing or unreadable/);
  await assert.rejects(
    readTenantIsolationEnvironmentFile(join(directory, 'missing.env')),
    /missing or unreadable/,
  );
});

test('accepts only exact staging origins, a public key, distinct credentials, and a safe product id', () => {
  assert.deepEqual(
    readTenantIsolationConfiguration(environment()),
    configuration({ timeoutMs: 1234 }),
  );

  for (const [name, value] of [
    ['NEXT_PUBLIC_AUTH_MODE', 'demo'],
    ['NEXT_PUBLIC_SIGNUP_ENABLED', 'true'],
    ['NEXT_PUBLIC_SUPABASE_URL', 'http://abcdefghijklmnopqrst.supabase.co'],
    ['NEXT_PUBLIC_SUPABASE_URL', `${SUPABASE_ORIGIN}/auth/v1`],
    ['NEXT_PUBLIC_SUPABASE_URL', 'https://zzzzzzzzzzzzzzzzzzzz.supabase.co'],
    ['NEXT_PUBLIC_SUPABASE_URL', 'https://attacker.invalid'],
    ['NEXT_PUBLIC_BFF_URL', 'http://supplier-staging.example.com'],
    ['NEXT_PUBLIC_BFF_URL', `${BFF_ORIGIN}/api`],
    ['NEXT_PUBLIC_BFF_URL', 'https://attacker.invalid'],
    ['NEXT_PUBLIC_SUPABASE_ANON_KEY', 'short'],
    ['NEXT_PUBLIC_SUPABASE_ANON_KEY', 'sb_secret_test_key_that_is_long_enough'],
    ['AUTH_TENANT_A_EMAIL', 'not-an-email'],
    ['AUTH_TENANT_B_EMAIL', EMAIL_A.toUpperCase()],
    ['AUTH_TENANT_A_PASSWORD', 'short'],
    ['AUTH_TENANT_B_PASSWORD', 'short'],
    ['AUTH_TENANT_TEST_PRODUCT_ID', 'unsafe/product'],
    ['AUTH_TENANT_TEST_PRODUCT_ID', 'x'.repeat(33)],
    ['AUTH_TEST_TIMEOUT_MS', '99'],
    ['AUTH_TEST_TIMEOUT_MS', '30001'],
  ]) {
    assert.throws(() => readTenantIsolationConfiguration(environment({ [name]: value })));
  }

  for (const name of [
    'AUTH_TENANT_A_EMAIL',
    'AUTH_TENANT_A_PASSWORD',
    'AUTH_TENANT_B_EMAIL',
    'AUTH_TENANT_B_PASSWORD',
    'AUTH_TENANT_TEST_PRODUCT_ID',
  ]) {
    assert.throws(() => readTenantIsolationConfiguration(environment({ [name]: '' })));
  }
});

test('rejects unpinned origins before issuing any request', async () => {
  for (const override of [
    { supabaseOrigin: 'https://zzzzzzzzzzzzzzzzzzzz.supabase.co' },
    { bffOrigin: 'https://attacker.invalid' },
  ]) {
    let requests = 0;
    await assert.rejects(
      verifySupabaseTenantIsolation(configuration(override), async () => {
        requests += 1;
        return jsonResponse({});
      }),
      /pinned tenant-isolation staging/,
    );
    assert.equal(requests, 0);
  }
});

test('proves bidirectional isolation and performs final delete, readback, logout, and refresh checks', async () => {
  const backend = createMockBackend();
  const result = await verifySupabaseTenantIsolation(configuration(), backend.fetcher);

  assert.deepEqual(result, {
    passwordGrantStatuses: { tenantA: 200, tenantB: 200 },
    distinctSupabaseUsers: true,
    initialAbsenceProven: true,
    tenantAIsolationProven: true,
    tenantBIsolationProven: true,
    favoriteCleanupProven: true,
    logoutStatuses: { tenantA: 204, tenantB: 204 },
    revokedRefreshStatuses: { tenantA: 401, tenantB: 401 },
  });
  assert.equal(containsSensitiveValue(JSON.stringify(result)), false);

  const passwordRequests = backend.requests.filter(({ url }) =>
    url.endsWith('/auth/v1/token?grant_type=password'),
  );
  assert.equal(passwordRequests.length, 2);
  assert.deepEqual(JSON.parse(passwordRequests[0].init.body), {
    email: EMAIL_A,
    password: PASSWORD_A,
  });
  assert.deepEqual(JSON.parse(passwordRequests[1].init.body), {
    email: EMAIL_B,
    password: PASSWORD_B,
  });
  assert.equal(passwordRequests[0].init.headers.apikey, ANON_KEY);

  const favoriteRequests = backend.requests.filter(({ url }) => url.includes('/api/favorites'));
  assert.equal(favoriteRequests.filter(({ init }) => init.method === 'PUT').length, 2);
  assert.equal(favoriteRequests.filter(({ init }) => init.method === 'DELETE').length, 4);
  assert.equal(favoriteRequests.filter(({ init }) => !init.method).length, 12);
  assert.deepEqual(backend.deleteCounts, { [ACCESS_A]: 2, [ACCESS_B]: 2 });
  assert.equal(backend.favorites.get(ACCESS_A).has(PRODUCT_ID), false);
  assert.equal(backend.favorites.get(ACCESS_B).has(PRODUCT_ID), false);
  assert.equal(backend.mutationResponses.length, 6);
  assert.ok(backend.mutationResponses.every((response) => response.bodyUsed));

  assert.equal(backend.requests.length, 24);
  assert.deepEqual(backend.requests.map(requestView), successfulRequestSequence());
  assert.ok(backend.requests.every(({ init }) => init.redirect === 'error'));
  assert.ok(backend.requests.every(({ init }) => init.signal instanceof AbortSignal));
  assert.equal(
    new Set(backend.requests.map(({ init }) => init.signal)).size,
    backend.requests.length,
  );
});

test('fails before arming favorite cleanup when an existing favorite is detected', async () => {
  const backend = createMockBackend({ initialFavoritesA: [PRODUCT_ID] });

  await assertSafeRejection(
    verifySupabaseTenantIsolation(configuration(), backend.fetcher),
    /already contains the test product/,
  );
  assert.equal(
    backend.requests.some(({ init }) => init.method === 'PUT'),
    false,
  );
  assert.equal(
    backend.requests.some(({ init }) => init.method === 'DELETE'),
    false,
  );
  assert.equal(
    backend.requests.filter(({ url }) => url === `${BFF_ORIGIN}/api/favorites`).length,
    1,
  );
  assert.equal(logoutRequests(backend).length, 2);
  assert.equal(refreshRequests(backend).length, 2);
  assert.equal(backend.favorites.get(ACCESS_A).has(PRODUCT_ID), true);
});

test('does not delete when both initial absences cannot be proven', async () => {
  const backend = createMockBackend({ failInitialTenantBRead: true });

  await assertSafeRejection(
    verifySupabaseTenantIsolation(configuration(), backend.fetcher),
    /Tenant B initial favorites: expected HTTP 200, got 503/,
  );
  assert.equal(
    backend.requests.some(({ init }) => init.method === 'PUT'),
    false,
  );
  assert.equal(
    backend.requests.some(({ init }) => init.method === 'DELETE'),
    false,
  );
  assert.equal(logoutRequests(backend).length, 2);
  assert.equal(refreshRequests(backend).length, 2);
});

test('fails closed on an inconsistent favorite total before arming cleanup', async () => {
  const backend = createMockBackend({ inconsistentTenantATotal: true });

  await assertSafeRejection(
    verifySupabaseTenantIsolation(configuration(), backend.fetcher),
    /Tenant A initial favorites did not return a valid favorite list/,
  );
  assert.equal(
    backend.requests.some(({ init }) => init.method === 'PUT'),
    false,
  );
  assert.equal(
    backend.requests.some(({ init }) => init.method === 'DELETE'),
    false,
  );
  assert.equal(logoutRequests(backend).length, 2);
});

test('never retries an uncertain PUT and treats immediate cleanup as best-effort', async () => {
  const backend = createMockBackend({ failTenantAPutWithSecret: true });

  await assertSafeRejection(
    verifySupabaseTenantIsolation(configuration(), backend.fetcher),
    /Tenant A favorite add request failed.*Final cleanup could not be proven.*best-effort/,
  );
  const puts = backend.requests.filter(({ init }) => init.method === 'PUT');
  assert.equal(puts.length, 1);
  assert.deepEqual(backend.deleteCounts, { [ACCESS_A]: 1, [ACCESS_B]: 1 });
  assert.equal(backend.favorites.get(ACCESS_A).has(PRODUCT_ID), false);
  assert.equal(backend.favorites.get(ACCESS_B).has(PRODUCT_ID), false);
  assert.equal(logoutRequests(backend).length, 2);
  assert.equal(refreshRequests(backend).length, 2);
});

test('keeps cleanup unproven after a non-200 PUT response without retrying it', async () => {
  const backend = createMockBackend({ failTenantAPutStatus: 503 });

  await assertSafeRejection(
    verifySupabaseTenantIsolation(configuration(), backend.fetcher),
    /Tenant A favorite add: expected HTTP 200, got 503.*Final cleanup could not be proven.*best-effort/,
  );
  assert.equal(backend.requests.filter(({ init }) => init.method === 'PUT').length, 1);
  assert.deepEqual(backend.deleteCounts, { [ACCESS_A]: 1, [ACCESS_B]: 1 });
  assert.equal(logoutRequests(backend).length, 2);
  assert.equal(refreshRequests(backend).length, 2);
});

test('does not claim cleanup when a timed-out PUT commits after delete and readback', async () => {
  const backend = createMockBackend({ lateCommitTenantAPutAfterAbort: true });

  await assertSafeRejection(
    verifySupabaseTenantIsolation(configuration({ timeoutMs: 100 }), backend.fetcher),
    /Tenant A favorite add timed out after 100ms.*Final cleanup could not be proven.*best-effort.*delayed commit/,
  );
  assert.equal(backend.requests.filter(({ init }) => init.method === 'PUT').length, 1);
  assert.deepEqual(backend.deleteCounts, { [ACCESS_A]: 1, [ACCESS_B]: 1 });
  assert.equal(backend.favorites.get(ACCESS_A).has(PRODUCT_ID), false);
  await backend.lateCommit;
  assert.equal(backend.favorites.get(ACCESS_A).has(PRODUCT_ID), true);
  assert.equal(logoutRequests(backend).length, 2);
  assert.equal(refreshRequests(backend).length, 2);
});

test('makes any final delete failure fatal while continuing all other cleanup', async () => {
  const backend = createMockBackend({ failTenantAFinalDelete: true });

  await assertSafeRejection(
    verifySupabaseTenantIsolation(configuration(), backend.fetcher),
    /Final cleanup could not be proven.*Tenant A final favorite delete: expected HTTP 200, got 500/,
  );
  assert.deepEqual(backend.deleteCounts, { [ACCESS_A]: 2, [ACCESS_B]: 2 });
  assert.equal(logoutRequests(backend).length, 2);
  assert.equal(refreshRequests(backend).length, 2);
});

test('logs out an access token from an incomplete password-grant response', async () => {
  const backend = createMockBackend({ incompleteTenantAGrant: true });

  await assertSafeRejection(
    verifySupabaseTenantIsolation(configuration(), backend.fetcher),
    /Tenant A password grant did not return a complete session and user identity/,
  );
  assert.equal(passwordRequests(backend).length, 1);
  assert.equal(logoutRequests(backend).length, 1);
  assert.equal(logoutRequests(backend)[0].init.headers.authorization, `Bearer ${ACCESS_A}`);
  assert.equal(refreshRequests(backend).length, 0);
  assert.equal(
    backend.requests.some(({ url }) => url.includes('/api/favorites')),
    false,
  );
});

test('marks cleanup unproven when an accepted password grant yields no readable access token', async () => {
  const backend = createMockBackend({ unreadableTenantAGrant: true });

  await assertSafeRejection(
    verifySupabaseTenantIsolation(configuration(), backend.fetcher),
    /returned invalid JSON.*Final cleanup could not be proven.*accepted password grant did not yield an access token/,
  );
  assert.equal(passwordRequests(backend).length, 1);
  assert.equal(logoutRequests(backend).length, 0);
  assert.equal(refreshRequests(backend).length, 0);
});

test('treats a tokenless password-grant 5xx as an uncertain session outcome', async () => {
  const backend = createMockBackend({ tenantAGrantStatus: 503 });

  await assertSafeRejection(
    verifySupabaseTenantIsolation(configuration(), backend.fetcher),
    /password grant: expected HTTP 200, got 503.*Final cleanup could not be proven.*password-grant result was uncertain/,
  );
  assert.equal(passwordRequests(backend).length, 1);
  assert.equal(logoutRequests(backend).length, 0);
  assert.equal(refreshRequests(backend).length, 0);
});

test('times out a password grant without leaking its transport error and marks session cleanup uncertain', async () => {
  const fetcher = async (_url, init) =>
    new Promise((_resolve, reject) => {
      const keepAlive = setTimeout(() => reject(new Error('abort signal did not fire')), 1000);
      init.signal.addEventListener(
        'abort',
        () => {
          clearTimeout(keepAlive);
          reject(new Error(`${EMAIL_A} ${PASSWORD_A} ${ANON_KEY} ${ACCESS_A}`));
        },
        { once: true },
      );
    });

  await assertSafeRejection(
    verifySupabaseTenantIsolation(configuration({ timeoutMs: 100 }), fetcher),
    /password grant timed out after 100ms.*Final cleanup could not be proven.*password-grant result was uncertain/,
  );
});

test('rejects equal Supabase user ids before touching favorites and still revokes both sessions', async () => {
  const backend = createMockBackend({ sameUserId: true });

  await assertSafeRejection(
    verifySupabaseTenantIsolation(configuration(), backend.fetcher),
    /same Supabase user/,
  );
  assert.equal(
    backend.requests.some(({ url }) => url.includes('/api/favorites')),
    false,
  );
  assert.equal(logoutRequests(backend).length, 2);
  assert.equal(refreshRequests(backend).length, 2);
});

test('rejects a non-UUID Supabase user id and revokes the partial session', async () => {
  const backend = createMockBackend({ invalidTenantAUserId: true });

  await assertSafeRejection(
    verifySupabaseTenantIsolation(configuration(), backend.fetcher),
    /did not return a complete session and user identity/,
  );
  assert.equal(passwordRequests(backend).length, 1);
  assert.equal(logoutRequests(backend).length, 1);
  assert.equal(refreshRequests(backend).length, 1);
  assert.equal(
    backend.requests.some(({ url }) => url.includes('/api/favorites')),
    false,
  );
});

test('fails if a refresh token remains usable and cleans the unexpected session without leaking it', async () => {
  const backend = createMockBackend({ keepTenantARefreshUsable: true });

  await assertSafeRejection(
    verifySupabaseTenantIsolation(configuration(), backend.fetcher),
    /Tenant A refresh token remained usable after logout/,
  );
  const unexpectedLogout = logoutRequests(backend).find(
    ({ init }) => init.headers.authorization === `Bearer ${UNEXPECTED_ACCESS_A}`,
  );
  assert.ok(unexpectedLogout);
  assert.ok(
    refreshRequests(backend).some(
      ({ init }) => JSON.parse(init.body).refresh_token === UNEXPECTED_REFRESH_A,
    ),
  );
});

function environment(overrides = {}) {
  return {
    NEXT_PUBLIC_AUTH_MODE: 'supabase',
    NEXT_PUBLIC_SIGNUP_ENABLED: 'false',
    NEXT_PUBLIC_SUPABASE_URL: SUPABASE_ORIGIN,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: ANON_KEY,
    NEXT_PUBLIC_BFF_URL: BFF_ORIGIN,
    AUTH_TENANT_A_EMAIL: EMAIL_A,
    AUTH_TENANT_A_PASSWORD: PASSWORD_A,
    AUTH_TENANT_B_EMAIL: EMAIL_B,
    AUTH_TENANT_B_PASSWORD: PASSWORD_B,
    AUTH_TENANT_TEST_PRODUCT_ID: PRODUCT_ID,
    AUTH_TEST_TIMEOUT_MS: '1234',
    ...overrides,
  };
}

function configuration(overrides = {}) {
  return {
    supabaseOrigin: SUPABASE_ORIGIN,
    bffOrigin: BFF_ORIGIN,
    anonKey: ANON_KEY,
    tenantA: { email: EMAIL_A, password: PASSWORD_A },
    tenantB: { email: EMAIL_B, password: PASSWORD_B },
    productId1688: PRODUCT_ID,
    timeoutMs: 5000,
    ...overrides,
  };
}

function createMockBackend(options = {}) {
  const requests = [];
  const favorites = new Map([
    [ACCESS_A, new Set(options.initialFavoritesA ?? [])],
    [ACCESS_B, new Set(options.initialFavoritesB ?? [])],
  ]);
  const accessToRefresh = new Map([
    [ACCESS_A, REFRESH_A],
    [ACCESS_B, REFRESH_B],
    [UNEXPECTED_ACCESS_A, UNEXPECTED_REFRESH_A],
  ]);
  const revokedRefreshes = new Set();
  const readCounts = { [ACCESS_A]: 0, [ACCESS_B]: 0 };
  const deleteCounts = { [ACCESS_A]: 0, [ACCESS_B]: 0 };
  const mutationResponses = [];
  let resolveLateCommit;
  const lateCommit = options.lateCommitTenantAPutAfterAbort
    ? new Promise((resolve) => {
        resolveLateCommit = resolve;
      })
    : undefined;

  const fetcher = async (url, init = {}) => {
    requests.push({ url, init });

    if (url === `${SUPABASE_ORIGIN}/auth/v1/token?grant_type=password`) {
      const body = JSON.parse(init.body);
      if (body.email === EMAIL_A) {
        if (options.tenantAGrantStatus) {
          return jsonResponse(
            { message: `${EMAIL_A} ${PASSWORD_A} ${ANON_KEY} ${ACCESS_A}` },
            options.tenantAGrantStatus,
          );
        }
        if (options.unreadableTenantAGrant) {
          return new Response(`${PASSWORD_A} ${ACCESS_A} ${REFRESH_A}`, { status: 200 });
        }
        if (options.incompleteTenantAGrant) return jsonResponse({ access_token: ACCESS_A });
        return sessionResponse(
          ACCESS_A,
          REFRESH_A,
          options.invalidTenantAUserId ? 'not-a-uuid' : options.sameUserId ? USER_B : USER_A,
        );
      }
      if (body.email === EMAIL_B) return sessionResponse(ACCESS_B, REFRESH_B, USER_B);
      return jsonResponse({ message: 'invalid credentials' }, 401);
    }

    if (url === `${SUPABASE_ORIGIN}/auth/v1/logout`) {
      const accessToken = bearerToken(init);
      const refreshToken = accessToRefresh.get(accessToken);
      if (!(options.keepTenantARefreshUsable && accessToken === ACCESS_A) && refreshToken) {
        revokedRefreshes.add(refreshToken);
      }
      return new Response(null, { status: 204 });
    }

    if (url === `${SUPABASE_ORIGIN}/auth/v1/token?grant_type=refresh_token`) {
      const refreshToken = JSON.parse(init.body).refresh_token;
      if (revokedRefreshes.has(refreshToken)) {
        return jsonResponse({ message: 'refresh token revoked' }, 401);
      }
      if (refreshToken === REFRESH_A) {
        return sessionResponse(UNEXPECTED_ACCESS_A, UNEXPECTED_REFRESH_A, USER_A);
      }
      if (refreshToken === REFRESH_B) {
        return sessionResponse(
          'unexpected-sensitive-access-b',
          'unexpected-sensitive-refresh-b',
          USER_B,
        );
      }
      if (refreshToken === UNEXPECTED_REFRESH_A) {
        return jsonResponse({ message: 'refresh token revoked' }, 401);
      }
      return jsonResponse({ message: 'refresh token invalid' }, 401);
    }

    if (url === `${BFF_ORIGIN}/api/favorites`) {
      const accessToken = bearerToken(init);
      readCounts[accessToken] = (readCounts[accessToken] ?? 0) + 1;
      if (
        options.failInitialTenantBRead &&
        accessToken === ACCESS_B &&
        readCounts[accessToken] === 1
      ) {
        return jsonResponse({ message: `${PASSWORD_B} ${REFRESH_B}` }, 503);
      }
      if (
        options.inconsistentTenantATotal &&
        accessToken === ACCESS_A &&
        readCounts[accessToken] === 1
      ) {
        return jsonResponse({ total: 1, items: [] });
      }
      return favoriteListResponse(favorites.get(accessToken) ?? new Set());
    }

    if (url === `${BFF_ORIGIN}/api/favorites/${PRODUCT_ID}`) {
      const accessToken = bearerToken(init);
      if (init.method === 'PUT') {
        if (options.lateCommitTenantAPutAfterAbort && accessToken === ACCESS_A) {
          return new Promise((_resolve, reject) => {
            const keepAlive = setTimeout(
              () => reject(new Error('PUT abort signal did not fire')),
              1000,
            );
            const onAbort = () => {
              clearTimeout(keepAlive);
              setTimeout(() => {
                favorites.get(accessToken).add(PRODUCT_ID);
                resolveLateCommit();
              }, 50);
              reject(new Error(`${EMAIL_A} ${PASSWORD_A} ${PRODUCT_ID} ${ACCESS_A}`));
            };
            if (init.signal.aborted) onAbort();
            else init.signal.addEventListener('abort', onAbort, { once: true });
          });
        }
        if (options.failTenantAPutWithSecret && accessToken === ACCESS_A) {
          throw new Error(`${PASSWORD_A} ${ANON_KEY} ${PRODUCT_ID} ${ACCESS_A}`);
        }
        if (options.failTenantAPutStatus && accessToken === ACCESS_A) {
          return jsonResponse(
            { message: `${EMAIL_A} ${PASSWORD_A} ${PRODUCT_ID} ${ACCESS_A}` },
            options.failTenantAPutStatus,
          );
        }
        favorites.get(accessToken).add(PRODUCT_ID);
        const response = jsonResponse({ productId1688: PRODUCT_ID });
        mutationResponses.push(response);
        return response;
      }
      if (init.method === 'DELETE') {
        deleteCounts[accessToken] = (deleteCounts[accessToken] ?? 0) + 1;
        if (
          options.failTenantAFinalDelete &&
          accessToken === ACCESS_A &&
          deleteCounts[accessToken] === 2
        ) {
          return jsonResponse({ message: `${EMAIL_A} ${PRODUCT_ID} ${ACCESS_A}` }, 500);
        }
        favorites.get(accessToken).delete(PRODUCT_ID);
        const response = jsonResponse({ removed: true });
        mutationResponses.push(response);
        return response;
      }
    }

    return jsonResponse({ message: 'unexpected mock request' }, 500);
  };

  return { requests, favorites, deleteCounts, mutationResponses, lateCommit, fetcher };
}

function requestView({ url, init }) {
  return {
    method: init.method ?? 'GET',
    url,
    bearer: init.headers?.authorization,
  };
}

function successfulRequestSequence() {
  const favorites = `${BFF_ORIGIN}/api/favorites`;
  const favorite = `${favorites}/${PRODUCT_ID}`;
  const passwordGrant = `${SUPABASE_ORIGIN}/auth/v1/token?grant_type=password`;
  const logout = `${SUPABASE_ORIGIN}/auth/v1/logout`;
  const refreshGrant = `${SUPABASE_ORIGIN}/auth/v1/token?grant_type=refresh_token`;
  const request = (method, url, accessToken) => ({
    method,
    url,
    bearer: accessToken ? `Bearer ${accessToken}` : undefined,
  });

  return [
    request('POST', passwordGrant),
    request('POST', passwordGrant),
    request('GET', favorites, ACCESS_A),
    request('GET', favorites, ACCESS_B),
    request('PUT', favorite, ACCESS_A),
    request('GET', favorites, ACCESS_A),
    request('GET', favorites, ACCESS_B),
    request('DELETE', favorite, ACCESS_A),
    request('GET', favorites, ACCESS_A),
    request('GET', favorites, ACCESS_B),
    request('PUT', favorite, ACCESS_B),
    request('GET', favorites, ACCESS_B),
    request('GET', favorites, ACCESS_A),
    request('DELETE', favorite, ACCESS_B),
    request('GET', favorites, ACCESS_B),
    request('GET', favorites, ACCESS_A),
    request('DELETE', favorite, ACCESS_A),
    request('DELETE', favorite, ACCESS_B),
    request('GET', favorites, ACCESS_A),
    request('GET', favorites, ACCESS_B),
    request('POST', logout, ACCESS_A),
    request('POST', logout, ACCESS_B),
    request('POST', refreshGrant),
    request('POST', refreshGrant),
  ];
}

function sessionResponse(accessToken, refreshToken, userId) {
  return jsonResponse({
    access_token: accessToken,
    refresh_token: refreshToken,
    user: { id: userId },
  });
}

function favoriteListResponse(productIds) {
  return jsonResponse({
    total: productIds.size,
    items: [...productIds].map((productId1688) => ({ productId1688 })),
  });
}

function bearerToken(init) {
  return init.headers.authorization.slice('Bearer '.length);
}

function passwordRequests(backend) {
  return backend.requests.filter(({ url }) => url.endsWith('/auth/v1/token?grant_type=password'));
}

function logoutRequests(backend) {
  return backend.requests.filter(({ url }) => url.endsWith('/auth/v1/logout'));
}

function refreshRequests(backend) {
  return backend.requests.filter(({ url }) =>
    url.endsWith('/auth/v1/token?grant_type=refresh_token'),
  );
}

async function assertSafeRejection(operation, expected) {
  await assert.rejects(operation, (error) => {
    assert.match(error.message, expected);
    assert.equal(containsSensitiveValue(error.message), false);
    return true;
  });
}

function containsSensitiveValue(value) {
  return [
    EMAIL_A,
    EMAIL_B,
    PASSWORD_A,
    PASSWORD_B,
    ANON_KEY,
    PRODUCT_ID,
    USER_A,
    USER_B,
    ACCESS_A,
    ACCESS_B,
    REFRESH_A,
    REFRESH_B,
    UNEXPECTED_ACCESS_A,
    UNEXPECTED_REFRESH_A,
  ].some((secret) => value.includes(secret));
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
