#!/usr/bin/env node

import { spawnSync as nodeSpawnSync } from 'node:child_process';
import { lstat as nodeLstat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { inspectBackupArchiveList } from './staging-libpq.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const packageDir = dirname(dirname(scriptPath));
const repositoryRoot = dirname(dirname(packageDir));

export const LIBPQ_BIN_DIR = '/opt/homebrew/opt/libpq@17/bin';
const INIT_ROLES_PATH = join(repositoryRoot, 'infra', 'postgres', 'init-supabase-roles.sql');
const WORKFLOW_CHECK_ASSERTION_PATH = join(
  repositoryRoot,
  'infra',
  'postgres',
  'assert-workflow-check-constraints.sql',
);
const POST_UPGRADE_ASSERTIONS = Object.freeze([
  join(repositoryRoot, 'infra', 'postgres', 'assert-public-schema-isolation.sql'),
  WORKFLOW_CHECK_ASSERTION_PATH,
  join(repositoryRoot, 'infra', 'postgres', 'assert-33-to-43-upgrade-data.sql'),
]);
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const LOOPBACK_SERVER_ADDRESSES = new Set(['127.0.0.1', '::1']);
const TARGET_PROBE_SQL =
  "SELECT json_build_object('database', current_database(), 'serverVersionNum', " +
  "current_setting('server_version_num')::integer, 'serverAddress', " +
  'inet_server_addr()::text)::text;';
const VERSION_TIMEOUT_MS = 30_000;
const INSPECTION_TIMEOUT_MS = 60_000;
const RESTORE_TIMEOUT_MS = 300_000;
const ASSERTION_TIMEOUT_MS = 60_000;
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const USAGE =
  'Usage: restore-rehearsal.mjs restore --archive=<absolute.dump> --confirm-database=<supplier_restore_*>' +
  '\n   or: restore-rehearsal.mjs post-upgrade-assert --confirm-database=<supplier_restore_*>';

export function readRestoreRehearsalOptions(args) {
  const action = args[0];
  if (!['restore', 'post-upgrade-assert'].includes(action)) throw new Error(USAGE);

  const confirmations = args.slice(1).filter((arg) => arg.startsWith('--confirm-database='));
  const archives = args.slice(1).filter((arg) => arg.startsWith('--archive='));
  const expectedLength = action === 'restore' ? 3 : 2;
  const allowed = new Set([...confirmations, ...archives]);
  if (
    args.length !== expectedLength ||
    confirmations.length !== 1 ||
    archives.length !== (action === 'restore' ? 1 : 0) ||
    args.slice(1).some((arg) => !allowed.has(arg))
  ) {
    throw new Error(USAGE);
  }

  const confirmedDatabase = confirmations[0].slice('--confirm-database='.length);
  if (!confirmedDatabase) throw new Error('--confirm-database must not be empty.');
  if (action === 'post-upgrade-assert') return { action, confirmedDatabase };

  const archive = archives[0].slice('--archive='.length);
  if (!archive || !isAbsolute(archive) || extname(archive) !== '.dump') {
    throw new Error('--archive must be an absolute path ending in .dump.');
  }
  return { action, archive: resolve(archive), confirmedDatabase };
}

export function readRestoreRehearsalConfiguration(args, environment) {
  const options = readRestoreRehearsalOptions(args);
  const runtime = describeLocalDatasource(environment.DATABASE_URL, 'DATABASE_URL');
  const direct = describeLocalDatasource(environment.DIRECT_URL, 'DIRECT_URL');
  for (const key of ['host', 'port', 'database', 'username']) {
    if (runtime[key] !== direct[key]) {
      throw new Error(`DATABASE_URL and DIRECT_URL must use the same local ${key}.`);
    }
  }
  if (!/^supplier_restore_[a-z0-9][a-z0-9_]*$/.test(direct.database)) {
    throw new Error('Restore rehearsal database must match supplier_restore_* exactly.');
  }
  if (options.confirmedDatabase !== direct.database) {
    throw new Error('--confirm-database must exactly match the validated restore database.');
  }

  const libpqEnvironment = {
    LC_ALL: 'C',
    PGAPPNAME: 'supplier-restore-rehearsal',
    PGCONNECT_TIMEOUT: '10',
    PGDATABASE: direct.database,
    PGHOST: direct.host,
    PGPASSWORD: direct.password,
    PGPORT: direct.port,
    PGSSLMODE: 'disable',
    PGUSER: direct.username,
  };
  return {
    ...options,
    database: direct.database,
    libpqEnvironment,
    readOnlyLibpqEnvironment: {
      ...libpqEnvironment,
      PGOPTIONS: '-c default_transaction_read_only=on',
    },
  };
}

export async function runRestoreRehearsal({
  args = process.argv.slice(2),
  environment = process.env,
  spawnSync = nodeSpawnSync,
  lstatFile = nodeLstat,
} = {}) {
  const configuration = readRestoreRehearsalConfiguration(args, environment);
  if (configuration.action === 'restore') {
    await assertRegularArchive(configuration.archive, lstatFile);
    assertLibpq17('pg_restore', spawnSync);
    assertLibpq17('psql', spawnSync);
    return runRestore(configuration, spawnSync);
  }

  assertLibpq17('psql', spawnSync);
  assertConnectedDatabase(configuration, spawnSync);
  return runPostUpgradeAssertions(configuration, spawnSync);
}

async function assertRegularArchive(archive, lstatFile) {
  const archiveStat = await lstatFile(archive);
  if (archiveStat.isSymbolicLink() || !archiveStat.isFile()) {
    throw new Error('Restore archive must be a regular non-symlink file.');
  }
}

function runRestore(configuration, spawnSync) {
  const listResult = spawnSync(
    join(LIBPQ_BIN_DIR, 'pg_restore'),
    ['--list', configuration.archive],
    {
      encoding: 'utf8',
      env: { LC_ALL: 'C' },
      killSignal: 'SIGTERM',
      maxBuffer: MAX_BUFFER_BYTES,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: INSPECTION_TIMEOUT_MS,
    },
  );
  assertCommandSucceeded('pg_restore --list', listResult);
  const { archiveEntryCount } = inspectBackupArchiveList(listResult.stdout);

  assertConnectedDatabase(configuration, spawnSync);
  const initResult = spawnSync(
    join(LIBPQ_BIN_DIR, 'psql'),
    ['--no-psqlrc', '--no-password', '--set=ON_ERROR_STOP=1', '--file', INIT_ROLES_PATH],
    commandOptions(configuration.libpqEnvironment, ASSERTION_TIMEOUT_MS),
  );
  assertCommandSucceeded(`psql ${basename(INIT_ROLES_PATH)}`, initResult);

  const restoreResult = spawnSync(
    join(LIBPQ_BIN_DIR, 'pg_restore'),
    [
      '--clean',
      '--if-exists',
      '--single-transaction',
      '--no-owner',
      '--no-privileges',
      '--no-password',
      '--dbname',
      configuration.database,
      configuration.archive,
    ],
    commandOptions(configuration.libpqEnvironment, RESTORE_TIMEOUT_MS),
  );
  assertCommandSucceeded('pg_restore restore', restoreResult);
  return {
    action: configuration.action,
    archive: configuration.archive,
    database: configuration.database,
    archiveEntryCount,
  };
}

function assertConnectedDatabase(configuration, spawnSync) {
  const result = spawnSync(
    join(LIBPQ_BIN_DIR, 'psql'),
    ['--no-psqlrc', '--no-password', '--tuples-only', '--no-align', '--command', TARGET_PROBE_SQL],
    commandOptions(configuration.readOnlyLibpqEnvironment, INSPECTION_TIMEOUT_MS),
  );
  assertCommandSucceeded('psql current_database check', result);
  let target;
  try {
    target = JSON.parse(String(result.stdout ?? '').trim());
  } catch {
    throw new Error('Connected database identity probe returned an invalid response.');
  }
  if (target.database !== configuration.database) {
    throw new Error('Connected database does not match the confirmed restore database.');
  }
  if (
    !Number.isInteger(target.serverVersionNum) ||
    Math.trunc(target.serverVersionNum / 10_000) !== 17
  ) {
    throw new Error('Connected PostgreSQL server must be major version 17.');
  }
  if (!LOOPBACK_SERVER_ADDRESSES.has(target.serverAddress)) {
    throw new Error('Connected PostgreSQL server must use a loopback address.');
  }
}

function runPostUpgradeAssertions(configuration, spawnSync) {
  const completedAssertions = [];
  for (const assertionPath of POST_UPGRADE_ASSERTIONS) {
    const environment =
      assertionPath === WORKFLOW_CHECK_ASSERTION_PATH
        ? configuration.libpqEnvironment
        : configuration.readOnlyLibpqEnvironment;
    const result = spawnSync(
      join(LIBPQ_BIN_DIR, 'psql'),
      ['--no-psqlrc', '--no-password', '--set=ON_ERROR_STOP=1', '--file', assertionPath],
      commandOptions(environment, ASSERTION_TIMEOUT_MS),
    );
    assertCommandSucceeded(`psql ${basename(assertionPath)}`, result);
    completedAssertions.push(basename(assertionPath));
  }
  return {
    action: configuration.action,
    database: configuration.database,
    completedAssertions,
  };
}

function commandOptions(environment, timeout) {
  return {
    encoding: 'utf8',
    env: environment,
    killSignal: 'SIGTERM',
    maxBuffer: MAX_BUFFER_BYTES,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout,
  };
}

function assertLibpq17(tool, spawnSync) {
  const result = spawnSync(
    join(LIBPQ_BIN_DIR, tool),
    ['--version'],
    commandOptions({ LC_ALL: 'C' }, VERSION_TIMEOUT_MS),
  );
  assertCommandSucceeded(`${tool} --version`, result);
  if (
    !new RegExp(`^${tool} \\(PostgreSQL\\) 17(?:\\.|$)`).test(String(result.stdout ?? '').trim())
  ) {
    throw new Error(`${tool} must be PostgreSQL 17.`);
  }
}

function assertCommandSucceeded(label, result) {
  if (result?.error) {
    throw new Error(`${label} could not start (${result.error.code ?? 'unknown error'}).`);
  }
  if (result?.signal) throw new Error(`${label} terminated by signal ${result.signal}.`);
  if (result?.status !== 0) throw new Error(`${label} failed with status ${result?.status}.`);
}

function describeLocalDatasource(value, name) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid PostgreSQL URL.`);
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error(`${name} must use the postgres or postgresql protocol.`);
  }

  const host = normalizeHostname(url.hostname);
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(`${name} must use localhost, 127.0.0.1, or ::1.`);
  }
  const username = decodeUrlComponent(url.username, `${name} username`);
  const password = decodeUrlComponent(url.password, `${name} password`);
  const database = decodeUrlComponent(url.pathname.replace(/^\//, ''), `${name} database`);
  if (!username) throw new Error(`${name} must include a username.`);
  if (!password) throw new Error(`${name} must include a password.`);
  if (!database) throw new Error(`${name} must include a database name.`);
  return {
    host,
    port: url.port || '5432',
    database,
    username,
    password,
  };
}

function normalizeHostname(hostname) {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

function decodeUrlComponent(value, label) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error(`${label} must use valid percent encoding.`);
  }
}

async function main() {
  const result = await runRestoreRehearsal();
  if (result.action === 'restore') {
    console.log(
      `Archive restored into confirmed local rehearsal database: database=${result.database} archiveEntries=${result.archiveEntryCount}. Run post-upgrade-assert before accepting the rehearsal.`,
    );
    return;
  }
  console.log(
    `Local restore rehearsal assertions passed: database=${result.database} count=${result.completedAssertions.length}.`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
