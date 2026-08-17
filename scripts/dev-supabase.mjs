#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), '..');

export function buildSupabaseDevEnvironment(input) {
  const environment = { ...input };
  if (environment.REDIS_URL?.trim()) {
    throw new Error('REDIS_URL is forbidden; development runtime state uses Supabase');
  }

  const runtime = parseRuntimeDatasource(environment.DATABASE_URL);
  const direct = parseDirectDatasource(environment.DIRECT_URL, runtime.projectRef);
  if (direct.database !== runtime.database) {
    throw new Error('DATABASE_URL and DIRECT_URL must target the same Supabase database');
  }

  const supabaseUrl = `https://${runtime.projectRef}.supabase.co`;
  if (environment.SUPABASE_URL?.trim()) {
    let configured;
    try {
      configured = new URL(environment.SUPABASE_URL.trim());
    } catch {
      throw new Error('SUPABASE_URL must be a valid URL');
    }
    if (configured.origin !== supabaseUrl || configured.href !== `${supabaseUrl}/`) {
      throw new Error('SUPABASE_URL must match the development DATABASE_URL project');
    }
  }

  if (environment.PUBLISH_QUEUE_MODE && environment.PUBLISH_QUEUE_MODE !== 'database') {
    throw new Error('PUBLISH_QUEUE_MODE must be database for Supabase development');
  }
  environment.NODE_ENV = environment.NODE_ENV || 'development';
  environment.SUPABASE_URL = supabaseUrl;
  environment.PUBLISH_QUEUE_MODE = 'database';
  return environment;
}

function parseRuntimeDatasource(value) {
  const url = postgresUrl(value, 'DATABASE_URL');
  const match = url.username.match(/^postgres\.([a-z0-9]{20})$/);
  if (!match || !url.hostname.endsWith('.pooler.supabase.com') || url.port !== '6543') {
    throw new Error('DATABASE_URL must use a Supabase transaction pooler');
  }
  if (url.searchParams.get('pgbouncer') !== 'true') {
    throw new Error('Supabase transaction pooler DATABASE_URL must set pgbouncer=true');
  }
  const connectionLimit = Number(url.searchParams.get('connection_limit'));
  if (!Number.isInteger(connectionLimit) || connectionLimit < 3 || connectionLimit > 10) {
    throw new Error('DATABASE_URL connection_limit must be between 3 and 10');
  }
  return { database: url.pathname, projectRef: match[1] };
}

function parseDirectDatasource(value, projectRef) {
  const url = postgresUrl(value, 'DIRECT_URL');
  const direct =
    url.hostname === `db.${projectRef}.supabase.co` &&
    (url.port || '5432') === '5432' &&
    url.username === 'postgres';
  const sessionPooler =
    url.hostname.endsWith('.pooler.supabase.com') &&
    url.port === '5432' &&
    url.username === `postgres.${projectRef}`;
  if (!direct && !sessionPooler) {
    throw new Error('DIRECT_URL must use the matching Supabase direct or session connection');
  }
  return { database: url.pathname };
}

function postgresUrl(value, name) {
  if (!value?.trim()) throw new Error(`${name} is required`);
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error(`${name} must use PostgreSQL`);
  }
  if (!url.password) throw new Error(`${name} must include a password`);
  if (url.pathname !== '/postgres') throw new Error(`${name} must target /postgres`);
  const sslMode = url.searchParams.get('sslmode');
  if (sslMode !== null && sslMode !== 'require') {
    throw new Error(`${name} must not weaken Supabase TLS`);
  }
  return url;
}

async function main() {
  const environment = buildSupabaseDevEnvironment(process.env);
  const turbo = join(repositoryRoot, 'node_modules', '.bin', 'turbo');
  const child = spawn(turbo, ['run', 'dev', '--parallel'], {
    cwd: repositoryRoot,
    env: environment,
    stdio: 'inherit',
  });
  child.once('error', (error) => {
    console.error(`Failed to start Supabase development runtime: ${error.message}`);
    process.exitCode = 1;
  });
  child.once('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  void main();
}
