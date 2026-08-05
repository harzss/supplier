import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';

import {
  LIBPQ_BIN_DIR,
  readRestoreRehearsalConfiguration,
  readRestoreRehearsalOptions,
  runRestoreRehearsal,
} from './restore-rehearsal.mjs';

const DATABASE = 'supplier_restore_release_9c937ef';
const PASSWORD = 'local:p@ssword';
const EXPECTED_ASSERTIONS = Object.freeze([
  'assert-public-schema-isolation.sql',
  'assert-workflow-check-constraints.sql',
  'assert-33-to-43-upgrade-data.sql',
]);
const ARCHIVE_LIST = `
; local restore rehearsal fixture
1; 1259 1 TABLE public _prisma_migrations postgres
2; 0 1 TABLE DATA public _prisma_migrations postgres
3; 1259 2 TABLE public source_products postgres
4; 0 2 TABLE DATA public source_products postgres
`;

function localEnvironment(overrides = {}) {
  return {
    DATABASE_URL: `postgresql://restore_user:local%3Ap%40ssword@127.0.0.1:5432/${DATABASE}?schema=public`,
    DIRECT_URL: `postgresql://restore_user:local%3Ap%40ssword@127.0.0.1:5432/${DATABASE}`,
    PGHOST: 'remote.invalid',
    PGSERVICE: 'unsafe-service',
    ...overrides,
  };
}

function successfulResult(overrides = {}) {
  return {
    error: undefined,
    signal: null,
    status: 0,
    stderr: '',
    stdout: '',
    ...overrides,
  };
}

function createFakeSpawn({
  archiveList = ARCHIVE_LIST,
  currentDatabase = DATABASE,
  serverVersionNum = 170_010,
  serverAddress = '127.0.0.1',
  initResult,
  restoreResult,
  assertionResults = [],
  assertionStatuses = [],
} = {}) {
  const calls = [];
  let assertionIndex = 0;
  const spawnSync = (command, args, options) => {
    calls.push({ command, args, options });
    const tool = basename(command);
    if (args.length === 1 && args[0] === '--version') {
      return successfulResult({ stdout: `${tool} (PostgreSQL) 17.10\n` });
    }
    if (tool === 'pg_restore' && args[0] === '--list') {
      return successfulResult({ stdout: archiveList });
    }
    if (tool === 'psql' && args.some((arg) => arg.includes('server_version_num'))) {
      return successfulResult({
        stdout: `${JSON.stringify({
          database: currentDatabase,
          serverVersionNum,
          serverAddress,
        })}\n`,
      });
    }
    if (tool === 'psql' && basename(args.at(-1)) === 'init-supabase-roles.sql') {
      return initResult ?? successfulResult();
    }
    if (tool === 'psql' && args.includes('--file')) {
      if (assertionResults[assertionIndex]) return assertionResults[assertionIndex++];
      return successfulResult({ status: assertionStatuses[assertionIndex++] ?? 0 });
    }
    if (tool === 'pg_restore') return restoreResult ?? successfulResult();
    throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
  };
  return { calls, spawnSync };
}

