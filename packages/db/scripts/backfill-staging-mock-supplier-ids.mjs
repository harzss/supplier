#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import prismaPackage from '@prisma/client';

import { assertMigrationHistory, describeStagingDatasource } from './audit-staging.mjs';
import {
  assertStagingMaintenanceRuntime,
  buildStrictSupabasePrismaDatasource,
} from './staging-maintenance-runtime.mjs';

const { PrismaClient } = prismaPackage;
const scriptPath = fileURLToPath(import.meta.url);
const packageDir = dirname(dirname(scriptPath));
const migrationsDir = join(packageDir, 'prisma', 'migrations');
const EXPECTED_LOCAL_MIGRATION_COUNT = 43;
const EXPECTED_APPLIED_MIGRATION_COUNT = 33;
const EXPECTED_LATEST_MIGRATION = '20260803173000_secure_supabase_public_schema';
const EXPECTED_MOCK_PRODUCTS = Object.freeze(
  Array.from({ length: 10 }, (_, index) => {
    const productId1688 = `mock-${1001 + index}`;
    return { productId1688, supplierId: `mock-supplier-${productId1688}` };
  }),
);

export function readBackfillOptions(args) {
  if (args.length === 0) {
    return { apply: false, confirmedProjectRef: null };
  }

  if (args.length !== 2 || args.filter((arg) => arg === '--apply').length !== 1) {
    throw new Error(
      'Usage: backfill-staging-mock-supplier-ids.mjs [--apply --confirm-project=<STAGING_PROJECT_REF>]',
    );
  }

  const confirmations = args.filter((arg) => arg.startsWith('--confirm-project='));
  if (
    confirmations.length !== 1 ||
    args.some((arg) => arg !== '--apply' && !confirmations.includes(arg))
  ) {
    throw new Error(
      'Usage: backfill-staging-mock-supplier-ids.mjs [--apply --confirm-project=<STAGING_PROJECT_REF>]',
    );
  }

  const confirmedProjectRef = confirmations[0].slice('--confirm-project='.length);
  if (!confirmedProjectRef) {
    throw new Error('--confirm-project must not be empty.');
  }
  return { apply: true, confirmedProjectRef };
}

export function readBackfillConfiguration(args, environment) {
  const options = readBackfillOptions(args);
  let datasource;
  try {
    datasource = describeStagingDatasource({
      projectRef: environment.STAGING_PROJECT_REF,
      databaseUrl: environment.DATABASE_URL,
      directUrl: environment.DIRECT_URL,
    });
  } catch (error) {
    throw new Error(redactProjectRefInMessage(error, environment.STAGING_PROJECT_REF));
  }

  if (options.apply && options.confirmedProjectRef !== datasource.projectRef) {
    throw new Error('--confirm-project must exactly match the validated STAGING_PROJECT_REF.');
  }
  if (datasource.direct.port !== '5432') {
    throw new Error('Backfill DIRECT_URL must use the PostgreSQL session port 5432.');
  }
  if (datasource.database !== 'postgres') {
    throw new Error('Backfill must target the postgres database.');
  }

  const prismaDatasourceUrl = buildStrictSupabasePrismaDatasource(
    new URL(environment.DIRECT_URL),
    datasource,
  );
  return { apply: options.apply, datasource, prismaDatasourceUrl };
}

