import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  readAuthSessionConfiguration,
  readAuthSessionEnvironmentFile,
  verifySupabaseAuthSession,
} from './verify-supabase-auth-session.mjs';

const SUPABASE_ORIGIN = 'https://abcdefghijklmnopqrst.supabase.co';
const BFF_ORIGIN = 'https://supplier-staging.example.com';
const ANON_KEY = 'sb_publishable_test_key_that_is_long_enough';
const EMAIL = 'auth-test@example.com';
const PASSWORD = 'test-password-secret';
const PREVIOUS_PASSWORD = 'previous-password-secret';

test('reads only a private explicit Auth environment file', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'supplier-auth-session-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const privateFile = join(directory, 'private.env');
  const publicFile = join(directory, 'public.env');
  const contents = Object.entries(environment())
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  await writeFile(privateFile, contents, { mode: 0o600 });
  await writeFile(publicFile, contents, { mode: 0o644 });
  await chmod(privateFile, 0o600);
  await chmod(publicFile, 0o644);

  assert.deepEqual(
    readAuthSessionConfiguration(await readAuthSessionEnvironmentFile(privateFile)),
    configuration({ timeoutMs: 1234 }),
  );
  await assert.rejects(
    readAuthSessionEnvironmentFile(publicFile),
    /owner-only regular file with mode 0600/,
  );
  await assert.rejects(
    readAuthSessionEnvironmentFile(join(directory, 'missing.env')),
    /missing or unreadable/,
  );
});

test('accepts only complete, exact HTTPS configuration', () => {
  assert.deepEqual(readAuthSessionConfiguration(environment()), configuration({ timeoutMs: 1234 }));

  assert.deepEqual(
    readAuthSessionConfiguration(environment({ AUTH_TEST_PREVIOUS_PASSWORD: PREVIOUS_PASSWORD }), {
      expectPreviousPasswordRejected: true,
    }),
    configuration({ timeoutMs: 1234, previousPassword: PREVIOUS_PASSWORD }),
  );

  for (const [name, value] of [
    ['NEXT_PUBLIC_AUTH_MODE', 'demo'],
    ['NEXT_PUBLIC_SIGNUP_ENABLED', 'true'],
    ['NEXT_PUBLIC_SUPABASE_URL', 'https://attacker.invalid'],
    ['NEXT_PUBLIC_BFF_URL', 'http://supplier-staging.example.com'],
    ['NEXT_PUBLIC_BFF_URL', `${BFF_ORIGIN}/api`],
    ['NEXT_PUBLIC_SUPABASE_ANON_KEY', 'short'],
    ['NEXT_PUBLIC_SUPABASE_ANON_KEY', 'sb_secret_test_key_that_is_long_enough'],
    ['AUTH_TEST_EMAIL', 'not-an-email'],
    ['AUTH_TEST_PASSWORD', 'short'],
    ['AUTH_TEST_TIMEOUT_MS', '99'],
    ['AUTH_TEST_TIMEOUT_MS', '30001'],
  ]) {
    assert.throws(() => readAuthSessionConfiguration(environment({ [name]: value })));
  }

  assert.throws(
    () =>
      readAuthSessionConfiguration(environment({ AUTH_TEST_PREVIOUS_PASSWORD: PASSWORD }), {
        expectPreviousPasswordRejected: true,
      }),
    /must differ/,
  );
  assert.throws(
    () => readAuthSessionConfiguration(environment(), { expectPreviousPasswordRejected: true }),
    /AUTH_TEST_PREVIOUS_PASSWORD is required/,
  );
});

