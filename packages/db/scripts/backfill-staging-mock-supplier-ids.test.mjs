import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertBackfillMigrationWindow,
  planMockSupplierIdBackfill,
  readBackfillConfiguration,
  readBackfillOptions,
} from './backfill-staging-mock-supplier-ids.mjs';
import { SUPABASE_CA_CERT_PATH } from './staging-libpq.mjs';

const PROJECT_REF = 'abcdefghijklmnopqrst';
const PASSWORD = 'p@ss:word';
const LATEST_MIGRATION = '20260803173000_secure_supabase_public_schema';

function stagingEnvironment() {
  return {
    STAGING_PROJECT_REF: PROJECT_REF,
    DATABASE_URL: `postgresql://postgres.${PROJECT_REF}:secret@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres`,
    DIRECT_URL:
      `postgresql://postgres:${encodeURIComponent(PASSWORD)}@db.${PROJECT_REF}.supabase.co:5432/postgres` +
      '?sslmode=disable&options=unsafe',
  };
}

function mockRows() {
  return Array.from({ length: 10 }, (_, index) => {
    const productId1688 = `mock-${1001 + index}`;
    return {
      productId1688,
      supplierId: `mock-supplier-${productId1688}`,
      availability: 'available',
      isOnePieceDrop: true,
    };
  });
}

function migrationFixtures() {
  const local = Array.from({ length: 43 }, (_, index) => ({
    name: index === 32 ? LATEST_MIGRATION : `migration-${String(index + 1).padStart(2, '0')}`,
    checksum: `checksum-${index + 1}`,
  }));
  const remote = local.slice(0, 33).map((migration) => ({
    migration_name: migration.name,
    checksum: migration.checksum,
    finished_at: new Date('2026-08-04T00:00:00.000Z'),
    rolled_back_at: null,
    applied_steps_count: 1,
  }));
  return { local, remote };
}

test('defaults to a read-only check and requires an exact project confirmation for apply', () => {
  assert.deepEqual(readBackfillOptions([]), { apply: false, confirmedProjectRef: null });
  assert.deepEqual(
    readBackfillConfiguration(
      ['--apply', `--confirm-project=${PROJECT_REF}`],
      stagingEnvironment(),
    ),
    {
      apply: true,
      datasource: {
        projectRef: PROJECT_REF,
        database: 'postgres',
        runtime: { host: 'aws-0-ap-southeast-1.pooler.supabase.com', port: '6543' },
        direct: { host: `db.${PROJECT_REF}.supabase.co`, port: '5432' },
      },
      prismaDatasourceUrl:
        `postgresql://postgres:p%40ss%3Aword@db.${PROJECT_REF}.supabase.co:5432/postgres` +
        `?sslmode=require&sslcert=${encodeURIComponent(SUPABASE_CA_CERT_PATH)}` +
        '&sslaccept=strict',
    },
  );

  assert.throws(
    () =>
      readBackfillConfiguration(
        ['--apply', '--confirm-project=zyxwvutsrqponmlkjihg'],
        stagingEnvironment(),
      ),
    /must exactly match/,
  );
});

test('rejects unsafe direct targets and malformed credentials before creating a client', () => {
  const cases = [
    {
      environment: {
        ...stagingEnvironment(),
        DIRECT_URL: `postgresql://postgres:secret@db.${PROJECT_REF}.supabase.co:6543/postgres`,
      },
      pattern: /session port 5432/,
    },
    {
      environment: {
        ...stagingEnvironment(),
        DATABASE_URL: `postgresql://postgres.${PROJECT_REF}:secret@aws-0-ap-southeast-1.pooler.supabase.com:6543/other`,
        DIRECT_URL: `postgresql://postgres:secret@db.${PROJECT_REF}.supabase.co:5432/other`,
      },
      pattern: /must target the postgres database/,
    },
  ];

  for (const testCase of cases) {
    assert.throws(
      () =>
        readBackfillConfiguration(
          ['--apply', `--confirm-project=${PROJECT_REF}`],
          testCase.environment,
        ),
      testCase.pattern,
    );
  }

  const environment = stagingEnvironment();
  environment.DIRECT_URL = `postgresql://postgres:secret%00leak@db.${PROJECT_REF}.supabase.co:5432/postgres`;
  assert.throws(
    () => readBackfillConfiguration(['--apply', `--confirm-project=${PROJECT_REF}`], environment),
    (error) => {
      assert.match(error.message, /without NUL bytes/);
      assert.doesNotMatch(error.message, /secret|leak/);
      return true;
    },
  );
});

test('rejects incomplete, duplicate, and unknown write arguments', () => {
  for (const args of [
    ['--apply'],
    [`--confirm-project=${PROJECT_REF}`],
    ['--apply', '--apply'],
    ['--apply', `--confirm-project=${PROJECT_REF}`, `--confirm-project=${PROJECT_REF}`],
    ['--apply', '--unknown'],
  ]) {
    assert.throws(() => readBackfillOptions(args), /Usage:/);
  }
});

test('allows only the exact 33/43 pre-binding migration window', () => {
  const { local, remote } = migrationFixtures();
  assert.deepEqual(assertBackfillMigrationWindow(local, remote, false), {
    appliedMigrationCount: 33,
    localMigrationCount: 43,
    latestMigration: LATEST_MIGRATION,
  });

  assert.throws(
    () => assertBackfillMigrationWindow(local, remote.slice(0, 32), false),
    /exact 33\/43 pre-M40 migration window/,
  );
  assert.throws(
    () => assertBackfillMigrationWindow(local, remote, true),
    /before published_product_source_bindings exists/,
  );
  assert.throws(
    () => assertBackfillMigrationWindow(local.slice(0, 42), remote, false),
    /exactly 43 local migrations/,
  );
});

test('plans updates only for blank supplier IDs', () => {
  const rows = mockRows();
  rows[0].supplierId = null;
  rows[1].supplierId = '   ';

  assert.deepEqual(planMockSupplierIdBackfill(rows), {
    checkedCount: 10,
    alreadyCorrectCount: 8,
    updatePlan: [
      { productId1688: 'mock-1001', supplierId: 'mock-supplier-mock-1001' },
      { productId1688: 'mock-1002', supplierId: 'mock-supplier-mock-1002' },
    ],
  });
});

test('rejects any missing, unexpected, or duplicate source product', () => {
  const missing = mockRows().slice(1);
  assert.throws(() => planMockSupplierIdBackfill(missing), /"missingCount":1/);

  const unexpected = mockRows();
  unexpected[0] = { ...unexpected[0], productId1688: 'unexpected' };
  assert.throws(
    () => planMockSupplierIdBackfill(unexpected),
    (error) => {
      assert.match(error.message, /"unexpectedCount":1/);
      assert.doesNotMatch(error.message, /unexpected"/);
      return true;
    },
  );

  const duplicate = mockRows();
  duplicate[9] = { ...duplicate[9], productId1688: 'mock-1001' };
  assert.throws(() => planMockSupplierIdBackfill(duplicate), /"duplicateCount":1/);
});

test('rejects unsafe availability, drop-shipping status, and supplier IDs', () => {
  const rows = mockRows();
  rows[0].availability = 'offline';
  rows[1].isOnePieceDrop = false;
  rows[2].supplierId = 'different-supplier';

  assert.throws(
    () => planMockSupplierIdBackfill(rows),
    (error) => {
      assert.match(error.message, /availability_not_available/);
      assert.match(error.message, /not_one_piece_drop/);
      assert.match(error.message, /supplier_id_not_blank_or_expected/);
      assert.doesNotMatch(error.message, /different-supplier/);
      return true;
    },
  );
});
