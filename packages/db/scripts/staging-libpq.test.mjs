import assert from 'node:assert/strict';
import { createHash, X509Certificate } from 'node:crypto';
import { writeSync } from 'node:fs';
import {
  access,
  link,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';

import {
  AUDIT_STAGING_PATH,
  EXPECTED_STAGING_PENDING_MIGRATIONS,
  LIBPQ_BIN_DIR,
  PRISMA_CLI_PATH,
  PRISMA_SCHEMA_PATH,
  SUPABASE_CA_CERT_PATH,
  inspectBackupArchiveList,
  readStagingLibpqConfiguration,
  readStagingLibpqOptions,
  runStagingLibpq,
} from './staging-libpq.mjs';

const PROJECT_REF = 'abcdefghijklmnopqrst';
const GIT_SHA = 'a'.repeat(40);
const PASSWORD = 'p@ss:word';
const DUMP_CONTENT = Buffer.from('fake PostgreSQL custom archive');
const EXPECTED_ASSERTION_BASENAMES = Object.freeze([
  'assert-public-schema-isolation.sql',
  'assert-workflow-check-constraints.sql',
  'assert-33-to-43-upgrade-data.sql',
]);
const ARCHIVE_LIST = `
; Archive created at 2026-08-05 00:00:00 UTC
1; 1259 1 TABLE public _prisma_migrations postgres
2; 0 1 TABLE DATA public _prisma_migrations postgres
3; 1259 2 TABLE public source_products postgres
4; 0 2 TABLE DATA public source_products postgres
`;

function stagingEnvironment() {
  return {
    STAGING_PROJECT_REF: PROJECT_REF,
    SUPPLIER_STAGING_MAINTENANCE_GIT_SHA: GIT_SHA,
    SUPPLIER_STAGING_MAINTENANCE_IMAGE: '1',
    DATABASE_URL: `postgresql://postgres.${PROJECT_REF}:secret@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1`,
    DIRECT_URL: `postgresql://postgres.${PROJECT_REF}:p%40ss%3Aword@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres?sslmode=disable&options=unsafe`,
    PGHOST: 'attacker.invalid',
    PGOPTIONS: '-c session_preload_libraries=unsafe',
    PGSERVICE: 'unexpected-service',
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
  dumpResult,
  restoreResult,
  archiveList = ARCHIVE_LIST,
  psqlResults = [],
  psqlStatuses = [],
} = {}) {
  const calls = [];
  let psqlIndex = 0;
  const spawnSync = (command, args, options) => {
    calls.push({ command, args, options });
    const tool = basename(command);
    if (args.length === 1 && args[0] === '--version') {
      return successfulResult({ stdout: `${tool} (PostgreSQL) 17.10\n` });
    }
    if (tool === 'pg_dump') {
      if (dumpResult) return dumpResult;
      writeSync(options.stdio[1], DUMP_CONTENT);
      return successfulResult();
    }
    if (tool === 'pg_restore') {
      if (restoreResult) return restoreResult;
      return successfulResult({ stdout: archiveList });
    }
    if (tool === 'psql') {
      if (psqlResults[psqlIndex]) return psqlResults[psqlIndex++];
      return successfulResult({ status: psqlStatuses[psqlIndex++] ?? 0 });
    }
    throw new Error(`Unexpected command: ${command}`);
  };
  return { calls, spawnSync };
}

async function temporaryDirectory(context) {
  const directory = await mkdtemp(join(tmpdir(), 'supplier-staging-libpq-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('accepts only the three closed operations with exact arguments', () => {
  assert.deepEqual(
    readStagingLibpqOptions([
      'backup',
      '--output=/private/tmp/final.dump',
      `--confirm-project=${PROJECT_REF}`,
    ]),
    {
      action: 'backup',
      confirmedProjectRef: PROJECT_REF,
      output: '/private/tmp/final.dump',
    },
  );
  assert.deepEqual(readStagingLibpqOptions(['migrate-once', `--confirm-project=${PROJECT_REF}`]), {
    action: 'migrate-once',
    confirmedProjectRef: PROJECT_REF,
  });
  assert.deepEqual(
    readStagingLibpqOptions(['post-upgrade-assert', `--confirm-project=${PROJECT_REF}`]),
    { action: 'post-upgrade-assert', confirmedProjectRef: PROJECT_REF },
  );

  for (const args of [
    [],
    ['migrate', `--confirm-project=${PROJECT_REF}`],
    ['psql', `--confirm-project=${PROJECT_REF}`],
    ['backup', '--output=relative.dump', `--confirm-project=${PROJECT_REF}`],
    ['backup', '--output=/private/tmp/final.sql', `--confirm-project=${PROJECT_REF}`],
    ['backup', '--output=/private/tmp/final.dump'],
    [
      'backup',
      '--output=/private/tmp/final.dump',
      `--confirm-project=${PROJECT_REF}`,
      '--no-owner',
    ],
    ['migrate-once', `--confirm-project=${PROJECT_REF}`, '--schema=/private/tmp/arbitrary.prisma'],
    [
      'post-upgrade-assert',
      `--confirm-project=${PROJECT_REF}`,
      '--file=/private/tmp/arbitrary.sql',
    ],
  ]) {
    assert.throws(() => readStagingLibpqOptions(args));
  }
});

test('builds a minimal fixed libpq environment from the validated direct URL', () => {
  const configuration = readStagingLibpqConfiguration(
    ['post-upgrade-assert', `--confirm-project=${PROJECT_REF}`],
    stagingEnvironment(),
  );

  assert.deepEqual(configuration.libpqEnvironment, {
    LC_ALL: 'C',
    PGAPPNAME: 'supplier-staging-maintenance',
    PGCONNECT_TIMEOUT: '10',
    PGDATABASE: 'postgres',
    PGHOST: 'aws-0-ap-southeast-1.pooler.supabase.com',
    PGPASSWORD: PASSWORD,
    PGPORT: '5432',
    PGSSLMODE: 'verify-full',
    PGSSLROOTCERT: SUPABASE_CA_CERT_PATH,
    PGUSER: `postgres.${PROJECT_REF}`,
  });
  assert.deepEqual(configuration.readOnlyLibpqEnvironment, {
    ...configuration.libpqEnvironment,
    PGOPTIONS: '-c default_transaction_read_only=on',
  });
  const canonicalDatasource =
    `postgresql://postgres.${PROJECT_REF}:p%40ss%3Aword@` +
    'aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres' +
    `?sslmode=require&sslcert=${encodeURIComponent(SUPABASE_CA_CERT_PATH)}` +
    '&sslaccept=strict';
  assert.deepEqual(configuration.auditEnvironment, {
    DATABASE_URL: canonicalDatasource,
    DIRECT_URL: canonicalDatasource,
    LC_ALL: 'C',
    PRISMA_HIDE_UPDATE_MESSAGE: '1',
    STAGING_PROJECT_REF: PROJECT_REF,
    SUPPLIER_STAGING_MAINTENANCE_GIT_SHA: GIT_SHA,
    SUPPLIER_STAGING_MAINTENANCE_IMAGE: '1',
  });
  assert.deepEqual(configuration.prismaEnvironment, {
    DATABASE_URL: canonicalDatasource,
    DIRECT_URL: canonicalDatasource,
    LC_ALL: 'C',
    PRISMA_HIDE_UPDATE_MESSAGE: '1',
  });
  assert.equal('PGSERVICE' in configuration.libpqEnvironment, false);
  assert.equal('DATABASE_URL' in configuration.libpqEnvironment, false);
  assert.equal('DIRECT_URL' in configuration.libpqEnvironment, false);
  assert.equal('PGHOST' in configuration.prismaEnvironment, false);
  assert.equal('PGOPTIONS' in configuration.prismaEnvironment, false);
  assert.equal('PGSERVICE' in configuration.prismaEnvironment, false);
});

test('runs the full read-only audit and exact 34-to-43 status gate before migration', async (context) => {
  const directory = await temporaryDirectory(context);
  const safeDotenv = join(directory, '.env');
  await writeFile(
    safeDotenv,
    'DATABASE_URL="postgresql://safe.invalid/database"\nDIRECT_URL="postgresql://safe.invalid/database"\n',
  );
  const calls = [];
  let statusCalls = 0;
  const spawnSync = (command, args, options) => {
    calls.push({ command, args, options });
    if (args[0] === AUDIT_STAGING_PATH) return successfulResult();
    if (args[1] === 'migrate' && args[2] === 'status') {
      statusCalls += 1;
      if (statusCalls === 1) {
        return successfulResult({
          status: 1,
          stdout:
            '43 migrations found in prisma/migrations\n' +
            'Following migrations have not yet been applied:\n' +
            `${EXPECTED_STAGING_PENDING_MIGRATIONS.join('\n')}\n`,
        });
      }
      return successfulResult({ stdout: 'Database schema is up to date!\n' });
    }
    if (args[1] === 'migrate' && args[2] === 'deploy') return successfulResult();
    throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
  };

  const result = await runStagingLibpq({
    args: ['migrate-once', `--confirm-project=${PROJECT_REF}`],
    environment: stagingEnvironment(),
    platform: 'linux',
    prismaDotenvCandidates: [safeDotenv],
    spawnSync,
  });

  assert.deepEqual(result, {
    action: 'migrate-once',
    projectRef: PROJECT_REF,
    verifiedMigrationCount: 10,
  });
  assert.deepEqual(
    calls.map(({ args }) => args),
    [
      [AUDIT_STAGING_PATH, '--allow-pending'],
      [PRISMA_CLI_PATH, 'migrate', 'status', '--schema', PRISMA_SCHEMA_PATH],
      [PRISMA_CLI_PATH, 'migrate', 'deploy', '--schema', PRISMA_SCHEMA_PATH],
      [PRISMA_CLI_PATH, 'migrate', 'status', '--schema', PRISMA_SCHEMA_PATH],
    ],
  );
  const repositoryRoot = dirname(dirname(dirname(dirname(PRISMA_SCHEMA_PATH))));
  assert.deepEqual(
    calls.map(({ options }) => options.timeout),
    [300_000, 60_000, 300_000, 60_000],
  );
  for (const [index, call] of calls.entries()) {
    assert.equal(call.command, process.execPath);
    assert.equal(call.options.cwd, repositoryRoot);
    assert.equal(call.options.encoding, 'utf8');
    assert.equal(call.options.killSignal, 'SIGTERM');
    assert.equal(call.options.maxBuffer, 4 * 1024 * 1024);
    assert.deepEqual(call.options.stdio, ['ignore', 'pipe', 'pipe']);
    const expectedEnvironmentKeys = [
      'DATABASE_URL',
      'DIRECT_URL',
      'LC_ALL',
      'PRISMA_HIDE_UPDATE_MESSAGE',
    ];
    if (index === 0) {
      expectedEnvironmentKeys.push(
        'STAGING_PROJECT_REF',
        'SUPPLIER_STAGING_MAINTENANCE_GIT_SHA',
        'SUPPLIER_STAGING_MAINTENANCE_IMAGE',
      );
    }
    assert.deepEqual(Object.keys(call.options.env).sort(), expectedEnvironmentKeys.sort());
    assert.equal(call.options.env.STAGING_PROJECT_REF, index === 0 ? PROJECT_REF : undefined);
    assert.equal(
      call.options.env.SUPPLIER_STAGING_MAINTENANCE_GIT_SHA,
      index === 0 ? GIT_SHA : undefined,
    );
    assert.equal(call.args.join(' ').includes(PASSWORD), false);
  }
});

test('refuses migrate-once outside the verified Linux maintenance runtime', async () => {
  const calls = [];
  await assert.rejects(
    runStagingLibpq({
      args: ['migrate-once', `--confirm-project=${PROJECT_REF}`],
      environment: stagingEnvironment(),
      platform: 'darwin',
      spawnSync: (...args) => {
        calls.push(args);
        return successfulResult();
      },
    }),
    /verified Linux staging-maintenance image/,
  );
  assert.equal(calls.length, 0);
});

test('refuses migration unless the audit and exact pending suffix both pass', async () => {
  const cases = [
    {
      name: 'audit failure',
      results: [successfulResult({ status: 1, stderr: `must not expose ${PASSWORD}` })],
      pattern: /staging pre-migration audit failed with status 1/,
      expectedCalls: 1,
    },
    {
      name: 'unexpected pending suffix',
      results: [
        successfulResult(),
        successfulResult({
          status: 1,
          stdout:
            'Following migration has not yet been applied:\n' +
            `${EXPECTED_STAGING_PENDING_MIGRATIONS[0]}\n`,
        }),
      ],
      pattern: /did not report the expected pending migration suffix/,
      expectedCalls: 2,
    },
    {
      name: 'deploy timeout',
      results: [
        successfulResult(),
        successfulResult({
          status: 1,
          stdout:
            'Following migrations have not yet been applied:\n' +
            `${EXPECTED_STAGING_PENDING_MIGRATIONS.join('\n')}\n`,
        }),
        successfulResult({
          error: Object.assign(new Error(`must not expose ${PASSWORD}`), { code: 'ETIMEDOUT' }),
          status: null,
        }),
      ],
      pattern: /prisma migrate deploy could not start \(ETIMEDOUT\)/,
      expectedCalls: 3,
    },
  ];

  for (const testCase of cases) {
    const calls = [];
    await assert.rejects(
      runStagingLibpq({
        args: ['migrate-once', `--confirm-project=${PROJECT_REF}`],
        environment: stagingEnvironment(),
        platform: 'linux',
        spawnSync: (command, args, options) => {
          calls.push({ command, args, options });
          return testCase.results[calls.length - 1];
        },
      }),
      (error) => {
        assert.match(error.message, testCase.pattern, testCase.name);
        assert.doesNotMatch(error.message, new RegExp(PASSWORD), testCase.name);
        return true;
      },
    );
    assert.equal(calls.length, testCase.expectedCalls, testCase.name);
    assert.equal(
      calls.some(({ args }) => args[2] === 'deploy'),
      testCase.name === 'deploy timeout',
      testCase.name,
    );
  }
});

test('rejects unsafe Prisma dotenv candidates before any migration child process', async (context) => {
  const directory = await temporaryDirectory(context);
  const secret = 'dotenv-secret-must-not-leak';
  const maliciousDotenv = join(directory, 'malicious.env');
  const safeTarget = join(directory, 'safe-target.env');
  const symlinkedDotenv = join(directory, 'symlink.env');
  await writeFile(
    maliciousDotenv,
    `DATABASE_URL="postgresql://safe.invalid/database"\nNODE_OPTIONS="${secret}"\n`,
  );
  await writeFile(safeTarget, 'DATABASE_URL="postgresql://safe.invalid/database"\n');
  await symlink(safeTarget, symlinkedDotenv);

  for (const candidate of [maliciousDotenv, symlinkedDotenv]) {
    const calls = [];
    await assert.rejects(
      runStagingLibpq({
        args: ['migrate-once', `--confirm-project=${PROJECT_REF}`],
        environment: stagingEnvironment(),
        platform: 'linux',
        prismaDotenvCandidates: [candidate],
        spawnSync: (...args) => {
          calls.push(args);
          return successfulResult();
        },
      }),
      (error) => {
        assert.match(error.message, /Prisma dotenv safety check failed/);
        assert.doesNotMatch(error.message, new RegExp(secret));
        return true;
      },
    );
    assert.equal(calls.length, 0);
  }
});

test('rejects unsafe migration ports and non-default databases before spawning', async () => {
  const cases = [
    {
      name: 'transaction pooler port',
      directUrl: `postgresql://postgres.${PROJECT_REF}:secret@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres`,
      databaseUrl: stagingEnvironment().DATABASE_URL,
      pattern: /session port 5432/,
    },
    {
      name: 'custom port',
      directUrl: `postgresql://postgres.${PROJECT_REF}:secret@aws-0-ap-southeast-1.pooler.supabase.com:6432/postgres`,
      databaseUrl: stagingEnvironment().DATABASE_URL,
      pattern: /session port 5432/,
    },
    {
      name: 'non-default database',
      directUrl: `postgresql://postgres.${PROJECT_REF}:secret@aws-0-ap-southeast-1.pooler.supabase.com:5432/other`,
      databaseUrl: `postgresql://postgres.${PROJECT_REF}:secret@aws-0-ap-southeast-1.pooler.supabase.com:6543/other`,
      pattern: /must target the postgres database/,
    },
  ];

  for (const testCase of cases) {
    const calls = [];
    const environment = {
      ...stagingEnvironment(),
      DATABASE_URL: testCase.databaseUrl,
      DIRECT_URL: testCase.directUrl,
    };
    await assert.rejects(
      runStagingLibpq({
        args: ['migrate-once', `--confirm-project=${PROJECT_REF}`],
        environment,
        platform: 'linux',
        spawnSync: (...args) => {
          calls.push(args);
          return successfulResult();
        },
      }),
      testCase.pattern,
      testCase.name,
    );
    assert.equal(calls.length, 0, testCase.name);
  }
});

test('rejects a NUL-bearing direct credential before spawning or exposing it', async () => {
  const environment = stagingEnvironment();
  environment.DIRECT_URL = `postgresql://postgres.${PROJECT_REF}:secret%00leak@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres`;
  const calls = [];

  await assert.rejects(
    runStagingLibpq({
      args: ['migrate-once', `--confirm-project=${PROJECT_REF}`],
      environment,
      platform: 'linux',
      spawnSync: (...args) => {
        calls.push(args);
        return successfulResult();
      },
    }),
    (error) => {
      assert.match(error.message, /without NUL bytes/);
      assert.doesNotMatch(error.message, /secret|leak/);
      return true;
    },
  );
  assert.equal(calls.length, 0);
});

test('rejects an unconfirmed target and missing direct credentials before spawning', async () => {
  const fake = createFakeSpawn();
  await assert.rejects(
    runStagingLibpq({
      args: ['migrate-once', '--confirm-project=zyxwvutsrqponmlkjihg'],
      environment: stagingEnvironment(),
      platform: 'linux',
      spawnSync: fake.spawnSync,
    }),
    /must exactly match/,
  );
  assert.equal(fake.calls.length, 0);

  const environment = stagingEnvironment();
  environment.DIRECT_URL = `postgresql://postgres.${PROJECT_REF}@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres`;
  await assert.rejects(
    runStagingLibpq({
      args: ['post-upgrade-assert', `--confirm-project=${PROJECT_REF}`],
      environment,
      spawnSync: fake.spawnSync,
    }),
    /must include a password/,
  );
  assert.equal(fake.calls.length, 0);
});

test('validates a non-empty archive list with the required schema and data objects', () => {
  assert.deepEqual(inspectBackupArchiveList(ARCHIVE_LIST), { archiveEntryCount: 4 });
  assert.throws(() => inspectBackupArchiveList('; only comments\n'), /empty archive list/);
  assert.throws(
    () =>
      inspectBackupArchiveList(
        '1; 1259 1 TABLE public _prisma_migrations postgres\n' +
          '2; 0 1 TABLE DATA public _prisma_migrations postgres\n',
      ),
    /source_products/,
  );
});

test('creates an exclusive 0600 backup and verifies it before returning metadata', async (context) => {
  const directory = await temporaryDirectory(context);
  const output = join(directory, 'final.dump');
  const fake = createFakeSpawn();
  const publishEvents = [];

  const result = await runStagingLibpq({
    args: ['backup', `--output=${output}`, `--confirm-project=${PROJECT_REF}`],
    environment: stagingEnvironment(),
    spawnSync: fake.spawnSync,
    linkFile: async (source, destination) => {
      publishEvents.push({ operation: 'link', source, destination });
      await link(source, destination);
    },
    unlinkFile: async (path) => {
      publishEvents.push({ operation: 'unlink', path });
      await unlink(path);
    },
  });

  assert.deepEqual(result, {
    action: 'backup',
    output,
    bytes: DUMP_CONTENT.length,
    sha256: createExpectedHash(DUMP_CONTENT),
    archiveEntryCount: 4,
  });
  assert.deepEqual(await readFile(output), DUMP_CONTENT);
  assert.equal((await stat(output)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(directory), ['final.dump']);
  assert.equal(publishEvents.length, 2);
  assert.equal(publishEvents[0].operation, 'link');
  assert.match(publishEvents[0].source, /final\.dump\.partial-\d+-[a-f0-9-]+$/);
  assert.equal(publishEvents[0].destination, output);
  assert.deepEqual(publishEvents[1], {
    operation: 'unlink',
    path: publishEvents[0].source,
  });

  const dumpCall = fake.calls.find(
    ({ command, args }) => basename(command) === 'pg_dump' && args[0] !== '--version',
  );
  assert.equal(dumpCall.command, join(LIBPQ_BIN_DIR, 'pg_dump'));
  assert.deepEqual(dumpCall.args, [
    '--format=custom',
    '--schema=public',
    '--no-owner',
    '--no-privileges',
    '--no-password',
  ]);
  assert.equal(dumpCall.args.join(' ').includes(PASSWORD), false);
  assert.equal(dumpCall.options.env.PGSSLMODE, 'verify-full');
  assert.equal(dumpCall.options.env.PGSSLROOTCERT, SUPABASE_CA_CERT_PATH);
  assert.equal(dumpCall.options.env.PGOPTIONS, '-c default_transaction_read_only=on');
  assert.equal(dumpCall.options.timeout, 300_000);
  assert.equal(dumpCall.options.killSignal, 'SIGTERM');
  assert.equal(dumpCall.options.maxBuffer, 4 * 1024 * 1024);

  const restoreCall = fake.calls.find(
    ({ command, args }) => basename(command) === 'pg_restore' && args[0] !== '--version',
  );
  assert.deepEqual(restoreCall.args, ['--list', publishEvents[0].source]);
  assert.deepEqual(restoreCall.options.env, { LC_ALL: 'C' });
  assert.equal(restoreCall.options.timeout, 60_000);
  assert.equal(restoreCall.options.killSignal, 'SIGTERM');
  assert.equal(restoreCall.options.maxBuffer, 4 * 1024 * 1024);
});

test('never overwrites an existing backup output', async (context) => {
  const directory = await temporaryDirectory(context);
  const output = join(directory, 'existing.dump');
  await writeFile(output, 'existing');
  const fake = createFakeSpawn();

  await assert.rejects(
    runStagingLibpq({
      args: ['backup', `--output=${output}`, `--confirm-project=${PROJECT_REF}`],
      environment: stagingEnvironment(),
      spawnSync: fake.spawnSync,
    }),
    (error) => error.code === 'EEXIST',
  );
  assert.equal(await readFile(output, 'utf8'), 'existing');
  assert.deepEqual(await readdir(directory), ['existing.dump']);
});

test('removes a newly created output after dump or archive verification failure', async (context) => {
  const directory = await temporaryDirectory(context);

  for (const failure of [
    {
      name: 'dump',
      fake: createFakeSpawn({ dumpResult: successfulResult({ status: 2 }) }),
      pattern: /pg_dump failed/,
    },
    {
      name: 'archive',
      fake: createFakeSpawn({ archiveList: '; no entries\n' }),
      pattern: /empty archive list/,
    },
    {
      name: 'dump-timeout',
      fake: createFakeSpawn({
        dumpResult: successfulResult({
          error: Object.assign(new Error('must not be reported'), { code: 'ETIMEDOUT' }),
          signal: 'SIGTERM',
          status: null,
        }),
      }),
      pattern: /pg_dump could not start \(ETIMEDOUT\)/,
    },
    {
      name: 'archive-timeout',
      fake: createFakeSpawn({
        restoreResult: successfulResult({
          error: Object.assign(new Error('must not be reported'), { code: 'ETIMEDOUT' }),
          signal: 'SIGTERM',
          status: null,
        }),
      }),
      pattern: /pg_restore --list could not start \(ETIMEDOUT\)/,
    },
  ]) {
    const output = join(directory, `${failure.name}.dump`);
    await assert.rejects(
      runStagingLibpq({
        args: ['backup', `--output=${output}`, `--confirm-project=${PROJECT_REF}`],
        environment: stagingEnvironment(),
        spawnSync: failure.fake.spawnSync,
      }),
      failure.pattern,
    );
    await assert.rejects(access(output), (error) => error.code === 'ENOENT');
    assert.deepEqual(await readdir(directory), []);
  }
});

test('runs only the three fixed assertions in order with psql and stops on first failure', async () => {
  const successful = createFakeSpawn();
  const result = await runStagingLibpq({
    args: ['post-upgrade-assert', `--confirm-project=${PROJECT_REF}`],
    environment: stagingEnvironment(),
    spawnSync: successful.spawnSync,
  });
  const successfulPsqlCalls = successful.calls.filter(
    ({ command, args }) => basename(command) === 'psql' && args[0] !== '--version',
  );

  assert.deepEqual(
    successfulPsqlCalls.map(({ args }) => basename(args.at(-1))),
    EXPECTED_ASSERTION_BASENAMES,
  );
  assert.deepEqual(result.completedAssertions, EXPECTED_ASSERTION_BASENAMES);
  for (const call of successfulPsqlCalls) {
    assert.deepEqual(call.args.slice(0, -1), [
      '--no-psqlrc',
      '--no-password',
      '--set=ON_ERROR_STOP=1',
      '--file',
    ]);
    assert.equal(call.args.join(' ').includes(PASSWORD), false);
    if (basename(call.args.at(-1)) === 'assert-workflow-check-constraints.sql') {
      assert.equal('PGOPTIONS' in call.options.env, false);
    } else {
      assert.equal(call.options.env.PGOPTIONS, '-c default_transaction_read_only=on');
    }
    assert.equal(call.options.timeout, 60_000);
    assert.equal(call.options.killSignal, 'SIGTERM');
    assert.equal(call.options.maxBuffer, 4 * 1024 * 1024);
  }

  const failing = createFakeSpawn({ psqlStatuses: [0, 9, 0] });
  await assert.rejects(
    runStagingLibpq({
      args: ['post-upgrade-assert', `--confirm-project=${PROJECT_REF}`],
      environment: stagingEnvironment(),
      spawnSync: failing.spawnSync,
    }),
    /assert-workflow-check-constraints\.sql failed with status 9/,
  );
  assert.equal(
    failing.calls.filter(
      ({ command, args }) => basename(command) === 'psql' && args[0] !== '--version',
    ).length,
    2,
  );

  const timeoutError = Object.assign(new Error(`must not expose ${PASSWORD}`), {
    code: 'ETIMEDOUT',
  });
  const timingOut = createFakeSpawn({
    psqlResults: [successfulResult(), successfulResult({ error: timeoutError, status: null })],
  });
  await assert.rejects(
    runStagingLibpq({
      args: ['post-upgrade-assert', `--confirm-project=${PROJECT_REF}`],
      environment: stagingEnvironment(),
      spawnSync: timingOut.spawnSync,
    }),
    (error) => {
      assert.match(error.message, /could not start \(ETIMEDOUT\)/);
      assert.doesNotMatch(error.message, new RegExp(PASSWORD));
      return true;
    },
  );
  assert.equal(
    timingOut.calls.filter(
      ({ command, args }) => basename(command) === 'psql' && args[0] !== '--version',
    ).length,
    2,
  );
});

test('refuses a non-17 libpq tool before running a database operation', async () => {
  const calls = [];
  const spawnSync = (command, args, options) => {
    calls.push({ command, args, options });
    return successfulResult({ stdout: `${basename(command)} (PostgreSQL) 16.9\n` });
  };

  await assert.rejects(
    runStagingLibpq({
      args: ['post-upgrade-assert', `--confirm-project=${PROJECT_REF}`],
      environment: stagingEnvironment(),
      spawnSync,
    }),
    /must be PostgreSQL 17/,
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['--version']);
  assert.equal(calls[0].options.timeout, 30_000);
  assert.equal(calls[0].options.killSignal, 'SIGTERM');
  assert.equal(calls[0].options.maxBuffer, 4 * 1024 * 1024);
});

test('pins the official Supabase Root 2021 CA certificate', async () => {
  const certificate = new X509Certificate(await readFile(SUPABASE_CA_CERT_PATH));
  assert.match(certificate.subject, /CN=Supabase Root 2021 CA/);
  assert.equal(
    certificate.fingerprint256,
    '80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA',
  );
  assert.equal(certificate.validTo, 'Apr 26 10:56:53 2031 GMT');
});

function createExpectedHash(value) {
  return createHash('sha256').update(value).digest('hex');
}