test('verifies password, protected API, refresh, logout, and no-token denial in order', async () => {
  const requests = [];
  const responses = [
    jsonResponse({ access_token: 'initial-access', refresh_token: 'initial-refresh' }),
    jsonResponse({ plan: 'trial' }),
    jsonResponse({ access_token: 'refreshed-access', refresh_token: 'refreshed-refresh' }),
    jsonResponse({ plan: 'trial' }),
    new Response(null, { status: 204 }),
    jsonResponse({ message: 'Refresh token revoked' }, 401),
    jsonResponse({ message: 'Unauthorized' }, 401),
  ];
  const fetcher = async (url, init) => {
    requests.push({ url, init });
    return responses.shift();
  };

  assert.deepEqual(await verifySupabaseAuthSession(configuration(), fetcher), {
    passwordGrantStatus: 200,
    initialProtectedStatus: 200,
    refreshGrantStatus: 200,
    refreshedProtectedStatus: 200,
    logoutStatus: 204,
    revokedRefreshStatus: 401,
    anonymousProtectedStatus: 401,
  });

  assert.equal(requests.length, 7);
  assert.equal(requests[0].url, `${SUPABASE_ORIGIN}/auth/v1/token?grant_type=password`);
  assert.deepEqual(JSON.parse(requests[0].init.body), { email: EMAIL, password: PASSWORD });
  assert.equal(requests[0].init.headers.apikey, ANON_KEY);
  assert.equal(Object.hasOwn(requests[0].init.headers, 'authorization'), false);
  assert.equal(requests[1].url, `${BFF_ORIGIN}/api/me/entitlements`);
  assert.equal(requests[1].init.headers.authorization, 'Bearer initial-access');
  assert.equal(requests[2].url, `${SUPABASE_ORIGIN}/auth/v1/token?grant_type=refresh_token`);
  assert.deepEqual(JSON.parse(requests[2].init.body), { refresh_token: 'initial-refresh' });
  assert.equal(requests[3].init.headers.authorization, 'Bearer refreshed-access');
  assert.equal(requests[4].url, `${SUPABASE_ORIGIN}/auth/v1/logout`);
  assert.equal(requests[4].init.headers.authorization, 'Bearer refreshed-access');
  assert.equal(requests[5].url, `${SUPABASE_ORIGIN}/auth/v1/token?grant_type=refresh_token`);
  assert.deepEqual(JSON.parse(requests[5].init.body), { refresh_token: 'refreshed-refresh' });
  assert.equal(requests[6].url, `${BFF_ORIGIN}/api/me/entitlements`);
  assert.equal(requests[6].init.headers, undefined);
  assert.ok(requests.every(({ init }) => init.signal instanceof AbortSignal));
});

test('proves the previous password is rejected before verifying the new session', async () => {
  const requests = [];
  const responses = [
    jsonResponse({ message: 'invalid credentials' }, 400),
    jsonResponse({ access_token: 'initial-access', refresh_token: 'initial-refresh' }),
    jsonResponse({ plan: 'trial' }),
    jsonResponse({ access_token: 'refreshed-access', refresh_token: 'refreshed-refresh' }),
    jsonResponse({ plan: 'trial' }),
    new Response(null, { status: 204 }),
    jsonResponse({ message: 'Refresh token revoked' }, 401),
    jsonResponse({ message: 'Unauthorized' }, 401),
  ];
  const fetcher = async (url, init) => {
    requests.push({ url, init });
    return responses.shift();
  };

  assert.deepEqual(
    await verifySupabaseAuthSession(
      configuration({ previousPassword: PREVIOUS_PASSWORD }),
      fetcher,
    ),
    {
      previousPasswordStatus: 400,
      passwordGrantStatus: 200,
      initialProtectedStatus: 200,
      refreshGrantStatus: 200,
      refreshedProtectedStatus: 200,
      logoutStatus: 204,
      revokedRefreshStatus: 401,
      anonymousProtectedStatus: 401,
    },
  );

  assert.equal(requests.length, 8);
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    email: EMAIL,
    password: PREVIOUS_PASSWORD,
  });
  assert.deepEqual(JSON.parse(requests[1].init.body), { email: EMAIL, password: PASSWORD });
});

test('cleans up and stops when the previous password unexpectedly creates a session', async () => {
  const requests = [];
  const responses = [
    jsonResponse({ access_token: 'previous-access', refresh_token: 'previous-refresh' }),
    new Response(null, { status: 204 }),
  ];
  const fetcher = async (url, init) => {
    requests.push({ url, init });
    return responses.shift();
  };

  await assertSafeRejection(
    verifySupabaseAuthSession(configuration({ previousPassword: PREVIOUS_PASSWORD }), fetcher),
    /Previous password grant: expected HTTP 400 or 401, got 200/,
  );
  assert.equal(requests.length, 2);
  assert.equal(requests[1].url, `${SUPABASE_ORIGIN}/auth/v1/logout`);
  assert.equal(requests[1].init.headers.authorization, 'Bearer previous-access');
});

