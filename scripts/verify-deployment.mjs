import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isCurrentBffReadiness, optionalGitSha } from './bff-readiness.mjs';

const DEFAULT_TIMEOUT_MS = 5_000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 30_000;
const CORS_PROBE_ORIGIN = 'https://cors-probe.invalid';

export function readDeploymentConfiguration(environment = process.env) {
  const allowInsecure = environment.ALLOW_INSECURE_DEPLOY_VERIFY === 'true';
  const bffUrl = requiredOrigin(environment.BFF_URL, 'BFF_URL', allowInsecure);
  const webUrl = requiredOrigin(environment.WEB_URL, 'WEB_URL', allowInsecure);
  const corsOrigin = environment.DEPLOY_VERIFY_CORS_ORIGIN
    ? requiredOrigin(
        environment.DEPLOY_VERIFY_CORS_ORIGIN,
        'DEPLOY_VERIFY_CORS_ORIGIN',
        allowInsecure,
      )
    : webUrl;

  return {
    bffUrl,
    webUrl,
    corsOrigin,
    operationsToken: requiredSecret(environment.OPERATIONS_TOKEN, 'OPERATIONS_TOKEN'),
    expectedRevision: optionalGitSha(environment.SUPPLIER_GIT_SHA),
    timeoutMs: parseTimeout(environment.DEPLOY_VERIFY_TIMEOUT_MS),
  };
}

export async function verifyDeployment(configuration, { fetcher = fetch, logger = console } = {}) {
  const { bffUrl, webUrl, corsOrigin, operationsToken, expectedRevision, timeoutMs } =
    configuration;
  const checks = [
    () =>
      checkJson(
        fetcher,
        timeoutMs,
        'BFF liveness',
        `${bffUrl}/api/health/live`,
        200,
        (body) => body.status === 'ok',
      ),
    () =>
      checkJson(fetcher, timeoutMs, 'BFF readiness', `${bffUrl}/api/health/ready`, 200, (body) =>
        isCurrentBffReadiness(body, expectedRevision),
      ),
    () => checkStatus(fetcher, timeoutMs, 'Swagger production gate', `${bffUrl}/docs`, 404),
    () =>
      checkStatus(fetcher, timeoutMs, 'OpenAPI JSON production gate', `${bffUrl}/docs-json`, 404),
    () =>
      checkStatus(fetcher, timeoutMs, 'OpenAPI YAML production gate', `${bffUrl}/docs-yaml`, 404),
    () =>
      checkStatus(
        fetcher,
        timeoutMs,
        'Swagger asset production gate',
        `${bffUrl}/docs/swagger-ui.css`,
        404,
      ),
    () =>
      checkStatus(
        fetcher,
        timeoutMs,
        'Protected API without token',
        `${bffUrl}/api/me/entitlements`,
        401,
      ),
    () =>
      checkStatus(
        fetcher,
        timeoutMs,
        'Protected API with invalid token',
        `${bffUrl}/api/me/entitlements`,
        401,
        { authorization: 'Bearer invalid-token' },
      ),
    () =>
      checkStatus(fetcher, timeoutMs, 'Forged demo headers', `${bffUrl}/api/me/entitlements`, 401, {
        'x-user-id': '1',
        'x-user-plan': 'flagship',
      }),
    () =>
      checkStatus(
        fetcher,
        timeoutMs,
        'OAuth callback remains public',
        `${bffUrl}/api/shops/oauth/douyin/callback`,
        400,
      ),
    () =>
      checkStatus(
        fetcher,
        timeoutMs,
        'Operations API without token',
        `${bffUrl}/api/operations/status`,
        401,
      ),
    () =>
      checkJson(
        fetcher,
        timeoutMs,
        'Operations status with token',
        `${bffUrl}/api/operations/status`,
        200,
        (body) =>
          body.service === 'supplier-bff' &&
          body.queue &&
          Array.isArray(body.activeAlerts) &&
          Number.isInteger(body.auditFailures5m) &&
          body.auditFailures5m >= 1,
        { authorization: `Bearer ${operationsToken}` },
      ),
    () =>
      checkJson(
        fetcher,
        timeoutMs,
        'Operations check with token',
        `${bffUrl}/api/operations/check`,
        200,
        (body) => body.service === 'supplier-bff' && body.queue?.available === true,
        { authorization: `Bearer ${operationsToken}` },
        'POST',
      ),
    () =>
      checkText(
        fetcher,
        timeoutMs,
        'Prometheus metrics with token',
        `${bffUrl}/api/operations/metrics`,
        200,
        'supplier_http_requests_total',
        { authorization: `Bearer ${operationsToken}` },
      ),
    () =>
      checkCorsPreflight(
        fetcher,
        timeoutMs,
        `${bffUrl}/api/publish-drafts/current`,
        corsOrigin,
        'PUT',
      ),
    () =>
      checkCorsPreflight(
        fetcher,
        timeoutMs,
        `${bffUrl}/api/publish-drafts/current`,
        corsOrigin,
        'DELETE',
      ),
    () => checkUntrustedOriginPreflight(fetcher, timeoutMs, `${bffUrl}/api/publish-drafts/current`),
    () => checkStatus(fetcher, timeoutMs, 'Web root', `${webUrl}/`, 200),
  ];

  let passed = 0;
  let failed = 0;
  for (const run of checks) {
    try {
      logger.log(`✓ ${await run()}`);
      passed += 1;
    } catch (error) {
      logger.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
      failed += 1;
    }
  }
  return { passed, failed };
}

