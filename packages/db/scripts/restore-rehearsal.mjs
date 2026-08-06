#!/usr/bin/env node

import { spawnSync as nodeSpawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants as fsConstants, fstatSync, openSync, readSync } from 'node:fs';
import {
  chmod as nodeChmod,
  mkdtemp as nodeMkdtemp,
  open as nodeOpen,
  readdir as nodeReaddir,
  rm as nodeRm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertSafePrismaDotenvCandidates, PRISMA_DOTENV_CANDIDATES } from './audit-staging.mjs';
import { EXPECTED_STAGING_PENDING_MIGRATIONS, inspectBackupArchiveList } from './staging-libpq.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const packageDir = dirname(dirname(scriptPath));
export const REPOSITORY_ROOT = dirname(dirname(packageDir));

export const LIBPQ_BIN_DIR = '/opt/homebrew/opt/libpq@17/bin';
export const DOCKER_BIN_PATH = '/opt/homebrew/bin/docker';
export const POSTGRES_17_IMAGE = 'postgres:17-alpine';
export const POSTGRES_17_IMAGE_ID =
  'sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193';
export const PRISMA_CLI_PATH = join(packageDir, 'node_modules', 'prisma', 'build', 'index.js');
export const PRISMA_SCHEMA_PATH = join(packageDir, 'prisma', 'schema.prisma');
const PRISMA_MIGRATIONS_PATH = join(packageDir, 'prisma', 'migrations');
const INIT_ROLES_PATH = join(REPOSITORY_ROOT, 'infra', 'postgres', 'init-supabase-roles.sql');
const WORKFLOW_CHECK_ASSERTION_PATH = join(
  REPOSITORY_ROOT,
  'infra',
  'postgres',
  'assert-workflow-check-constraints.sql',
);
const POST_UPGRADE_ASSERTIONS = Object.freeze([
  join(REPOSITORY_ROOT, 'infra', 'postgres', 'assert-public-schema-isolation.sql'),
  WORKFLOW_CHECK_ASSERTION_PATH,
  join(REPOSITORY_ROOT, 'infra', 'postgres', 'assert-33-to-43-upgrade-data.sql'),
]);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1']);
const RESTORE_CONTAINER_LABEL = 'com.supplier.restore-database';
const POSTGRES_DATA_PATH = '/var/lib/postgresql/data';
const DOCKER_CONTAINER_INSPECT_FORMAT =
  '{"id":{{json .Id}},"running":{{json .State.Running}},' +
  '"autoRemove":{{json .HostConfig.AutoRemove}},"imageId":{{json .Image}},' +
  '"imageRef":{{json .Config.Image}},"entrypoint":{{json .Config.Entrypoint}},' +
  '"cmd":{{json .Config.Cmd}},"labels":{{json .Config.Labels}},' +
  '"ports":{{json .NetworkSettings.Ports}},"tmpfs":{{json .HostConfig.Tmpfs}},' +
  '"mounts":{{json .Mounts}}}';
