#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { lstat as nodeLstat, open as nodeOpen, readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

import prismaPackage from '@prisma/client';

const { PrismaClient } = prismaPackage;
const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageDir = dirname(scriptDir);
const repositoryRoot = dirname(dirname(packageDir));
const schemaPath = join(packageDir, 'prisma', 'schema.prisma');
const migrationsDir = join(packageDir, 'prisma', 'migrations');
const prismaCliPath = join(packageDir, 'node_modules', 'prisma', 'build', 'index.js');
export const PRISMA_DOTENV_CANDIDATES = Object.freeze([
  join(repositoryRoot, '.env'),
  join(repositoryRoot, 'prisma', '.env'),
  join(packageDir, '.env'),
  join(packageDir, 'prisma', '.env'),
]);
export const PRISMA_DOTENV_SAFETY_ERROR =
  'Prisma dotenv safety check failed; candidate files must be regular files containing only DATABASE_URL and DIRECT_URL assignments.';
const ALLOWED_PRISMA_DOTENV_KEYS = new Set(['DATABASE_URL', 'DIRECT_URL']);
const PRISMA_DOTENV_ASSIGNMENT = /^\s*(?:export\s+)?(DATABASE_URL|DIRECT_URL)\s*=/;

function requireDatabaseConfig(environment) {
  for (const key of ['STAGING_PROJECT_REF', 'DATABASE_URL', 'DIRECT_URL']) {
    if (!environment[key]) {
      throw new Error(`${key} is required. Load the staging env explicitly with Node --env-file.`);
    }
  }
}

export async function assertSafePrismaDotenvCandidates({
  candidates = PRISMA_DOTENV_CANDIDATES,
  lstatFile = nodeLstat,
  openFile = nodeOpen,
} = {}) {
  for (const candidate of candidates) {
    let pathStat;
    try {
      pathStat = await lstatFile(candidate);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw new Error(PRISMA_DOTENV_SAFETY_ERROR);
    }
    if (!pathStat.isFile()) throw new Error(PRISMA_DOTENV_SAFETY_ERROR);

    let handle;
    let failed = false;
    try {
      handle = await openFile(
        candidate,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
      );
      const openedStat = await handle.stat();
      if (
        !openedStat.isFile() ||
        openedStat.dev !== pathStat.dev ||
        openedStat.ino !== pathStat.ino
      ) {
        failed = true;
      } else {
        const contents = await handle.readFile({ encoding: 'utf8' });
        assertSafePrismaDotenvContents(contents);
      }
    } catch {
      failed = true;
    }
    try {
      await handle?.close();
    } catch {
      failed = true;
    }
    if (failed) throw new Error(PRISMA_DOTENV_SAFETY_ERROR);
  }
}

