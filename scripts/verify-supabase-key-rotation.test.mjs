import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  readKeyRotationConfiguration,
  readKeyRotationEnvironmentFile,
  verifySupabaseKeyRotation,
} from './verify-supabase-key-rotation.mjs';

const ORIGIN = 'https://abcdefghijklmnopqrst.supabase.co';
const ADMIN_KEY = 'sb_secret_test_key_that_is_long_enough';
const BUCKET = 'supplier-assets';
const PROBE_ID = '12345678-1234-1234-1234-123456789abc';
const PROBE_CONTENT = 'supplier-supabase-key-rotation-smoke-v1';

test('reads only a private staging environment file and requires a modern secret key', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'supplier-key-rotation-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const privateFile = join(directory, 'private.env');
  const publicFile = join(directory, 'public.env');
  const contents = [
    `SUPABASE_URL=${ORIGIN}`,
    `SUPABASE_SERVICE_ROLE_KEY=${ADMIN_KEY}`,
    `SUPABASE_STORAGE_BUCKET=${BUCKET}`,
  ].join('\n');
  await writeFile(privateFile, contents, { mode: 0o600 });
  await writeFile(publicFile, contents, { mode: 0o644 });
  await chmod(privateFile, 0o600);
  await chmod(publicFile, 0o644);

  assert.deepEqual(
    readKeyRotationConfiguration(await readKeyRotationEnvironmentFile(privateFile)),
    {
      supabaseOrigin: ORIGIN,
      adminKey: ADMIN_KEY,
      bucket: BUCKET,
      timeoutMs: 10_000,
    },
  );
  await assert.rejects(
    readKeyRotationEnvironmentFile(publicFile),
    /owner-only regular file with mode 0600/,
  );
  await assert.rejects(
    readKeyRotationEnvironmentFile(join(directory, 'missing.env')),
    /missing or unreadable/,
  );

  assert.throws(
    () =>
      readKeyRotationConfiguration({
        SUPABASE_URL: ORIGIN,
        SUPABASE_SERVICE_ROLE_KEY: jwtWithRole('service_role'),
        SUPABASE_STORAGE_BUCKET: BUCKET,
      }),
    /must be a new secret key/,
  );
});

test('verifies admin, upload, public read, and delete without using the secret as bearer', async () => {
  const requests = [];
  const responses = [
    new Response(null, { status: 200 }),
    new Response(null, { status: 200 }),
    new Response(PROBE_CONTENT, { status: 200 }),
    new Response(null, { status: 200 }),
  ];
  const fetcher = async (url, init) => {
    requests.push({ url, init });
    return responses.shift();
  };

  assert.deepEqual(await verifySupabaseKeyRotation(configuration(), fetcher, () => PROBE_ID), {
    adminStatus: 200,
    uploadStatus: 200,
    publicReadStatus: 200,
    deleteStatus: 200,
  });

  assert.equal(requests.length, 4);
  assert.equal(requests[0].url, `${ORIGIN}/auth/v1/admin/users?page=1&per_page=1`);
  assert.equal(requests[1].init.method, 'POST');
  assert.equal(requests[1].init.body, PROBE_CONTENT);
  assert.equal(requests[2].init.headers, undefined);
  assert.equal(requests[3].init.method, 'DELETE');
  for (const request of [requests[0], requests[1], requests[3]]) {
    assert.equal(request.init.headers.apikey, ADMIN_KEY);
    assert.equal(Object.hasOwn(request.init.headers, 'authorization'), false);
    assert.equal(request.init.redirect, 'error');
  }
  assert.ok(requests.every(({ init }) => init.signal instanceof AbortSignal));
});

test('cleans up once after a failed public read without retrying the failed step', async () => {
  const requests = [];
  const responses = [
    new Response(null, { status: 200 }),
    new Response(null, { status: 200 }),
    new Response(null, { status: 503 }),
    new Response(null, { status: 200 }),
  ];
  const fetcher = async (url, init) => {
    requests.push({ url, init });
    return responses.shift();
  };

  await assertSafeRejection(
    verifySupabaseKeyRotation(configuration(), fetcher, () => PROBE_ID),
    /Public storage read probe: expected HTTP 200, got 503/,
  );
  assert.equal(requests.length, 4);
  assert.equal(requests[3].init.method, 'DELETE');
});

test('reports when cleanup cannot be proven without exposing the key or response body', async () => {
  const requests = [];
  const responses = [
    new Response(null, { status: 200 }),
    new Response(null, { status: 200 }),
    new Response(`${ADMIN_KEY} leaked`, { status: 503 }),
    new Response(`${ADMIN_KEY} leaked`, { status: 503 }),
  ];
  const fetcher = async (url, init) => {
    requests.push({ url, init });
    return responses.shift();
  };

  await assertSafeRejection(
    verifySupabaseKeyRotation(configuration(), fetcher, () => PROBE_ID),
    /Probe cleanup could not be proven/,
  );
  assert.equal(requests.length, 4);
});

test('does not issue a storage cleanup when upload was not accepted', async () => {
  const requests = [];
  const responses = [new Response(null, { status: 200 }), new Response(null, { status: 403 })];
  const fetcher = async (url, init) => {
    requests.push({ url, init });
    return responses.shift();
  };

  await assertSafeRejection(
    verifySupabaseKeyRotation(configuration(), fetcher, () => PROBE_ID),
    /Storage upload probe failed \(HTTP 403\)/,
  );
  assert.equal(requests.length, 2);
});

test('cleans up when the upload response is lost and the remote outcome is unknown', async () => {
  const requests = [];
  const fetcher = async (url, init) => {
    requests.push({ url, init });
    if (requests.length === 1) return new Response(null, { status: 200 });
    if (requests.length === 2) throw new Error('connection reset');
    return new Response(null, { status: 404 });
  };

  await assertSafeRejection(
    verifySupabaseKeyRotation(configuration(), fetcher, () => PROBE_ID),
    /Storage upload probe request failed/,
  );
  assert.equal(requests.length, 3);
  assert.equal(requests[2].init.method, 'DELETE');
});

test('cleans up after a server error because the upload outcome may be unknown', async () => {
  const requests = [];
  const responses = [
    new Response(null, { status: 200 }),
    new Response(null, { status: 503 }),
    new Response(null, { status: 404 }),
  ];
  const fetcher = async (url, init) => {
    requests.push({ url, init });
    return responses.shift();
  };

  await assertSafeRejection(
    verifySupabaseKeyRotation(configuration(), fetcher, () => PROBE_ID),
    /Storage upload probe failed \(HTTP 503\)/,
  );
  assert.equal(requests.length, 3);
  assert.equal(requests[2].init.method, 'DELETE');
});

function configuration(overrides = {}) {
  return {
    supabaseOrigin: ORIGIN,
    adminKey: ADMIN_KEY,
    bucket: BUCKET,
    timeoutMs: 5000,
    ...overrides,
  };
}

async function assertSafeRejection(operation, expected) {
  await assert.rejects(operation, (error) => {
    assert.match(error.message, expected);
    assert.equal(error.message.includes(ADMIN_KEY), false);
    assert.equal(error.message.includes(PROBE_ID), false);
    assert.equal(error.message.includes('Bearer'), false);
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
