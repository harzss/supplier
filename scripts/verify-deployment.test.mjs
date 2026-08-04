import assert from 'node:assert/strict';
import test from 'node:test';

import {
  checkCorsPreflight,
  checkUntrustedOriginPreflight,
  readDeploymentConfiguration,
  verifyDeployment,
} from './verify-deployment.mjs';

const BFF_ORIGIN = 'https://api.supplier.example.com';
const WEB_ORIGIN = 'https://supplier.example.com';
const OPERATIONS_TOKEN = 'operations-token-that-is-long-enough';

test('accepts exact HTTPS deployment origins and defaults CORS to the Web origin', () => {
  assert.deepEqual(
    readDeploymentConfiguration({
      BFF_URL: BFF_ORIGIN,
      WEB_URL: WEB_ORIGIN,
      OPERATIONS_TOKEN,
      DEPLOY_VERIFY_TIMEOUT_MS: '1234',
    }),
    configuration({ timeoutMs: 1234 }),
  );

  assert.deepEqual(
    readDeploymentConfiguration({
      ALLOW_INSECURE_DEPLOY_VERIFY: 'true',
      BFF_URL: 'http://127.0.0.1:3001',
      WEB_URL: 'http://127.0.0.1:3000',
      DEPLOY_VERIFY_CORS_ORIGIN: WEB_ORIGIN,
      OPERATIONS_TOKEN,
    }),
    configuration({
      bffUrl: 'http://127.0.0.1:3001',
      webUrl: 'http://127.0.0.1:3000',
      corsOrigin: WEB_ORIGIN,
    }),
  );

  for (const [name, value] of [
    ['BFF_URL', `${BFF_ORIGIN}/api`],
    ['WEB_URL', 'http://supplier.example.com'],
    ['DEPLOY_VERIFY_CORS_ORIGIN', 'https://supplier.example.com/path'],
    ['OPERATIONS_TOKEN', 'short'],
    ['DEPLOY_VERIFY_TIMEOUT_MS', '99'],
    ['DEPLOY_VERIFY_TIMEOUT_MS', '30001'],
  ]) {
    assert.throws(() =>
      readDeploymentConfiguration({
        BFF_URL: BFF_ORIGIN,
        WEB_URL: WEB_ORIGIN,
        OPERATIONS_TOKEN,
        [name]: value,
      }),
    );
  }
});

test('runs a non-mutating publish-draft CORS preflight as part of deployment verification', async () => {
  const requests = [];
  const responses = successfulResponses();
  const servedResponses = [];
  const logs = [];
  const errors = [];
  const result = await verifyDeployment(configuration(), {
    fetcher: async (url, init) => {
      requests.push({ url, init });
      const response = responses.shift();
      servedResponses.push(response);
      return response;
    },
    logger: {
      log: (message) => logs.push(message),
      error: (message) => errors.push(message),
    },
  });

  assert.deepEqual(result, { passed: 18, failed: 0 });
  assert.equal(responses.length, 0);
  assert.equal(errors.length, 0);
  assert.equal(logs.length, 18);
  const putPreflight = requests[14];
  assert.equal(putPreflight.url, `${BFF_ORIGIN}/api/publish-drafts/current`);
  assert.equal(putPreflight.init.method, 'OPTIONS');
  assert.deepEqual(putPreflight.init.headers, {
    origin: WEB_ORIGIN,
    'access-control-request-method': 'PUT',
    'access-control-request-headers': 'authorization,content-type',
  });
  const deletePreflight = requests[15];
  assert.equal(deletePreflight.url, `${BFF_ORIGIN}/api/publish-drafts/current`);
  assert.equal(deletePreflight.init.method, 'OPTIONS');
  assert.deepEqual(deletePreflight.init.headers, {
    origin: WEB_ORIGIN,
    'access-control-request-method': 'DELETE',
    'access-control-request-headers': 'authorization,content-type',
  });
  const untrustedPreflight = requests[16];
  assert.equal(untrustedPreflight.url, `${BFF_ORIGIN}/api/publish-drafts/current`);
  assert.equal(untrustedPreflight.init.method, 'OPTIONS');
  assert.deepEqual(untrustedPreflight.init.headers, {
    origin: 'https://cors-probe.invalid',
    'access-control-request-method': 'PUT',
    'access-control-request-headers': 'authorization,content-type',
  });
  assert.equal(putPreflight.init.redirect, 'error');
  assert.equal(deletePreflight.init.redirect, 'error');
  assert.equal(untrustedPreflight.init.redirect, 'error');
  assert.ok(requests.every(({ init }) => init.signal instanceof AbortSignal));
  assert.equal(servedResponses[16].bodyUsed, true);
  assert.equal(servedResponses[17].bodyUsed, true);
});

