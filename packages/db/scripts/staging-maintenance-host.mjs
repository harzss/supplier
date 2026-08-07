#!/usr/bin/env node

import { spawnSync as nodeSpawnSync } from 'node:child_process';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describeStagingDatasource } from './audit-staging.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const packageDir = dirname(dirname(scriptPath));
export const REPOSITORY_ROOT = dirname(dirname(packageDir));
export const STAGING_ENV_PATH = join(packageDir, '.env.staging.local');
export const DOCKER_BIN_PATH = '/opt/homebrew/bin/docker';
export const GIT_BIN_PATH = '/usr/bin/git';
const EXPECTED_ENV_KEYS = Object.freeze(['DATABASE_URL', 'DIRECT_URL', 'STAGING_PROJECT_REF']);
const ARCHIVE_MAX_BUFFER_BYTES = 128 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 20 * 60 * 1000;
const USAGE =
  'Usage: staging-maintenance-host.mjs build\n' +
  '   or: staging-maintenance-host.mjs audit [--allow-pending]\n' +
  '   or: staging-maintenance-host.mjs backfill-check\n' +
  '   or: staging-maintenance-host.mjs backfill-apply --confirm-project=<STAGING_PROJECT_REF>\n' +
  '   or: staging-maintenance-host.mjs migrate-once --confirm-project=<STAGING_PROJECT_REF>\n' +
  '   or: staging-maintenance-host.mjs migrate-forward-once --confirm-project=<STAGING_PROJECT_REF>';

export function readStagingMaintenanceHostOptions(args) {
  if (args.length === 1 && args[0] === 'build') return { action: 'build' };
  if (
    args[0] === 'audit' &&
    (args.length === 1 || (args.length === 2 && args[1] === '--allow-pending'))
  ) {
    return {
      action: 'run',
      operation: 'audit',
      containerArgs: ['packages/db/scripts/audit-staging.mjs', ...(args[1] ? [args[1]] : [])],
    };
  }
  if (args.length === 1 && args[0] === 'backfill-check') {
    return {
      action: 'run',
      operation: 'backfill-check',
      containerArgs: ['packages/db/scripts/backfill-staging-mock-supplier-ids.mjs'],
    };
  }
  if (
    args.length === 2 &&
    ['backfill-apply', 'migrate-once', 'migrate-forward-once'].includes(args[0]) &&
    /^--confirm-project=[a-z0-9]{20}$/.test(args[1])
  ) {
    const projectRef = args[1].slice('--confirm-project='.length);
    if (args[0] === 'backfill-apply') {
      return {
        action: 'run',
        operation: 'backfill-apply',
        projectRef,
        containerArgs: [
          'packages/db/scripts/backfill-staging-mock-supplier-ids.mjs',
          '--apply',
          args[1],
        ],
      };
    }
    return {
      action: 'run',
      operation: args[0],
      projectRef,
      containerArgs: ['packages/db/scripts/staging-libpq.mjs', args[0], args[1]],
    };
  }
  throw new Error(USAGE);
}

