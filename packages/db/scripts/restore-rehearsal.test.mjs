import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';

import {
  DOCKER_BIN_PATH,
  LIBPQ_BIN_DIR,
  POSTGRES_17_IMAGE,
  POSTGRES_17_IMAGE_ID,
  PRISMA_CLI_PATH,
  PRISMA_SCHEMA_PATH,
  REPOSITORY_ROOT,
  readRestoreRehearsalConfiguration,
  readRestoreRehearsalOptions,
  runRestoreRehearsal,
} from './restore-rehearsal.mjs';

const DATABASE = 'supplier_restore_release_9c937ef';
const CONTAINER = 'supplier-restore-release-pg17';
const CONTAINER_ID = 'a'.repeat(64);
const PASSWORD = 'local:p@ssword';
const DOCKER_CHECKS = ['docker:context', 'docker:image', 'docker:container'];
const FIRST_DOCKER_CHECKS = ['docker:context-show', ...DOCKER_CHECKS];
const EXPECTED_ASSERTIONS = Object.freeze([
  'assert-public-schema-isolation.sql',
  'assert-workflow-check-constraints.sql',
  'assert-33-to-43-upgrade-data.sql',
]);
const EXPECTED_FORWARD_ASSERTIONS = Object.freeze([
  'assert-43-to-44-sku-edits.sql',
  'assert-44-to-45-runtime-state.sql',
]);
const ARCHIVE_LIST = `
; local restore rehearsal fixture
1; 1259 1 TABLE public _prisma_migrations postgres
2; 0 1 TABLE DATA public _prisma_migrations postgres
3; 1259 2 TABLE public source_products postgres
4; 0 2 TABLE DATA public source_products postgres
`;
const PRISMA_MIGRATIONS_PATH = join(dirname(PRISMA_SCHEMA_PATH), 'migrations');
const EXPECTED_MIGRATION_BASELINE = await readExpectedMigrationBaseline(33);
const EXPECTED_HISTORICAL_MIGRATION_BASELINE = await readExpectedMigrationBaseline(43);

async function readExpectedMigrationBaseline(count) {
  const entries = await readdir(PRISMA_MIGRATIONS_PATH, { withFileTypes: true });
  const migrationNames = entries
    .filter((entry) => entry.isDirectory() && /^\d{14}_[a-z0-9_]+$/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .slice(0, count);
  return Promise.all(
    migrationNames.map(async (migrationName) => ({
      migrationName,
      checksum: createHash('sha256')
        .update(await readFile(join(PRISMA_MIGRATIONS_PATH, migrationName, 'migration.sql')))
        .digest('hex'),
      appliedStepsCount: 1,
      finished: true,
      rolledBack: false,
    })),
  );
}

function localEnvironment(overrides = {}) {
  return {
    DATABASE_URL: `postgresql://restore_user:local%3Ap%40ssword@127.0.0.1:5432/${DATABASE}?schema=public`,
    DIRECT_URL: `postgresql://restore_user:local%3Ap%40ssword@127.0.0.1:5432/${DATABASE}`,
    PGHOST: 'remote.invalid',
    PGSERVICE: 'unsafe-service',
    NODE_OPTIONS: '--require=/tmp/unsafe.cjs',
    NODE_PATH: '/tmp/unsafe-node-modules',
    DOCKER_HOST: 'tcp://attacker.invalid:2376',
    DOCKER_CONTEXT: 'remote-context',
    PRISMA_SCHEMA_ENGINE_BINARY: '/tmp/unsafe-schema-engine',
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

function restoreArgs(archive) {
  return [
    'restore',
    `--archive=${archive}`,
    `--confirm-database=${DATABASE}`,
    `--confirm-container=${CONTAINER}`,
  ];
}

function rehearsalArgs(archive) {
  return [
    'rehearse',
    `--archive=${archive}`,
    `--confirm-database=${DATABASE}`,
    `--confirm-container=${CONTAINER}`,
  ];
}

function assertionArgs() {
  return [
    'post-upgrade-assert',
    `--confirm-database=${DATABASE}`,
    `--confirm-container=${CONTAINER}`,
  ];
}

function forwardRehearsalArgs() {
  return [
    'rehearse-forward-sku-edits',
    `--confirm-database=${DATABASE}`,
    `--confirm-container=${CONTAINER}`,
  ];
}

function dockerContainer(overrides = {}) {
  return {
    id: CONTAINER_ID,
    running: true,
    autoRemove: true,
    imageId: POSTGRES_17_IMAGE_ID,
    imageRef: POSTGRES_17_IMAGE,
    entrypoint: ['docker-entrypoint.sh'],
    cmd: ['postgres'],
    labels: { 'com.supplier.restore-database': DATABASE },
    ports: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '5432' }] },
    tmpfs: { '/var/lib/postgresql/data': 'rw,noexec,nosuid,size=256m' },
    mounts: [],
    ...overrides,
  };
}

