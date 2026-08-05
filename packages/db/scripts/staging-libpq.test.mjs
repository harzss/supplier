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
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';

import {
  LIBPQ_BIN_DIR,
  SUPABASE_CA_CERT_PATH,
  inspectBackupArchiveList,
  readStagingLibpqConfiguration,
  readStagingLibpqOptions,
  runStagingLibpq,
} from './staging-libpq.mjs';

const PROJECT_REF = 'abcdefghijklmnopqrst';
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

test('accepts only the two closed operations with exact arguments', () => {
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
  assert.deepEqual(
    readStagingLibpqOptions(['post-upgrade-assert', `--confirm-project=${PROJECT_REF}`]),
    { action: 'post-upgrade-assert', confirmedProjectRef: PROJECT_REF },
  );

  for (const args of [
    [],
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
  assert.equal('PGSERVICE' in configuration.libpqEnvironment, false);
  assert.equal('DATABASE_URL' in configuration.libpqEnvironment, false);
  assert.equal('DIRECT_URL' in configuration.libpqEnvironment, false);
});

test('rejects an unconfirmed target and missing direct credentials before spawning', async () => {
  const fake = createFakeSpawn();
  await assert.rejects(
    runStagingLibpq({
      args: ['post-upgrade-assert', '--confirm-project=zyxwvutsrqponmlkjihg'],
      environment: stagingEnvironment(),
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
