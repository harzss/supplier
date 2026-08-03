import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  inviteStagingUser,
  readInviteConfiguration,
  readInviteEnvironmentFile,
} from './invite-staging-user.mjs';

const SUPABASE_ORIGIN = 'https://abcdefghijklmnopqrst.supabase.co';
const WEB_ORIGIN = 'https://supplier-staging-web.example.com';
const ADMIN_KEY = 'sb_secret_test_key_that_is_long_enough';
const EMAIL = 'staging-invite@example.com';

test('reads only a private explicit environment file', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'supplier-invite-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const privateFile = join(directory, 'private.env');
  const publicFile = join(directory, 'public.env');
  const contents = [
    `SUPABASE_URL=${SUPABASE_ORIGIN}`,
    `SUPABASE_SERVICE_ROLE_KEY=${ADMIN_KEY}`,
    `WEB_URL=${WEB_ORIGIN}`,
    `STAGING_INVITE_EMAIL=${EMAIL}`,
  ].join('\n');
  await writeFile(privateFile, contents, { mode: 0o600 });
  await writeFile(publicFile, contents, { mode: 0o644 });
  await chmod(privateFile, 0o600);
  await chmod(publicFile, 0o644);

  assert.deepEqual(readInviteConfiguration(await readInviteEnvironmentFile(privateFile)), {
    supabaseOrigin: SUPABASE_ORIGIN,
    webOrigin: WEB_ORIGIN,
    adminKey: ADMIN_KEY,
    email: EMAIL,
    timeoutMs: 10_000,
  });
  await assert.rejects(
    readInviteEnvironmentFile(publicFile),
    /owner-only regular file with mode 0600/,
  );
  await assert.rejects(
    readInviteEnvironmentFile(join(directory, 'missing.env')),
    /missing or unreadable/,
  );
});

test('accepts only complete and exact invitation configuration', () => {
  assert.deepEqual(
    readInviteConfiguration({
      SUPABASE_URL: SUPABASE_ORIGIN,
      SUPABASE_SERVICE_ROLE_KEY: ADMIN_KEY,
      WEB_URL: WEB_ORIGIN,
      STAGING_INVITE_EMAIL: ` ${EMAIL} `,
      STAGING_INVITE_TIMEOUT_MS: '1234',
    }),
    {
      supabaseOrigin: SUPABASE_ORIGIN,
      webOrigin: WEB_ORIGIN,
      adminKey: ADMIN_KEY,
      email: EMAIL,
      timeoutMs: 1234,
    },
  );

  const serviceRoleJwt = jwtWithRole('service_role');
  assert.equal(
    readInviteConfiguration({
      SUPABASE_URL: SUPABASE_ORIGIN,
      SUPABASE_SERVICE_ROLE_KEY: serviceRoleJwt,
      WEB_URL: WEB_ORIGIN,
      STAGING_INVITE_EMAIL: EMAIL,
    }).adminKey,
    serviceRoleJwt,
  );

  for (const [name, value] of [
    ['SUPABASE_URL', 'https://attacker.invalid'],
    ['SUPABASE_URL', `${SUPABASE_ORIGIN}/auth/v1`],
    ['SUPABASE_URL', 'https://abcdefghijklmnopqrst.supabase.co:8443'],
    ['WEB_URL', 'http://supplier-staging-web.example.com'],
    ['WEB_URL', `${WEB_ORIGIN}/settings`],
    ['WEB_URL', 'https://supplier-staging-web.example.com:8443'],
    ['SUPABASE_SERVICE_ROLE_KEY', 'sb_publishable_not_an_admin_key'],
    ['SUPABASE_SERVICE_ROLE_KEY', jwtWithRole('anon')],
    ['SUPABASE_SERVICE_ROLE_KEY', jwtWithRole('service_role', { iss: 'attacker' })],
    ['SUPABASE_SERVICE_ROLE_KEY', jwtWithRole('service_role', { exp: 1 })],
    ['SUPABASE_SERVICE_ROLE_KEY', jwtWithRole('service_role').replace('.', '!.')],
    ['STAGING_INVITE_EMAIL', 'not-an-email'],
    ['STAGING_INVITE_TIMEOUT_MS', '99'],
    ['STAGING_INVITE_TIMEOUT_MS', '30001'],
  ]) {
    const environment = {
      SUPABASE_URL: SUPABASE_ORIGIN,
      SUPABASE_SERVICE_ROLE_KEY: ADMIN_KEY,
      WEB_URL: WEB_ORIGIN,
      STAGING_INVITE_EMAIL: EMAIL,
      [name]: value,
    };
    assert.throws(() => readInviteConfiguration(environment));
  }

  for (const name of [
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'WEB_URL',
    'STAGING_INVITE_EMAIL',
  ]) {
    const environment = {
      SUPABASE_URL: SUPABASE_ORIGIN,
      SUPABASE_SERVICE_ROLE_KEY: ADMIN_KEY,
      WEB_URL: WEB_ORIGIN,
      STAGING_INVITE_EMAIL: EMAIL,
    };
    delete environment[name];
    assert.throws(() => readInviteConfiguration(environment));
  }
});

test('requires an exact action-time email confirmation before fetch', async () => {
  let requests = 0;
  const fetcher = async () => {
    requests += 1;
    return jsonResponse({});
  };

  await assertSafeRejection(
    inviteStagingUser(configuration(), 'other@example.com', fetcher),
    /target confirmation did not match; no request was sent/,
  );
  assert.equal(requests, 0);
});