function createFakeSpawn({
  archiveList = ARCHIVE_LIST,
  currentDatabase = DATABASE,
  serverVersionNum = 170_010,
  dataDirectory = '/var/lib/postgresql/data',
  userObjectCount = 0,
  prismaMigrationTableExists = false,
  databaseProbes = [],
  migrationBaseline = EXPECTED_MIGRATION_BASELINE,
  dockerContextName = 'colima',
  dockerContextHost = 'unix:///Users/test/.colima/default/docker.sock',
  dockerContextHosts = [dockerContextHost],
  dockerImageId = POSTGRES_17_IMAGE_ID,
  dockerContainers = [dockerContainer()],
  initResult,
  restoreResult,
  assertionResults = [],
  assertionStatuses = [],
  prismaResults = {},
  onCall,
} = {}) {
  const calls = [];
  let assertionIndex = 0;
  let containerIndex = 0;
  let contextIndex = 0;
  let databaseProbeIndex = 0;
  const spawnSync = (command, args, options) => {
    calls.push({ command, args, options });
    onCall?.({ args, command, options });
    const tool = basename(command);
    if (args.length === 1 && args[0] === '--version') {
      return successfulResult({ stdout: `${tool} (PostgreSQL) 17.10\n` });
    }
    if (tool === 'docker' && args[0] === 'context' && args[1] === 'show') {
      return successfulResult({ stdout: `${dockerContextName}\n` });
    }
    if (tool === 'docker' && args[0] === 'context' && args[1] === 'inspect') {
      const contextHost =
        dockerContextHosts[Math.min(contextIndex++, dockerContextHosts.length - 1)];
      return successfulResult({ stdout: `${JSON.stringify(contextHost)}\n` });
    }
    if (tool === 'docker' && args[0] === '--context' && args[2] === 'image') {
      return successfulResult({ stdout: `${JSON.stringify(dockerImageId)}\n` });
    }
    if (tool === 'docker' && args[0] === '--context' && args[2] === 'container') {
      const inspected = dockerContainers[Math.min(containerIndex++, dockerContainers.length - 1)];
      return successfulResult({ stdout: `${JSON.stringify(inspected)}\n` });
    }
    if (tool === 'pg_restore' && args.includes('--list')) {
      return successfulResult({ stdout: archiveList });
    }
    if (tool === 'psql' && args.some((arg) => arg.includes('server_version_num'))) {
      const probe = databaseProbes[databaseProbeIndex++] ?? {
        currentDatabase,
        serverVersionNum,
        dataDirectory,
        userObjectCount,
        prismaMigrationTableExists,
      };
      return successfulResult({
        stdout: `${JSON.stringify({
          database: probe.currentDatabase ?? currentDatabase,
          serverVersionNum: probe.serverVersionNum ?? serverVersionNum,
          dataDirectory: probe.dataDirectory ?? dataDirectory,
          userObjectCount: probe.userObjectCount ?? userObjectCount,
          prismaMigrationTableExists:
            probe.prismaMigrationTableExists ?? prismaMigrationTableExists,
        })}\n`,
      });
    }
    if (tool === 'psql' && args.some((arg) => arg.includes('FROM public._prisma_migrations'))) {
      return successfulResult({ stdout: `${JSON.stringify(migrationBaseline)}\n` });
    }
    if (tool === 'psql' && basename(args.at(-1)) === 'init-supabase-roles.sql') {
      return initResult ?? successfulResult();
    }
    if (tool === 'psql' && args.includes('--file')) {
      if (assertionResults[assertionIndex]) return assertionResults[assertionIndex++];
      return successfulResult({ status: assertionStatuses[assertionIndex++] ?? 0 });
    }
    if (tool === 'pg_restore') return restoreResult ?? successfulResult();
    if (command === process.execPath && args[0] === PRISMA_CLI_PATH) {
      const operation = args.slice(1, 3).join(' ');
      return prismaResults[operation] ?? successfulResult();
    }
    throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
  };
  return { calls, spawnSync };
}

