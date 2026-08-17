import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSupabaseDevEnvironment } from './dev-supabase.mjs';

const PROJECT_REF = 'abcdefghijklmnopqrst';
const DATABASE_URL =
  `postgresql://postgres.${PROJECT_REF}:secret@aws-0-ap-southeast-1.pooler.supabase.com:6543/` +
  'postgres?pgbouncer=true&connection_limit=5&sslmode=require';
const DIRECT_URL =
  `postgresql://postgres.${PROJECT_REF}:secret@aws-0-ap-southeast-1.pooler.supabase.com:5432/` +
  'postgres?sslmode=require';

test('builds a Supabase-only development environment', () => {
  const environment = buildSupabaseDevEnvironment({ DATABASE_URL, DIRECT_URL });

  assert.equal(environment.NODE_ENV, 'development');
  assert.equal(environment.SUPABASE_URL, `https://${PROJECT_REF}.supabase.co`);
  assert.equal(environment.PUBLISH_QUEUE_MODE, 'database');
});

test('rejects local or mismatched middleware configuration', () => {
  for (const environment of [
    { DATABASE_URL: 'postgresql://postgres:secret@127.0.0.1:5432/postgres', DIRECT_URL },
    { DATABASE_URL, DIRECT_URL, REDIS_URL: 'redis://127.0.0.1:6379' },
    { DATABASE_URL, DIRECT_URL, PUBLISH_QUEUE_MODE: 'inline' },
    { DATABASE_URL, DIRECT_URL, SUPABASE_URL: 'https://differentprojectref1.supabase.co' },
  ]) {
    assert.throws(() => buildSupabaseDevEnvironment(environment));
  }
});