test('sends one exact admin invitation request and accepts a complete user response', async () => {
  const requests = [];
  const fetcher = async (url, init) => {
    requests.push({ url, init });
    return jsonResponse({
      id: 'user-id-must-not-be-logged',
      email: EMAIL.toUpperCase(),
      invited_at: '2026-08-03T12:00:00.000Z',
    });
  };

  assert.deepEqual(await inviteStagingUser(configuration(), EMAIL, fetcher), { status: 200 });
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url.toString(),
    `${SUPABASE_ORIGIN}/auth/v1/invite?redirect_to=${encodeURIComponent(WEB_ORIGIN)}`,
  );
  assert.equal(requests[0].init.method, 'POST');
  assert.deepEqual(requests[0].init.headers, {
    apikey: ADMIN_KEY,
    'Content-Type': 'application/json;charset=UTF-8',
    'X-Supabase-Api-Version': '2024-01-01',
  });
  assert.equal(Object.hasOwn(requests[0].init.headers, 'authorization'), false);
  assert.equal(Object.hasOwn(requests[0].init.headers, 'Authorization'), false);
  assert.deepEqual(JSON.parse(requests[0].init.body), { email: EMAIL });
  assert.equal(requests[0].init.body.includes('redirect_to'), false);
  assert.equal(requests[0].init.redirect, 'error');
  assert.ok(requests[0].init.signal instanceof AbortSignal);
});

test('uses the legacy service-role JWT as both apikey and bearer authorization', async () => {
  const legacyKey = jwtWithRole('service_role');
  const requests = [];
  const fetcher = async (url, init) => {
    requests.push({ url, init });
    return jsonResponse({
      id: 'user-id-must-not-be-logged',
      email: EMAIL,
      invited_at: '2026-08-03T12:00:00.000Z',
    });
  };

  await inviteStagingUser(configuration({ adminKey: legacyKey }), EMAIL, fetcher);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].init.headers.apikey, legacyKey);
  assert.equal(requests[0].init.headers.authorization, `Bearer ${legacyKey}`);
});

test('does not read or expose non-success response bodies', async () => {
  let bodyRead = false;
  const fetcher = async () => ({
    status: 422,
    json: async () => {
      bodyRead = true;
      return { message: `${EMAIL} ${ADMIN_KEY}` };
    },
  });

  await assertSafeRejection(
    inviteStagingUser(configuration(), EMAIL, fetcher),
    /failed \(HTTP 422\); inspect Auth users before retrying/,
  );
  assert.equal(bodyRead, false);
});

test('treats 5xx and network failure as unknown without retrying or leaking details', async () => {
  let serverRequests = 0;
  await assertSafeRejection(
    inviteStagingUser(configuration(), EMAIL, async () => {
      serverRequests += 1;
      return new Response(`${EMAIL} ${ADMIN_KEY}`, { status: 503 });
    }),
    /HTTP 503; outcome is unknown/,
  );
  assert.equal(serverRequests, 1);

  let networkRequests = 0;
  await assertSafeRejection(
    inviteStagingUser(configuration(), EMAIL, async () => {
      networkRequests += 1;
      throw new Error(`${EMAIL} ${ADMIN_KEY}`);
    }),
    /request failed; outcome is unknown/,
  );
  assert.equal(networkRequests, 1);
});

test('fails safely when a successful request has invalid or incomplete JSON', async () => {
  await assertSafeRejection(
    inviteStagingUser(
      configuration(),
      EMAIL,
      async () => new Response(`${EMAIL} ${ADMIN_KEY}`, { status: 200 }),
    ),
    /invalid success JSON; the request may already be effective/,
  );

  for (const body of [
    {},
    { id: 'user-id', email: EMAIL },
    { id: 'user-id', email: 'other@example.com', invited_at: '2026-08-03T12:00:00Z' },
  ]) {
    await assertSafeRejection(
      inviteStagingUser(configuration(), EMAIL, async () => jsonResponse(body)),
      /incomplete success response; the request may already be effective/,
    );
  }
});

test('enforces the configured timeout once without exposing the underlying error', async () => {
  let requests = 0;
  const fetcher = async (_url, init) =>
    new Promise((_resolve, reject) => {
      requests += 1;
      const keepAlive = setTimeout(() => reject(new Error('timeout signal did not fire')), 1000);
      init.signal.addEventListener(
        'abort',
        () => {
          clearTimeout(keepAlive);
          reject(new Error(`${EMAIL} ${ADMIN_KEY}`));
        },
        { once: true },
      );
    });

  await assertSafeRejection(
    inviteStagingUser(configuration({ timeoutMs: 100 }), EMAIL, fetcher),
    /timed out after 100ms; outcome is unknown/,
  );
  assert.equal(requests, 1);
});

function configuration(overrides = {}) {
  return {
    supabaseOrigin: SUPABASE_ORIGIN,
    webOrigin: WEB_ORIGIN,
    adminKey: ADMIN_KEY,
    email: EMAIL,
    timeoutMs: 5000,
    ...overrides,
  };
}

async function assertSafeRejection(promise, expected) {
  await assert.rejects(promise, (error) => {
    assert.match(error.message, expected);
    assert.equal(error.message.includes(EMAIL), false);
    assert.equal(error.message.includes(ADMIN_KEY), false);
    assert.equal(error.message.includes('Bearer'), false);
    return true;
  });
}

function jwtWithRole(role, overrides = {}) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ role, iss: 'supabase', exp: 4_102_444_800, ...overrides }),
  ).toString('base64url');
  return `${header}.${payload}.${'s'.repeat(43)}`;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