export async function checkCorsPreflight(fetcher, timeoutMs, url, origin, requestedMethod) {
  const name = `Publish draft ${requestedMethod} CORS preflight`;
  const response = await request(fetcher, timeoutMs, name, url, {
    method: 'OPTIONS',
    headers: {
      origin,
      'access-control-request-method': requestedMethod,
      'access-control-request-headers': 'authorization,content-type',
    },
  });

  try {
    await assertStatus(response, 204, name);
    if (response.headers.get('access-control-allow-origin') !== origin) {
      throw new Error(`${name}: exact allowed origin was not returned.`);
    }
    if (response.headers.get('access-control-allow-credentials') !== 'true') {
      throw new Error(`${name}: credentialed requests are not allowed.`);
    }
    assertHeaderIncludes(response, 'access-control-allow-methods', [requestedMethod], name);
    assertHeaderIncludes(
      response,
      'access-control-allow-headers',
      ['AUTHORIZATION', 'CONTENT-TYPE'],
      name,
    );
    return `${name} (204)`;
  } finally {
    await releaseResponseBody(response);
  }
}

export async function checkUntrustedOriginPreflight(fetcher, timeoutMs, url) {
  const name = 'Untrusted origin CORS preflight';
  const response = await request(fetcher, timeoutMs, name, url, {
    method: 'OPTIONS',
    headers: {
      origin: CORS_PROBE_ORIGIN,
      'access-control-request-method': 'PUT',
      'access-control-request-headers': 'authorization,content-type',
    },
  });

  try {
    if (response.headers.get('access-control-allow-origin') === CORS_PROBE_ORIGIN) {
      throw new Error(`${name}: the untrusted origin was reflected.`);
    }
    if (response.headers.get('access-control-allow-credentials')?.toLowerCase() === 'true') {
      throw new Error(`${name}: credentialed requests were allowed.`);
    }
    return `${name} (${response.status})`;
  } finally {
    await releaseResponseBody(response);
  }
}

async function checkStatus(fetcher, timeoutMs, name, url, expectedStatus, headers, method = 'GET') {
  const response = await request(fetcher, timeoutMs, name, url, { method, headers });
  try {
    await assertStatus(response, expectedStatus, name);
    return `${name} (${response.status})`;
  } finally {
    await releaseResponseBody(response);
  }
}

async function checkJson(
  fetcher,
  timeoutMs,
  name,
  url,
  expectedStatus,
  validateBody,
  headers,
  method = 'GET',
) {
  const response = await request(fetcher, timeoutMs, name, url, { method, headers });
  await assertStatus(response, expectedStatus, name);
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(`${name}: response is not JSON.`);
  }
  if (!validateBody(body)) throw new Error(`${name}: response body failed validation.`);
  return `${name} (${response.status})`;
}

async function checkText(fetcher, timeoutMs, name, url, expectedStatus, expectedText, headers) {
  const response = await request(fetcher, timeoutMs, name, url, { headers });
  await assertStatus(response, expectedStatus, name);
  const body = await response.text();
  if (!body.includes(expectedText)) {
    throw new Error(`${name}: response did not contain ${expectedText}.`);
  }
  return `${name} (${response.status})`;
}

async function request(fetcher, timeoutMs, name, url, init) {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    return await fetcher(url, { ...init, redirect: 'error', signal });
  } catch {
    if (signal.aborted) throw new Error(`${name}: timed out after ${timeoutMs}ms.`);
    throw new Error(`${name}: request failed.`);
  }
}

async function assertStatus(response, expectedStatus, name) {
  if (response.status !== expectedStatus) {
    await releaseResponseBody(response);
    throw new Error(`${name}: expected ${expectedStatus}, got ${response.status}.`);
  }
}

async function releaseResponseBody(response) {
  if (!response.body || response.bodyUsed) return;
  try {
    await response.body.cancel();
  } catch {
    // Body release must not hide the authoritative verification result.
  }
}

function assertHeaderIncludes(response, headerName, expectedValues, name) {
  const values = new Set(
    (response.headers.get(headerName) ?? '')
      .split(',')
      .map((value) => value.trim().toUpperCase())
      .filter(Boolean),
  );
  for (const expected of expectedValues) {
    if (!values.has(expected)) {
      throw new Error(`${name}: ${headerName} did not include ${expected}.`);
    }
  }
}

function requiredOrigin(rawValue, name, allowInsecure) {
  const value = rawValue?.trim();
  if (!value) throw new Error(`${name} is required`);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
  if (url.origin !== value || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`${name} must be an origin without path, query, or hash`);
  }
  if (!allowInsecure && url.protocol !== 'https:') {
    throw new Error(
      `${name} must use HTTPS; set ALLOW_INSECURE_DEPLOY_VERIFY=true only for local smoke tests`,
    );
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`${name} must use HTTP or HTTPS`);
  }
  return value;
}

function parseTimeout(value) {
  if (!value) return DEFAULT_TIMEOUT_MS;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < MIN_TIMEOUT_MS || parsed > MAX_TIMEOUT_MS) {
    throw new Error(
      `DEPLOY_VERIFY_TIMEOUT_MS must be an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`,
    );
  }
  return parsed;
}

function requiredSecret(rawValue, name) {
  const value = rawValue?.trim();
  if (!value || value.length < 32) throw new Error(`${name} must contain at least 32 characters`);
  return value;
}

async function main() {
  const result = await verifyDeployment(readDeploymentConfiguration());
  if (result.failed > 0) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Deployment verification failed.');
    process.exitCode = 1;
  });
}