async function temporaryDirectory(context) {
  const directory = await mkdtemp(join(tmpdir(), 'supplier-restore-rehearsal-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('accepts only restore and post-upgrade-assert with exact arguments', () => {
  assert.deepEqual(
    readRestoreRehearsalOptions([
      'restore',
      '--archive=/private/tmp/staging.dump',
      `--confirm-database=${DATABASE}`,
    ]),
    {
      action: 'restore',
      archive: '/private/tmp/staging.dump',
      confirmedDatabase: DATABASE,
    },
  );
  assert.deepEqual(
    readRestoreRehearsalOptions(['post-upgrade-assert', `--confirm-database=${DATABASE}`]),
    { action: 'post-upgrade-assert', confirmedDatabase: DATABASE },
  );

  for (const args of [
    [],
    ['restore', '--archive=relative.dump', `--confirm-database=${DATABASE}`],
    ['restore', '--archive=/private/tmp/staging.sql', `--confirm-database=${DATABASE}`],
    ['restore', '--archive=/private/tmp/staging.dump'],
    ['post-upgrade-assert', `--confirm-database=${DATABASE}`, '--file=unsafe.sql'],
    ['psql', `--confirm-database=${DATABASE}`],
  ]) {
    assert.throws(() => readRestoreRehearsalOptions(args));
  }
});

test('accepts only an exactly confirmed local restore database with minimal child environments', () => {
  const configuration = readRestoreRehearsalConfiguration(
    ['post-upgrade-assert', `--confirm-database=${DATABASE}`],
    localEnvironment(),
  );

  assert.deepEqual(configuration.libpqEnvironment, {
    LC_ALL: 'C',
    PGAPPNAME: 'supplier-restore-rehearsal',
    PGCONNECT_TIMEOUT: '10',
    PGDATABASE: DATABASE,
    PGHOST: '127.0.0.1',
    PGPASSWORD: PASSWORD,
    PGPORT: '5432',
    PGSSLMODE: 'disable',
    PGUSER: 'restore_user',
  });
  assert.deepEqual(configuration.readOnlyLibpqEnvironment, {
    ...configuration.libpqEnvironment,
    PGOPTIONS: '-c default_transaction_read_only=on',
  });
  assert.equal('DATABASE_URL' in configuration.libpqEnvironment, false);
  assert.equal('DIRECT_URL' in configuration.libpqEnvironment, false);
  assert.equal('PGSERVICE' in configuration.libpqEnvironment, false);
});

test('rejects remote, Supabase, mismatched, unconfirmed, and unsafe database targets', () => {
  const args = ['post-upgrade-assert', `--confirm-database=${DATABASE}`];
  for (const environment of [
    localEnvironment({
      DIRECT_URL: `postgresql://restore_user:secret@db.abcdefghijklmnopqrst.supabase.co:5432/${DATABASE}`,
    }),
    localEnvironment({
      DIRECT_URL: `postgresql://restore_user:secret@192.168.1.5:5432/${DATABASE}`,
    }),
    localEnvironment({
      DIRECT_URL: `postgresql://different_user:secret@127.0.0.1:5432/${DATABASE}`,
    }),
    localEnvironment({
      DIRECT_URL: `postgresql://restore_user:secret@127.0.0.1:5433/${DATABASE}`,
    }),
    localEnvironment({
      DIRECT_URL: 'postgresql://restore_user:secret@127.0.0.1:5432/supplier',
    }),
    {
      DATABASE_URL: 'postgresql://restore_user:secret@127.0.0.1:5432/supplier',
      DIRECT_URL: 'postgresql://restore_user:secret@127.0.0.1:5432/supplier',
    },
    localEnvironment({
      DIRECT_URL: `postgresql://restore_user@127.0.0.1:5432/${DATABASE}`,
    }),
  ]) {
    assert.throws(() => readRestoreRehearsalConfiguration(args, environment));
  }

  assert.throws(
    () =>
      readRestoreRehearsalConfiguration(
        ['post-upgrade-assert', '--confirm-database=supplier_restore_other'],
        localEnvironment(),
      ),
    /must exactly match/,
  );
});

test('accepts each exact loopback hostname but requires both URLs to use the same one', () => {
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    const environment = localEnvironment({
      DATABASE_URL: `postgresql://restore_user:secret@${host}:5432/${DATABASE}`,
      DIRECT_URL: `postgresql://restore_user:secret@${host}:5432/${DATABASE}`,
    });
    assert.equal(
      readRestoreRehearsalConfiguration(
        ['post-upgrade-assert', `--confirm-database=${DATABASE}`],
        environment,
      ).database,
      DATABASE,
    );
  }

  assert.throws(() =>
    readRestoreRehearsalConfiguration(
      ['post-upgrade-assert', `--confirm-database=${DATABASE}`],
      localEnvironment({
        DATABASE_URL: `postgresql://restore_user:secret@localhost:5432/${DATABASE}`,
      }),
    ),
  );
});

