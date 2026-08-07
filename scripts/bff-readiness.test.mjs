import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isCurrentBffReadiness,
  isCurrentBffReadinessResponse,
  optionalGitSha,
} from './bff-readiness.mjs';

const GIT_SHA = 'a'.repeat(40);

test('accepts only the current exact BFF dependency shape and optional revision', () => {
  const body = readiness({ revision: GIT_SHA });
  assert.equal(isCurrentBffReadiness(body), true);
  assert.equal(isCurrentBffReadiness(body, GIT_SHA), true);

  for (const invalid of [
    { ...body, service: 'other-service' },
    { ...body, revision: 'b'.repeat(40) },
    { ...body, checks: { database: { status: 'up' }, redis: { status: 'up' } } },
    {
      ...body,
      checks: { ...body.checks, redis: { status: 'up' } },
    },
    { ...body, checks: { ...body.checks, runtimeState: { status: 'down' } } },
  ]) {
    assert.equal(isCurrentBffReadiness(invalid, GIT_SHA), false);
  }
});

test('validates Git revisions and parses readiness responses without throwing', async () => {
  assert.equal(optionalGitSha(undefined), undefined);
  assert.equal(optionalGitSha(GIT_SHA), GIT_SHA);
  assert.throws(() => optionalGitSha('short'), /40-character lowercase Git SHA/);

  assert.equal(
    await isCurrentBffReadinessResponse(
      new Response(JSON.stringify(readiness({ revision: GIT_SHA })), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
      GIT_SHA,
    ),
    true,
  );
  assert.equal(
    await isCurrentBffReadinessResponse(new Response('not-json', { status: 200 }), GIT_SHA),
    false,
  );
  assert.equal(
    await isCurrentBffReadinessResponse(new Response(JSON.stringify(readiness()), { status: 503 })),
    false,
  );
});

function readiness(overrides = {}) {
  return {
    status: 'ready',
    service: 'supplier-bff',
    checks: { database: { status: 'up' }, runtimeState: { status: 'up' } },
    ...overrides,
  };
}
