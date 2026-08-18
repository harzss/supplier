import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseEnv } from 'node:util';

import {
  DOCKER_BIN_PATH,
  GIT_BIN_PATH,
  REPOSITORY_ROOT,
  parseStagingMaintenanceEnvironment,
  readStagingMaintenanceEnvironment,
  readStagingMaintenanceHostOptions,
  runStagingMaintenanceHost,
} from './staging-maintenance-host.mjs';

const PROJECT_REF = 'abcdefghijklmnopqrst';
const GIT_SHA = 'a'.repeat(40);
const IMAGE_ID = `sha256:${'b'.repeat(64)}`;
const VALID_ENV =
  `DATABASE_URL=postgresql://postgres.${PROJECT_REF}:runtime-secret@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1\n` +
  `DIRECT_URL=postgresql://postgres.${PROJECT_REF}:direct-secret@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres\n` +
  `STAGING_PROJECT_REF=${PROJECT_REF}\n`;

async function temporaryDirectory(context) {
  const directory = await mkdtemp(join(tmpdir(), 'supplier-staging-maintenance-host-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function successfulResult(stdout = '') {
  return { error: undefined, signal: null, status: 0, stderr: '', stdout };
}

function createFakeSpawn({ dirty = false, revision = GIT_SHA, user = 'node' } = {}) {
  const calls = [];
  const archive = Buffer.from('exact git archive');
  const spawnSync = (command, args, options) => {
    calls.push({ command, args, options });
    if (command === GIT_BIN_PATH && args[0] === 'rev-parse')
      return successfulResult(`${GIT_SHA}\n`);
    if (command === GIT_BIN_PATH && args[0] === 'status') {
      return successfulResult(dirty ? ' M tracked-file\n' : '');
    }
    if (command === GIT_BIN_PATH && args[0] === 'archive') return successfulResult(archive);
    if (command === DOCKER_BIN_PATH && args[0] === 'context' && args[1] === 'show') {
      return successfulResult('colima\n');
    }
    if (command === DOCKER_BIN_PATH && args[0] === 'context' && args[1] === 'inspect') {
      return successfulResult('"unix:///tmp/colima.sock"\n');
    }
    if (command === DOCKER_BIN_PATH && args.includes('image') && args.at(-1) === '{{.Id}}') {
      return successfulResult(`${IMAGE_ID}\n`);
    }
    if (
      command === DOCKER_BIN_PATH &&
      args.includes('image') &&
      args.at(-1).includes('org.opencontainers.image.revision')
    ) {
      return successfulResult(`${revision}\n`);
    }
    if (
      command === DOCKER_BIN_PATH &&
      args.includes('image') &&
      args.at(-1) === '{{.Config.User}}'
    ) {
      return successfulResult(`${user}\n`);
    }
    if (command === DOCKER_BIN_PATH && (args.includes('build') || args.includes('run'))) {
      return successfulResult();
    }
    throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
  };
  return { archive, calls, spawnSync };
}

test('parses only exactly three unquoted printable single-line assignments', () => {
  assert.deepEqual(parseStagingMaintenanceEnvironment(VALID_ENV), {
    DATABASE_URL: `postgresql://postgres.${PROJECT_REF}:runtime-secret@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1`,
    DIRECT_URL: `postgresql://postgres.${PROJECT_REF}:direct-secret@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres`,
    STAGING_PROJECT_REF: PROJECT_REF,
  });

  const multilineQuoted =
    `DATABASE_URL="postgresql://first\nsecond"\n` +
    `DIRECT_URL=postgresql://direct\nSTAGING_PROJECT_REF=${PROJECT_REF}\n`;
  assert.equal(parseEnv(multilineQuoted).DATABASE_URL, 'postgresql://first\nsecond');

  for (const contents of [
    multilineQuoted,
    VALID_ENV.replace('DATABASE_URL=', 'DATABASE_URL="').replace('\nDIRECT_URL=', '"\nDIRECT_URL='),
    `# comment\n${VALID_ENV}`,
    `${VALID_ENV}NODE_OPTIONS=--import=/tmp/attack.mjs\n`,
    VALID_ENV.replace('DIRECT_URL=', 'DATABASE_URL='),
    VALID_ENV.replaceAll('\n', '\r\n'),
    VALID_ENV.replace('runtime-secret', 'runtime\tsecret'),
    `${VALID_ENV}\n`,
    VALID_ENV.replace('runtime-secret', 'runtime#comment'),
    VALID_ENV.replace('runtime-secret', "runtime'secret"),
    VALID_ENV.replace('runtime-secret', 'runtime\\secret'),
  ]) {
    assert.throws(() => parseStagingMaintenanceEnvironment(contents));
  }
});

test('requires a non-symlink owner-only env file', async (context) => {
  const directory = await temporaryDirectory(context);
  const target = join(directory, 'staging.env');
  const link = join(directory, 'staging-link.env');
  await writeFile(target, VALID_ENV, { mode: 0o600 });
  assert.deepEqual(readStagingMaintenanceEnvironment({ path: target }), parseEnv(VALID_ENV));

  await chmod(target, 0o644);
  assert.throws(
    () => readStagingMaintenanceEnvironment({ path: target }),
    /owner-only regular file/,
  );
  await chmod(target, 0o600);
  await symlink(target, link);
  assert.throws(() => readStagingMaintenanceEnvironment({ path: link }), /owner-only regular file/);
});

test('allows only closed maintenance operations and arguments', () => {
  assert.deepEqual(readStagingMaintenanceHostOptions(['build']), { action: 'build' });
  assert.deepEqual(readStagingMaintenanceHostOptions(['audit', '--allow-pending']), {
    action: 'run',
    operation: 'audit',
    containerArgs: ['packages/db/scripts/audit-staging.mjs', '--allow-pending'],
  });
  assert.equal(
    readStagingMaintenanceHostOptions(['backfill-apply', `--confirm-project=${PROJECT_REF}`])
      .projectRef,
    PROJECT_REF,
  );
  assert.deepEqual(
    readStagingMaintenanceHostOptions(['migrate-forward-once', `--confirm-project=${PROJECT_REF}`]),
    {
      action: 'run',
      operation: 'migrate-forward-once',
      projectRef: PROJECT_REF,
      containerArgs: [
        'packages/db/scripts/staging-libpq.mjs',
        'migrate-forward-once',
        `--confirm-project=${PROJECT_REF}`,
      ],
    },
  );
  assert.deepEqual(
    readStagingMaintenanceHostOptions([
      'migrate-marketplace-entitlement-once',
      `--confirm-project=${PROJECT_REF}`,
    ]),
    {
      action: 'run',
      operation: 'migrate-marketplace-entitlement-once',
      projectRef: PROJECT_REF,
      containerArgs: [
        'packages/db/scripts/staging-libpq.mjs',
        'migrate-marketplace-entitlement-once',
        `--confirm-project=${PROJECT_REF}`,
      ],
    },
  );
  for (const args of [
    [],
    ['audit', '--unknown'],
    ['backfill-apply'],
    ['migrate-once', '--confirm-project=short'],
    ['migrate-forward-once', '--confirm-project=short'],
    ['migrate-marketplace-entitlement-once', '--confirm-project=short'],
    ['shell'],
    ['build', '--file=other'],
  ]) {
    assert.throws(() => readStagingMaintenanceHostOptions(args), /Usage:/);
  }
});

test('builds only from the exact Git archive and verifies immutable image metadata', () => {
  const fake = createFakeSpawn();
  const result = runStagingMaintenanceHost({
    args: ['build'],
    environment: { HOME: '/Users/test', NODE_OPTIONS: '--import=/tmp/attack.mjs' },
    spawnSync: fake.spawnSync,
  });
  assert.deepEqual(result, {
    action: 'build',
    dockerContext: 'colima',
    gitSha: GIT_SHA,
    imageId: IMAGE_ID,
  });

  const archiveCall = fake.calls.find(
    ({ command, args }) => command === GIT_BIN_PATH && args[0] === 'archive',
  );
  assert.deepEqual(archiveCall.args, ['archive', '--format=tar', GIT_SHA]);
  const buildCall = fake.calls.find(
    ({ command, args }) => command === DOCKER_BIN_PATH && args.includes('build'),
  );
  assert.equal(buildCall.args.at(-1), '-');
  assert.deepEqual(buildCall.options.input, fake.archive);
  assert.equal(buildCall.args.includes('.'), false);
  assert.equal('NODE_OPTIONS' in buildCall.options.env, false);
  assert.equal('DATABASE_URL' in buildCall.options.env, false);
});

test('Docker context exclusions cover generated caches, reports, and local tooling', async () => {
  const dockerignore = await readFile(join(REPOSITORY_ROOT, '.dockerignore'), 'utf8');
  const exclusions = new Set(dockerignore.split(/\r?\n/));
  for (const pattern of [
    '**/build',
    '**/.open-next',
    '**/out',
    '**/.wrangler',
    '**/playwright-report',
    '**/test-results',
    '**/.cache',
    '**/.venv',
    '.vscode',
    '.idea',
  ]) {
    assert.equal(exclusions.has(pattern), true, pattern);
  }
});

test('passes only named staging variables to the hardened container', () => {
  const fake = createFakeSpawn();
  const parsedEnvironment = parseStagingMaintenanceEnvironment(VALID_ENV);
  const result = runStagingMaintenanceHost({
    args: ['backfill-apply', `--confirm-project=${PROJECT_REF}`],
    environment: {
      HOME: '/Users/test',
      NODE_OPTIONS: '--import=/tmp/attack.mjs',
      DATABASE_URL: 'postgresql://ambient.invalid/leak',
    },
    readEnvironment: () => parsedEnvironment,
    spawnSync: fake.spawnSync,
  });
  assert.equal(result.operation, 'backfill-apply');

  const runCall = fake.calls.find(
    ({ command, args }) => command === DOCKER_BIN_PATH && args.includes('run'),
  );
  assert.equal(runCall.args.includes('--env-file'), false);
  assert.deepEqual(
    runCall.args.filter((value, index) => runCall.args[index - 1] === '--env'),
    ['STAGING_PROJECT_REF', 'DATABASE_URL', 'DIRECT_URL'],
  );
  assert.equal(runCall.args.includes(parsedEnvironment.DATABASE_URL), false);
  assert.equal(runCall.args.includes(parsedEnvironment.DIRECT_URL), false);
  assert.equal(runCall.args.includes(IMAGE_ID), true);
  assert.equal(runCall.args.includes('--read-only'), true);
  assert.equal(runCall.args.includes('no-new-privileges'), true);
  assert.equal(runCall.options.env.NODE_OPTIONS, undefined);
  assert.equal(runCall.options.env.DATABASE_URL, parsedEnvironment.DATABASE_URL);
  assert.deepEqual(Object.keys(runCall.options.env).sort(), [
    'DATABASE_URL',
    'DIRECT_URL',
    'HOME',
    'LC_ALL',
    'PATH',
    'STAGING_PROJECT_REF',
  ]);
});

test('fails before Docker when the worktree is dirty', () => {
  const fake = createFakeSpawn({ dirty: true });
  assert.throws(
    () =>
      runStagingMaintenanceHost({
        args: ['build'],
        environment: { HOME: '/Users/test' },
        spawnSync: fake.spawnSync,
      }),
    /dirty worktree/,
  );
  assert.equal(
    fake.calls.some(({ command }) => command === DOCKER_BIN_PATH),
    false,
  );
});