const TARGET_PROBE_SQL = `
WITH user_objects AS (
  SELECT relation.oid::text
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname !~ '^pg_' AND namespace.nspname <> 'information_schema'
  UNION ALL
  SELECT procedure.oid::text
  FROM pg_catalog.pg_proc AS procedure
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
  WHERE namespace.nspname !~ '^pg_' AND namespace.nspname <> 'information_schema'
  UNION ALL
  SELECT type_record.oid::text
  FROM pg_catalog.pg_type AS type_record
  JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = type_record.typnamespace
  WHERE namespace.nspname !~ '^pg_' AND namespace.nspname <> 'information_schema'
  UNION ALL
  SELECT namespace.oid::text
  FROM pg_catalog.pg_namespace AS namespace
  WHERE namespace.nspname !~ '^pg_'
    AND namespace.nspname NOT IN ('information_schema', 'public')
)
SELECT json_build_object(
  'database', current_database(),
  'serverVersionNum', current_setting('server_version_num')::integer,
  'dataDirectory', current_setting('data_directory'),
  'userObjectCount', (SELECT count(*)::integer FROM user_objects),
  'prismaMigrationTableExists', to_regclass('public._prisma_migrations') IS NOT NULL
)::text;
`.trim();
const RESTORED_MIGRATION_BASELINE_PROBE_SQL = `
SELECT coalesce(
  json_agg(
    json_build_object(
      'migrationName', migration_name,
      'checksum', checksum,
      'appliedStepsCount', applied_steps_count,
      'finished', finished_at IS NOT NULL,
      'rolledBack', rolled_back_at IS NOT NULL
    )
    ORDER BY started_at, id
  ),
  '[]'::json
)::text
FROM public._prisma_migrations;
`.trim();
const RESTORED_MIGRATION_COUNT = 33;
const ARCHIVE_CHILD_FD = 3;
const ARCHIVE_CHILD_PATH = `/dev/fd/${ARCHIVE_CHILD_FD}`;
const ARCHIVE_COPY_BUFFER_BYTES = 64 * 1024;
const VERSION_TIMEOUT_MS = 30_000;
const DOCKER_TIMEOUT_MS = 30_000;
const INSPECTION_TIMEOUT_MS = 60_000;
const RESTORE_TIMEOUT_MS = 300_000;
const PRISMA_TIMEOUT_MS = 300_000;
const ASSERTION_TIMEOUT_MS = 60_000;
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const USAGE =
  'Usage: restore-rehearsal.mjs rehearse --archive=<absolute.dump> --confirm-database=<supplier_restore_*> --confirm-container=<supplier-restore-*-pg17>' +
  '\n   or: restore-rehearsal.mjs restore --archive=<absolute.dump> --confirm-database=<supplier_restore_*> --confirm-container=<supplier-restore-*-pg17>' +
  '\n   or: restore-rehearsal.mjs post-upgrade-assert --confirm-database=<supplier_restore_*> --confirm-container=<supplier-restore-*-pg17>';

export function readRestoreRehearsalOptions(args) {
  const action = args[0];
  if (!['rehearse', 'restore', 'post-upgrade-assert'].includes(action)) throw new Error(USAGE);

  const confirmations = args.slice(1).filter((arg) => arg.startsWith('--confirm-database='));
  const containers = args.slice(1).filter((arg) => arg.startsWith('--confirm-container='));
  const archives = args.slice(1).filter((arg) => arg.startsWith('--archive='));
  const restoresArchive = action === 'rehearse' || action === 'restore';
  const expectedLength = restoresArchive ? 4 : 3;
  const allowed = new Set([...confirmations, ...containers, ...archives]);
  if (
    args.length !== expectedLength ||
    confirmations.length !== 1 ||
    containers.length !== 1 ||
    archives.length !== (restoresArchive ? 1 : 0) ||
    args.slice(1).some((arg) => !allowed.has(arg))
  ) {
    throw new Error(USAGE);
  }

  const confirmedDatabase = confirmations[0].slice('--confirm-database='.length);
  if (!confirmedDatabase) throw new Error('--confirm-database must not be empty.');
  const confirmedContainer = containers[0].slice('--confirm-container='.length);
  if (
    !/^supplier-restore-[a-z0-9][a-z0-9-]*-pg17$/.test(confirmedContainer) ||
    confirmedContainer.length > 63
  ) {
    throw new Error('--confirm-container must match supplier-restore-*-pg17 exactly.');
  }
  if (action === 'post-upgrade-assert') {
    return { action, confirmedContainer, confirmedDatabase };
  }

  const archive = archives[0].slice('--archive='.length);
  if (!archive || !isAbsolute(archive) || extname(archive) !== '.dump') {
    throw new Error('--archive must be an absolute path ending in .dump.');
  }
  return { action, archive: resolve(archive), confirmedContainer, confirmedDatabase };
}

