import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageDir = dirname(scriptDir);
const hardeningMigration = join(
  packageDir,
  'prisma',
  'migrations',
  '20260805040000_harden_workflow_check_null_semantics',
  'migration.sql',
);
const negativeProbe = resolve(
  packageDir,
  '..',
  '..',
  'infra',
  'postgres',
  'assert-workflow-check-constraints.sql',
);
const releaseWorkflow = resolve(
  packageDir,
  '..',
  '..',
  '.github',
  'workflows',
  'release-gates.yml',
);

const hardenedConstraints = [
  'exception_case_events_transition_check',
  'after_sale_purchase_links_lifecycle_check',
  'after_sale_case_events_transition_check',
];

test('the forward migration makes nullable workflow CHECK predicates strictly boolean', async () => {
  const sql = await readFile(hardeningMigration, 'utf8');

  assert.match(sql, /^BEGIN;$/m);
  assert.match(sql, /^COMMIT;$/m);
  for (const constraint of hardenedConstraints) {
    assert.match(sql, new RegExp(`DROP CONSTRAINT "${constraint}"`));
    assert.match(sql, new RegExp(`ADD CONSTRAINT "${constraint}"`));
  }
  assert.equal([...sql.matchAll(/\) IS TRUE\s*\n\s*\);/g)].length, hardenedConstraints.length);
});

test('release migration smoke runs rollback-only negative probes for all hardened constraints', async () => {
  const [probeSql, workflow] = await Promise.all([
    readFile(negativeProbe, 'utf8'),
    readFile(releaseWorkflow, 'utf8'),
  ]);

  assert.match(probeSql, /^BEGIN;$/m);
  assert.match(probeSql, /^ROLLBACK;$/m);
  for (const constraint of hardenedConstraints) {
    assert.match(probeSql, new RegExp(constraint));
  }
  assert.match(workflow, /infra\/postgres\/assert-workflow-check-constraints\.sql/);
});
