function requiredValue(rawValue, name) {
  if (typeof rawValue !== 'string' || rawValue.length === 0) {
    throw new Error(`${name} is required.`);
  }
  return rawValue.trim();
}

export function requireSupabaseAdminApiKey(rawValue, name = 'SUPABASE_SERVICE_ROLE_KEY') {
  const value = requiredValue(rawValue, name);
  if (/^sb_secret_[A-Za-z0-9_-]{20,}$/.test(value)) return value;
  if (isLegacyJwtForRole(value, 'service_role')) return value;
  throw new Error(`${name} must have a supported service-role or secret key format.`);
}

export function requireSupabasePublicApiKey(rawValue, name = 'NEXT_PUBLIC_SUPABASE_ANON_KEY') {
  const value = requiredValue(rawValue, name);
  if (/^sb_publishable_[A-Za-z0-9_-]{20,}$/.test(value)) return value;
  if (isLegacyJwtForRole(value, 'anon')) return value;
  throw new Error(`${name} must have a supported anon or publishable key format.`);
}

export function supabaseAdminApiKeyHeaders(rawValue) {
  return apiKeyHeaders(requireSupabaseAdminApiKey(rawValue));
}

export function supabasePublicApiKeyHeaders(rawValue) {
  return apiKeyHeaders(requireSupabasePublicApiKey(rawValue));
}

function apiKeyHeaders(value) {
  if (value.startsWith('sb_')) return { apikey: value };
  return { apikey: value, authorization: `Bearer ${value}` };
}

function isLegacyJwtForRole(value, role) {
  const parts = value.split('.');
  if (parts.length !== 3) return false;
  if (!/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]+$/.test(parts[1])) return false;
  if (!/^[A-Za-z0-9_-]{43}$/.test(parts[2])) return false;

  try {
    const headerBytes = Buffer.from(parts[0], 'base64url');
    const payloadBytes = Buffer.from(parts[1], 'base64url');
    if (
      headerBytes.toString('base64url') !== parts[0] ||
      payloadBytes.toString('base64url') !== parts[1]
    ) {
      return false;
    }
    const header = JSON.parse(headerBytes.toString('utf8'));
    const payload = JSON.parse(payloadBytes.toString('utf8'));
    return (
      header &&
      typeof header === 'object' &&
      header.alg === 'HS256' &&
      header.typ === 'JWT' &&
      payload &&
      typeof payload === 'object' &&
      payload.role === role &&
      payload.iss === 'supabase' &&
      Number.isInteger(payload.exp) &&
      payload.exp > Math.floor(Date.now() / 1000)
    );
  } catch {
    return false;
  }
}
