import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertAnonymousBusinessAccessDenied,
  assertSignupDisabled,
  readSupabaseBoundaryConfiguration,
  verifySupabaseBoundary,
} from './verify-supabase-boundary.mjs';

const ORIGIN = 'https://abcdefghijklmnopqrst.supabase.co';
const ANON_KEY = 'public-anon-key-that-is-long-enough';

test('accepts only an exact Supabase project origin', () => {
  assert.deepEqual(
    readSupabaseBoundaryConfiguration({
      NEXT_PUBLIC_SUPABASE_URL: ORIGIN,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: ANON_KEY,
    }),
    { origin: ORIGIN, anonKey: ANON_KEY },
  );
  assert.throws(
    () =>
      readSupabaseBoundaryConfiguration({
        SUPABASE_URL: 'https://attacker.invalid',
        SUPABASE_ANON_KEY: ANON_KEY,
      }),
    /exact https/,
  );
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

test('verifies Auth settings and PostgREST denial without exposing the anon key', async () => {
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

  await expectResult(verifySupabaseBoundary({ origin: ORIGIN, anonKey: ANON_KEY }, fetcher), {
    signupDisabled: true,
    anonymousBusinessAccessStatus: 401,
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].init.headers.apikey, ANON_KEY);
});

async function expectResult(operation, expected) {
  assert.deepEqual(await operation, expected);
}
