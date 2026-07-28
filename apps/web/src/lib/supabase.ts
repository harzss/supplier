import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { authMode, getSupabaseConfiguration } from './environment';

export { authMode, frontendConfigurationError, isDemoAuthMode } from './environment';

let client: SupabaseClient | undefined;
let accessToken: string | null = null;

export function getSupabaseClient(): SupabaseClient {
  if (authMode !== 'supabase') throw new Error('Supabase Auth is not enabled');
  if (client) return client;

  const { url, anonKey } = getSupabaseConfiguration();
  client = createClient(url, anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });
  return client;
}

export function setAccessToken(next: string | null): void {
  accessToken = next;
}

export function getAccessToken(): string | null {
  return accessToken;
}
