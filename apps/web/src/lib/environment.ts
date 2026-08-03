export type WebAuthMode = 'demo' | 'supabase';

const production = process.env.NODE_ENV === 'production';
const configuredAuthMode = process.env.NEXT_PUBLIC_AUTH_MODE?.trim();
const configuredBffUrl = process.env.NEXT_PUBLIC_BFF_URL?.trim();
const configuredSupabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const configuredSupabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
const configuredSignupEnabled = process.env.NEXT_PUBLIC_SIGNUP_ENABLED?.trim();

export const authMode: WebAuthMode =
  configuredAuthMode === 'supabase' || production ? 'supabase' : 'demo';
export const isDemoAuthMode = authMode === 'demo';
export const isSignupEnabled = configuredSignupEnabled === 'true';

export function frontendConfigurationError(): string | undefined {
  if (configuredAuthMode && !['demo', 'supabase'].includes(configuredAuthMode)) {
    return 'NEXT_PUBLIC_AUTH_MODE 必须为 demo 或 supabase';
  }
  if (production && configuredAuthMode !== 'supabase') {
    return '生产环境必须设置 NEXT_PUBLIC_AUTH_MODE=supabase';
  }
  if (configuredSignupEnabled && !['true', 'false'].includes(configuredSignupEnabled)) {
    return 'NEXT_PUBLIC_SIGNUP_ENABLED 必须为 true 或 false';
  }

  if (authMode === 'supabase') {
    if (!configuredSupabaseUrl || !configuredSupabaseAnonKey) {
      return '缺少 NEXT_PUBLIC_SUPABASE_URL 或 NEXT_PUBLIC_SUPABASE_ANON_KEY';
    }
    const error = validateOrigin(configuredSupabaseUrl, 'NEXT_PUBLIC_SUPABASE_URL', production);
    if (error) return error;
  }

  if (production && !configuredBffUrl) return '生产环境缺少 NEXT_PUBLIC_BFF_URL';
  if (configuredBffUrl) {
    const error = validateOrigin(configuredBffUrl, 'NEXT_PUBLIC_BFF_URL', production);
    if (error) return error;
  }
  return undefined;
}

export function getBffUrl(): string {
  const error = frontendConfigurationError();
  if (error) throw new Error(error);
  return configuredBffUrl ?? 'http://localhost:3001';
}

export function getSupabaseConfiguration(): { url: string; anonKey: string } {
  const error = frontendConfigurationError();
  if (error) throw new Error(error);
  if (!configuredSupabaseUrl || !configuredSupabaseAnonKey) {
    throw new Error('Supabase Auth is not enabled');
  }
  return { url: configuredSupabaseUrl, anonKey: configuredSupabaseAnonKey };
}

function validateOrigin(value: string, name: string, requireHttps: boolean): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return `${name} 必须是有效 URL`;
  }
  if (url.origin !== value || url.pathname !== '/' || url.search || url.hash) {
    return `${name} 必须是无路径、query 和 hash 的 origin`;
  }
  if (requireHttps && url.protocol !== 'https:') return `${name} 在生产环境必须使用 HTTPS`;
  if (!['http:', 'https:'].includes(url.protocol)) return `${name} 必须使用 HTTP 或 HTTPS`;
  return undefined;
}