async function temporaryDirectory(context) {
  const directory = await mkdtemp(join(tmpdir(), 'supplier-restore-rehearsal-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('accepts only the four closed restore operations with exact arguments', () => {
  assert.deepEqual(
    readRestoreRehearsalOptions([
      'rehearse',
      '--archive=/private/tmp/staging.dump',
      `--confirm-database=${DATABASE}`,
      `--confirm-container=${CONTAINER}`,
    ]),
    {
      action: 'rehearse',
      archive: '/private/tmp/staging.dump',
      confirmedContainer: CONTAINER,
      confirmedDatabase: DATABASE,
    },
  );
  assert.deepEqual(
    readRestoreRehearsalOptions([
      'restore',
      '--archive=/private/tmp/staging.dump',
      `--confirm-database=${DATABASE}`,
      `--confirm-container=${CONTAINER}`,
    ]),
    {
      action: 'restore',
      archive: '/private/tmp/staging.dump',
      confirmedContainer: CONTAINER,
      confirmedDatabase: DATABASE,
    },
  );
  assert.deepEqual(readRestoreRehearsalOptions(assertionArgs()), {
    action: 'post-upgrade-assert',
    confirmedContainer: CONTAINER,
    confirmedDatabase: DATABASE,
  });
  assert.deepEqual(readRestoreRehearsalOptions(forwardRehearsalArgs()), {
    action: 'rehearse-forward-sku-edits',
    confirmedContainer: CONTAINER,
    confirmedDatabase: DATABASE,
  });

  for (const args of [
    [],
    [
      'restore',
      '--archive=relative.dump',
      `--confirm-database=${DATABASE}`,
      `--confirm-container=${CONTAINER}`,
    ],
    [
      'restore',
      '--archive=/private/tmp/staging.sql',
      `--confirm-database=${DATABASE}`,
      `--confirm-container=${CONTAINER}`,
    ],
    ['restore', '--archive=/private/tmp/staging.dump', `--confirm-database=${DATABASE}`],
    [...assertionArgs(), '--file=unsafe.sql'],
    ['post-upgrade-assert', `--confirm-database=${DATABASE}`],
    [...forwardRehearsalArgs(), '--archive=/private/tmp/staging.dump'],
    ['psql', `--confirm-database=${DATABASE}`, `--confirm-container=${CONTAINER}`],
    ['post-upgrade-assert', `--confirm-database=${DATABASE}`, '--confirm-container=unsafe/name'],
  ]) {
    assert.throws(() => readRestoreRehearsalOptions(args));
  }
});

test('accepts only an exactly confirmed local restore database with minimal child environments', () => {
  const configuration = readRestoreRehearsalConfiguration(assertionArgs(), localEnvironment());

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
  assert.deepEqual(configuration.prismaEnvironment, {
    DATABASE_URL: `postgresql://restore_user:local%3Ap%40ssword@127.0.0.1:5432/${DATABASE}?schema=public&connect_timeout=10&sslmode=disable`,
    DIRECT_URL: `postgresql://restore_user:local%3Ap%40ssword@127.0.0.1:5432/${DATABASE}?schema=public&connect_timeout=10&sslmode=disable`,
    LC_ALL: 'C',
    PRISMA_HIDE_UPDATE_MESSAGE: '1',
  });
  assert.equal('PGHOST' in configuration.prismaEnvironment, false);
  assert.equal('PGSERVICE' in configuration.prismaEnvironment, false);
});

test('rejects remote, Supabase, mismatched, unconfirmed, and unsafe database targets', () => {
  const args = assertionArgs();
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
      DIRECT_URL: `postgresql://restore_user:different@127.0.0.1:5432/${DATABASE}`,
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
    localEnvironment({
      DIRECT_URL: `postgresql://restore%00_user:secret@127.0.0.1:5432/${DATABASE}`,
    }),
    localEnvironment({
      DIRECT_URL: `postgresql://restore_user:secret%00@127.0.0.1:5432/${DATABASE}`,
    }),
    localEnvironment({
      DIRECT_URL: `postgresql://restore_user:secret@127.0.0.1:5432/${DATABASE}%00`,
    }),
  ]) {
    assert.throws(() => readRestoreRehearsalConfiguration(args, environment));
  }

  assert.throws(
    () =>
      readRestoreRehearsalConfiguration(
        [
          'post-upgrade-assert',
          '--confirm-database=supplier_restore_other',
          `--confirm-container=${CONTAINER}`,
        ],
        localEnvironment(),
      ),
    /must exactly match/,
  );
});

test('rejects mismatched passwords and decoded NUL values with fixed errors', () => {
  assert.throws(
    () =>
      readRestoreRehearsalConfiguration(
        assertionArgs(),
        localEnvironment({
          DIRECT_URL: `postgresql://restore_user:different@127.0.0.1:5432/${DATABASE}`,
        }),
      ),
    /must use the same local password/,
  );

  for (const [field, directUrl] of [
    ['username', `postgresql://restore%00_user:local%3Ap%40ssword@127.0.0.1:5432/${DATABASE}`],
    ['password', `postgresql://restore_user:local%3Ap%40ssword%00@127.0.0.1:5432/${DATABASE}`],
    ['database', `postgresql://restore_user:local%3Ap%40ssword@127.0.0.1:5432/${DATABASE}%00`],
  ]) {
    assert.throws(
      () =>
        readRestoreRehearsalConfiguration(
          assertionArgs(),
          localEnvironment({ DIRECT_URL: directUrl }),
        ),
      new RegExp(`DIRECT_URL ${field} must not contain NUL`),
    );
  }
});

test('accepts only numeric loopback hosts and requires both URLs to use the same one', () => {
  for (const host of ['127.0.0.1', '[::1]']) {
    const environment = localEnvironment({
      DATABASE_URL: `postgresql://restore_user:secret@${host}:5432/${DATABASE}`,
      DIRECT_URL: `postgresql://restore_user:secret@${host}:5432/${DATABASE}`,
    });
    assert.equal(
      readRestoreRehearsalConfiguration(assertionArgs(), environment).database,
      DATABASE,
    );
  }

  assert.throws(() =>
    readRestoreRehearsalConfiguration(
      assertionArgs(),
      localEnvironment({
        DATABASE_URL: `postgresql://restore_user:secret@localhost:5432/${DATABASE}`,
        DIRECT_URL: `postgresql://restore_user:secret@localhost:5432/${DATABASE}`,
      }),
    ),
  );

  assert.throws(() =>
    readRestoreRehearsalConfiguration(
      assertionArgs(),
      localEnvironment({
        DIRECT_URL: `postgresql://restore_user:secret@[::1]:5432/${DATABASE}`,
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
        args: restoreArgs(archive),
        environment: localEnvironment(),
        spawnSync: fake.spawnSync,
      }),
      /regular non-symlink/,
    );
    assert.equal(fake.calls.length, 0);
  }
});

test('rejects Prisma dotenv overrides before any restore or child process starts', async (context) => {
  const directory = await temporaryDirectory(context);
  const archive = join(directory, 'staging.dump');
  const unsafeDotenv = join(directory, '.env');
  await writeFile(archive, 'archive');
  await writeFile(
    unsafeDotenv,
    'PRISMA_SCHEMA_ENGINE_BINARY=/private/tmp/must-not-run-secret-engine\n',
  );
  const fake = createFakeSpawn();

  await assert.rejects(
    runRestoreRehearsal({
      args: rehearsalArgs(archive),
      environment: localEnvironment(),
      prismaDotenvCandidates: [unsafeDotenv],
      spawnSync: fake.spawnSync,
    }),
    (error) => {
      assert.match(error.message, /Prisma dotenv safety check failed/);
      assert.doesNotMatch(error.message, /must-not-run-secret-engine/);
      return true;
    },
  );
  assert.equal(fake.calls.length, 0);
});