test('fails if cleanup of an unexpected previous-password session is not proven', async () => {
  const responses = [
    jsonResponse({ access_token: 'previous-access', refresh_token: 'previous-refresh' }),
    new Response(null, { status: 500 }),
  ];

  await assertSafeRejection(
    verifySupabaseAuthSession(configuration({ previousPassword: PREVIOUS_PASSWORD }), async () =>
      responses.shift(),
    ),
    /Cleanup logout could not be proven/,
  );
});

test('does not treat throttling as proof that the previous password was revoked', async () => {
  let requests = 0;
  await assertSafeRejection(
    verifySupabaseAuthSession(configuration({ previousPassword: PREVIOUS_PASSWORD }), async () => {
      requests += 1;
      return jsonResponse({ message: 'rate limited' }, 429);
    }),
    /Previous password grant: expected HTTP 400 or 401, got 429/,
  );
  assert.equal(requests, 1);
});

test('cleans up and fails when a revoked refresh token unexpectedly creates a session', async () => {
  const requests = [];
  const responses = [
    jsonResponse({ access_token: 'initial-access', refresh_token: 'initial-refresh' }),
    jsonResponse({ plan: 'trial' }),
    jsonResponse({ access_token: 'refreshed-access', refresh_token: 'refreshed-refresh' }),
    jsonResponse({ plan: 'trial' }),
    new Response(null, { status: 204 }),
    jsonResponse({ access_token: 'unexpected-access', refresh_token: 'unexpected-refresh' }),
    new Response(null, { status: 204 }),
  ];
  const fetcher = async (url, init) => {
    requests.push({ url, init });
    return responses.shift();
  };

  await assert.rejects(verifySupabaseAuthSession(configuration(), fetcher), (error) => {
    assert.match(error.message, /expected HTTP 400 or 401, got 200/);
    assert.equal(error.message.includes('unexpected-access'), false);
    assert.equal(error.message.includes(PASSWORD), false);
    return true;
  });

  assert.equal(requests.length, 7);
  assert.equal(requests[6].url, `${SUPABASE_ORIGIN}/auth/v1/logout`);
  assert.equal(requests[6].init.headers.authorization, 'Bearer unexpected-access');
});

test('retries cleanup when the normal logout response is not successful', async () => {
  const requests = [];
  const responses = [
    jsonResponse({ access_token: 'initial-access', refresh_token: 'initial-refresh' }),
    jsonResponse({ plan: 'trial' }),
    jsonResponse({ access_token: 'refreshed-access', refresh_token: 'refreshed-refresh' }),
    jsonResponse({ plan: 'trial' }),
    new Response(null, { status: 500 }),
    new Response(null, { status: 204 }),
  ];
  const fetcher = async (url, init) => {
    requests.push({ url, init });
    return responses.shift();
  };

  await assertSafeRejection(
    verifySupabaseAuthSession(configuration(), fetcher),
    /Logout: expected HTTP 204, got 500/,
  );
  assert.equal(requests.length, 6);
  assert.equal(requests[5].url, `${SUPABASE_ORIGIN}/auth/v1/logout`);
  assert.equal(requests[5].init.headers.authorization, 'Bearer refreshed-access');
});

test('reports when cleanup after a failed normal logout cannot be proven', async () => {
  const responses = [
    jsonResponse({ access_token: 'initial-access', refresh_token: 'initial-refresh' }),
    jsonResponse({ plan: 'trial' }),
    jsonResponse({ access_token: 'refreshed-access', refresh_token: 'refreshed-refresh' }),
    jsonResponse({ plan: 'trial' }),
    new Response(null, { status: 500 }),
    new Response(null, { status: 500 }),
  ];

  await assertSafeRejection(
    verifySupabaseAuthSession(configuration(), async () => responses.shift()),
    /Logout: expected HTTP 204, got 500\. Cleanup logout could not be proven/,
  );
});

