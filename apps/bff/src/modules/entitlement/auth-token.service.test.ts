import type { ConfigService } from '@nestjs/config';
import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { AuthTokenService } from './auth-token.service';

const SECRET = 'supabase-jwt-secret-that-is-long-enough';
const SUBJECT = '9d278917-3e63-4f42-9b7f-981cabf48eb1';
const ISSUER = 'https://project.supabase.co/auth/v1';

function service(overrides: Record<string, string> = {}) {
  const values = {
    AUTH_MODE: 'supabase',
    SUPABASE_URL: 'https://project.supabase.co',
    SUPABASE_JWT_SECRET: SECRET,
    ...overrides,
  };
  return new AuthTokenService({ get: (key: string) => values[key] } as unknown as ConfigService);
}

async function token(subject = SUBJECT, secret = SECRET) {
  return new SignJWT({ role: 'authenticated' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(subject)
    .setIssuer(ISSUER)
    .setAudience('authenticated')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(secret));
}

describe('AuthTokenService', () => {
  it('verifies a valid Supabase access token', async () => {
    await expect(service().verify(await token())).resolves.toEqual({ subject: SUBJECT });
  });

  it('rejects invalid signatures and non-UUID subjects', async () => {
    await expect(service().verify(await token(SUBJECT, `${SECRET}-wrong`))).rejects.toMatchObject({
      status: 401,
    });
    await expect(service().verify(await token('user-1'))).rejects.toMatchObject({ status: 401 });
  });
});
