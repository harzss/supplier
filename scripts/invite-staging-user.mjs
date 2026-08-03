#!/usr/bin/env node

import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

import { requireSupabaseAdminApiKey, supabaseAdminApiKeyHeaders } from './supabase-api-keys.mjs';

const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 30_000;
const STAGING_ENV_FILE = resolve('apps/bff/.env.staging.local');

export async function readInviteEnvironmentFile(path = STAGING_ENV_FILE) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch {
    throw new Error('The staging invitation environment file is missing or unreadable.');
  }
  if (
    !metadata.isFile() ||
    (metadata.mode & 0o777) !== 0o600 ||
    (typeof process.getuid === 'function' && metadata.uid !== process.getuid())
  ) {
    throw new Error(
      'The staging invitation environment file must be an owner-only regular file with mode 0600.',
    );
  }

  try {
    return parseEnv(await readFile(path, 'utf8'));
  } catch {
    throw new Error('The staging invitation environment file could not be parsed.');
  }
}

export function readInviteConfiguration(environment = process.env) {
  const supabaseOrigin = requiredOrigin(environment.SUPABASE_URL, 'SUPABASE_URL', true);
  const webOrigin = requiredOrigin(environment.WEB_URL, 'WEB_URL');
  const adminKey = requireSupabaseAdminApiKey(environment.SUPABASE_SERVICE_ROLE_KEY);
  const email = requiredValue(environment.STAGING_INVITE_EMAIL, 'STAGING_INVITE_EMAIL').trim();
  if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('STAGING_INVITE_EMAIL is invalid.');
  }

  return {
    supabaseOrigin,
    webOrigin,
    adminKey,
    email,
    timeoutMs: parseTimeout(environment.STAGING_INVITE_TIMEOUT_MS),
  };
}

export async function inviteStagingUser(configuration, confirmedEmail, fetcher = fetch) {
  const { supabaseOrigin, webOrigin, adminKey, email, timeoutMs } = configuration;
  if (typeof confirmedEmail !== 'string' || confirmedEmail.trim() !== email) {
    throw new Error('Invitation target confirmation did not match; no request was sent.');
  }
  const url = new URL('/auth/v1/invite', `${supabaseOrigin}/`);
  url.searchParams.set('redirect_to', webOrigin);
  const signal = AbortSignal.timeout(timeoutMs);

  let response;
  try {
    response = await fetcher(url, {
      method: 'POST',
      headers: {
        ...supabaseAdminApiKeyHeaders(adminKey),
        'Content-Type': 'application/json;charset=UTF-8',
        'X-Supabase-Api-Version': '2024-01-01',
      },
      body: JSON.stringify({ email }),
      redirect: 'error',
      signal,
    });
  } catch {
    if (signal.aborted) {
      throw new Error(
        `Supabase invitation timed out after ${timeoutMs}ms; outcome is unknown; inspect Auth users before retrying.`,
      );
    }
    throw new Error(
      'Supabase invitation request failed; outcome is unknown; inspect Auth users before retrying.',
    );
  }

  if (response.status !== 200) {
    if (response.status >= 500) {
      throw new Error(
        `Supabase invitation returned HTTP ${response.status}; outcome is unknown; inspect Auth users before retrying.`,
      );
    }
    throw new Error(
      `Supabase invitation failed (HTTP ${response.status}); inspect Auth users before retrying.`,
    );
  }

  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(
      'Supabase invitation returned invalid success JSON; the request may already be effective; inspect Auth users before retrying.',
    );
  }
  if (
    !body ||
    typeof body !== 'object' ||
    typeof body.id !== 'string' ||
    body.id.length === 0 ||
    typeof body.email !== 'string' ||
    body.email.toLowerCase() !== email.toLowerCase() ||
    typeof body.invited_at !== 'string' ||
    body.invited_at.length === 0
  ) {
    throw new Error(
      'Supabase invitation returned an incomplete success response; the request may already be effective; inspect Auth users before retrying.',
    );
  }

  return { status: response.status };
}

function requiredOrigin(rawValue, name, requireSupabaseProject = false) {
  const value = requiredValue(rawValue, name).trim();
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL.`);
  }
  if (
    url.protocol !== 'https:' ||
    url.port !== '' ||
    url.origin !== value ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${name} must be an exact HTTPS origin without path, query, or hash.`);
  }
  if (requireSupabaseProject && !/^[a-z0-9]{20}\.supabase\.co$/.test(url.hostname)) {
    throw new Error(`${name} must be an exact Supabase project origin.`);
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
    throw new Error('STAGING_INVITE_TIMEOUT_MS must be an integer between 100 and 30000.');
  }
  return parsed;
}

async function main() {
  const configuration = readInviteConfiguration(await readInviteEnvironmentFile());
  const reader = createInterface({ input: process.stdin, output: process.stderr });
  let confirmedEmail;
  try {
    confirmedEmail = await reader.question(
      'Type the exact target email to authorize one invitation request: ',
    );
  } finally {
    reader.close();
  }
  const result = await inviteStagingUser(configuration, confirmedEmail);
  console.log(
    `Supabase staging invitation accepted (HTTP ${result.status}). Remove STAGING_INVITE_EMAIL now, then check the target inbox.`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Supabase invitation failed.');
    process.exitCode = 1;
  });
}