test('checks PUT and DELETE preflights against their corresponding allowed method', async () => {
  await checkCorsPreflight(
    async () => corsResponse({ 'access-control-allow-methods': 'PUT' }),
    5_000,
    `${BFF_ORIGIN}/api/publish-drafts/current`,
    WEB_ORIGIN,
    'PUT',
  );
  await checkCorsPreflight(
    async () => corsResponse({ 'access-control-allow-methods': 'DELETE' }),
    5_000,
    `${BFF_ORIGIN}/api/publish-drafts/current`,
    WEB_ORIGIN,
    'DELETE',
  );

  await assert.rejects(
    checkCorsPreflight(
      async () => corsResponse({ 'access-control-allow-methods': 'PUT' }),
      5_000,
      `${BFF_ORIGIN}/api/publish-drafts/current`,
      WEB_ORIGIN,
      'DELETE',
    ),
    /access-control-allow-methods did not include DELETE/,
  );
});

test('rejects reflect-any-origin and credentialed untrusted-origin responses', async () => {
  await assert.rejects(
    checkUntrustedOriginPreflight(
      async () =>
        new Response('reflected', {
          status: 200,
          headers: { 'access-control-allow-origin': 'https://cors-probe.invalid' },
        }),
      5_000,
      `${BFF_ORIGIN}/api/publish-drafts/current`,
    ),
    /untrusted origin was reflected/,
  );
  await assert.rejects(
    checkUntrustedOriginPreflight(
      async () =>
        new Response('credentialed', {
          status: 403,
          headers: { 'access-control-allow-credentials': 'true' },
        }),
      5_000,
      `${BFF_ORIGIN}/api/publish-drafts/current`,
    ),
    /credentialed requests were allowed/,
  );
});

test('releases every error response body without logging it or the operations token', async () => {
  const errors = [];
  const leaked = `${OPERATIONS_TOKEN} sensitive upstream details`;
  const responses = [];
  const result = await verifyDeployment(configuration(), {
    fetcher: async () => {
      const response = new Response(leaked, {
        status: 503,
        headers: {
          'access-control-allow-origin': 'https://cors-probe.invalid',
          'access-control-allow-credentials': 'true',
        },
      });
      responses.push(response);
      return response;
    },
    logger: { log: () => {}, error: (message) => errors.push(message) },
  });

  assert.deepEqual(result, { passed: 0, failed: 18 });
  assert.equal(errors.length, 18);
  assert.equal(responses.length, 18);
  assert.ok(responses.every((response) => response.bodyUsed));
  assert.equal(
    errors.some((message) => message.includes(OPERATIONS_TOKEN)),
    false,
  );
  assert.equal(
    errors.some((message) => message.includes('sensitive upstream details')),
    false,
  );
});

function configuration(overrides = {}) {
  return {
    bffUrl: BFF_ORIGIN,
    webUrl: WEB_ORIGIN,
    corsOrigin: WEB_ORIGIN,
    operationsToken: OPERATIONS_TOKEN,
    timeoutMs: 5_000,
    ...overrides,
  };
}

function successfulResponses() {
  return [
    jsonResponse({ status: 'ok' }),
    jsonResponse({
      status: 'ready',
      checks: { database: { status: 'up' }, redis: { status: 'up' } },
    }),
    ...Array.from({ length: 4 }, () => new Response(null, { status: 404 })),
    ...Array.from({ length: 3 }, () => new Response(null, { status: 401 })),
    new Response(null, { status: 400 }),
    new Response(null, { status: 401 }),
    jsonResponse({
      service: 'supplier-bff',
      queue: { available: true },
      activeAlerts: [],
      auditFailures5m: 1,
    }),
    jsonResponse({ service: 'supplier-bff', queue: { available: true } }),
    new Response('supplier_http_requests_total 1', { status: 200 }),
    corsResponse(),
    corsResponse(),
    new Response('denied', { status: 403 }),
    new Response('<!doctype html>', { status: 200 }),
  ];
}

function corsResponse(overrides = {}) {
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': WEB_ORIGIN,
      'access-control-allow-credentials': 'true',
      'access-control-allow-methods': 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS',
      'access-control-allow-headers': 'authorization, content-type',
      ...overrides,
    },
  });
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