test('fails on unexpected HTTP status without exposing response bodies or credentials', async () => {
  const leakedBody = `${PASSWORD} initial-access`;
  const fetcher = async () => new Response(leakedBody, { status: 401 });

  await assert.rejects(verifySupabaseAuthSession(configuration(), fetcher), (error) => {
    assert.match(error.message, /Password grant: expected HTTP 200, got 401/);
    assert.equal(error.message.includes(PASSWORD), false);
    assert.equal(error.message.includes('initial-access'), false);
    return true;
  });
});

test('fails closed on an incomplete session response without exposing it', async () => {
  const fetcher = async () => jsonResponse({ access_token: 'sensitive-access' });

  await assert.rejects(verifySupabaseAuthSession(configuration(), fetcher), (error) => {
    assert.match(error.message, /did not return a complete session/);
    assert.equal(error.message.includes('sensitive-access'), false);
    return true;
  });
});

test('enforces the configured request timeout without exposing credentials', async () => {
  const fetcher = async (_url, init) =>
    new Promise((_resolve, reject) => {
      const keepAlive = setTimeout(() => reject(new Error('timeout signal did not fire')), 1000);
      init.signal.addEventListener(
        'abort',
        () => {
          clearTimeout(keepAlive);
          reject(new Error(`${PASSWORD} timed out`));
        },
        { once: true },
      );
    });

  await assert.rejects(
    verifySupabaseAuthSession(configuration({ timeoutMs: 100 }), fetcher),
    (error) => {
      assert.match(error.message, /Password grant timed out after 100ms/);
      assert.equal(error.message.includes(PASSWORD), false);
      return true;
    },
  );
});

test('uses a legacy anon JWT as bearer only until a user access token is available', async () => {
  const legacyAnonKey = jwtWithRole('anon');
  const requests = [];
  const fetcher = async (url, init) => {
    requests.push({ url, init });
    return jsonResponse({ message: 'invalid credentials' }, 401);
  };

  await assert.rejects(
    verifySupabaseAuthSession(configuration({ anonKey: legacyAnonKey }), fetcher),
    /Password grant: expected HTTP 200, got 401/,
  );
  assert.equal(requests.length, 1);
  assert.equal(requests[0].init.headers.apikey, legacyAnonKey);
  assert.equal(requests[0].init.headers.authorization, `Bearer ${legacyAnonKey}`);
});

function environment(overrides = {}) {
  return {
    NEXT_PUBLIC_APP_NAME: 'Supplier Test',
    NEXT_PUBLIC_AUTH_MODE: 'supabase',
    NEXT_PUBLIC_SIGNUP_ENABLED: 'false',
    NEXT_PUBLIC_BFF_URL: BFF_ORIGIN,
    NEXT_PUBLIC_SUPABASE_URL: SUPABASE_ORIGIN,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: ANON_KEY,
    AUTH_TEST_EMAIL: EMAIL,
    AUTH_TEST_PASSWORD: PASSWORD,
    AUTH_TEST_TIMEOUT_MS: '1234',
    ...overrides,
  };
}

function configuration(overrides = {}) {
  return {
    supabaseOrigin: SUPABASE_ORIGIN,
    bffOrigin: BFF_ORIGIN,
    anonKey: ANON_KEY,
    email: EMAIL,
    password: PASSWORD,
    timeoutMs: 5000,
    ...overrides,
  };
}

async function assertSafeRejection(operation, expected) {
  await assert.rejects(operation, (error) => {
    assert.match(error.message, expected);
    assert.equal(error.message.includes(EMAIL), false);
    assert.equal(error.message.includes(PASSWORD), false);
    assert.equal(error.message.includes(PREVIOUS_PASSWORD), false);
    assert.equal(error.message.includes(ANON_KEY), false);
    assert.equal(error.message.includes('previous-access'), false);
    return true;
  });
}

function jwtWithRole(role) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ role, iss: 'supabase', exp: 4_102_444_800 }),
  ).toString('base64url');
  return `${header}.${payload}.${'s'.repeat(43)}`;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
