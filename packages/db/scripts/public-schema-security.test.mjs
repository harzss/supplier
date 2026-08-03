import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(dirname(scriptDir), 'prisma', 'migrations');
const schemaPath = join(dirname(scriptDir), 'prisma', 'schema.prisma');
const securityMigrationName = '20260803173000_secure_supabase_public_schema';

function readPrismaTableNames(schema) {
  return new Set(
    [...schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)].map((match) => {
      const mappedName = /^\s*@@map\("([^"]+)"\)/m.exec(match[2]);
      return mappedName?.[1] ?? match[1];
    }),
  );
}

function readFinalRlsState(migrations) {
  const rlsState = new Map();

  for (const migration of migrations) {
    for (const match of migration.matchAll(
      /ALTER TABLE(?: IF EXISTS)?(?: ONLY)?\s+(?:"public"\.)?"([^"]+)"\s+(ENABLE|DISABLE) ROW LEVEL SECURITY;/g,
    )) {
      rlsState.set(match[1], match[2] === 'ENABLE');
    }
  }

  return rlsState;
}

test('migration history leaves every Prisma public table protected by RLS', async () => {
  const entries = await readdir(migrationsDir, { withFileTypes: true });
  const migrations = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue;
    migrations.push(await readFile(join(migrationsDir, entry.name, 'migration.sql'), 'utf8'));
  }

  const schema = await readFile(schemaPath, 'utf8');
  const expectedTables = readPrismaTableNames(schema);
  expectedTables.add('_prisma_migrations');
  const rlsState = readFinalRlsState(migrations);
  const tablesWithoutRls = [...expectedTables].filter((table) => rlsState.get(table) !== true);

  assert.deepEqual(tablesWithoutRls, []);
});

test('the Supabase security baseline revokes current and future client-role privileges', async () => {
  const securitySql = await readFile(
    join(migrationsDir, securityMigrationName, 'migration.sql'),
    'utf8',
  );

  assert.match(
    securitySql,
    /REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA "public" FROM "anon", "authenticated";/,
  );
  assert.match(
    securitySql,
    /REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA "public" FROM "anon", "authenticated";/,
  );
  assert.match(securitySql, /ALTER DEFAULT PRIVILEGES IN SCHEMA "public"/);
});