function assertSafePrismaDotenvContents(contents) {
  const assignedKeys = new Set();
  for (const line of contents.split(/\r?\n/)) {
    if (/^\s*(?:#.*)?$/.test(line)) continue;
    const assignment = PRISMA_DOTENV_ASSIGNMENT.exec(line);
    if (!assignment) throw new Error(PRISMA_DOTENV_SAFETY_ERROR);
    assignedKeys.add(assignment[1]);
  }

  const parsed = parseEnv(contents);
  const parsedKeys = Object.keys(parsed);
  if (
    parsedKeys.some((key) => !ALLOWED_PRISMA_DOTENV_KEYS.has(key)) ||
    parsedKeys.length !== assignedKeys.size ||
    parsedKeys.some((key) => !assignedKeys.has(key))
  ) {
    throw new Error(PRISMA_DOTENV_SAFETY_ERROR);
  }
}

export function readAuditConfiguration(environment) {
  requireDatabaseConfig(environment);
  const datasource = describeStagingDatasource({
    projectRef: environment.STAGING_PROJECT_REF,
    databaseUrl: environment.DATABASE_URL,
    directUrl: environment.DIRECT_URL,
  });
  return {
    datasource,
    prismaEnvironment: {
      DATABASE_URL: new URL(environment.DATABASE_URL).toString(),
      DIRECT_URL: new URL(environment.DIRECT_URL).toString(),
      LC_ALL: 'C',
      PRISMA_HIDE_UPDATE_MESSAGE: '1',
    },
  };
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

export function assertNoDuplicatePlatformProductIds(duplicateGroups) {
  if (duplicateGroups > 0) {
    throw new Error(
      `Duplicate non-null platform_product_id groups found within a shop: ${duplicateGroups}`,
    );
  }
}

export function summarizeMockPublishReadiness(sourceProducts, dataCounts) {
  const isExactMockProductSet =
    sourceProducts.source_products === 10 &&
    sourceProducts.unexpected_mock_products === 0 &&
    sourceProducts.missing_mock_products === 0;
  const publishReady =
    sourceProducts.missing_supplier_ids === 0 &&
    sourceProducts.unexpected_supplier_ids === 0 &&
    sourceProducts.not_available === 0 &&
    sourceProducts.not_one_piece_drop === 0;
  const mockSupplierIdBackfillDataCompatible =
    isExactMockProductSet &&
    !sourceProducts.published_source_bindings_exist &&
    sourceProducts.unexpected_supplier_ids === 0 &&
    sourceProducts.not_available === 0 &&
    sourceProducts.not_one_piece_drop === 0;

  return {
    sourceProductCount: sourceProducts.source_products,
    isExactMockProductSet,
    unexpectedMockProductCount: sourceProducts.unexpected_mock_products,
    missingMockProductCount: sourceProducts.missing_mock_products,
    missingSupplierIdCount: sourceProducts.missing_supplier_ids,
    unexpectedSupplierIdCount: sourceProducts.unexpected_supplier_ids,
    notAvailableCount: sourceProducts.not_available,
    notOnePieceDropCount: sourceProducts.not_one_piece_drop,
    publishTaskCount: dataCounts.publish_tasks,
    publishedSourceBindingsExist: sourceProducts.published_source_bindings_exist,
    publishReady,
    mockSupplierIdBackfillDataCompatible,
    mockSupplierIdBackfillRequired:
      mockSupplierIdBackfillDataCompatible && sourceProducts.missing_supplier_ids > 0,
  };
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

export function spawnPrisma(args, prismaEnvironment, spawnPrismaSync = spawnSync) {
  const result = spawnPrismaSync(process.execPath, [prismaCliPath, ...args], {
    cwd: repositoryRoot,
    env: { ...prismaEnvironment },
    encoding: 'utf8',
  });

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  if (result.error) {
    throw new Error(
      `Prisma ${args.slice(0, 2).join(' ')} could not start: ${result.error.message}`,
    );
  }

  return result;
}

function runPrisma(args, prismaEnvironment) {
  const result = spawnPrisma(args, prismaEnvironment);
  if (result.status !== 0) {
    throw new Error(`Prisma ${args.slice(0, 2).join(' ')} failed.`);
  }
}

export function readAuditOptions(args) {
  if (args.length === 0) return { allowPending: false };
  if (args.length === 1 && args[0] === '--allow-pending') return { allowPending: true };
  throw new Error('Usage: audit-staging.mjs [--allow-pending]');
}

export function assertExpectedPendingStatus(result, pendingMigrations) {
  if (
    result.error ||
    result.signal ||
    result.status !== 1 ||
    (result.stderr ?? '').trim().length > 0
  ) {
    throw new Error(
      'Prisma migrate status failed for a reason other than expected pending migrations.',
    );
  }

  const output = result.stdout ?? '';
  const reportedPending = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^\d{14}_[A-Za-z0-9_-]+$/.test(line));
  const expectedHeader = `Following migration${pendingMigrations.length === 1 ? '' : 's'} have not yet been applied:`;

  if (
    !output.includes(expectedHeader) ||
    reportedPending.length !== pendingMigrations.length ||
    reportedPending.some((migration, index) => migration !== pendingMigrations[index])
  ) {
    throw new Error('Prisma migrate status did not report the expected pending migration suffix.');
  }
}

function runPrismaStatus(pendingMigrations, allowPending, prismaEnvironment) {
  const args = ['migrate', 'status', '--schema', schemaPath];
  const result = spawnPrisma(args, prismaEnvironment);
  if (result.status === 0) {
    if (pendingMigrations.length > 0) {
      throw new Error('Prisma migrate status no longer matches the read-only migration snapshot.');
    }
    return;
  }

  if (allowPending && pendingMigrations.length > 0) {
    assertExpectedPendingStatus(result, pendingMigrations);
    return;
  }

  throw new Error('Prisma migrate status failed.');
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

export function assertMigrationHistory(
  localMigrations,
  remoteMigrations,
  { allowPending = false } = {},
) {
  const localByName = new Map(
    localMigrations.map((migration) => [migration.name, migration.checksum]),
  );
  const remoteNames = remoteMigrations.map((migration) => migration.migration_name);
  const remoteNameCounts = new Map();
  for (const name of remoteNames) {
    remoteNameCounts.set(name, (remoteNameCounts.get(name) ?? 0) + 1);
  }

  const unknownRemote = remoteMigrations
    .filter((migration) => !localByName.has(migration.migration_name))
    .map((migration) => migration.migration_name);
  const duplicateRemote = [...remoteNameCounts]
    .filter(([, count]) => count > 1)
    .map(([name]) => name);
  const checksumMismatches = remoteMigrations
    .filter(
      (migration) =>
        localByName.has(migration.migration_name) &&
        localByName.get(migration.migration_name) !== migration.checksum,
    )
    .map((migration) => migration.migration_name);
  const unfinished = remoteMigrations
    .filter((migration) => migration.finished_at === null && migration.rolled_back_at === null)
    .map((migration) => migration.migration_name);
  const rolledBack = remoteMigrations
    .filter((migration) => migration.rolled_back_at !== null)
    .map((migration) => migration.migration_name);
  const emptyApplied = remoteMigrations
    .filter((migration) => migration.applied_steps_count <= 0)
    .map((migration) => migration.migration_name);
  const orderMismatches = remoteNames
    .map((name, index) => {
      const expected = localMigrations[index]?.name ?? null;
      return name === expected ? null : { index, expected, actual: name };
    })
    .filter(Boolean);
  const pendingMigrations = localMigrations.slice(remoteMigrations.length).map(({ name }) => name);

  const failures = {
    unknownRemote,
    duplicateRemote,
    checksumMismatches,
    unfinished,
    rolledBack,
    emptyApplied,
    orderMismatches,
    pendingDisallowed: allowPending ? [] : pendingMigrations,
  };

  if (Object.values(failures).some((items) => items.length > 0)) {
    throw new Error(`Migration history mismatch: ${JSON.stringify(failures)}`);
  }

  return { pendingMigrations };
}

async function main() {
  const { allowPending } = readAuditOptions(process.argv.slice(2));
  const { datasource, prismaEnvironment } = readAuditConfiguration(process.env);
  await assertSafePrismaDotenvCandidates();
  const localMigrations = await readLocalMigrations();

  console.log(
    `Auditing Supabase staging project ${datasource.projectRef} (${datasource.runtime.host}:${datasource.runtime.port}/${datasource.database}; direct ${datasource.direct.host}:${datasource.direct.port})`,
  );

  const prisma = new PrismaClient({ datasourceUrl: prismaEnvironment.DATABASE_URL });
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
          (SELECT COUNT(*)::int FROM purchase_orders) AS purchase_orders,
          (SELECT COUNT(*)::int FROM publish_tasks) AS publish_tasks
      `);
      const sourceProducts = await transaction.$queryRawUnsafe(`
        SELECT
          COUNT(*)::int AS source_products,
          COUNT(*) FILTER (
            WHERE NOT (product_id_1688 = ANY (ARRAY[
              'mock-1001', 'mock-1002', 'mock-1003', 'mock-1004', 'mock-1005',
              'mock-1006', 'mock-1007', 'mock-1008', 'mock-1009', 'mock-1010'
            ]::text[]))
          )::int AS unexpected_mock_products,
          (10 - COUNT(DISTINCT product_id_1688) FILTER (
            WHERE product_id_1688 = ANY (ARRAY[
              'mock-1001', 'mock-1002', 'mock-1003', 'mock-1004', 'mock-1005',
              'mock-1006', 'mock-1007', 'mock-1008', 'mock-1009', 'mock-1010'
            ]::text[])
          ))::int AS missing_mock_products,
          COUNT(*) FILTER (WHERE supplier_id IS NULL OR BTRIM(supplier_id) = '')::int
            AS missing_supplier_ids,
          COUNT(*) FILTER (
            WHERE supplier_id IS NOT NULL
              AND BTRIM(supplier_id) <> ''
              AND supplier_id <> 'mock-supplier-' || product_id_1688
          )::int AS unexpected_supplier_ids,
          COUNT(*) FILTER (WHERE availability IS DISTINCT FROM 'available')::int AS not_available,
          COUNT(*) FILTER (WHERE is_one_piece_drop IS NOT TRUE)::int AS not_one_piece_drop
        FROM source_products
      `);
      const publishedSourceBindings = await transaction.$queryRawUnsafe(`
        SELECT to_regclass('public.published_product_source_bindings') IS NOT NULL AS table_exists
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
      const duplicatePlatformProductIds = await transaction.$queryRawUnsafe(`
        SELECT COUNT(*)::int AS duplicate_groups
        FROM (
          SELECT shop_id, platform_product_id
          FROM published_products
          WHERE platform_product_id IS NOT NULL
          GROUP BY shop_id, platform_product_id
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
        sourceProducts: {
          ...sourceProducts[0],
          published_source_bindings_exist: publishedSourceBindings[0].table_exists,
        },
        duplicateRecoveryKeys: duplicateRecoveryKeys[0],
        duplicatePlatformProductIds: duplicatePlatformProductIds[0],
        publicTables,
        publicSequences,
        unsafeDefaultPrivileges,
      };
    });

    const { pendingMigrations } = assertMigrationHistory(localMigrations, audit.migrations, {
      allowPending,
    });
    assertPublicSchemaIsolation(
      audit.publicTables,
      audit.publicSequences,
      audit.unsafeDefaultPrivileges,
    );
    assertNoDuplicatePlatformProductIds(audit.duplicatePlatformProductIds.duplicate_groups);

    await assertSafePrismaDotenvCandidates();
    runPrismaStatus(pendingMigrations, allowPending, prismaEnvironment);
    const schemaDiff =
      pendingMigrations.length > 0
        ? {
            status: 'deferred',
            reason: 'pending migrations must be applied before comparing the live schema',
          }
        : { status: 'matched' };
    if (schemaDiff.status === 'matched') {
      await assertSafePrismaDotenvCandidates();
      runPrisma(
        [
          'migrate',
          'diff',
          '--exit-code',
          '--from-schema-datasource',
          schemaPath,
          '--to-schema-datamodel',
          schemaPath,
        ],
        prismaEnvironment,
      );
    }

    const latestMigration = audit.migrations.at(-1);
    console.log(
      JSON.stringify(
        {
          database: audit.database,
          migrations: {
            local: localMigrations.length,
            applied: audit.migrations.length,
            pending: pendingMigrations.length,
            pendingNames: pendingMigrations,
            unfinished: 0,
            rolledBack: 0,
            checksumMismatches: 0,
            latest: latestMigration?.migration_name ?? null,
            latestFinishedAt: latestMigration?.finished_at ?? null,
          },
          dataCounts: audit.dataCounts,
          mockPublishReadiness: summarizeMockPublishReadiness(
            audit.sourceProducts,
            audit.dataCounts,
          ),
          duplicateRecoveryKeyGroups: audit.duplicateRecoveryKeys.duplicate_groups,
          duplicatePlatformProductIdGroups: audit.duplicatePlatformProductIds.duplicate_groups,
          publicSchemaIsolation: {
            tables: audit.publicTables.length,
            rlsEnabled: audit.publicTables.length,
            tablePrivilegesForAnonOrAuthenticated: 0,
            sequences: audit.publicSequences.length,
            sequencePrivilegesForAnonOrAuthenticated: 0,
            defaultPrivilegesForAnonOrAuthenticated: 0,
          },
          schemaDiff,
          conclusion:
            pendingMigrations.length > 0
              ? 'Pre-migration audit passed; pending migrations form a continuous local suffix and schema diff is deferred.'
              : 'Staging schema audit passed.',
        },
        null,
        2,
      ),
    );
    if (pendingMigrations.length > 0) {
      console.log(
        `Staging pre-migration audit passed with ${pendingMigrations.length} pending migration(s); schema diff deferred.`,
      );
    } else {
      console.log('Staging schema audit passed.');
    }
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