export function parseStagingMaintenanceEnvironment(contents) {
  const buffer = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
  if (buffer.length === 0 || buffer.length > 16 * 1024) {
    throw new Error('Staging maintenance env must be a small non-empty file.');
  }
  for (const byte of buffer) {
    if (byte !== 0x0a && (byte < 0x21 || byte > 0x7e)) {
      throw new Error('Staging maintenance env must contain printable ASCII single-line values.');
    }
  }

  const text = buffer.toString('ascii');
  const normalized = text.endsWith('\n') ? text.slice(0, -1) : text;
  const lines = normalized.split('\n');
  if (lines.length !== EXPECTED_ENV_KEYS.length || lines.some((line) => line.length === 0)) {
    throw new Error('Staging maintenance env must contain exactly three assignments.');
  }

  const values = {};
  for (const line of lines) {
    const separator = line.indexOf('=');
    if (separator <= 0) throw new Error('Invalid staging maintenance env assignment.');
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (
      !EXPECTED_ENV_KEYS.includes(key) ||
      Object.hasOwn(values, key) ||
      value.length === 0 ||
      /["'#\\]/.test(value)
    ) {
      throw new Error('Invalid staging maintenance env assignment.');
    }
    values[key] = value;
  }
  if (Object.keys(values).sort().join(',') !== EXPECTED_ENV_KEYS.join(',')) {
    throw new Error('Staging maintenance env keys do not match the required set.');
  }
  return values;
}

export function readStagingMaintenanceEnvironment({
  path = STAGING_ENV_PATH,
  expectedUid = process.getuid(),
  lstatFile = lstatSync,
  openFile = openSync,
  fstatFile = fstatSync,
  readFile = readFileSync,
  closeFile = closeSync,
} = {}) {
  const pathStat = lstatFile(path);
  if (
    !pathStat.isFile() ||
    pathStat.isSymbolicLink() ||
    (pathStat.mode & 0o777) !== 0o600 ||
    pathStat.uid !== expectedUid
  ) {
    throw new Error('Staging maintenance env must be an owner-only regular file.');
  }

  const fd = openFile(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const openedStat = fstatFile(fd);
    if (
      !openedStat.isFile() ||
      openedStat.dev !== pathStat.dev ||
      openedStat.ino !== pathStat.ino ||
      openedStat.uid !== expectedUid ||
      (openedStat.mode & 0o777) !== 0o600
    ) {
      throw new Error('Staging maintenance env changed before it was opened.');
    }
    return parseStagingMaintenanceEnvironment(readFile(fd));
  } finally {
    closeFile(fd);
  }
}

export function createMaintenanceDockerEnvironment(environment, stagingEnvironment) {
  const dockerEnvironment = {
    LC_ALL: 'C',
    PATH: '/opt/homebrew/bin:/usr/bin:/bin',
  };
  if (environment.HOME) dockerEnvironment.HOME = environment.HOME;
  if (stagingEnvironment) Object.assign(dockerEnvironment, stagingEnvironment);
  return dockerEnvironment;
}

export function runStagingMaintenanceHost({
  args = process.argv.slice(2),
  environment = process.env,
  spawnSync = nodeSpawnSync,
  readEnvironment = readStagingMaintenanceEnvironment,
} = {}) {
  const options = readStagingMaintenanceHostOptions(args);
  const commandEnvironment = createMaintenanceDockerEnvironment(environment);
  const gitSha = readGitState(spawnSync, commandEnvironment);
  const dockerContext = readDockerContext(spawnSync, commandEnvironment);
  const imageTag = `supplier-staging-maintenance:${gitSha}`;

  if (options.action === 'build') {
    const archive = runBuffered(
      'git archive',
      spawnSync,
      GIT_BIN_PATH,
      ['archive', '--format=tar', gitSha],
      commandEnvironment,
    );
    runInherited(
      'docker build',
      spawnSync,
      DOCKER_BIN_PATH,
      [
        '--context',
        dockerContext,
        'build',
        '--target',
        'staging-maintenance',
        '--build-arg',
        `SUPPLIER_GIT_SHA=${gitSha}`,
        '-t',
        imageTag,
        '-',
      ],
      commandEnvironment,
      archive,
    );
  }

  const imageId = inspectMaintenanceImage(
    spawnSync,
    commandEnvironment,
    dockerContext,
    imageTag,
    gitSha,
  );
  if (options.action === 'build') return { action: 'build', dockerContext, gitSha, imageId };

  const stagingEnvironment = readEnvironment();
  const datasource = describeStagingDatasource({
    projectRef: stagingEnvironment.STAGING_PROJECT_REF,
    databaseUrl: stagingEnvironment.DATABASE_URL,
    directUrl: stagingEnvironment.DIRECT_URL,
  });
  if (options.projectRef && options.projectRef !== datasource.projectRef) {
    throw new Error('--confirm-project must exactly match the validated STAGING_PROJECT_REF.');
  }
  const dockerRunEnvironment = createMaintenanceDockerEnvironment(environment, stagingEnvironment);
  const dockerArgs = [
    '--context',
    dockerContext,
    'run',
    '--rm',
    '--read-only',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,size=64m',
    '--user',
    'node',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--env',
    'STAGING_PROJECT_REF',
    '--env',
    'DATABASE_URL',
    '--env',
    'DIRECT_URL',
    imageId,
    ...options.containerArgs,
  ];
  runInherited(
    `docker ${options.operation}`,
    spawnSync,
    DOCKER_BIN_PATH,
    dockerArgs,
    dockerRunEnvironment,
  );
  return { action: 'run', operation: options.operation, dockerContext, gitSha, imageId };
}

function readGitState(spawnSync, environment) {
  const gitSha = runText(
    'git rev-parse',
    spawnSync,
    GIT_BIN_PATH,
    ['rev-parse', 'HEAD'],
    environment,
  );
  if (!/^[a-f0-9]{40}$/.test(gitSha)) throw new Error('Git HEAD is not a full commit SHA.');
  const status = runText(
    'git status',
    spawnSync,
    GIT_BIN_PATH,
    ['status', '--porcelain', '--untracked-files=normal'],
    environment,
  );
  if (status) throw new Error('Refusing staging maintenance from a dirty worktree.');
  return gitSha;
}

function readDockerContext(spawnSync, environment) {
  const context = runText(
    'docker context show',
    spawnSync,
    DOCKER_BIN_PATH,
    ['context', 'show'],
    environment,
  );
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(context)) {
    throw new Error('Docker context name returned an invalid response.');
  }
  const endpointValue = runText(
    'docker context inspect',
    spawnSync,
    DOCKER_BIN_PATH,
    ['context', 'inspect', context, '--format', '{{json .Endpoints.docker.Host}}'],
    environment,
  );
  let endpoint;
  try {
    endpoint = JSON.parse(endpointValue);
  } catch {
    throw new Error('Docker context endpoint returned invalid JSON.');
  }
  if (typeof endpoint !== 'string' || !endpoint.startsWith('unix:///')) {
    throw new Error('Staging maintenance requires a local Unix-socket Docker context.');
  }
  return context;
}

