import assert from 'node:assert/strict';
import test from 'node:test';

import { isSupabaseDatabaseUrl, readSeedOptions } from './seed.mjs';

test('keeps the default local seed mode when STAGING_PROJECT_REF is absent', () => {
  assert.deepEqual(readSeedOptions([], {}), {});
  assert.deepEqual(
    readSeedOptions([], { DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:5432/supplier' }),
    {},
  );
});

test('always refuses the full seed when STAGING_PROJECT_REF is present', () => {
  assert.throws(
    () => readSeedOptions([], { STAGING_PROJECT_REF: 'abcdefghijklmnopqrst' }),
    /Refusing to run the full seed against staging/,
  );
  assert.throws(
    () => readSeedOptions([], { STAGING_PROJECT_REF: '' }),
    /Refusing to run the full seed against staging/,
  );
  assert.throws(
    () => readSeedOptions(['--staging'], { STAGING_PROJECT_REF: 'abcdefghijklmnopqrst' }),
    /backfill-staging-mock-supplier-ids\.mjs/,
  );
});

test('refuses Supabase database hosts when STAGING_PROJECT_REF was omitted', () => {
  const projectRef = 'abcdefghijklmnopqrst';
  const urls = [
    `postgresql://postgres:secret@db.${projectRef}.supabase.co:5432/postgres`,
    `postgresql://postgres:secret@db.${projectRef}.supabase.co.:5432/postgres`,
    `postgresql://postgres.${projectRef}:secret@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres`,
  ];
  for (const databaseUrl of urls) {
    assert.equal(isSupabaseDatabaseUrl(databaseUrl), true);
    assert.throws(
      () => readSeedOptions([], { DATABASE_URL: databaseUrl }),
      /Refusing to run the full seed against staging/,
    );
  }
  assert.equal(
    isSupabaseDatabaseUrl('postgresql://postgres:postgres@127.0.0.1:5432/supplier'),
    false,
  );
});

test('rejects unknown and duplicate seed arguments', () => {
  for (const args of [['--unknown'], ['--staging'], ['--staging', '--staging']]) {
    assert.throws(() => readSeedOptions(args, {}), /Usage: seed\.mjs/);
  }
});
