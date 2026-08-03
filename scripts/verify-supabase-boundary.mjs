#!/usr/bin/env node

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REQUEST_TIMEOUT_MS = 10_000;

export function readSupabaseBoundaryConfiguration(environment = process.env) {
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
  if (anonKey.trim().length < 20) throw new Error('SUPABASE_ANON_KEY is invalid.');
  return { origin: url.origin, anonKey: anonKey.trim() };
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
  const headers = { apikey: anonKey, Authorization: `Bearer ${anonKey}` };
  const settingsResponse = await fetcher(`${origin}/auth/v1/settings`, {
    headers,
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
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  assertAnonymousBusinessAccessDenied(restResponse.status);
  return { signupDisabled: true, anonymousBusinessAccessStatus: restResponse.status };
}

async function main() {
  const result = await verifySupabaseBoundary(readSupabaseBoundaryConfiguration());
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
