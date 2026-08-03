import assert from 'node:assert/strict';
import test from 'node:test';

import { assertPublicSchemaIsolation, describeStagingDatasource } from './audit-staging.mjs';

const PROJECT_REF = 'abcdefghijklmnopqrst';

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
