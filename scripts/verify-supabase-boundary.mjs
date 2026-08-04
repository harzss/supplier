#!/usr/bin/env node

import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

import { requireSupabasePublicApiKey, supabasePublicApiKeyHeaders } from './supabase-api-keys.mjs';

const REQUEST_TIMEOUT_MS = 10_000;
const STAGING_ENV_FILE = resolve('apps/web/.env.staging.local');

export async function readSupabaseBoundaryEnvironmentFile(path = STAGING_ENV_FILE) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch {
    throw new Error('The staging boundary environment file is missing or unreadable.');
  }
  if (
    !metadata.isFile() ||
    (metadata.mode & 0o777) !== 0o600 ||
    (typeof process.getuid === 'function' && metadata.uid !== process.getuid())
  ) {
    throw new Error(
      'The staging boundary environment file must be an owner-only regular file with mode 0600.',
    );
  }

  try {
    return parseEnv(await readFile(path, 'utf8'));
  } catch {
    throw new Error('The staging boundary environment file could not be parsed.');
  }
}

export function readSupabaseBoundaryConfiguration(
  environment,
  { requirePublishableKey = false } = {},
) {
  const rawUrl = environment.SUPABASE_URL ?? environment.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = environment.SUPABASE_ANON_KEY ?? environment.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!rawUrl || !anonKey) {
    throw new Error(
      'SUPABASE_URL/SUPABASE_ANON_KEY (or their NEXT_PUBLIC equivalents) are required.',
    );
  }

  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('SUPABASE_URL must be a valid URL.');
  }
  if (
    url.protocol !== 'https:' ||
    !/^[a-z0-9]{20}\.supabase\.co$/.test(url.hostname) ||
    url.origin !== rawUrl ||
    url.pathname !== '/'
  ) {
    throw new Error('SUPABASE_URL must be an exact https://<project-ref>.supabase.co origin.');
  }
  const validatedAnonKey = requireSupabasePublicApiKey(anonKey, 'SUPABASE_ANON_KEY');
  if (requirePublishableKey && !validatedAnonKey.startsWith('sb_publishable_')) {
    throw new Error('SUPABASE_ANON_KEY must be a publishable key for this verification.');
  }
  return { origin: url.origin, anonKey: validatedAnonKey };
}

export function assertSignupDisabled(settings) {
  if (!settings || typeof settings !== 'object' || settings.disable_signup !== true) {
    throw new Error('Supabase public signup is enabled or could not be proven disabled.');
  }
}

export function assertAnonymousBusinessAccessDenied(status) {
  if (![401, 403].includes(status)) {
    throw new Error(`Anonymous business-table access was not denied (HTTP ${status}).`);
  }
}

export async function verifySupabaseBoundary({ origin, anonKey }, fetcher = fetch) {
  const headers = supabasePublicApiKeyHeaders(anonKey);
  const settingsResponse = await fetcher(`${origin}/auth/v1/settings`, {
    headers,
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!settingsResponse.ok) {
    throw new Error(`Supabase Auth settings check failed (HTTP ${settingsResponse.status}).`);
  }
  let settings;
  try {
    settings = await settingsResponse.json();
  } catch {
    throw new Error('Supabase Auth settings returned invalid JSON.');
  }
  assertSignupDisabled(settings);

  const restResponse = await fetcher(`${origin}/rest/v1/users?select=id&limit=1`, {
    headers,
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  assertAnonymousBusinessAccessDenied(restResponse.status);
  return { signupDisabled: true, anonymousBusinessAccessStatus: restResponse.status };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--require-publishable-key')) {
    throw new Error('Unsupported command-line argument.');
  }
  const result = await verifySupabaseBoundary(
    readSupabaseBoundaryConfiguration(await readSupabaseBoundaryEnvironmentFile(), {
      requirePublishableKey: args.includes('--require-publishable-key'),
    }),
  );
  console.log(
    `Supabase boundary verified: signup disabled; anonymous business access denied (HTTP ${result.anonymousBusinessAccessStatus}).`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
