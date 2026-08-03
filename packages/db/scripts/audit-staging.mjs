#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import prismaPackage from '@prisma/client';

const { PrismaClient } = prismaPackage;
const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageDir = dirname(scriptDir);
const repositoryRoot = dirname(dirname(packageDir));
const schemaPath = join(packageDir, 'prisma', 'schema.prisma');
const migrationsDir = join(packageDir, 'prisma', 'migrations');
const prismaCliPath = join(packageDir, 'node_modules', 'prisma', 'build', 'index.js');

function requireDatabaseConfig() {
  for (const key of ['STAGING_PROJECT_REF', 'DATABASE_URL', 'DIRECT_URL']) {
    if (!process.env[key]) {
      throw new Error(`${key} is required. Load the staging env explicitly with Node --env-file.`);
    }
  }
}

export function describeStagingDatasource({ projectRef, databaseUrl, directUrl }) {
  if (!/^[a-z0-9]{20}$/.test(projectRef)) {
    throw new Error('STAGING_PROJECT_REF must be a 20-character lowercase Supabase project ref.');
  }

  const runtime = describeDatabaseUrl(databaseUrl, 'DATABASE_URL', projectRef);
  const direct = describeDatabaseUrl(directUrl, 'DIRECT_URL', projectRef);
  if (runtime.database !== direct.database) {
    throw new Error(
      `DATABASE_URL and DIRECT_URL must target the same database (${runtime.database} != ${direct.database}).`,
    );
  }

  return {
    projectRef,
    database: runtime.database,
    runtime: { host: runtime.host, port: runtime.port },
    direct: { host: direct.host, port: direct.port },
  };
}

export function assertPublicSchemaIsolation(
  publicTables,
  publicSequences,
  unsafeDefaultPrivileges,
) {
  if (publicTables.length === 0) throw new Error('No public tables were found during RLS audit.');

  const failures = {
    rlsDisabled: publicTables.filter((table) => !table.rowsecurity).map((table) => table.tablename),
    anonTablePrivileges: publicTables
      .filter((table) => table.anon_has_privilege)
      .map((table) => table.tablename),
    authenticatedTablePrivileges: publicTables
      .filter((table) => table.authenticated_has_privilege)
      .map((table) => table.tablename),
    anonSequencePrivileges: publicSequences
      .filter((sequence) => sequence.anon_has_privilege)
      .map((sequence) => sequence.sequence_name),
    authenticatedSequencePrivileges: publicSequences
      .filter((sequence) => sequence.authenticated_has_privilege)
      .map((sequence) => sequence.sequence_name),
    unsafeDefaultPrivileges: unsafeDefaultPrivileges.map(
      (privilege) => `${privilege.client_role}:${privilege.object_type}`,
    ),
  };

  if (Object.values(failures).some((items) => items.length > 0)) {
    throw new Error(`Public schema isolation mismatch: ${JSON.stringify(failures)}`);
  }
}

