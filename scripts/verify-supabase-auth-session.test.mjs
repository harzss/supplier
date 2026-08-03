import assert from 'node:assert/strict';
import test from 'node:test';

import {
  readAuthSessionConfiguration,
  verifySupabaseAuthSession,
} from './verify-supabase-auth-session.mjs';

const SUPABASE_ORIGIN = 'https://abcdefghijklmnopqrst.supabase.co';
const BFF_ORIGIN = 'https://supplier-staging.example.com';
const ANON_KEY = 'public-anon-key-that-is-long-enough';
const EMAIL = 'auth-test@example.com';
const PASSWORD = 'test-password-secret';

test('accepts only complete, exact HTTPS configuration', () => {
  assert.deepEqual(
    readAuthSessionConfiguration({
      NEXT_PUBLIC_SUPABASE_URL: SUPABASE_ORIGIN,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: ANON_KEY,
      BFF_URL: BFF_ORIGIN,
      AUTH_TEST_EMAIL: EMAIL,
      AUTH_TEST_PASSWORD: PASSWORD,
      AUTH_TEST_TIMEOUT_MS: '1234',
    }),
    {
      supabaseOrigin: SUPABASE_ORIGIN,
      bffOrigin: BFF_ORIGIN,
      anonKey: ANON_KEY,
      email: EMAIL,
      password: PASSWORD,
      timeoutMs: 1234,
    },
  );

  for (const [name, value] of [
    ['NEXT_PUBLIC_SUPABASE_URL', 'https://attacker.invalid'],
    ['BFF_URL', 'http://supplier-staging.example.com'],
    ['BFF_URL', `${BFF_ORIGIN}/api`],
    ['NEXT_PUBLIC_SUPABASE_ANON_KEY', 'short'],
    ['AUTH_TEST_EMAIL', 'not-an-email'],
    ['AUTH_TEST_PASSWORD', 'short'],
    ['AUTH_TEST_TIMEOUT_MS', '99'],
    ['AUTH_TEST_TIMEOUT_MS', '30001'],
  ]) {
    const environment = {
      NEXT_PUBLIC_SUPABASE_URL: SUPABASE_ORIGIN,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: ANON_KEY,
      BFF_URL: BFF_ORIGIN,
      AUTH_TEST_EMAIL: EMAIL,
      AUTH_TEST_PASSWORD: PASSWORD,
      [name]: value,
    };
    assert.throws(() => readAuthSessionConfiguration(environment));
  }
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

  assert.deepEqual(
    await verifySupabaseAuthSession(
      {
        supabaseOrigin: SUPABASE_ORIGIN,
        bffOrigin: BFF_ORIGIN,
        anonKey: ANON_KEY,
        email: EMAIL,
        password: PASSWORD,
        timeoutMs: 5000,
      },
      fetcher,
    ),
    {
      passwordGrantStatus: 200,
      initialProtectedStatus: 200,
      refreshGrantStatus: 200,
      refreshedProtectedStatus: 200,
      logoutStatus: 204,
      revokedRefreshStatus: 401,
      anonymousProtectedStatus: 401,
    },
  );

  assert.equal(requests.length, 7);
  assert.equal(requests[0].url, `${SUPABASE_ORIGIN}/auth/v1/token?grant_type=password`);
  assert.deepEqual(JSON.parse(requests[0].init.body), { email: EMAIL, password: PASSWORD });
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

  await assert.rejects(
    verifySupabaseAuthSession(
      {
        supabaseOrigin: SUPABASE_ORIGIN,
        bffOrigin: BFF_ORIGIN,
        anonKey: ANON_KEY,
        email: EMAIL,
        password: PASSWORD,
        timeoutMs: 5000,
      },
      fetcher,
    ),
    (error) => {
      assert.match(error.message, /expected HTTP 400 or 401, got 200/);
      assert.equal(error.message.includes('unexpected-access'), false);
      assert.equal(error.message.includes(PASSWORD), false);
      return true;
    },
  );

  assert.equal(requests.length, 7);
  assert.equal(requests[6].url, `${SUPABASE_ORIGIN}/auth/v1/logout`);
  assert.equal(requests[6].init.headers.authorization, 'Bearer unexpected-access');
});

test('fails on unexpected HTTP status without exposing response bodies or credentials', async () => {
  const leakedBody = `${PASSWORD} initial-access`;
  const fetcher = async () => new Response(leakedBody, { status: 401 });

  await assert.rejects(
    verifySupabaseAuthSession(
      {
        supabaseOrigin: SUPABASE_ORIGIN,
        bffOrigin: BFF_ORIGIN,
        anonKey: ANON_KEY,
        email: EMAIL,
        password: PASSWORD,
        timeoutMs: 5000,
      },
      fetcher,
    ),
    (error) => {
      assert.match(error.message, /Password grant: expected HTTP 200, got 401/);
      assert.equal(error.message.includes(PASSWORD), false);
      assert.equal(error.message.includes('initial-access'), false);
      return true;
    },
  );
});

test('fails closed on an incomplete session response without exposing it', async () => {
  const fetcher = async () => jsonResponse({ access_token: 'sensitive-access' });

  await assert.rejects(
    verifySupabaseAuthSession(
      {
        supabaseOrigin: SUPABASE_ORIGIN,
        bffOrigin: BFF_ORIGIN,
        anonKey: ANON_KEY,
        email: EMAIL,
        password: PASSWORD,
        timeoutMs: 5000,
      },
      fetcher,
    ),
    (error) => {
      assert.match(error.message, /did not return a complete session/);
      assert.equal(error.message.includes('sensitive-access'), false);
      return true;
    },
  );
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
    verifySupabaseAuthSession(
      {
        supabaseOrigin: SUPABASE_ORIGIN,
        bffOrigin: BFF_ORIGIN,
        anonKey: ANON_KEY,
        email: EMAIL,
        password: PASSWORD,
        timeoutMs: 100,
      },
      fetcher,
    ),
    (error) => {
      assert.match(error.message, /Password grant timed out after 100ms/);
      assert.equal(error.message.includes(PASSWORD), false);
      return true;
    },
  );
});

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