export function planMockSupplierIdBackfill(rows) {
  const expectedIds = new Set(EXPECTED_MOCK_PRODUCTS.map(({ productId1688 }) => productId1688));
  const counts = new Map();
  for (const row of rows) {
    counts.set(row.productId1688, (counts.get(row.productId1688) ?? 0) + 1);
  }

  const missing = EXPECTED_MOCK_PRODUCTS.map(({ productId1688 }) => productId1688).filter(
    (productId1688) => !counts.has(productId1688),
  );
  const unexpected = [...counts.keys()]
    .filter((productId1688) => !expectedIds.has(productId1688))
    .sort();
  const duplicates = [...counts]
    .filter(([, count]) => count > 1)
    .map(([productId1688]) => productId1688)
    .sort();

  if (
    rows.length !== EXPECTED_MOCK_PRODUCTS.length ||
    missing.length ||
    unexpected.length ||
    duplicates.length
  ) {
    throw new Error(
      `Staging source_products must contain exactly mock-1001..mock-1010: ${JSON.stringify({
        expectedCount: EXPECTED_MOCK_PRODUCTS.length,
        actualCount: rows.length,
        missingCount: missing.length,
        unexpectedCount: unexpected.length,
        duplicateCount: duplicates.length,
      })}`,
    );
  }

  const rowsById = new Map(rows.map((row) => [row.productId1688, row]));
  const unsafeRows = [];
  const updatePlan = [];
  for (const expected of EXPECTED_MOCK_PRODUCTS) {
    const row = rowsById.get(expected.productId1688);
    const blankSupplierId =
      row.supplierId === null ||
      (typeof row.supplierId === 'string' && row.supplierId.trim() === '');
    const reasons = [];
    if (row.availability !== 'available') reasons.push('availability_not_available');
    if (row.isOnePieceDrop !== true) reasons.push('not_one_piece_drop');
    if (!blankSupplierId && row.supplierId !== expected.supplierId) {
      reasons.push('supplier_id_not_blank_or_expected');
    }
    if (reasons.length) {
      unsafeRows.push({ productId1688: expected.productId1688, reasons });
    } else if (blankSupplierId) {
      updatePlan.push(expected);
    }
  }

  if (unsafeRows.length) {
    throw new Error(`Unsafe staging mock source_products: ${JSON.stringify(unsafeRows)}`);
  }

  return {
    checkedCount: EXPECTED_MOCK_PRODUCTS.length,
    alreadyCorrectCount: EXPECTED_MOCK_PRODUCTS.length - updatePlan.length,
    updatePlan,
  };
}

export function assertBackfillMigrationWindow(
  localMigrations,
  remoteMigrations,
  bindingTableExists,
) {
  if (localMigrations.length !== EXPECTED_LOCAL_MIGRATION_COUNT) {
    throw new Error(
      `Backfill requires exactly ${EXPECTED_LOCAL_MIGRATION_COUNT} local migrations; found ${localMigrations.length}.`,
    );
  }

  const { pendingMigrations } = assertMigrationHistory(localMigrations, remoteMigrations, {
    allowPending: true,
  });
  const latestMigration = remoteMigrations.at(-1)?.migration_name ?? null;
  if (
    remoteMigrations.length !== EXPECTED_APPLIED_MIGRATION_COUNT ||
    pendingMigrations.length !==
      EXPECTED_LOCAL_MIGRATION_COUNT - EXPECTED_APPLIED_MIGRATION_COUNT ||
    latestMigration !== EXPECTED_LATEST_MIGRATION
  ) {
    throw new Error(
      `Backfill is allowed only at the exact 33/43 pre-M40 migration window with latest=${EXPECTED_LATEST_MIGRATION}.`,
    );
  }
  if (bindingTableExists) {
    throw new Error(
      'Backfill must run before published_product_source_bindings exists; no binding synchronization will be attempted.',
    );
  }

  return {
    appliedMigrationCount: remoteMigrations.length,
    localMigrationCount: localMigrations.length,
    latestMigration,
  };
}

