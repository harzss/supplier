#!/usr/bin/env node

import { lstat, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

import { requireSupabaseAdminApiKey, supabaseAdminApiKeyHeaders } from './supabase-api-keys.mjs';

const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 30_000;
const STAGING_ENV_FILE = resolve('apps/bff/.env.staging.local');
const PROBE_CONTENT = 'supplier-supabase-key-rotation-smoke-v1';

export async function readKeyRotationEnvironmentFile(path = STAGING_ENV_FILE) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch {
    throw new Error('The staging key-rotation environment file is missing or unreadable.');
  }
  if (
    !metadata.isFile() ||
    (metadata.mode & 0o777) !== 0o600 ||
    (typeof process.getuid === 'function' && metadata.uid !== process.getuid())
  ) {
    throw new Error(
      'The staging key-rotation environment file must be an owner-only regular file with mode 0600.',
    );
  }

  try {
    return parseEnv(await readFile(path, 'utf8'));
  } catch {
    throw new Error('The staging key-rotation environment file could not be parsed.');
  }
}

export function readKeyRotationConfiguration(environment) {
  const supabaseOrigin = requiredSupabaseOrigin(environment.SUPABASE_URL);
  const adminKey = requireSupabaseAdminApiKey(environment.SUPABASE_SERVICE_ROLE_KEY);
  if (!adminKey.startsWith('sb_secret_')) {
    throw new Error(
      'SUPABASE_SERVICE_ROLE_KEY must be a new secret key for rotation verification.',
    );
  }
  const bucket = requiredValue(
    environment.SUPABASE_STORAGE_BUCKET,
    'SUPABASE_STORAGE_BUCKET',
  ).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(bucket)) {
    throw new Error('SUPABASE_STORAGE_BUCKET is invalid.');
  }
  return {
    supabaseOrigin,
    adminKey,
    bucket,
    timeoutMs: parseTimeout(environment.STAGING_KEY_ROTATION_TIMEOUT_MS),
  };
}

export async function verifySupabaseKeyRotation(
  configuration,
  fetcher = fetch,
  idFactory = randomUUID,
) {
  const { supabaseOrigin, adminKey, bucket, timeoutMs } = configuration;
  const probeId = idFactory();
  if (typeof probeId !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(probeId)) {
    throw new Error('Could not create a safe storage probe identifier.');
  }

  const encodedObject = encodePath(`${bucket}/_supplier-key-rotation/${probeId}.txt`);
  const objectUrl = `${supabaseOrigin}/storage/v1/object/${encodedObject}`;
  const publicUrl = `${supabaseOrigin}/storage/v1/object/public/${encodedObject}`;
  const adminHeaders = supabaseAdminApiKeyHeaders(adminKey);
  let probeMayExist = false;

  try {
    const adminResponse = await request(
      fetcher,
      `${supabaseOrigin}/auth/v1/admin/users?page=1&per_page=1`,
      { headers: adminHeaders, redirect: 'error' },
      timeoutMs,
      'Auth admin probe',
    );
    assertStatus(adminResponse, 200, 'Auth admin probe');

    probeMayExist = true;
    const uploadResponse = await request(
      fetcher,
      objectUrl,
      {
        method: 'POST',
        headers: {
          ...adminHeaders,
          'content-type': 'text/plain;charset=UTF-8',
          'x-upsert': 'false',
        },
        body: PROBE_CONTENT,
        redirect: 'error',
      },
      timeoutMs,
      'Storage upload probe',
    );
    if (uploadResponse.status >= 400 && uploadResponse.status < 500) {
      probeMayExist = false;
    }
    assertSuccess(uploadResponse, 'Storage upload probe');

    const publicReadResponse = await request(
      fetcher,
      publicUrl,
      { redirect: 'error' },
      timeoutMs,
      'Public storage read probe',
    );
    assertStatus(publicReadResponse, 200, 'Public storage read probe');
    if ((await publicReadResponse.text()) !== PROBE_CONTENT) {
      throw new Error('Public storage read probe returned unexpected content.');
    }

    const deleteResponse = await request(
      fetcher,
      objectUrl,
      { method: 'DELETE', headers: adminHeaders, redirect: 'error' },
      timeoutMs,
      'Storage delete probe',
    );
    assertSuccess(deleteResponse, 'Storage delete probe');
    probeMayExist = false;

    return {
      adminStatus: adminResponse.status,
      uploadStatus: uploadResponse.status,
      publicReadStatus: publicReadResponse.status,
      deleteStatus: deleteResponse.status,
    };
  } catch (error) {
    if (probeMayExist) {
      const cleanupProven = await cleanupProbe(fetcher, objectUrl, adminHeaders, timeoutMs);
      if (!cleanupProven) {
        throw new Error(`${safeMessage(error)} Probe cleanup could not be proven.`);
      }
    }
    throw error;
  }
}

async function cleanupProbe(fetcher, objectUrl, headers, timeoutMs) {
  try {
    const response = await request(
      fetcher,
      objectUrl,
      { method: 'DELETE', headers, redirect: 'error' },
      timeoutMs,
      'Storage probe cleanup',
    );
    return response.ok || response.status === 404;
  } catch {
    return false;
  }
}

async function request(fetcher, url, init, timeoutMs, label) {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    return await fetcher(url, { ...init, signal });
  } catch {
    if (signal.aborted) throw new Error(`${label} timed out after ${timeoutMs}ms.`);
    throw new Error(`${label} request failed.`);
  }
}

function assertStatus(response, expectedStatus, label) {
  if (response.status !== expectedStatus) {
    throw new Error(`${label}: expected HTTP ${expectedStatus}, got ${response.status}.`);
  }
}

function assertSuccess(response, label) {
  if (!response.ok) throw new Error(`${label} failed (HTTP ${response.status}).`);
}

function requiredSupabaseOrigin(rawValue) {
  const value = requiredValue(rawValue, 'SUPABASE_URL').trim();
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('SUPABASE_URL must be a valid URL.');
  }
  if (
    url.protocol !== 'https:' ||
    url.port !== '' ||
    url.origin !== value ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    !/^[a-z0-9]{20}\.supabase\.co$/.test(url.hostname)
  ) {
    throw new Error('SUPABASE_URL must be an exact Supabase project HTTPS origin.');
  }
  return url.origin;
}

function requiredValue(value, name) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} is required.`);
  return value;
}

function parseTimeout(value) {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < MIN_TIMEOUT_MS || parsed > MAX_TIMEOUT_MS) {
    throw new Error('STAGING_KEY_ROTATION_TIMEOUT_MS must be an integer between 100 and 30000.');
  }
  return parsed;
}

function encodePath(value) {
  return value
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function safeMessage(error) {
  return error instanceof Error ? error.message : 'Supabase key-rotation verification failed.';
}

async function main() {
  const result = await verifySupabaseKeyRotation(
    readKeyRotationConfiguration(await readKeyRotationEnvironmentFile()),
  );
  console.log(
    `Supabase secret key verified: admin ${result.adminStatus}; storage upload ${result.uploadStatus}; public read ${result.publicReadStatus}; delete ${result.deleteStatus}.`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Supabase key verification failed.');
    process.exitCode = 1;
  });
}
