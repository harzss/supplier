import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  assertAnonymousBusinessAccessDenied,
  assertSignupDisabled,
  readSupabaseBoundaryConfiguration,
  readSupabaseBoundaryEnvironmentFile,
  verifySupabaseBoundary,
} from './verify-supabase-boundary.mjs';

const ORIGIN = 'https://abcdefghijklmnopqrst.supabase.co';
const PUBLISHABLE_KEY = 'sb_publishable_test_key_that_is_long_enough';
const LEGACY_ANON_KEY = jwtWithRole('anon');

test('reads only a private explicit boundary environment file', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'supplier-boundary-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const privateFile = join(directory, 'private.env');
  const publicFile = join(directory, 'public.env');
  const contents = [
    `NEXT_PUBLIC_SUPABASE_URL=${ORIGIN}`,
    `NEXT_PUBLIC_SUPABASE_ANON_KEY=${PUBLISHABLE_KEY}`,
  ].join('\n');
  await writeFile(privateFile, contents, { mode: 0o600 });
  await writeFile(publicFile, contents, { mode: 0o644 });
  await chmod(privateFile, 0o600);
  await chmod(publicFile, 0o644);

  assert.deepEqual(
    readSupabaseBoundaryConfiguration(await readSupabaseBoundaryEnvironmentFile(privateFile)),
    { origin: ORIGIN, anonKey: PUBLISHABLE_KEY },
  );
  await assert.rejects(
    readSupabaseBoundaryEnvironmentFile(publicFile),
    /owner-only regular file with mode 0600/,
  );
  await assert.rejects(
    readSupabaseBoundaryEnvironmentFile(join(directory, 'missing.env')),
    /missing or unreadable/,
  );
});

test('accepts only an exact Supabase project origin', () => {
  assert.deepEqual(
    readSupabaseBoundaryConfiguration({
      NEXT_PUBLIC_SUPABASE_URL: ORIGIN,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: PUBLISHABLE_KEY,
    }),
    { origin: ORIGIN, anonKey: PUBLISHABLE_KEY },
  );
  assert.deepEqual(
    readSupabaseBoundaryConfiguration({
      NEXT_PUBLIC_SUPABASE_URL: ORIGIN,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: LEGACY_ANON_KEY,
    }),
    { origin: ORIGIN, anonKey: LEGACY_ANON_KEY },
  );
  assert.throws(
    () =>
      readSupabaseBoundaryConfiguration(
        {
          NEXT_PUBLIC_SUPABASE_URL: ORIGIN,
          NEXT_PUBLIC_SUPABASE_ANON_KEY: LEGACY_ANON_KEY,
        },
        { requirePublishableKey: true },
      ),
    /must be a publishable key/,
  );
  assert.throws(
    () =>
      readSupabaseBoundaryConfiguration({
        SUPABASE_URL: 'https://attacker.invalid',
        SUPABASE_ANON_KEY: PUBLISHABLE_KEY,
      }),
    /exact https/,
  );
  for (const invalidKey of [
    'sb_secret_test_key_that_is_long_enough',
    jwtWithRole('service_role'),
    jwtWithRole('anon', { exp: 1 }),
    'unknown-public-key-that-is-long-enough',
  ]) {
    assert.throws(() =>
      readSupabaseBoundaryConfiguration({
        NEXT_PUBLIC_SUPABASE_URL: ORIGIN,
        NEXT_PUBLIC_SUPABASE_ANON_KEY: invalidKey,
      }),
    );
  }
});

test('fails closed when public signup is not proven disabled', () => {
  assert.doesNotThrow(() => assertSignupDisabled({ disable_signup: true }));
  assert.throws(() => assertSignupDisabled({ disable_signup: false }), /public signup is enabled/);
  assert.throws(() => assertSignupDisabled({}), /could not be proven disabled/);
});

test('accepts only an authorization denial for anonymous business data', () => {
  assert.doesNotThrow(() => assertAnonymousBusinessAccessDenied(401));
  assert.doesNotThrow(() => assertAnonymousBusinessAccessDenied(403));
  assert.throws(() => assertAnonymousBusinessAccessDenied(200), /was not denied/);
  assert.throws(() => assertAnonymousBusinessAccessDenied(404), /was not denied/);
});

test('uses a publishable key only as apikey for both boundary requests', async () => {
  const requests = [];
  const responses = [
    new Response(JSON.stringify({ disable_signup: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
    new Response(JSON.stringify({ message: 'permission denied' }), { status: 401 }),
  ];
  const fetcher = async (url, init) => {
    requests.push({ url, init });
    return responses.shift();
  };

  await expectResult(
    verifySupabaseBoundary({ origin: ORIGIN, anonKey: PUBLISHABLE_KEY }, fetcher),
    {
      signupDisabled: true,
      anonymousBusinessAccessStatus: 401,
    },
  );
  assert.equal(requests.length, 2);
  for (const { init } of requests) {
    assert.equal(init.headers.apikey, PUBLISHABLE_KEY);
    assert.equal(Object.hasOwn(init.headers, 'authorization'), false);
    assert.equal(init.redirect, 'error');
  }
});

test('uses a legacy anon JWT as apikey and bearer for both boundary requests', async () => {
  const requests = [];
  const responses = [
    jsonResponse({ disable_signup: true }),
    jsonResponse({ message: 'permission denied' }, 403),
  ];
  const fetcher = async (url, init) => {
    requests.push({ url, init });
    return responses.shift();
  };

  await verifySupabaseBoundary({ origin: ORIGIN, anonKey: LEGACY_ANON_KEY }, fetcher);

  assert.equal(requests.length, 2);
  for (const { init } of requests) {
    assert.equal(init.headers.apikey, LEGACY_ANON_KEY);
    assert.equal(init.headers.authorization, `Bearer ${LEGACY_ANON_KEY}`);
    assert.equal(init.redirect, 'error');
  }
});

async function expectResult(operation, expected) {
  assert.deepEqual(await operation, expected);
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