test('rejects symlink and non-regular archives before starting libpq', async (context) => {
  const directory = await temporaryDirectory(context);
  const regular = join(directory, 'regular.dump');
  const linked = join(directory, 'linked.dump');
  const archiveDirectory = join(directory, 'directory.dump');
  await writeFile(regular, 'archive');
  await symlink(regular, linked);
  await mkdir(archiveDirectory);

  for (const archive of [linked, archiveDirectory]) {
    const fake = createFakeSpawn();
    await assert.rejects(
      runRestoreRehearsal({
        args: ['restore', `--archive=${archive}`, `--confirm-database=${DATABASE}`],
        environment: localEnvironment(),
        spawnSync: fake.spawnSync,
      }),
      /regular non-symlink/,
    );
    assert.equal(fake.calls.length, 0);
  }
});

test('inspects, confirms, initializes, and restores in a fixed order without DSNs in argv', async (context) => {
  const directory = await temporaryDirectory(context);
  const archive = join(directory, 'staging.dump');
  await writeFile(archive, 'archive');
  const fake = createFakeSpawn();

  const result = await runRestoreRehearsal({
    args: ['restore', `--archive=${archive}`, `--confirm-database=${DATABASE}`],
    environment: localEnvironment(),
    spawnSync: fake.spawnSync,
  });
  const operations = fake.calls.filter(({ args }) => args[0] !== '--version');

  assert.deepEqual(result, {
    action: 'restore',
    archive,
    database: DATABASE,
    archiveEntryCount: 4,
  });
  assert.deepEqual(operations.map(describeOperation), [
    'pg_restore:list',
    'psql:database-check',
    'psql:init-roles',
    'pg_restore:restore',
  ]);
  for (const call of fake.calls) {
    assert.equal(call.command, join(LIBPQ_BIN_DIR, basename(call.command)));
  }
  for (const call of operations) {
    const argv = call.args.join(' ');
    assert.doesNotMatch(argv, /postgres(?:ql)?:\/\//);
    assert.doesNotMatch(argv, new RegExp(PASSWORD));
    assert.equal(call.options.maxBuffer, 4 * 1024 * 1024);
    assert.equal(call.options.killSignal, 'SIGTERM');
  }
  for (const call of fake.calls.filter(({ args }) => args[0] === '--version')) {
    assert.equal(call.options.timeout, 30_000);
    assert.equal(call.options.maxBuffer, 4 * 1024 * 1024);
    assert.equal(call.options.killSignal, 'SIGTERM');
  }

  const queryCall = operations[1];
  assert.equal(operations[0].options.timeout, 60_000);
  assert.equal(queryCall.options.timeout, 60_000);
  assert.equal(operations[2].options.timeout, 60_000);
  assert.equal(operations[3].options.timeout, 300_000);
  assert.equal(queryCall.options.env.PGOPTIONS, '-c default_transaction_read_only=on');
  assert.equal('PGOPTIONS' in operations[2].options.env, false);
  assert.equal('PGOPTIONS' in operations[3].options.env, false);
  assert.deepEqual(operations[3].args, [
    '--clean',
    '--if-exists',
    '--single-transaction',
    '--no-owner',
    '--no-privileges',
    '--no-password',
    '--dbname',
    DATABASE,
    archive,
  ]);
});

test('stops restore before mutation when archive or connected database validation fails', async (context) => {
  const directory = await temporaryDirectory(context);
  const archive = join(directory, 'staging.dump');
  await writeFile(archive, 'archive');

  for (const failure of [
    {
      fake: createFakeSpawn({ archiveList: '; empty\n' }),
      pattern: /empty archive list/,
      operations: ['pg_restore:list'],
    },
    {
      fake: createFakeSpawn({ currentDatabase: 'supplier_restore_wrong' }),
      pattern: /does not match/,
      operations: ['pg_restore:list', 'psql:database-check'],
    },
    {
      fake: createFakeSpawn({ serverVersionNum: 160_009 }),
      pattern: /server must be major version 17/,
      operations: ['pg_restore:list', 'psql:database-check'],
    },
    {
      fake: createFakeSpawn({ serverAddress: '192.0.2.10' }),
      pattern: /server must use a loopback address/,
      operations: ['pg_restore:list', 'psql:database-check'],
    },
    {
      fake: createFakeSpawn({ initResult: successfulResult({ status: 7 }) }),
      pattern: /init-supabase-roles\.sql failed with status 7/,
      operations: ['pg_restore:list', 'psql:database-check', 'psql:init-roles'],
    },
  ]) {
    await assert.rejects(
      runRestoreRehearsal({
        args: ['restore', `--archive=${archive}`, `--confirm-database=${DATABASE}`],
        environment: localEnvironment(),
        spawnSync: failure.fake.spawnSync,
      }),
      failure.pattern,
    );
    assert.deepEqual(
      failure.fake.calls.filter(({ args }) => args[0] !== '--version').map(describeOperation),
      failure.operations,
    );
  }
});

test('runs fixed assertions with least-privilege environments and stops at the first failure', async () => {
  const successful = createFakeSpawn();
  const result = await runRestoreRehearsal({
    args: ['post-upgrade-assert', `--confirm-database=${DATABASE}`],
    environment: localEnvironment(),
    spawnSync: successful.spawnSync,
  });
  const operations = successful.calls.filter(({ args }) => args[0] !== '--version');
  const assertionCalls = operations.slice(1);

  assert.equal(describeOperation(operations[0]), 'psql:database-check');
  assert.deepEqual(
    assertionCalls.map(({ args }) => basename(args.at(-1))),
    EXPECTED_ASSERTIONS,
  );
  assert.deepEqual(result.completedAssertions, EXPECTED_ASSERTIONS);
  for (const call of assertionCalls) {
    if (basename(call.args.at(-1)) === 'assert-workflow-check-constraints.sql') {
      assert.equal('PGOPTIONS' in call.options.env, false);
    } else {
      assert.equal(call.options.env.PGOPTIONS, '-c default_transaction_read_only=on');
    }
    assert.equal(call.options.timeout, 60_000);
  }

  const failing = createFakeSpawn({ assertionStatuses: [0, 8, 0] });
  await assert.rejects(
    runRestoreRehearsal({
      args: ['post-upgrade-assert', `--confirm-database=${DATABASE}`],
      environment: localEnvironment(),
      spawnSync: failing.spawnSync,
    }),
    /assert-workflow-check-constraints\.sql failed with status 8/,
  );
  assert.deepEqual(
    failing.calls.filter(({ args }) => args[0] !== '--version').map(describeOperation),
    ['psql:database-check', 'psql:assert', 'psql:assert'],
  );

  const timeoutError = Object.assign(new Error(`must not expose ${PASSWORD}`), {
    code: 'ETIMEDOUT',
  });
  const timingOut = createFakeSpawn({
    assertionResults: [
      successfulResult(),
      successfulResult({ error: timeoutError, signal: 'SIGTERM', status: null }),
    ],
  });
  await assert.rejects(
    runRestoreRehearsal({
      args: ['post-upgrade-assert', `--confirm-database=${DATABASE}`],
      environment: localEnvironment(),
      spawnSync: timingOut.spawnSync,
    }),
    (error) => {
      assert.match(error.message, /could not start \(ETIMEDOUT\)/);
      assert.doesNotMatch(error.message, new RegExp(PASSWORD));
      return true;
    },
  );
  assert.deepEqual(
    timingOut.calls.filter(({ args }) => args[0] !== '--version').map(describeOperation),
    ['psql:database-check', 'psql:assert', 'psql:assert'],
  );
});

test('refuses non-17 libpq before connecting to the restore database', async () => {
  const calls = [];
  const spawnSync = (command, args, options) => {
    calls.push({ command, args, options });
    return successfulResult({ stdout: `${basename(command)} (PostgreSQL) 16.9\n` });
  };

  await assert.rejects(
    runRestoreRehearsal({
      args: ['post-upgrade-assert', `--confirm-database=${DATABASE}`],
      environment: localEnvironment(),
      spawnSync,
    }),
    /must be PostgreSQL 17/,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, join(LIBPQ_BIN_DIR, 'psql'));
  assert.deepEqual(calls[0].args, ['--version']);
});

function describeOperation({ command, args }) {
  const tool = basename(command);
  if (tool === 'pg_restore') return args[0] === '--list' ? 'pg_restore:list' : 'pg_restore:restore';
  if (args.some((arg) => arg.includes('server_version_num'))) return 'psql:database-check';
  if (basename(args.at(-1)) === 'init-supabase-roles.sql') return 'psql:init-roles';
  return 'psql:assert';
}