export function readRestoreRehearsalConfiguration(args, environment) {
  const options = readRestoreRehearsalOptions(args);
  const runtime = describeLocalDatasource(environment.DATABASE_URL, 'DATABASE_URL');
  const direct = describeLocalDatasource(environment.DIRECT_URL, 'DIRECT_URL');
  for (const key of ['host', 'port', 'database', 'username', 'password']) {
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
  const prismaDatasourceUrl = formatLocalDatasource(direct);
  return {
    ...options,
    database: direct.database,
    libpqEnvironment,
    readOnlyLibpqEnvironment: {
      ...libpqEnvironment,
      PGOPTIONS: '-c default_transaction_read_only=on',
    },
    prismaEnvironment: {
      DATABASE_URL: prismaDatasourceUrl,
      DIRECT_URL: prismaDatasourceUrl,
      LC_ALL: 'C',
      PRISMA_HIDE_UPDATE_MESSAGE: '1',
    },
  };
}

export async function runRestoreRehearsal({
  args = process.argv.slice(2),
  environment = process.env,
  prismaDotenvCandidates = PRISMA_DOTENV_CANDIDATES,
  readMigrationDirectory = nodeReaddir,
  spawnSync = nodeSpawnSync,
} = {}) {
  const configuration = readRestoreRehearsalConfiguration(args, environment);
  if (configuration.action === 'restore' || configuration.action === 'rehearse') {
    if (configuration.action === 'rehearse') {
      await assertSafePrismaDotenvCandidates({ candidates: prismaDotenvCandidates });
    }
    const stableArchive = await prepareStableArchive(configuration.archive);
    try {
      assertLibpq17('pg_restore', spawnSync);
      assertLibpq17('psql', spawnSync);
      const dockerTarget = assertDockerRestoreTarget(configuration, spawnSync);
      const restoreResult = runRestore(configuration, spawnSync, dockerTarget, stableArchive);
      if (configuration.action === 'restore') return restoreResult;

      await runPrismaDeploy(
        configuration,
        spawnSync,
        dockerTarget,
        readMigrationDirectory,
        prismaDotenvCandidates,
      );
      await runPrismaStatus(configuration, spawnSync, dockerTarget, prismaDotenvCandidates);
      await runPrismaDiff(configuration, spawnSync, dockerTarget, prismaDotenvCandidates);
      assertDockerRestoreTarget(configuration, spawnSync, dockerTarget);
      assertConnectedDatabase(configuration, spawnSync, 'restored');
      const assertionResult = runPostUpgradeAssertions(configuration, spawnSync, dockerTarget);
      return {
        ...restoreResult,
        action: configuration.action,
        completedAssertions: assertionResult.completedAssertions,
        prismaChecks: ['migrate deploy', 'migrate status', 'migrate diff'],
      };
    } finally {
      await disposeStableArchive(stableArchive);
    }
  }

  assertLibpq17('psql', spawnSync);
  const dockerTarget = assertDockerRestoreTarget(configuration, spawnSync);
  assertConnectedDatabase(configuration, spawnSync, 'any');
  assertDockerRestoreTarget(configuration, spawnSync, dockerTarget);
  return runPostUpgradeAssertions(configuration, spawnSync, dockerTarget);
}

async function prepareStableArchive(archive) {
  let sourceHandle;
  let copyHandle;
  let privateDirectory;
  try {
    try {
      sourceHandle = await nodeOpen(archive, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    } catch (error) {
      if (error?.code === 'ELOOP' || error?.code === 'EMLINK') {
        throw new Error('Restore archive must be a regular non-symlink file.');
      }
      throw error;
    }
    const initialStat = await sourceHandle.stat({ bigint: true });
    if (!initialStat.isFile()) {
      throw new Error('Restore archive must be a regular non-symlink file.');
    }

    privateDirectory = await nodeMkdtemp(join(tmpdir(), 'supplier-restore-archive-'));
    await nodeChmod(privateDirectory, 0o700);
    const privatePath = join(privateDirectory, 'archive.dump');
    copyHandle = await nodeOpen(
      privatePath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    const copied = await copyAndHashArchive(sourceHandle, copyHandle);
    await copyHandle.sync();
    await copyHandle.chmod(0o600);
    const copyStat = await copyHandle.stat({ bigint: true });
    if (
      !copyStat.isFile() ||
      copyStat.size !== BigInt(copied.size) ||
      (copyStat.mode & 0o777n) !== 0o600n
    ) {
      throw new Error('Private restore archive copy failed validation.');
    }
    await copyHandle.close();
    copyHandle = undefined;

    const finalStat = await sourceHandle.stat({ bigint: true });
    if (!sameFileSnapshot(initialStat, finalStat) || finalStat.size !== BigInt(copied.size)) {
      throw new Error('Restore archive changed while creating the private copy.');
    }
    return {
      directory: privateDirectory,
      path: privatePath,
      sha256: copied.sha256,
      size: copied.size,
      sourceHandle,
    };
  } catch (error) {
    await closeFileHandle(copyHandle);
    await closeFileHandle(sourceHandle);
    if (privateDirectory) await nodeRm(privateDirectory, { force: true, recursive: true });
    throw error;
  }
}

async function copyAndHashArchive(sourceHandle, destinationHandle) {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(ARCHIVE_COPY_BUFFER_BYTES);
  let position = 0;
  while (true) {
    const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    let written = 0;
    while (written < bytesRead) {
      const result = await destinationHandle.write(
        buffer,
        written,
        bytesRead - written,
        position + written,
      );
      if (result.bytesWritten === 0) throw new Error('Private restore archive copy stalled.');
      written += result.bytesWritten;
    }
    position += bytesRead;
  }
  return { sha256: hash.digest('hex'), size: position };
}

function sameFileSnapshot(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function closeFileHandle(handle) {
  if (!handle) return;
  try {
    await handle.close();
  } catch {
    // The cleanup caller still removes the private directory below.
  }
}

async function disposeStableArchive(stableArchive) {
  let closeError;
  try {
    await stableArchive.sourceHandle.close();
  } catch (error) {
    closeError = error;
  }
  await nodeRm(stableArchive.directory, { force: true, recursive: true });
  if (closeError) throw closeError;
}

function runRestore(configuration, spawnSync, dockerTarget, stableArchive) {
  const listResult = spawnWithStableArchive(
    stableArchive,
    spawnSync,
    join(LIBPQ_BIN_DIR, 'pg_restore'),
    ['--format=custom', '--list', ARCHIVE_CHILD_PATH],
    {
      encoding: 'utf8',
      env: { LC_ALL: 'C' },
      killSignal: 'SIGTERM',
      maxBuffer: MAX_BUFFER_BYTES,
      timeout: INSPECTION_TIMEOUT_MS,
    },
  );
  assertCommandSucceeded('pg_restore --list', listResult);
  const { archiveEntryCount } = inspectBackupArchiveList(listResult.stdout);

  assertConnectedDatabase(configuration, spawnSync, 'empty');
  assertDockerRestoreTarget(configuration, spawnSync, dockerTarget);
  const initResult = spawnSync(
    join(LIBPQ_BIN_DIR, 'psql'),
    ['--no-psqlrc', '--no-password', '--set=ON_ERROR_STOP=1', '--file', INIT_ROLES_PATH],
    commandOptions(configuration.libpqEnvironment, ASSERTION_TIMEOUT_MS),
  );
  assertCommandSucceeded(`psql ${basename(INIT_ROLES_PATH)}`, initResult);

  assertDockerRestoreTarget(configuration, spawnSync, dockerTarget);
  const restoreResult = spawnWithStableArchive(
    stableArchive,
    spawnSync,
    join(LIBPQ_BIN_DIR, 'pg_restore'),
    [
      '--format=custom',
      '--clean',
      '--if-exists',
      '--single-transaction',
      '--no-owner',
      '--no-privileges',
      '--no-password',
      '--dbname',
      configuration.database,
      ARCHIVE_CHILD_PATH,
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

function spawnWithStableArchive(stableArchive, spawnSync, command, args, options) {
  let archiveFd;
  try {
    archiveFd = openSync(stableArchive.path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const archiveStat = fstatSync(archiveFd, { bigint: true });
    if (
      !archiveStat.isFile() ||
      archiveStat.size !== BigInt(stableArchive.size) ||
      (archiveStat.mode & 0o777n) !== 0o600n ||
      hashArchiveDescriptor(archiveFd, stableArchive.size) !== stableArchive.sha256 ||
      !sameFileSnapshot(archiveStat, fstatSync(archiveFd, { bigint: true }))
    ) {
      throw new Error('Private restore archive copy changed before use.');
    }
    return spawnSync(command, args, {
      ...options,
      stdio: ['ignore', 'pipe', 'pipe', archiveFd],
    });
  } finally {
    if (archiveFd !== undefined) closeSync(archiveFd);
  }
}

function hashArchiveDescriptor(archiveFd, size) {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(ARCHIVE_COPY_BUFFER_BYTES);
  let position = 0;
  while (position < size) {
    const bytesRead = readSync(
      archiveFd,
      buffer,
      0,
      Math.min(buffer.length, size - position),
      position,
    );
    if (bytesRead === 0) throw new Error('Private restore archive copy ended unexpectedly.');
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return hash.digest('hex');
}

function assertConnectedDatabase(configuration, spawnSync, expectedState) {
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
  if (target.dataDirectory !== POSTGRES_DATA_PATH) {
    throw new Error('Connected PostgreSQL server must use the inspected tmpfs data directory.');
  }
  if (!Number.isInteger(target.userObjectCount) || target.userObjectCount < 0) {
    throw new Error('Connected database identity probe returned an invalid object count.');
  }
  if (typeof target.prismaMigrationTableExists !== 'boolean') {
    throw new Error('Connected database identity probe returned an invalid migration table state.');
  }
  if (expectedState === 'empty' && target.userObjectCount !== 0) {
    throw new Error('Restore target database must be empty before role initialization.');
  }
  if (
    expectedState === 'restored' &&
    (target.userObjectCount === 0 || !target.prismaMigrationTableExists)
  ) {
    throw new Error('Migration target must be a restored database with _prisma_migrations.');
  }
}

function assertDockerRestoreTarget(configuration, spawnSync, expectedTarget) {
  let contextName = expectedTarget?.contextName;
  if (!contextName) {
    const contextNameResult = spawnSync(
      DOCKER_BIN_PATH,
      ['context', 'show'],
      dockerCommandOptions(),
    );
    assertCommandSucceeded('docker context show', contextNameResult);
    contextName = String(contextNameResult.stdout ?? '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(contextName)) {
      throw new Error('Docker context name returned an invalid response.');
    }
  }

  const contextResult = spawnSync(
    DOCKER_BIN_PATH,
    ['context', 'inspect', contextName, '--format', '{{json .Endpoints.docker.Host}}'],
    dockerCommandOptions(),
  );
  assertCommandSucceeded('docker context inspect', contextResult);
  const contextHost = parseJsonOutput('Docker context', contextResult.stdout);
  if (typeof contextHost !== 'string' || !contextHost.startsWith('unix:///')) {
    throw new Error('Restore rehearsal requires a local Unix-socket Docker context.');
  }
  if (expectedTarget && contextHost !== expectedTarget.contextHost) {
    throw new Error('Docker context endpoint changed before mutation.');
  }

  const imageResult = spawnSync(
    DOCKER_BIN_PATH,
    ['--context', contextName, 'image', 'inspect', '--format', '{{json .Id}}', POSTGRES_17_IMAGE],
    dockerCommandOptions(),
  );
  assertCommandSucceeded('docker image inspect', imageResult);
  if (parseJsonOutput('Docker image', imageResult.stdout) !== POSTGRES_17_IMAGE_ID) {
    throw new Error('Restore rehearsal PostgreSQL 17 image ID does not match the pinned image.');
  }

  const identifier = expectedTarget?.containerId ?? configuration.confirmedContainer;
  const containerResult = spawnSync(
    DOCKER_BIN_PATH,
    [
      '--context',
      contextName,
      'container',
      'inspect',
      '--format',
      DOCKER_CONTAINER_INSPECT_FORMAT,
      identifier,
    ],
    dockerCommandOptions(),
  );
  assertCommandSucceeded('docker container inspect', containerResult);
  const container = parseJsonOutput('Docker container', containerResult.stdout);
  if (!container || typeof container !== 'object' || Array.isArray(container)) {
    throw new Error('Docker container inspection returned an invalid response.');
  }
  if (!/^[a-f0-9]{64}$/.test(container.id)) {
    throw new Error('Docker container inspection returned an invalid container ID.');
  }
  if (expectedTarget && container.id !== expectedTarget.containerId) {
    throw new Error('Confirmed Docker restore container changed before mutation.');
  }
  if (container.running !== true || container.autoRemove !== true) {
    throw new Error('Restore container must be running with automatic removal enabled.');
  }
  if (container.imageRef !== POSTGRES_17_IMAGE || container.imageId !== POSTGRES_17_IMAGE_ID) {
    throw new Error('Restore container must use the pinned PostgreSQL 17 image.');
  }
  if (
    !sameStringArray(container.entrypoint, ['docker-entrypoint.sh']) ||
    !sameStringArray(container.cmd, ['postgres'])
  ) {
    throw new Error('Restore container must use the default PostgreSQL entrypoint and command.');
  }
  if (container.labels?.[RESTORE_CONTAINER_LABEL] !== configuration.database) {
    throw new Error('Restore container label must exactly match the confirmed database.');
  }

  const portKeys = Object.keys(container.ports ?? {});
  const bindings = container.ports?.['5432/tcp'];
  if (portKeys.length !== 1 || !Array.isArray(bindings) || bindings.length !== 1) {
    throw new Error('Restore container must expose only one PostgreSQL port binding.');
  }
  const binding = bindings[0];
  if (
    typeof binding?.HostIp !== 'string' ||
    normalizeHostname(binding?.HostIp) !== configuration.libpqEnvironment.PGHOST ||
    binding?.HostPort !== configuration.libpqEnvironment.PGPORT
  ) {
    throw new Error('Restore container port binding must match the validated loopback target.');
  }

  const tmpfsKeys = Object.keys(container.tmpfs ?? {});
  const tmpfsOptions = new Set(String(container.tmpfs?.[POSTGRES_DATA_PATH] ?? '').split(','));
  if (
    tmpfsKeys.length !== 1 ||
    tmpfsKeys[0] !== POSTGRES_DATA_PATH ||
    !tmpfsOptions.has('rw') ||
    !tmpfsOptions.has('noexec') ||
    !tmpfsOptions.has('nosuid') ||
    ![...tmpfsOptions].some((option) => /^size=\d+[kmg]$/i.test(option)) ||
    !Array.isArray(container.mounts) ||
    container.mounts.length !== 0
  ) {
    throw new Error('Restore container must use only disposable tmpfs PostgreSQL storage.');
  }
  return { containerId: container.id, contextHost, contextName };
}

async function runPrismaDeploy(
  configuration,
  spawnSync,
  dockerTarget,
  readMigrationDirectory,
  prismaDotenvCandidates,
) {
  assertDockerRestoreTarget(configuration, spawnSync, dockerTarget);
  assertConnectedDatabase(configuration, spawnSync, 'restored');
  await assertRestoredMigrationBaseline(configuration, spawnSync, readMigrationDirectory);
  assertDockerRestoreTarget(configuration, spawnSync, dockerTarget);
  await assertSafePrismaDotenvCandidates({ candidates: prismaDotenvCandidates });
  const result = spawnSync(
    process.execPath,
    [PRISMA_CLI_PATH, 'migrate', 'deploy', '--schema', PRISMA_SCHEMA_PATH],
    prismaCommandOptions(configuration.prismaEnvironment),
  );
  assertCommandSucceeded('prisma migrate deploy', result);
}

async function assertRestoredMigrationBaseline(configuration, spawnSync, readMigrationDirectory) {
  const expectedMigrations = await readExpectedRestoredMigrations(readMigrationDirectory);
  const result = spawnSync(
    join(LIBPQ_BIN_DIR, 'psql'),
    [
      '--no-psqlrc',
      '--no-password',
      '--tuples-only',
      '--no-align',
      '--command',
      RESTORED_MIGRATION_BASELINE_PROBE_SQL,
    ],
    commandOptions(configuration.readOnlyLibpqEnvironment, INSPECTION_TIMEOUT_MS),
  );
  assertCommandSucceeded('psql restored migration baseline check', result);
  const baseline = parseJsonOutput('Restored migration baseline', result.stdout);
  if (!sameRestoredMigrations(baseline, expectedMigrations)) {
    throw new Error(
      `Migration target must exactly match the first ${RESTORED_MIGRATION_COUNT} repository migrations by ordered name, checksum, and completed state.`,
    );
  }
}

async function readExpectedRestoredMigrations(readMigrationDirectory) {
  const entries = await readMigrationDirectory(PRISMA_MIGRATIONS_PATH, { withFileTypes: true });
  const migrationDirectories = [];
  let hasMigrationLock = false;
  for (const entry of entries) {
    if (entry.isDirectory() && /^\d{14}_[a-z0-9_]+$/.test(entry.name)) {
      migrationDirectories.push(entry);
      continue;
    }
    if (entry.name === 'migration_lock.toml' && entry.isFile()) {
      hasMigrationLock = true;
      continue;
    }
    throw new Error('Repository contains an unexpected Prisma migration entry.');
  }
  if (!hasMigrationLock) {
    throw new Error('Repository must contain a regular Prisma migration_lock.toml file.');
  }
  const migrationNames = migrationDirectories.map((entry) => entry.name).sort();
  if (
    migrationNames.length !==
      RESTORED_MIGRATION_COUNT + EXPECTED_STAGING_PENDING_MIGRATIONS.length ||
    !sameStringArray(
      migrationNames.slice(RESTORED_MIGRATION_COUNT),
      EXPECTED_STAGING_PENDING_MIGRATIONS,
    )
  ) {
    throw new Error('Repository does not contain the exact 33-to-43 migration boundary.');
  }
  return Promise.all(
    migrationNames.slice(0, RESTORED_MIGRATION_COUNT).map(async (migrationName) => {
      const migration = await nodeOpen(
        join(PRISMA_MIGRATIONS_PATH, migrationName, 'migration.sql'),
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
      );
      try {
        const migrationStat = await migration.stat();
        if (!migrationStat.isFile()) {
          throw new Error(`Repository migration ${migrationName} must be a regular SQL file.`);
        }
        const contents = await migration.readFile();
        return {
          migrationName,
          checksum: createHash('sha256').update(contents).digest('hex'),
          appliedStepsCount: 1,
          finished: true,
          rolledBack: false,
        };
      } finally {
        await migration.close();
      }
    }),
  );
}

function sameRestoredMigrations(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((migration, index) => {
      const expectedMigration = expected[index];
      return (
        migration?.migrationName === expectedMigration.migrationName &&
        migration?.checksum === expectedMigration.checksum &&
        migration?.appliedStepsCount === expectedMigration.appliedStepsCount &&
        migration?.finished === expectedMigration.finished &&
        migration?.rolledBack === expectedMigration.rolledBack &&
        Object.keys(migration).length === 5
      );
    })
  );
}

async function runPrismaStatus(configuration, spawnSync, dockerTarget, prismaDotenvCandidates) {
  assertDockerRestoreTarget(configuration, spawnSync, dockerTarget);
  await assertSafePrismaDotenvCandidates({ candidates: prismaDotenvCandidates });
  const result = spawnSync(
    process.execPath,
    [PRISMA_CLI_PATH, 'migrate', 'status', '--schema', PRISMA_SCHEMA_PATH],
    prismaCommandOptions(configuration.prismaEnvironment),
  );
  assertCommandSucceeded('prisma migrate status', result);
}

async function runPrismaDiff(configuration, spawnSync, dockerTarget, prismaDotenvCandidates) {
  assertDockerRestoreTarget(configuration, spawnSync, dockerTarget);
  await assertSafePrismaDotenvCandidates({ candidates: prismaDotenvCandidates });
  const result = spawnSync(
    process.execPath,
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
    prismaCommandOptions(configuration.prismaEnvironment),
  );
  assertCommandSucceeded('prisma migrate diff', result);
}

function runPostUpgradeAssertions(configuration, spawnSync, dockerTarget) {
  const completedAssertions = [];
  for (const assertionPath of POST_UPGRADE_ASSERTIONS) {
    assertDockerRestoreTarget(configuration, spawnSync, dockerTarget);
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

function prismaCommandOptions(environment) {
  return {
    ...commandOptions(environment, PRISMA_TIMEOUT_MS),
    cwd: REPOSITORY_ROOT,
  };
}

function dockerCommandOptions() {
  const environment = {
    LC_ALL: 'C',
    PATH: '/opt/homebrew/bin:/usr/bin:/bin',
  };
  if (process.env.HOME) environment.HOME = process.env.HOME;
  return commandOptions(environment, DOCKER_TIMEOUT_MS);
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

function parseJsonOutput(label, value) {
  try {
    return JSON.parse(String(value ?? '').trim());
  } catch {
    throw new Error(`${label} inspection returned invalid JSON.`);
  }
}

function sameStringArray(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
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
    throw new Error(`${name} must use 127.0.0.1 or ::1.`);
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

function formatLocalDatasource(datasource) {
  const host = datasource.host === '::1' ? '[::1]' : datasource.host;
  return (
    `postgresql://${encodeURIComponent(datasource.username)}:` +
    `${encodeURIComponent(datasource.password)}@${host}:${datasource.port}/` +
    `${encodeURIComponent(datasource.database)}?schema=public&connect_timeout=10&sslmode=disable`
  );
}

function normalizeHostname(hostname) {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

function decodeUrlComponent(value, label) {
  try {
    const decoded = decodeURIComponent(value);
    if (decoded.includes('\0')) throw new Error(`${label} must not contain NUL.`);
    return decoded;
  } catch {
    if (String(value).toLowerCase().includes('%00')) {
      throw new Error(`${label} must not contain NUL.`);
    }
    throw new Error(`${label} must use valid percent encoding.`);
  }
}

async function main() {
  const result = await runRestoreRehearsal();
  if (result.action === 'restore') {
    console.log(
      `Diagnostic-only restore completed: database=${result.database} archiveEntries=${result.archiveEntryCount}. Only one successful rehearse action is acceptable as end-to-end evidence.`,
    );
    return;
  }
  if (result.action === 'rehearse') {
    console.log(
      `Local restore rehearsal passed: database=${result.database} archiveEntries=${result.archiveEntryCount} prismaChecks=${result.prismaChecks.length} assertions=${result.completedAssertions.length}.`,
    );
    return;
  }
  console.log(
    `Diagnostic-only assertions passed: database=${result.database} count=${result.completedAssertions.length}. Only one successful rehearse action is acceptable as end-to-end evidence.`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