async function inspectOrApplyBackfill(prisma, { apply }, localMigrations) {
  return prisma.$transaction(async (transaction) => {
    if (apply) {
      const [migrationLock] = await transaction.$queryRawUnsafe(
        'SELECT pg_try_advisory_xact_lock(72707369) AS "acquired"',
      );
      if (migrationLock?.acquired !== true) {
        throw new Error('Could not acquire the Prisma migration lock; retry after migration ends.');
      }
      await transaction.$executeRawUnsafe(
        'LOCK TABLE "source_products" IN SHARE ROW EXCLUSIVE MODE',
      );
    } else {
      await transaction.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    }

    const remoteMigrations = await transaction.$queryRawUnsafe(`
      SELECT
        "migration_name",
        "checksum",
        "finished_at",
        "rolled_back_at",
        "applied_steps_count"
      FROM "_prisma_migrations"
      ORDER BY "started_at" ASC
    `);
    const [bindingTable] = await transaction.$queryRawUnsafe(`
      SELECT
        to_regclass('public.published_product_source_bindings') IS NOT NULL AS "tableExists"
    `);
    if (typeof bindingTable?.tableExists !== 'boolean') {
      throw new Error('Could not prove that published_product_source_bindings is absent.');
    }
    assertBackfillMigrationWindow(localMigrations, remoteMigrations, bindingTable.tableExists);

    const rows = await readSourceProducts(transaction, apply);
    const plan = planMockSupplierIdBackfill(rows);

    if (!apply) {
      return { ...plan, updatedCount: 0 };
    }

    for (const update of plan.updatePlan) {
      const updated = await transaction.$executeRawUnsafe(
        `
          UPDATE "source_products"
          SET "supplier_id" = $1
          WHERE "product_id_1688" = $2
            AND ("supplier_id" IS NULL OR "supplier_id" ~ '^[[:space:]]*$')
        `,
        update.supplierId,
        update.productId1688,
      );
      if (updated !== 1) {
        throw new Error(`Expected exactly one locked row for ${update.productId1688}.`);
      }
    }

    const verified = planMockSupplierIdBackfill(await readSourceProducts(transaction, true));
    if (verified.updatePlan.length !== 0) {
      throw new Error('Staging mock supplier_id backfill did not pass its locked readback.');
    }

    return { ...verified, updatedCount: plan.updatePlan.length };
  });
}

async function readLocalMigrations() {
  const entries = await readdir(migrationsDir, { withFileTypes: true });
  const migrations = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const sql = await readFile(join(migrationsDir, entry.name, 'migration.sql'), 'utf8');
    migrations.push({
      name: entry.name,
      checksum: createHash('sha256').update(sql).digest('hex'),
    });
  }
  return migrations.sort((left, right) => left.name.localeCompare(right.name));
}

function readSourceProducts(transaction, forUpdate) {
  return transaction.$queryRawUnsafe(`
    SELECT
      "product_id_1688" AS "productId1688",
      "supplier_id" AS "supplierId",
      "availability"::text AS "availability",
      "is_one_piece_drop" AS "isOnePieceDrop"
    FROM "source_products"
    ORDER BY "product_id_1688"
    ${forUpdate ? 'FOR UPDATE' : ''}
  `);
}

function redactProjectRefInMessage(error, projectRef) {
  const message = error instanceof Error ? error.message : String(error);
  return projectRef ? message.replaceAll(projectRef, redactProjectRef(projectRef)) : message;
}

function redactProjectRef(projectRef) {
  return projectRef.length > 8 ? `${projectRef.slice(0, 4)}…${projectRef.slice(-4)}` : '<redacted>';
}

function redactSupabaseHost(host) {
  if (/^db\.[a-z0-9]{20}\.supabase\.co$/.test(host)) {
    return 'db.<redacted>.supabase.co';
  }
  if (/^[a-z0-9-]+\.pooler\.supabase\.com$/.test(host)) {
    return '<redacted>.pooler.supabase.com';
  }
  return '<redacted-host>';
}

function formatTarget(configuration) {
  const { datasource } = configuration;
  return [
    `mode=${configuration.apply ? 'apply' : 'check'}`,
    `projectRef=${redactProjectRef(datasource.projectRef)}`,
    `runtimeHost=${redactSupabaseHost(datasource.runtime.host)}`,
    `directHost=${redactSupabaseHost(datasource.direct.host)}`,
  ].join(' ');
}

async function main() {
  assertStagingMaintenanceRuntime(process.env, process.platform);
  const configuration = readBackfillConfiguration(process.argv.slice(2), process.env);
  console.log(`Staging mock supplier_id backfill target: ${formatTarget(configuration)}`);

  const localMigrations = await readLocalMigrations();
  const prisma = new PrismaClient({ datasourceUrl: configuration.prismaDatasourceUrl });
  try {
    const result = await inspectOrApplyBackfill(prisma, configuration, localMigrations);
    console.log(
      configuration.apply
        ? `Backfill applied and verified: checked=${result.checkedCount} updated=${result.updatedCount}.`
        : `Read-only check passed: checked=${result.checkedCount} pendingUpdates=${result.updatePlan.length}.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
