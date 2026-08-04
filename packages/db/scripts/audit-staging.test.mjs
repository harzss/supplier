import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertExpectedPendingStatus,
  assertMigrationHistory,
  assertNoDuplicatePlatformProductIds,
  assertPublicSchemaIsolation,
  describeStagingDatasource,
  readAuditOptions,
} from './audit-staging.mjs';

const PROJECT_REF = 'abcdefghijklmnopqrst';
const LOCAL_MIGRATIONS = [
  { name: '20260801000000_first', checksum: 'checksum-first' },
  { name: '20260802000000_second', checksum: 'checksum-second' },
  { name: '20260803000000_third', checksum: 'checksum-third' },
];

function appliedMigration(localMigration, overrides = {}) {
  return {
    migration_name: localMigration.name,
    checksum: localMigration.checksum,
    finished_at: new Date('2026-08-03T00:00:00.000Z'),
    rolled_back_at: null,
    applied_steps_count: 1,
    ...overrides,
  };
}

test('accepts only the explicit allow-pending option', () => {
  assert.deepEqual(readAuditOptions([]), { allowPending: false });
  assert.deepEqual(readAuditOptions(['--allow-pending']), { allowPending: true });
  assert.throws(() => readAuditOptions(['--unknown']), /Usage: audit-staging/);
  assert.throws(
    () => readAuditOptions(['--allow-pending', '--allow-pending']),
    /Usage: audit-staging/,
  );
});

test('strict migration history requires every local migration to be applied in order', () => {
  const remote = LOCAL_MIGRATIONS.map((migration) => appliedMigration(migration));
  assert.deepEqual(assertMigrationHistory(LOCAL_MIGRATIONS, remote), {
    pendingMigrations: [],
  });

  assert.throws(
    () => assertMigrationHistory(LOCAL_MIGRATIONS, remote.slice(0, 2)),
    /"pendingDisallowed":\["20260803000000_third"\]/,
  );
});