test('inspects, confirms, initializes, and restores in a fixed order without DSNs in argv', async (context) => {
  const directory = await temporaryDirectory(context);
  const archive = join(directory, 'staging.dump');
  await writeFile(archive, 'archive');
  const fake = createFakeSpawn();

  const result = await runRestoreRehearsal({
    args: restoreArgs(archive),
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
    ...FIRST_DOCKER_CHECKS,
    'pg_restore:list',
    'psql:database-check',
    ...DOCKER_CHECKS,
    'psql:init-roles',
    ...DOCKER_CHECKS,
    'pg_restore:restore',
  ]);
  for (const call of fake.calls) {
    assert.equal(
      call.command,
      basename(call.command) === 'docker'
        ? DOCKER_BIN_PATH
        : join(LIBPQ_BIN_DIR, basename(call.command)),
    );
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

  const dockerCalls = operations.filter(({ command }) => basename(command) === 'docker');
  for (const call of dockerCalls) {
    assert.equal(call.options.timeout, 30_000);
    assert.equal('DOCKER_HOST' in call.options.env, false);
    assert.equal('DOCKER_CONTEXT' in call.options.env, false);
    assert.doesNotMatch(call.args.join(' '), new RegExp(PASSWORD));
  }
  const contextCalls = dockerCalls.filter(
    ({ args }) => args[0] === 'context' && args[1] === 'inspect',
  );
  assert.equal(contextCalls[0].args[2], 'colima');
  const scopedDockerCalls = dockerCalls.filter(({ args }) => args[0] === '--context');
  for (const call of scopedDockerCalls) assert.equal(call.args[1], 'colima');
  const containerCalls = dockerCalls.filter(({ args }) => args[2] === 'container');
  assert.equal(containerCalls[0].args.at(-1), CONTAINER);
  for (const call of containerCalls.slice(1)) assert.equal(call.args.at(-1), CONTAINER_ID);

  const listCall = operations.find((call) => describeOperation(call) === 'pg_restore:list');
  const queryCall = operations.find((call) => describeOperation(call) === 'psql:database-check');
  const initCall = operations.find((call) => describeOperation(call) === 'psql:init-roles');
  const restoreCall = operations.find((call) => describeOperation(call) === 'pg_restore:restore');
  assert.equal(listCall.options.timeout, 60_000);
  assert.equal(queryCall.options.timeout, 60_000);
  assert.equal(initCall.options.timeout, 60_000);
  assert.equal(restoreCall.options.timeout, 300_000);
  assert.equal(queryCall.options.env.PGOPTIONS, '-c default_transaction_read_only=on');
  assert.equal('PGOPTIONS' in initCall.options.env, false);
  assert.equal('PGOPTIONS' in restoreCall.options.env, false);
  assert.deepEqual(listCall.args, ['--format=custom', '--list', '/dev/fd/3']);
  assert.equal(listCall.options.stdio.length, 4);
  assert.equal(Number.isInteger(listCall.options.stdio[3]), true);
  assert.deepEqual(restoreCall.args, [
    '--format=custom',
    '--clean',
    '--if-exists',
    '--single-transaction',
    '--no-owner',
    '--no-privileges',
    '--no-password',
    '--dbname',
    DATABASE,
    '/dev/fd/3',
  ]);
  assert.equal(restoreCall.options.stdio.length, 4);
  assert.equal(Number.isInteger(restoreCall.options.stdio[3]), true);
});

test('uses one private archive after the original path is replaced and removes it', async (context) => {
  const directory = await temporaryDirectory(context);
  const archive = join(directory, 'staging.dump');
  const movedArchive = join(directory, 'moved.dump');
  const replacement = join(directory, 'replacement.dump');
  await writeFile(archive, 'original archive');
  await writeFile(replacement, 'replacement archive');
  const privateDirectoriesBefore = new Set(
    (await readdir(tmpdir())).filter((entry) => entry.startsWith('supplier-restore-archive-')),
  );
  let replaced = false;
  const inheritedArchiveBytes = [];
  const fake = createFakeSpawn({
    onCall: ({ args, command, options }) => {
      if (basename(command) === 'pg_restore' && args[0] !== '--version') {
        const buffer = Buffer.alloc(1);
        assert.equal(readSync(options.stdio[3], buffer, 0, 1, null), 1);
        inheritedArchiveBytes.push(buffer.toString());
      }
      if (!replaced && basename(command) === 'pg_restore' && args.includes('--list')) {
        renameSync(archive, movedArchive);
        renameSync(replacement, archive);
        replaced = true;
      }
    },
  });

  const result = await runRestoreRehearsal({
    args: restoreArgs(archive),
    environment: localEnvironment(),
    spawnSync: fake.spawnSync,
  });

  assert.equal(replaced, true);
  assert.equal(await readFile(archive, 'utf8'), 'replacement archive');
  assert.equal(result.archive, archive);
  const archiveCalls = fake.calls.filter(
    ({ args, command }) => basename(command) === 'pg_restore' && args[0] !== '--version',
  );
  assert.deepEqual(
    archiveCalls.map(({ args }) => args.at(-1)),
    ['/dev/fd/3', '/dev/fd/3'],
  );
  assert.deepEqual(inheritedArchiveBytes, ['o', 'o']);
  const privateDirectoriesAfter = new Set(
    (await readdir(tmpdir())).filter((entry) => entry.startsWith('supplier-restore-archive-')),
  );
  assert.deepEqual(privateDirectoriesAfter, privateDirectoriesBefore);
});

test('rejects a changed private archive before restore and removes the copy', async (context) => {
  const directory = await temporaryDirectory(context);
  const archive = join(directory, 'staging.dump');
  await writeFile(archive, 'original archive');
  const privateDirectoriesBefore = new Set(
    (await readdir(tmpdir())).filter((entry) => entry.startsWith('supplier-restore-archive-')),
  );
  let privateArchivePath;
  const fake = createFakeSpawn({
    onCall: ({ args, command }) => {
      if (basename(command) !== 'pg_restore' || !args.includes('--list')) return;
      const privateDirectory = readdirSync(tmpdir()).find(
        (entry) =>
          entry.startsWith('supplier-restore-archive-') && !privateDirectoriesBefore.has(entry),
      );
      assert.ok(privateDirectory);
      privateArchivePath = join(tmpdir(), privateDirectory, 'archive.dump');
      assert.equal(readFileSync(privateArchivePath, 'utf8'), 'original archive');
      writeFileSync(privateArchivePath, 'changed archive');
    },
  });

  await assert.rejects(
    runRestoreRehearsal({
      args: restoreArgs(archive),
      environment: localEnvironment(),
      spawnSync: fake.spawnSync,
    }),
    /Private restore archive copy changed before use/,
  );

  assert.ok(privateArchivePath);
  assert.equal(
    fake.calls.filter(
      ({ args, command }) => basename(command) === 'pg_restore' && args[0] !== '--version',
    ).length,
    1,
  );
  const privateDirectoriesAfter = new Set(
    (await readdir(tmpdir())).filter((entry) => entry.startsWith('supplier-restore-archive-')),
  );
  assert.deepEqual(privateDirectoriesAfter, privateDirectoriesBefore);
});

test('runs restore, migration verification, and assertions against one fixed container ID', async (context) => {
  const directory = await temporaryDirectory(context);
  const archive = join(directory, 'staging.dump');
  await writeFile(archive, 'archive');
  const fake = createFakeSpawn({
    databaseProbes: [
      { userObjectCount: 0, prismaMigrationTableExists: false },
      { userObjectCount: 4, prismaMigrationTableExists: true },
      { userObjectCount: 8, prismaMigrationTableExists: true },
    ],
  });

  const result = await runRestoreRehearsal({
    args: rehearsalArgs(archive),
    environment: localEnvironment({
      DATABASE_URL: `postgresql://restore_user:local%3Ap%40ssword@127.0.0.1:5432/${DATABASE}?schema=unsafe`,
      DIRECT_URL: `postgresql://restore_user:local%3Ap%40ssword@127.0.0.1:5432/${DATABASE}?connect_timeout=999`,
    }),
    spawnSync: fake.spawnSync,
  });
  const operations = fake.calls.filter(({ args }) => args[0] !== '--version');

  assert.deepEqual(result, {
    action: 'rehearse',
    archive,
    database: DATABASE,
    archiveEntryCount: 4,
    completedAssertions: EXPECTED_ASSERTIONS,
    prismaChecks: ['migrate deploy', 'migrate status', 'migrate diff'],
  });
  assert.deepEqual(operations.map(describeOperation), [
    ...FIRST_DOCKER_CHECKS,
    'pg_restore:list',
    'psql:database-check',
    ...DOCKER_CHECKS,
    'psql:init-roles',
    ...DOCKER_CHECKS,
    'pg_restore:restore',
    ...DOCKER_CHECKS,
    'psql:database-check',
    'psql:migration-baseline',
    ...DOCKER_CHECKS,
    'prisma:migrate deploy',
    ...DOCKER_CHECKS,
    'prisma:migrate status',
    ...DOCKER_CHECKS,
    'prisma:migrate diff',
    ...DOCKER_CHECKS,
    'psql:database-check',
    ...DOCKER_CHECKS,
    'psql:assert',
    ...DOCKER_CHECKS,
    'psql:assert',
    ...DOCKER_CHECKS,
    'psql:assert',
  ]);

  const containerCalls = operations.filter(
    ({ command, args }) => basename(command) === 'docker' && args[2] === 'container',
  );
  assert.equal(containerCalls[0].args.at(-1), CONTAINER);
  for (const call of containerCalls.slice(1)) assert.equal(call.args.at(-1), CONTAINER_ID);

  const prismaCalls = operations.filter(({ command }) => command === process.execPath);
  const historicalSchemaPath = prismaCalls[0].args.at(-1);
  assert.notEqual(historicalSchemaPath, PRISMA_SCHEMA_PATH);
  assert.match(historicalSchemaPath, /supplier-restore-migrations-43-[^/]+\/schema\.prisma$/);
  assert.deepEqual(
    prismaCalls.map(({ args }) => args),
    [
      [PRISMA_CLI_PATH, 'migrate', 'deploy', '--schema', historicalSchemaPath],
      [PRISMA_CLI_PATH, 'migrate', 'status', '--schema', historicalSchemaPath],
      [
        PRISMA_CLI_PATH,
        'migrate',
        'diff',
        '--exit-code',
        '--from-schema-datasource',
        historicalSchemaPath,
        '--to-schema-datamodel',
        historicalSchemaPath,
      ],
    ],
  );
  for (const call of prismaCalls) {
    assert.deepEqual(call.options.env, {
      DATABASE_URL: `postgresql://restore_user:local%3Ap%40ssword@127.0.0.1:5432/${DATABASE}?schema=public&connect_timeout=10&sslmode=disable`,
      DIRECT_URL: `postgresql://restore_user:local%3Ap%40ssword@127.0.0.1:5432/${DATABASE}?schema=public&connect_timeout=10&sslmode=disable`,
      LC_ALL: 'C',
      PRISMA_HIDE_UPDATE_MESSAGE: '1',
    });
    assert.equal(call.options.timeout, 300_000);
    assert.equal(call.options.cwd, REPOSITORY_ROOT);
    assert.doesNotMatch(call.args.join(' '), /postgres(?:ql)?:\/\//);
    assert.doesNotMatch(call.args.join(' '), new RegExp(PASSWORD));
  }
  await assert.rejects(readFile(historicalSchemaPath), { code: 'ENOENT' });
});

test('applies only migrations 44 and 45 to an exact local migration 43 baseline', async () => {
  const fake = createFakeSpawn({
    databaseProbes: [
      { userObjectCount: 8, prismaMigrationTableExists: true },
      { userObjectCount: 8, prismaMigrationTableExists: true },
    ],
    migrationBaseline: EXPECTED_HISTORICAL_MIGRATION_BASELINE,
  });

  const result = await runRestoreRehearsal({
    args: forwardRehearsalArgs(),
    environment: localEnvironment(),
    spawnSync: fake.spawnSync,
  });
  const operations = fake.calls.filter(({ args }) => args[0] !== '--version');

  assert.deepEqual(result, {
    action: 'rehearse-forward-sku-edits',
    database: DATABASE,
    completedAssertions: EXPECTED_FORWARD_ASSERTIONS,
    prismaChecks: ['migrate deploy', 'migrate status', 'migrate diff'],
  });
  assert.deepEqual(operations.map(describeOperation), [
    ...FIRST_DOCKER_CHECKS,
    'psql:database-check',
    'psql:migration-baseline',
    ...DOCKER_CHECKS,
    'prisma:migrate deploy',
    ...DOCKER_CHECKS,
    'prisma:migrate status',
    ...DOCKER_CHECKS,
    'prisma:migrate diff',
    ...DOCKER_CHECKS,
    'psql:database-check',
    ...DOCKER_CHECKS,
    'psql:assert',
    ...DOCKER_CHECKS,
    'psql:assert',
  ]);
  const prismaCalls = operations.filter(({ command }) => command === process.execPath);
  assert.deepEqual(
    prismaCalls.map(({ args }) => args),
    [
      [PRISMA_CLI_PATH, 'migrate', 'deploy', '--schema', PRISMA_SCHEMA_PATH],
      [PRISMA_CLI_PATH, 'migrate', 'status', '--schema', PRISMA_SCHEMA_PATH],
      [
        PRISMA_CLI_PATH,
        'migrate',
        'diff',
        '--exit-code',
        '--from-schema-datasource',
        PRISMA_SCHEMA_PATH,
        '--to-schema-datamodel',
        PRISMA_SCHEMA_PATH,
      ],
    ],
  );
  const assertionCall = operations.at(-1);
  assert.equal(assertionCall.options.env.PGOPTIONS, '-c default_transaction_read_only=on');
});

test('refuses the forward migration unless the local database exactly matches migration 43', async () => {
  const fake = createFakeSpawn({
    databaseProbes: [{ userObjectCount: 8, prismaMigrationTableExists: true }],
    migrationBaseline: EXPECTED_HISTORICAL_MIGRATION_BASELINE.slice(0, -1),
  });

  await assert.rejects(
    runRestoreRehearsal({
      args: forwardRehearsalArgs(),
      environment: localEnvironment(),
      spawnSync: fake.spawnSync,
    }),
    /exactly match the first 43 repository migrations/,
  );
  assert.equal(
    fake.calls.some((call) => describeOperation(call) === 'prisma:migrate deploy'),
    false,
  );
});

test('refuses migration when the restored state or original container identity is lost', async (context) => {
  const directory = await temporaryDirectory(context);
  const archive = join(directory, 'staging.dump');
  await writeFile(archive, 'archive');

  const emptyAfterRestore = createFakeSpawn({
    databaseProbes: [
      { userObjectCount: 0, prismaMigrationTableExists: false },
      { userObjectCount: 0, prismaMigrationTableExists: false },
    ],
  });
  await assert.rejects(
    runRestoreRehearsal({
      args: rehearsalArgs(archive),
      environment: localEnvironment(),
      spawnSync: emptyAfterRestore.spawnSync,
    }),
    /must be a restored database with _prisma_migrations/,
  );
  assert.equal(
    emptyAfterRestore.calls.some((call) => describeOperation(call) === 'prisma:migrate deploy'),
    false,
  );

  const wrongBaseline = createFakeSpawn({
    databaseProbes: [
      { userObjectCount: 0, prismaMigrationTableExists: false },
      { userObjectCount: 4, prismaMigrationTableExists: true },
    ],
    migrationBaseline: EXPECTED_MIGRATION_BASELINE.slice(0, -1),
  });
  await assert.rejects(
    runRestoreRehearsal({
      args: rehearsalArgs(archive),
      environment: localEnvironment(),
      spawnSync: wrongBaseline.spawnSync,
    }),
    /exactly match the first 33 repository migrations/,
  );
  assert.equal(
    wrongBaseline.calls.some((call) => describeOperation(call) === 'prisma:migrate deploy'),
    false,
  );

  const replacement = createFakeSpawn({
    dockerContainers: [
      dockerContainer(),
      dockerContainer(),
      dockerContainer(),
      dockerContainer({ id: 'b'.repeat(64) }),
    ],
  });
  await assert.rejects(
    runRestoreRehearsal({
      args: rehearsalArgs(archive),
      environment: localEnvironment(),
      spawnSync: replacement.spawnSync,
    }),
    /changed before mutation/,
  );
  assert.equal(
    replacement.calls.some((call) => describeOperation(call) === 'prisma:migrate deploy'),
    false,
  );
});

test('binds the restored baseline to exact repository names, checksums, and completed rows', async (context) => {
  const directory = await temporaryDirectory(context);
  const archive = join(directory, 'staging.dump');
  await writeFile(archive, 'archive');
  const cloneBaseline = () => EXPECTED_MIGRATION_BASELINE.map((migration) => ({ ...migration }));
  const failures = [
    (baseline) => baseline.reverse(),
    (baseline) => {
      baseline[0].checksum = 'b'.repeat(64);
      return baseline;
    },
    (baseline) => {
      baseline[0].appliedStepsCount = 0;
      return baseline;
    },
    (baseline) => {
      baseline[0].finished = false;
      return baseline;
    },
    (baseline) => {
      baseline[0].rolledBack = true;
      return baseline;
    },
    (baseline) => baseline.slice(0, -1),
  ];

  for (const corruptBaseline of failures) {
    const fake = createFakeSpawn({
      databaseProbes: [
        { userObjectCount: 0, prismaMigrationTableExists: false },
        { userObjectCount: 4, prismaMigrationTableExists: true },
      ],
      migrationBaseline: corruptBaseline(cloneBaseline()),
    });
    await assert.rejects(
      runRestoreRehearsal({
        args: rehearsalArgs(archive),
        environment: localEnvironment(),
        spawnSync: fake.spawnSync,
      }),
      /exactly match the first 33 repository migrations/,
    );
    assert.equal(
      fake.calls.some((call) => describeOperation(call) === 'prisma:migrate deploy'),
      false,
    );
  }
});

test('rejects extra directories, files, and symlinks in the migration root before deploy', async (context) => {
  const directory = await temporaryDirectory(context);
  const archive = join(directory, 'staging.dump');
  await writeFile(archive, 'archive');
  const migrationEntries = await readdir(PRISMA_MIGRATIONS_PATH, { withFileTypes: true });
  const unexpectedEntries = [
    { name: 'manual_hotfix', isDirectory: () => true, isFile: () => false },
    { name: 'notes.txt', isDirectory: () => false, isFile: () => true },
    { name: '20260806000000_symlink', isDirectory: () => false, isFile: () => false },
  ];

  for (const unexpectedEntry of unexpectedEntries) {
    const fake = createFakeSpawn({
      databaseProbes: [
        { userObjectCount: 0, prismaMigrationTableExists: false },
        { userObjectCount: 4, prismaMigrationTableExists: true },
      ],
    });
    await assert.rejects(
      runRestoreRehearsal({
        args: rehearsalArgs(archive),
        environment: localEnvironment(),
        readMigrationDirectory: async (path, options) => {
          assert.equal(path, PRISMA_MIGRATIONS_PATH);
          assert.deepEqual(options, { withFileTypes: true });
          return [...migrationEntries, unexpectedEntry];
        },
        spawnSync: fake.spawnSync,
      }),
      /unexpected Prisma migration entry/,
    );
    assert.equal(
      fake.calls.some((call) => describeOperation(call) === 'prisma:migrate deploy'),
      false,
    );
    assert.equal(
      fake.calls.some((call) => describeOperation(call) === 'psql:migration-baseline'),
      false,
    );
  }
});

test('stops restore before mutation when archive or connected database validation fails', async (context) => {
  const directory = await temporaryDirectory(context);
  const archive = join(directory, 'staging.dump');
  await writeFile(archive, 'archive');

  for (const failure of [
    {
      fake: createFakeSpawn({ archiveList: '; empty\n' }),
      pattern: /empty archive list/,
      operations: [...FIRST_DOCKER_CHECKS, 'pg_restore:list'],
    },
    {
      fake: createFakeSpawn({ currentDatabase: 'supplier_restore_wrong' }),
      pattern: /does not match/,
      operations: [...FIRST_DOCKER_CHECKS, 'pg_restore:list', 'psql:database-check'],
    },
    {
      fake: createFakeSpawn({ serverVersionNum: 160_009 }),
      pattern: /server must be major version 17/,
      operations: [...FIRST_DOCKER_CHECKS, 'pg_restore:list', 'psql:database-check'],
    },
    {
      fake: createFakeSpawn({ dataDirectory: '/tmp/postgres-data' }),
      pattern: /inspected tmpfs data directory/,
      operations: [...FIRST_DOCKER_CHECKS, 'pg_restore:list', 'psql:database-check'],
    },
    {
      fake: createFakeSpawn({ userObjectCount: 1 }),
      pattern: /must be empty/,
      operations: [...FIRST_DOCKER_CHECKS, 'pg_restore:list', 'psql:database-check'],
    },
    {
      fake: createFakeSpawn({
        dockerContainers: [dockerContainer(), dockerContainer({ id: 'b'.repeat(64) })],
      }),
      pattern: /changed before mutation/,
      operations: [
        ...FIRST_DOCKER_CHECKS,
        'pg_restore:list',
        'psql:database-check',
        ...DOCKER_CHECKS,
      ],
    },
    {
      fake: createFakeSpawn({ initResult: successfulResult({ status: 7 }) }),
      pattern: /init-supabase-roles\.sql failed with status 7/,
      operations: [
        ...FIRST_DOCKER_CHECKS,
        'pg_restore:list',
        'psql:database-check',
        ...DOCKER_CHECKS,
        'psql:init-roles',
      ],
    },
  ]) {
    await assert.rejects(
      runRestoreRehearsal({
        args: restoreArgs(archive),
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

test('rejects remote Docker contexts and non-disposable restore containers before connecting', async () => {
  const failures = [
    {
      fake: createFakeSpawn({ dockerContextHost: 'tcp://192.0.2.10:2376' }),
      pattern: /local Unix-socket Docker context/,
      operations: ['docker:context-show', 'docker:context'],
    },
    {
      fake: createFakeSpawn({ dockerImageId: `sha256:${'b'.repeat(64)}` }),
      pattern: /image ID does not match/,
      operations: ['docker:context-show', 'docker:context', 'docker:image'],
    },
    {
      fake: createFakeSpawn({
        dockerContextHosts: [
          'unix:///Users/test/.colima/default/docker.sock',
          'unix:///Users/test/.colima/replaced/docker.sock',
        ],
      }),
      pattern: /context endpoint changed/,
      operations: [...FIRST_DOCKER_CHECKS, 'psql:database-check', 'docker:context'],
    },
    {
      fake: createFakeSpawn({ dockerContainers: [dockerContainer({ running: false })] }),
      pattern: /running with automatic removal/,
      operations: FIRST_DOCKER_CHECKS,
    },
    {
      fake: createFakeSpawn({ dockerContainers: [dockerContainer({ autoRemove: false })] }),
      pattern: /running with automatic removal/,
      operations: FIRST_DOCKER_CHECKS,
    },
    {
      fake: createFakeSpawn({
        dockerContainers: [dockerContainer({ entrypoint: ['proxy-entrypoint'] })],
      }),
      pattern: /default PostgreSQL entrypoint/,
      operations: FIRST_DOCKER_CHECKS,
    },
    {
      fake: createFakeSpawn({
        dockerContainers: [
          dockerContainer({ labels: { 'com.supplier.restore-database': 'wrong' } }),
        ],
      }),
      pattern: /label must exactly match/,
      operations: FIRST_DOCKER_CHECKS,
    },
    {
      fake: createFakeSpawn({
        dockerContainers: [
          dockerContainer({
            ports: { '5432/tcp': [{ HostIp: '0.0.0.0', HostPort: '5432' }] },
          }),
        ],
      }),
      pattern: /port binding must match/,
      operations: FIRST_DOCKER_CHECKS,
    },
    {
      fake: createFakeSpawn({ dockerContainers: [dockerContainer({ tmpfs: {} })] }),
      pattern: /disposable tmpfs/,
      operations: FIRST_DOCKER_CHECKS,
    },
    {
      fake: createFakeSpawn({
        dockerContainers: [
          dockerContainer({
            mounts: [{ Type: 'volume', Destination: '/var/lib/postgresql/data' }],
          }),
        ],
      }),
      pattern: /disposable tmpfs/,
      operations: FIRST_DOCKER_CHECKS,
    },
  ];

  for (const failure of failures) {
    await assert.rejects(
      runRestoreRehearsal({
        args: assertionArgs(),
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
    args: assertionArgs(),
    environment: localEnvironment(),
    spawnSync: successful.spawnSync,
  });
  const operations = successful.calls.filter(({ args }) => args[0] !== '--version');
  const assertionCalls = operations.filter((call) => describeOperation(call) === 'psql:assert');

  assert.deepEqual(operations.map(describeOperation), [
    ...FIRST_DOCKER_CHECKS,
    'psql:database-check',
    ...DOCKER_CHECKS,
    ...DOCKER_CHECKS,
    'psql:assert',
    ...DOCKER_CHECKS,
    'psql:assert',
    ...DOCKER_CHECKS,
    'psql:assert',
  ]);
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
      args: assertionArgs(),
      environment: localEnvironment(),
      spawnSync: failing.spawnSync,
    }),
    /assert-workflow-check-constraints\.sql failed with status 8/,
  );
  assert.deepEqual(
    failing.calls.filter(({ args }) => args[0] !== '--version').map(describeOperation),
    [
      ...FIRST_DOCKER_CHECKS,
      'psql:database-check',
      ...DOCKER_CHECKS,
      ...DOCKER_CHECKS,
      'psql:assert',
      ...DOCKER_CHECKS,
      'psql:assert',
    ],
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
      args: assertionArgs(),
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
    [
      ...FIRST_DOCKER_CHECKS,
      'psql:database-check',
      ...DOCKER_CHECKS,
      ...DOCKER_CHECKS,
      'psql:assert',
      ...DOCKER_CHECKS,
      'psql:assert',
    ],
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
      args: assertionArgs(),
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
  if (tool === 'docker') {
    if (args[0] === 'context' && args[1] === 'show') return 'docker:context-show';
    if (args[0] === 'context' && args[1] === 'inspect') return 'docker:context';
    return `docker:${args[2]}`;
  }
  if (tool === 'pg_restore') {
    return args.includes('--list') ? 'pg_restore:list' : 'pg_restore:restore';
  }
  if (command === process.execPath && args[0] === PRISMA_CLI_PATH) {
    return `prisma:${args.slice(1, 3).join(' ')}`;
  }
  if (args.some((arg) => arg.includes('server_version_num'))) return 'psql:database-check';
  if (args.some((arg) => arg.includes('FROM public._prisma_migrations'))) {
    return 'psql:migration-baseline';
  }
  if (basename(args.at(-1)) === 'init-supabase-roles.sql') return 'psql:init-roles';
  return 'psql:assert';
}
