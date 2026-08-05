#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { spawnSync as nodeSpawnSync } from 'node:child_process';
import { createReadStream as nodeCreateReadStream } from 'node:fs';
import {
  link as nodeLink,
  open as nodeOpen,
  stat as nodeStat,
  unlink as nodeUnlink,
} from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describeStagingDatasource } from './audit-staging.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const packageDir = dirname(dirname(scriptPath));
const repositoryRoot = dirname(dirname(packageDir));

export const LIBPQ_BIN_DIR = '/opt/homebrew/opt/libpq@17/bin';
export const SUPABASE_CA_CERT_PATH = join(
  repositoryRoot,
  'infra',
  'postgres',
  'certs',
  'supabase-prod-ca-2021.crt',
);
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

const BACKUP_REQUIRED_OBJECTS = Object.freeze([
  'TABLE public _prisma_migrations',
  'TABLE DATA public _prisma_migrations',
  'TABLE public source_products',
  'TABLE DATA public source_products',
]);
const VERSION_TIMEOUT_MS = 30_000;
const BACKUP_TIMEOUT_MS = 300_000;
const ARCHIVE_LIST_TIMEOUT_MS = 60_000;
const ASSERTION_TIMEOUT_MS = 60_000;
const MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const USAGE =
  'Usage: staging-libpq.mjs backup --output=<absolute.dump> --confirm-project=<STAGING_PROJECT_REF>\n' +
  '   or: staging-libpq.mjs post-upgrade-assert --confirm-project=<STAGING_PROJECT_REF>';

export function readStagingLibpqOptions(args) {
  const action = args[0];
  if (!['backup', 'post-upgrade-assert'].includes(action)) throw new Error(USAGE);

  const expectedLength = action === 'backup' ? 3 : 2;
  const confirmations = args.slice(1).filter((arg) => arg.startsWith('--confirm-project='));
  const outputs = args.slice(1).filter((arg) => arg.startsWith('--output='));
  const allowed = new Set([...confirmations, ...outputs]);
  if (
    args.length !== expectedLength ||
    confirmations.length !== 1 ||
    outputs.length !== (action === 'backup' ? 1 : 0) ||
    args.slice(1).some((arg) => !allowed.has(arg))
  ) {
    throw new Error(USAGE);
  }

  const confirmedProjectRef = confirmations[0].slice('--confirm-project='.length);
  if (!confirmedProjectRef) throw new Error('--confirm-project must not be empty.');

  if (action === 'post-upgrade-assert') {
    return { action, confirmedProjectRef };
  }

  const output = outputs[0].slice('--output='.length);
  if (!output || !isAbsolute(output) || extname(output) !== '.dump') {
    throw new Error('--output must be an absolute path ending in .dump.');
  }
  return { action, confirmedProjectRef, output: resolve(output) };
}

export function readStagingLibpqConfiguration(args, environment) {
  const options = readStagingLibpqOptions(args);
  const datasource = describeStagingDatasource({
    projectRef: environment.STAGING_PROJECT_REF,
    databaseUrl: environment.DATABASE_URL,
    directUrl: environment.DIRECT_URL,
  });
  if (options.confirmedProjectRef !== datasource.projectRef) {
    throw new Error('--confirm-project must exactly match the validated STAGING_PROJECT_REF.');
  }

  const directUrl = new URL(environment.DIRECT_URL);
  const username = decodeUrlComponent(directUrl.username, 'DIRECT_URL username');
  const password = decodeUrlComponent(directUrl.password, 'DIRECT_URL password');
  if (!username) throw new Error('DIRECT_URL must include a username.');
  if (!password) throw new Error('DIRECT_URL must include a password.');

  const libpqEnvironment = {
    LC_ALL: 'C',
    PGAPPNAME: 'supplier-staging-maintenance',
    PGCONNECT_TIMEOUT: '10',
    PGDATABASE: datasource.database,
    PGHOST: datasource.direct.host,
    PGPASSWORD: password,
    PGPORT: datasource.direct.port,
    PGSSLMODE: 'verify-full',
    PGSSLROOTCERT: SUPABASE_CA_CERT_PATH,
    PGUSER: username,
  };
  return {
    ...options,
    datasource,
    libpqEnvironment,
    readOnlyLibpqEnvironment: {
      ...libpqEnvironment,
      PGOPTIONS: '-c default_transaction_read_only=on',
    },
  };
}

export function inspectBackupArchiveList(value) {
  const entries = String(value)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith(';'));
  if (entries.length === 0) throw new Error('pg_restore returned an empty archive list.');

  const missingObjects = BACKUP_REQUIRED_OBJECTS.filter(
    (required) => !entries.some((entry) => entry.includes(` ${required} `)),
  );
  if (missingObjects.length > 0) {
    throw new Error(`Backup archive is missing required objects: ${missingObjects.join(', ')}.`);
  }
  return { archiveEntryCount: entries.length };
}

