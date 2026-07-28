const ALERT_PATH = '/_supplier/alerts';
const MAX_ALERT_BYTES = 256 * 1024;
const DEFAULT_MAX_CLOCK_SKEW_SECONDS = 300;
const encoder = new TextEncoder();

export default {
  fetch: handleRequest,
};

export async function handleRequest(request, env) {
  const url = new URL(request.url);
  if (url.pathname === ALERT_PATH) return receiveAlert(request, env);
  return proxyToBff(request, env, url);
}

async function proxyToBff(request, env, incomingUrl) {
  let origin;
  try {
    origin = parseBffOrigin(env.BFF_ORIGIN);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'staging_gateway_configuration_error',
        error: error instanceof Error ? error.message : 'invalid BFF_ORIGIN',
      }),
    );
    return textResponse('staging gateway is not configured', 503);
  }

  const target = new URL(incomingUrl.pathname + incomingUrl.search, origin);
  const headers = new Headers(request.headers);
  headers.set('x-forwarded-host', incomingUrl.host);
  headers.set('x-forwarded-proto', 'https');
  headers.set('x-supplier-staging-gateway', 'cloudflare');

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  const body = hasBody ? await request.arrayBuffer() : undefined;
  const outbound = new Request(target, {
    method: request.method,
    headers,
    body,
    redirect: 'manual',
  });

  try {
    return await fetch(outbound);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'staging_gateway_upstream_error',
        method: request.method,
        path: incomingUrl.pathname,
        error: error instanceof Error ? error.name : 'unknown',
      }),
    );
    return textResponse('staging BFF is unavailable', 502);
  }
}

async function receiveAlert(request, env) {
  if (request.method !== 'POST') {
    return new Response('method not allowed', {
      status: 405,
      headers: { allow: 'POST', 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  const secret = typeof env.ALERT_WEBHOOK_SECRET === 'string' ? env.ALERT_WEBHOOK_SECRET : '';
  if (secret.length < 32) return textResponse('alert receiver is not configured', 503);

  const timestamp = request.headers.get('x-supplier-alert-timestamp') ?? '';
  const deliveryId = request.headers.get('x-supplier-alert-delivery-id') ?? '';
  const signature = request.headers.get('x-supplier-alert-signature') ?? '';
  if (!/^\d{13}$/.test(timestamp) || !/^[a-f0-9]{64}$/.test(deliveryId)) {
    return textResponse('invalid alert headers', 400);
  }

  const maxClockSkewSeconds = boundedInteger(
    env.ALERT_MAX_CLOCK_SKEW_SECONDS,
    DEFAULT_MAX_CLOCK_SKEW_SECONDS,
    30,
    3_600,
  );
  if (Math.abs(Date.now() - Number(timestamp)) > maxClockSkewSeconds * 1_000) {
    return textResponse('stale alert', 401);
  }

  const declaredLength = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > MAX_ALERT_BYTES) {
    return textResponse('alert payload too large', 413);
  }

  const payloadText = await request.text();
  if (encoder.encode(payloadText).byteLength > MAX_ALERT_BYTES) {
    return textResponse('alert payload too large', 413);
  }

  const expectedSignature = `sha256=${await hmacSha256(secret, `${timestamp}.${payloadText}`)}`;
  if (!constantTimeEqual(signature, expectedSignature)) {
    return textResponse('invalid alert signature', 401);
  }

  let payload;
  try {
    payload = JSON.parse(payloadText);
  } catch {
    return textResponse('invalid alert payload', 400);
  }
  if (
    payload?.version !== 1 ||
    payload?.deliveryId !== deliveryId ||
    payload?.service !== 'supplier-bff' ||
    !['firing', 'resolved'].includes(payload?.state)
  ) {
    return textResponse('invalid alert payload', 400);
  }

  console.log(
    JSON.stringify({
      event: 'supplier_operational_alert',
      deliveryId,
      state: payload.state,
      occurredAt: payload.occurredAt,
      key: payload.alert?.key,
      type: payload.alert?.type,
      severity: payload.alert?.severity,
      summary: payload.alert?.summary,
    }),
  );
  return new Response(null, { status: 204 });
}

function parseBffOrigin(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('BFF_ORIGIN is missing');
  const url = new URL(value.trim());
  if (url.protocol !== 'https:') throw new Error('BFF_ORIGIN must use https');
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('BFF_ORIGIN must be an HTTPS origin without credentials, path, query, or hash');
  }
  return url;
}

async function hmacSha256(secret, value) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const result = await crypto.subtle.sign('HMAC', key, encoder.encode(value));
  return [...new Uint8Array(result)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function constantTimeEqual(left, right) {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  let mismatch = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    mismatch |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return mismatch === 0;
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) return fallback;
  return parsed;
}

function textResponse(message, status) {
  return new Response(message, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}