test('allow-pending accepts only a continuous local migration suffix', () => {
  const remote = LOCAL_MIGRATIONS.slice(0, 2).map((migration) => appliedMigration(migration));
  assert.deepEqual(assertMigrationHistory(LOCAL_MIGRATIONS, remote, { allowPending: true }), {
    pendingMigrations: ['20260803000000_third'],
  });

  assert.throws(
    () =>
      assertMigrationHistory(
        LOCAL_MIGRATIONS,
        [appliedMigration(LOCAL_MIGRATIONS[0]), appliedMigration(LOCAL_MIGRATIONS[2])],
        { allowPending: true },
      ),
    /"orderMismatches":\[/,
  );
});

test('migration history rejects unknown, duplicate, checksum, unfinished, and rolled-back rows', () => {
  const validFirst = appliedMigration(LOCAL_MIGRATIONS[0]);
  const cases = [
    [
      [validFirst, appliedMigration({ name: '20260801500000_unknown', checksum: 'unknown' })],
      /"unknownRemote":\["20260801500000_unknown"\]/,
    ],
    [[validFirst, validFirst], /"duplicateRemote":\["20260801000000_first"\]/],
    [
      [appliedMigration(LOCAL_MIGRATIONS[0], { checksum: 'changed' })],
      /"checksumMismatches":\["20260801000000_first"\]/,
    ],
    [
      [appliedMigration(LOCAL_MIGRATIONS[0], { finished_at: null })],
      /"unfinished":\["20260801000000_first"\]/,
    ],
    [
      [
        appliedMigration(LOCAL_MIGRATIONS[0], {
          finished_at: null,
          rolled_back_at: new Date('2026-08-03T01:00:00.000Z'),
        }),
      ],
      /"rolledBack":\["20260801000000_first"\]/,
    ],
    [
      [appliedMigration(LOCAL_MIGRATIONS[0], { applied_steps_count: 0 })],
      /"emptyApplied":\["20260801000000_first"\]/,
    ],
  ];

  for (const [remote, expected] of cases) {
    assert.throws(
      () => assertMigrationHistory(LOCAL_MIGRATIONS, remote, { allowPending: true }),
      expected,
    );
  }
});

test('accepts Prisma status exit 1 only when it reports the exact pending suffix', () => {
  const pending = ['20260802000000_second', '20260803000000_third'];
  assert.doesNotThrow(() =>
    assertExpectedPendingStatus(
      {
        status: 1,
        signal: null,
        stdout: `3 migrations found in prisma/migrations\nFollowing migrations have not yet been applied:\n${pending.join('\n')}\n`,
        stderr: '',
      },
      pending,
    ),
  );

  assert.throws(
    () =>
      assertExpectedPendingStatus(
        { status: 1, signal: null, stdout: '', stderr: 'Error: P1001 cannot reach database' },
        pending,
      ),
    /reason other than expected pending migrations/,
  );
  assert.throws(
    () =>
      assertExpectedPendingStatus(
        {
          status: 1,
          signal: null,
          stdout: `Following migrations have not yet been applied:\n${pending.join('\n')}\n`,
          stderr: 'Error: P1001 cannot reach database',
        },
        pending,
      ),
    /reason other than expected pending migrations/,
  );
  assert.throws(
    () =>
      assertExpectedPendingStatus(
        {
          status: 1,
          signal: null,
          stdout:
            'Following migrations have not yet been applied:\n20260802000000_second\n20260802500000_unexpected\n',
          stderr: '',
        },
        pending,
      ),
    /did not report the expected pending migration suffix/,
  );
  assert.throws(
    () =>
      assertExpectedPendingStatus(
        {
          status: 2,
          signal: null,
          stdout: `Following migrations have not yet been applied:\n${pending.join('\n')}\n`,
          stderr: '',
        },
        pending,
      ),
    /reason other than expected pending migrations/,
  );
});

test('fails the staging precondition when platform product ids are duplicated within a shop', () => {
  assert.doesNotThrow(() => assertNoDuplicatePlatformProductIds(0));
  assert.throws(
    () => assertNoDuplicatePlatformProductIds(2),
    /Duplicate non-null platform_product_id groups found within a shop: 2/,
  );
});

test('accepts pooler URLs that identify the same Supabase project and database', () => {
  const datasource = describeStagingDatasource({
    projectRef: PROJECT_REF,
    databaseUrl: `postgresql://postgres.${PROJECT_REF}:secret@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres?pgbouncer=true`,
    directUrl: `postgresql://postgres.${PROJECT_REF}:secret@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres`,
  });

  assert.equal(datasource.projectRef, PROJECT_REF);
  assert.equal(datasource.database, 'postgres');
  assert.equal(datasource.runtime.port, '6543');
  assert.equal(datasource.direct.port, '5432');
});

test('accepts a direct Supabase host for the same project', () => {
  const datasource = describeStagingDatasource({
    projectRef: PROJECT_REF,
    databaseUrl: `postgresql://postgres.${PROJECT_REF}:secret@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres`,
    directUrl: `postgresql://postgres:secret@db.${PROJECT_REF}.supabase.co:5432/postgres`,
  });

  assert.equal(datasource.direct.host, `db.${PROJECT_REF}.supabase.co`);
});

test('rejects URLs from different Supabase projects', () => {
  assert.throws(
    () =>
      describeStagingDatasource({
        projectRef: PROJECT_REF,
        databaseUrl: `postgresql://postgres.${PROJECT_REF}:secret@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres`,
        directUrl:
          'postgresql://postgres.zyxwvutsrqponmlkjihg:secret@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres',
      }),
    /DIRECT_URL does not identify Supabase project/,
  );
});

test('rejects URLs that target different databases', () => {
  assert.throws(
    () =>
      describeStagingDatasource({
        projectRef: PROJECT_REF,
        databaseUrl: `postgresql://postgres.${PROJECT_REF}:secret@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres`,
        directUrl: `postgresql://postgres.${PROJECT_REF}:secret@aws-0-ap-southeast-1.pooler.supabase.com:5432/other`,
      }),
    /must target the same database/,
  );
});

test('rejects a generic PostgreSQL URL that cannot prove its Supabase project', () => {
  assert.throws(
    () =>
      describeStagingDatasource({
        projectRef: PROJECT_REF,
        databaseUrl: 'postgresql://postgres:secret@localhost:5432/postgres',
        directUrl: `postgresql://postgres.${PROJECT_REF}:secret@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres`,
      }),
    /DATABASE_URL must use a Supabase direct or pooler hostname/,
  );
});

test('rejects arbitrary hosts even when the username impersonates the project ref', () => {
  assert.throws(
    () =>
      describeStagingDatasource({
        projectRef: PROJECT_REF,
        databaseUrl: `postgresql://postgres.${PROJECT_REF}:secret@attacker.invalid:6543/postgres`,
        directUrl: `postgresql://postgres.${PROJECT_REF}:secret@different.invalid:5432/postgres`,
      }),
    /DATABASE_URL must use a Supabase direct or pooler hostname/,
  );
});

test('rejects a pooler URL whose username does not identify the project', () => {
  assert.throws(
    () =>
      describeStagingDatasource({
        projectRef: PROJECT_REF,
        databaseUrl:
          'postgresql://postgres:secret@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres',
        directUrl: `postgresql://postgres.${PROJECT_REF}:secret@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres`,
      }),
    /DATABASE_URL pooler username must identify its Supabase project/,
  );
});

test('accepts public tables with RLS and no client-role privileges', () => {
  assert.doesNotThrow(() =>
    assertPublicSchemaIsolation(
      [
        {
          tablename: 'orders',
          rowsecurity: true,
          anon_has_privilege: false,
          authenticated_has_privilege: false,
        },
      ],
      [
        {
          sequence_name: 'orders_id_seq',
          anon_has_privilege: false,
          authenticated_has_privilege: false,
        },
      ],
      [],
    ),
  );
});

test('rejects disabled RLS or client-role privileges', () => {
  assert.throws(
    () =>
      assertPublicSchemaIsolation(
        [
          {
            tablename: 'orders',
            rowsecurity: false,
            anon_has_privilege: true,
            authenticated_has_privilege: false,
          },
        ],
        [
          {
            sequence_name: 'orders_id_seq',
            anon_has_privilege: false,
            authenticated_has_privilege: true,
          },
        ],
        [],
      ),
    /Public schema isolation mismatch/,
  );
});

test('rejects client-role privileges inherited from public default ACLs', () => {
  assert.throws(
    () =>
      assertPublicSchemaIsolation(
        [
          {
            tablename: 'orders',
            rowsecurity: true,
            anon_has_privilege: false,
            authenticated_has_privilege: false,
          },
        ],
        [],
        [
          { client_role: 'anon', object_type: 'tables' },
          { client_role: 'authenticated', object_type: 'sequences' },
        ],
      ),
    /"unsafeDefaultPrivileges":\["anon:tables","authenticated:sequences"\]/,
  );
});
