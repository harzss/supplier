const allowInsecure = process.env.ALLOW_INSECURE_DEPLOY_VERIFY === 'true';
const timeoutMs = parseTimeout(process.env.DEPLOY_VERIFY_TIMEOUT_MS);
const bffUrl = requiredOrigin('BFF_URL');
const webUrl = requiredOrigin('WEB_URL');
const operationsToken = requiredSecret('OPERATIONS_TOKEN');

const checks = [
  () => check('BFF liveness', `${bffUrl}/api/health/live`, 200, (body) => body.status === 'ok'),
  () =>
    check(
      'BFF readiness',
      `${bffUrl}/api/health/ready`,
      200,
      (body) =>
        body.status === 'ready' &&
        body.checks?.database?.status === 'up' &&
        body.checks?.redis?.status === 'up',
    ),
  () => check('Swagger production gate', `${bffUrl}/docs`, 404),
  () => check('OpenAPI JSON production gate', `${bffUrl}/docs-json`, 404),
  () => check('OpenAPI YAML production gate', `${bffUrl}/docs-yaml`, 404),
  () => check('Swagger asset production gate', `${bffUrl}/docs/swagger-ui.css`, 404),
  () => check('Protected API without token', `${bffUrl}/api/me/entitlements`, 401),
  () =>
    check('Protected API with invalid token', `${bffUrl}/api/me/entitlements`, 401, undefined, {
      authorization: 'Bearer invalid-token',
    }),
  () =>
    check('Forged demo headers', `${bffUrl}/api/me/entitlements`, 401, undefined, {
      'x-user-id': '1',
      'x-user-plan': 'flagship',
    }),
  () => check('OAuth callback remains public', `${bffUrl}/api/shops/oauth/douyin/callback`, 400),
  () => check('Operations API without token', `${bffUrl}/api/operations/status`, 401),
  () =>
    check(
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
    check(
      'Operations check with token',
      `${bffUrl}/api/operations/check`,
      200,
      (body) => body.service === 'supplier-bff' && body.queue?.available === true,
      { authorization: `Bearer ${operationsToken}` },
      'POST',
    ),
  () =>
    checkText(
      'Prometheus metrics with token',
      `${bffUrl}/api/operations/metrics`,
      200,
      'supplier_http_requests_total',
      { authorization: `Bearer ${operationsToken}` },
    ),
  () => check('Web root', `${webUrl}/`, 200),
];

let failed = false;
for (const run of checks) {
  try {
    console.log(`✓ ${await run()}`);
  } catch (error) {
    failed = true;
    console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
  }
}
if (failed) process.exitCode = 1;

async function check(name, url, expectedStatus, validateBody, headers, method = 'GET') {
  const response = await fetch(url, {
    method,
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  if (response.status !== expectedStatus) {
    throw new Error(
      `${name}: expected ${expectedStatus}, got ${response.status} (${truncate(text)})`,
    );
  }
  if (validateBody) {
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`${name}: response is not JSON (${truncate(text)})`);
    }
    if (!validateBody(body)) throw new Error(`${name}: response body failed validation`);
  }
  return `${name} (${response.status})`;
}

async function checkText(name, url, expectedStatus, expectedText, headers) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  const body = await response.text();
  if (response.status !== expectedStatus) {
    throw new Error(
      `${name}: expected ${expectedStatus}, got ${response.status} (${truncate(body)})`,
    );
  }
  if (!body.includes(expectedText)) {
    throw new Error(`${name}: response did not contain ${expectedText}`);
  }
  return `${name} (${response.status})`;
}

function requiredOrigin(name) {
  const value = process.env[name]?.trim();
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
  if (!['http:', 'https:'].includes(url.protocol))
    throw new Error(`${name} must use HTTP or HTTPS`);
  return value;
}

function parseTimeout(value) {
  if (!value) return 5_000;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 100 || parsed > 30_000) {
    throw new Error('DEPLOY_VERIFY_TIMEOUT_MS must be an integer between 100 and 30000');
  }
  return parsed;
}

function requiredSecret(name) {
  const value = process.env[name]?.trim();
  if (!value || value.length < 32) throw new Error(`${name} must contain at least 32 characters`);
  return value;
}

function truncate(value) {
  return value.replace(/\s+/g, ' ').slice(0, 200);
}