function inspectMaintenanceImage(spawnSync, environment, context, imageTag, gitSha) {
  const imageId = runText(
    'docker image ID inspect',
    spawnSync,
    DOCKER_BIN_PATH,
    ['--context', context, 'image', 'inspect', imageTag, '--format', '{{.Id}}'],
    environment,
  );
  if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) {
    throw new Error('Staging maintenance image ID is not a full sha256 digest.');
  }
  const revision = runText(
    'docker image revision inspect',
    spawnSync,
    DOCKER_BIN_PATH,
    [
      '--context',
      context,
      'image',
      'inspect',
      imageId,
      '--format',
      '{{index .Config.Labels "org.opencontainers.image.revision"}}',
    ],
    environment,
  );
  const user = runText(
    'docker image user inspect',
    spawnSync,
    DOCKER_BIN_PATH,
    ['--context', context, 'image', 'inspect', imageId, '--format', '{{.Config.User}}'],
    environment,
  );
  if (revision !== gitSha || user !== 'node') {
    throw new Error('Staging maintenance image metadata does not match the current Git SHA.');
  }
  return imageId;
}

function baseOptions(environment) {
  return {
    cwd: REPOSITORY_ROOT,
    env: environment,
    killSignal: 'SIGTERM',
    timeout: COMMAND_TIMEOUT_MS,
  };
}

function runText(label, spawnSync, command, args, environment) {
  const result = spawnSync(command, args, {
    ...baseOptions(environment),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assertCommandSucceeded(label, result);
  return String(result.stdout ?? '').trim();
}

function runBuffered(label, spawnSync, command, args, environment) {
  const result = spawnSync(command, args, {
    ...baseOptions(environment),
    encoding: null,
    maxBuffer: ARCHIVE_MAX_BUFFER_BYTES,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assertCommandSucceeded(label, result);
  return result.stdout;
}

function runInherited(label, spawnSync, command, args, environment, input) {
  const result = spawnSync(command, args, {
    ...baseOptions(environment),
    input,
    stdio: [input ? 'pipe' : 'ignore', 'inherit', 'inherit'],
  });
  assertCommandSucceeded(label, result);
}

function assertCommandSucceeded(label, result) {
  if (result?.error) {
    throw new Error(`${label} could not start (${result.error.code ?? 'unknown error'}).`);
  }
  if (result?.signal) throw new Error(`${label} terminated by signal ${result.signal}.`);
  if (result?.status !== 0) throw new Error(`${label} failed with status ${result?.status}.`);
}

function main() {
  const result = runStagingMaintenanceHost();
  console.log(
    result.action === 'build'
      ? `Staging maintenance image built and verified: gitSha=${result.gitSha} imageId=${result.imageId}.`
      : `Staging maintenance operation completed: operation=${result.operation} gitSha=${result.gitSha} imageId=${result.imageId}.`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