function describeDatabaseUrl(value, name, expectedProjectRef) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid PostgreSQL URL.`);
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error(`${name} must use the postgres or postgresql protocol.`);
  }

  const projectRefs = new Set();
  const hostnameMatch = /^db\.([a-z0-9]{20})\.supabase\.co$/.exec(url.hostname);
  const usernameMatch = /^postgres\.([a-z0-9]{20})$/.exec(decodeURIComponent(url.username));
  const isPooler = /^[a-z0-9-]+\.pooler\.supabase\.com$/.test(url.hostname);
  if (!hostnameMatch && !isPooler) {
    throw new Error(`${name} must use a Supabase direct or pooler hostname.`);
  }
  if (isPooler && !usernameMatch) {
    throw new Error(`${name} pooler username must identify its Supabase project.`);
  }
  if (hostnameMatch) projectRefs.add(hostnameMatch[1]);
  if (usernameMatch) projectRefs.add(usernameMatch[1]);
  if (projectRefs.size !== 1 || !projectRefs.has(expectedProjectRef)) {
    throw new Error(`${name} does not identify Supabase project ${expectedProjectRef}.`);
  }

  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!database) throw new Error(`${name} must include a database name.`);
  return {
    host: url.hostname,
    port: url.port || '5432',
    database,
  };
}

function runPrisma(args) {
  const result = spawnSync(process.execPath, [prismaCliPath, ...args], {
    cwd: repositoryRoot,
    env: process.env,
    encoding: 'utf8',
  });

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  if (result.status !== 0) {
    throw new Error(`Prisma ${args.slice(0, 2).join(' ')} failed.`);
  }
}

async function readLocalMigrations() {
  const entries = await readdir(migrationsDir, { withFileTypes: true });
  const migrations = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const sql = await readFile(join(migrationsDir, entry.name, 'migration.sql'), 'utf8');
    migrations.push({
      name: entry.name,
      checksum: createHash('sha256').update(sql).digest('hex'),
    });
  }

  return migrations.sort((left, right) => left.name.localeCompare(right.name));
}

function assertMigrationHistory(localMigrations, remoteMigrations) {
  const localByName = new Map(
    localMigrations.map((migration) => [migration.name, migration.checksum]),
  );
  const remoteByName = new Map(
    remoteMigrations.map((migration) => [migration.migration_name, migration]),
  );

  const missingRemote = localMigrations
    .filter((migration) => !remoteByName.has(migration.name))
    .map((migration) => migration.name);
  const unknownRemote = remoteMigrations
    .filter((migration) => !localByName.has(migration.migration_name))
    .map((migration) => migration.migration_name);
  const checksumMismatches = remoteMigrations
    .filter((migration) => localByName.get(migration.migration_name) !== migration.checksum)
    .map((migration) => migration.migration_name);
  const unfinished = remoteMigrations
    .filter((migration) => migration.finished_at === null && migration.rolled_back_at === null)
    .map((migration) => migration.migration_name);
  const rolledBack = remoteMigrations
    .filter((migration) => migration.rolled_back_at !== null)
    .map((migration) => migration.migration_name);

  const failures = {
    missingRemote,
    unknownRemote,
    checksumMismatches,
    unfinished,
    rolledBack,
  };

  if (Object.values(failures).some((items) => items.length > 0)) {
    throw new Error(`Migration history mismatch: ${JSON.stringify(failures)}`);
  }
}

async function main() {
  requireDatabaseConfig();
  const datasource = describeStagingDatasource({
    projectRef: process.env.STAGING_PROJECT_REF,
    databaseUrl: process.env.DATABASE_URL,
    directUrl: process.env.DIRECT_URL,
  });
  const localMigrations = await readLocalMigrations();

  console.log(
    `Auditing Supabase staging project ${datasource.projectRef} (${datasource.runtime.host}:${datasource.runtime.port}/${datasource.database}; direct ${datasource.direct.host}:${datasource.direct.port})`,
  );

  runPrisma(['migrate', 'status', '--schema', schemaPath]);
  runPrisma([
    'migrate',
    'diff',
    '--exit-code',
    '--from-schema-datasource',
    schemaPath,
    '--to-schema-datamodel',
    schemaPath,
  ]);

  const prisma = new PrismaClient();
  try {
    const audit = await prisma.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe('SET TRANSACTION READ ONLY');

      const database = await transaction.$queryRawUnsafe(`
        SELECT
          current_database() AS database,
          current_schema() AS schema,
          current_setting('server_version') AS server_version,
          pg_database_size(current_database())::text AS database_bytes
      `);
      const migrations = await transaction.$queryRawUnsafe(`
        SELECT
          migration_name,
          checksum,
          finished_at,
          rolled_back_at,
          applied_steps_count
        FROM "_prisma_migrations"
        ORDER BY started_at ASC
      `);
      const dataCounts = await transaction.$queryRawUnsafe(`
        SELECT
          (SELECT COUNT(*)::int FROM source_products) AS source_products,
          (SELECT COUNT(*)::int FROM published_products) AS published_products,
          (SELECT COUNT(*)::int FROM orders) AS orders,
          (SELECT COUNT(*)::int FROM purchase_orders) AS purchase_orders
      `);
      const duplicateRecoveryKeys = await transaction.$queryRawUnsafe(`
        SELECT COUNT(*)::int AS duplicate_groups
        FROM (
          SELECT task_id, shop_id
          FROM published_products
          WHERE task_id IS NOT NULL
          GROUP BY task_id, shop_id
          HAVING COUNT(*) > 1
        ) duplicates
      `);
      const publicTables = await transaction.$queryRawUnsafe(`
        SELECT
          tablename,
          rowsecurity,
          has_table_privilege(
            'anon',
            format('%I.%I', schemaname, tablename),
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
          ) AS anon_has_privilege,
          has_table_privilege(
            'authenticated',
            format('%I.%I', schemaname, tablename),
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
          ) AS authenticated_has_privilege
        FROM pg_tables
        WHERE schemaname = 'public'
        ORDER BY tablename
      `);
      const publicSequences = await transaction.$queryRawUnsafe(`
        SELECT
          sequence_name,
          has_sequence_privilege(
            'anon',
            format('%I.%I', sequence_schema, sequence_name),
            'USAGE,SELECT,UPDATE'
          ) AS anon_has_privilege,
          has_sequence_privilege(
            'authenticated',
            format('%I.%I', sequence_schema, sequence_name),
            'USAGE,SELECT,UPDATE'
          ) AS authenticated_has_privilege
        FROM information_schema.sequences
        WHERE sequence_schema = 'public'
        ORDER BY sequence_name
      `);
      const unsafeDefaultPrivileges = await transaction.$queryRawUnsafe(`
        WITH owner_role AS (
          SELECT oid
          FROM pg_roles
          WHERE rolname = current_user
        ),
        client_roles AS (
          SELECT oid, rolname
          FROM pg_roles
          WHERE rolname IN ('anon', 'authenticated')
        ),
        object_types AS (
          SELECT *
          FROM (
            VALUES ('r'::"char", 'tables'), ('S'::"char", 'sequences')
          ) AS values_table(object_type, object_label)
        )
        SELECT DISTINCT
          client_roles.rolname AS client_role,
          object_types.object_label AS object_type
        FROM owner_role
        CROSS JOIN client_roles
        CROSS JOIN object_types
        WHERE EXISTS (
          SELECT 1
          FROM pg_default_acl
          CROSS JOIN LATERAL aclexplode(pg_default_acl.defaclacl) AS default_acl
          WHERE pg_default_acl.defaclrole = owner_role.oid
            AND pg_default_acl.defaclobjtype = object_types.object_type
            AND (
              pg_default_acl.defaclnamespace = 0
              OR pg_default_acl.defaclnamespace = 'public'::regnamespace
            )
            AND CASE
              WHEN default_acl.grantee = 0 THEN true
              ELSE pg_has_role(client_roles.oid, default_acl.grantee, 'USAGE')
            END
        )
        ORDER BY client_role, object_type
      `);

      return {
        database: database[0],
        migrations,
        dataCounts: dataCounts[0],
        duplicateRecoveryKeys: duplicateRecoveryKeys[0],
        publicTables,
        publicSequences,
        unsafeDefaultPrivileges,
      };
    });

    assertMigrationHistory(localMigrations, audit.migrations);
    assertPublicSchemaIsolation(
      audit.publicTables,
      audit.publicSequences,
      audit.unsafeDefaultPrivileges,
    );

    const latestMigration = audit.migrations.at(-1);
    console.log(
      JSON.stringify(
        {
          database: audit.database,
          migrations: {
            local: localMigrations.length,
            applied: audit.migrations.length,
            unfinished: 0,
            rolledBack: 0,
            checksumMismatches: 0,
            latest: latestMigration?.migration_name ?? null,
            latestFinishedAt: latestMigration?.finished_at ?? null,
          },
          dataCounts: audit.dataCounts,
          duplicateRecoveryKeyGroups: audit.duplicateRecoveryKeys.duplicate_groups,
          publicSchemaIsolation: {
            tables: audit.publicTables.length,
            rlsEnabled: audit.publicTables.length,
            tablePrivilegesForAnonOrAuthenticated: 0,
            sequences: audit.publicSequences.length,
            sequencePrivilegesForAnonOrAuthenticated: 0,
            defaultPrivilegesForAnonOrAuthenticated: 0,
          },
        },
        null,
        2,
      ),
    );
    console.log('Staging schema audit passed.');
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