export async function runStagingLibpq({
  args = process.argv.slice(2),
  environment = process.env,
  spawnSync = nodeSpawnSync,
  linkFile = nodeLink,
  openFile = nodeOpen,
  statFile = nodeStat,
  unlinkFile = nodeUnlink,
  createReadStream = nodeCreateReadStream,
} = {}) {
  const configuration = readStagingLibpqConfiguration(args, environment);
  if (configuration.action === 'backup') {
    assertLibpq17('pg_dump', spawnSync);
    assertLibpq17('pg_restore', spawnSync);
    return runBackup(configuration, {
      spawnSync,
      linkFile,
      openFile,
      statFile,
      unlinkFile,
      createReadStream,
    });
  }

  assertLibpq17('psql', spawnSync);
  return runPostUpgradeAssertions(configuration, spawnSync);
}

async function runBackup(
  configuration,
  { spawnSync, linkFile, openFile, statFile, unlinkFile, createReadStream },
) {
  const partialOutput = `${configuration.output}.partial-${process.pid}-${randomUUID()}`;
  let partialCreated = false;
  let published = false;
  let outputHandle;
  let result;
  try {
    outputHandle = await openFile(partialOutput, 'wx', 0o600);
    partialCreated = true;
    await outputHandle.chmod(0o600);

    const dumpResult = spawnSync(
      join(LIBPQ_BIN_DIR, 'pg_dump'),
      ['--format=custom', '--schema=public', '--no-owner', '--no-privileges', '--no-password'],
      {
        encoding: 'utf8',
        env: configuration.readOnlyLibpqEnvironment,
        killSignal: 'SIGTERM',
        maxBuffer: MAX_BUFFER_BYTES,
        stdio: ['ignore', outputHandle.fd, 'pipe'],
        timeout: BACKUP_TIMEOUT_MS,
      },
    );
    assertCommandSucceeded('pg_dump', dumpResult);
    await outputHandle.sync();
    await outputHandle.close();
    outputHandle = undefined;

    const listResult = spawnSync(join(LIBPQ_BIN_DIR, 'pg_restore'), ['--list', partialOutput], {
      encoding: 'utf8',
      env: { LC_ALL: 'C' },
      killSignal: 'SIGTERM',
      maxBuffer: MAX_BUFFER_BYTES,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: ARCHIVE_LIST_TIMEOUT_MS,
    });
    assertCommandSucceeded('pg_restore --list', listResult);
    const { archiveEntryCount } = inspectBackupArchiveList(listResult.stdout);

    const outputStat = await statFile(partialOutput);
    if (!outputStat.isFile() || outputStat.size === 0) {
      throw new Error('Backup output must be a non-empty regular file.');
    }
    if ((outputStat.mode & 0o777) !== 0o600) {
      throw new Error('Backup output permissions must be exactly 0600.');
    }

    result = {
      action: configuration.action,
      output: configuration.output,
      bytes: outputStat.size,
      sha256: await hashFile(partialOutput, createReadStream),
      archiveEntryCount,
    };
    await linkFile(partialOutput, configuration.output);
    published = true;
    await unlinkFile(partialOutput);
    partialCreated = false;
    return result;
  } catch (error) {
    const cleanupErrors = [];
    if (outputHandle) {
      try {
        await outputHandle.close();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (partialCreated) {
      try {
        await unlinkFile(partialOutput);
        partialCreated = false;
      } catch (cleanupError) {
        if (cleanupError?.code !== 'ENOENT') cleanupErrors.push(cleanupError);
      }
    }
    if (published && cleanupErrors.length === 0) return result;
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        published
          ? 'Backup archive was published, but its validated partial file could not be removed.'
          : 'Backup failed and its incomplete partial output could not be cleaned up.',
      );
    }
    throw error;
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
      {
        encoding: 'utf8',
        env: environment,
        killSignal: 'SIGTERM',
        maxBuffer: MAX_BUFFER_BYTES,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: ASSERTION_TIMEOUT_MS,
      },
    );
    assertCommandSucceeded(`psql ${basename(assertionPath)}`, result);
    completedAssertions.push(basename(assertionPath));
  }
  return {
    action: configuration.action,
    completedAssertions,
  };
}

function assertLibpq17(tool, spawnSync) {
  const result = spawnSync(join(LIBPQ_BIN_DIR, tool), ['--version'], {
    encoding: 'utf8',
    env: { LC_ALL: 'C' },
    killSignal: 'SIGTERM',
    maxBuffer: MAX_BUFFER_BYTES,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: VERSION_TIMEOUT_MS,
  });
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

async function hashFile(path, createReadStream) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function decodeUrlComponent(value, label) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error(`${label} must use valid percent encoding.`);
  }
}

async function main() {
  const result = await runStagingLibpq();
  if (result.action === 'backup') {
    console.log(
      `Backup archive created; TOC inspection passed, but recoverability still requires the runbook restore rehearsal: output=${result.output} bytes=${result.bytes} sha256=${result.sha256} archiveEntries=${result.archiveEntryCount}.`,
    );
    return;
  }
  console.log(`Post-upgrade assertions passed: count=${result.completedAssertions.length}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
