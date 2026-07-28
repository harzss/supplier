import assert from 'node:assert/strict';
import test from 'node:test';
import { handleRequest } from './worker.mjs';

const BFF_ORIGIN = 'https://example-tunnel.trycloudflare.com';
const ALERT_SECRET = 'staging-alert-secret-that-is-longer-than-thirty-two';

test('returns 503 when the BFF origin is missing', async () => {
  const response = await handleRequest(new Request('https://gateway.example/api/health/live'), {});
  assert.equal(response.status, 503);
});

test('proxies method, path, query, headers, and body to the configured BFF', async (context) => {
  let outbound;
  context.mock.method(globalThis, 'fetch', async (request) => {
    outbound = request;
    return new Response('proxied', { status: 202 });
  });

  const response = await handleRequest(
    new Request('https://gateway.example/api/products/recommendations?page=2', {
      method: 'POST',
      headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
      body: JSON.stringify({ category: 'home' }),
    }),
    { BFF_ORIGIN },
  );

  assert.equal(response.status, 202);
  assert.equal(outbound.url, `${BFF_ORIGIN}/api/products/recommendations?page=2`);
  assert.equal(outbound.method, 'POST');
  assert.equal(outbound.headers.get('authorization'), 'Bearer test-token');
  assert.equal(outbound.headers.get('x-forwarded-host'), 'gateway.example');
  assert.equal(outbound.headers.get('x-supplier-staging-gateway'), 'cloudflare');
  assert.deepEqual(await outbound.json(), { category: 'home' });
});

test('rejects unsigned operational alerts', async () => {
  const response = await handleRequest(
    new Request('https://gateway.example/_supplier/alerts', {
      method: 'POST',
      body: '{}',
    }),
    { ALERT_WEBHOOK_SECRET: ALERT_SECRET },
  );
  assert.equal(response.status, 400);
});

test('rejects a validly shaped alert with the wrong signature', async () => {
  const timestamp = Date.now().toString();
  const deliveryId = 'a'.repeat(64);
  const response = await handleRequest(
    new Request('https://gateway.example/_supplier/alerts', {
      method: 'POST',
      headers: {
        'x-supplier-alert-timestamp': timestamp,
        'x-supplier-alert-delivery-id': deliveryId,
        'x-supplier-alert-signature': `sha256=${'b'.repeat(64)}`,
      },
      body: JSON.stringify(alertPayload(deliveryId)),
    }),
    { ALERT_WEBHOOK_SECRET: ALERT_SECRET },
  );
  assert.equal(response.status, 401);
});

test('rejects stale alerts before accepting a signature', async () => {
  const timestamp = (Date.now() - 301_000).toString();
  const deliveryId = 'c'.repeat(64);
  const response = await handleRequest(
    new Request('https://gateway.example/_supplier/alerts', {
      method: 'POST',
      headers: {
        'x-supplier-alert-timestamp': timestamp,
        'x-supplier-alert-delivery-id': deliveryId,
        'x-supplier-alert-signature': `sha256=${'d'.repeat(64)}`,
      },
      body: JSON.stringify(alertPayload(deliveryId)),
    }),
    { ALERT_WEBHOOK_SECRET: ALERT_SECRET },
  );
  assert.equal(response.status, 401);
});

test('accepts a current alert with a matching HMAC signature', async (context) => {
  context.mock.method(console, 'log', () => undefined);
  const deliveryId = 'e'.repeat(64);
  const request = await signedAlertRequest(alertPayload(deliveryId), ALERT_SECRET);
  const response = await handleRequest(request, { ALERT_WEBHOOK_SECRET: ALERT_SECRET });
  assert.equal(response.status, 204);
});

test('rejects a signed payload whose delivery id differs from its header', async () => {
  const request = await signedAlertRequest(alertPayload('f'.repeat(64)), ALERT_SECRET, '1'.repeat(64));
  const response = await handleRequest(request, { ALERT_WEBHOOK_SECRET: ALERT_SECRET });
  assert.equal(response.status, 400);
});

function alertPayload(deliveryId) {
  return {
    version: 1,
    deliveryId,
    state: 'firing',
    service: 'supplier-bff',
    occurredAt: new Date().toISOString(),
    alert: {
      key: 'database.unavailable',
      type: 'dependency',
      severity: 'critical',
      summary: 'Database is unavailable',
    },
  };
}

async function signedAlertRequest(payload, secret, headerDeliveryId = payload.deliveryId) {
  const timestamp = Date.now().toString();
  const body = JSON.stringify(payload);
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const digest = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${timestamp}.${body}`),
  );
  const signature = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return new Request('https://gateway.example/_supplier/alerts', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-supplier-alert-timestamp': timestamp,
      'x-supplier-alert-delivery-id': headerDeliveryId,
      'x-supplier-alert-signature': `sha256=${signature}`,
    },
    body,
  });
}
