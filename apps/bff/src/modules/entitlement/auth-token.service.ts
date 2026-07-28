import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyResult } from 'jose';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface AuthTokenClaims {
  subject: string;
}

@Injectable()
export class AuthTokenService {
  private readonly logger = new Logger(AuthTokenService.name);
  private readonly enabled: boolean;
  private readonly verifyJwt: (token: string) => Promise<JWTVerifyResult<JWTPayload>>;

  constructor(config: ConfigService) {
    this.enabled = config.get<string>('AUTH_MODE') === 'supabase';
    if (!this.enabled) {
      this.verifyJwt = async () => {
        throw new UnauthorizedException('可信身份认证未启用');
      };
      return;
    }
    const supabaseUrl = required(config, 'SUPABASE_URL').replace(/\/$/, '');
    const issuer = `${supabaseUrl}/auth/v1`;
    const audience = config.get<string>('SUPABASE_JWT_AUDIENCE')?.trim() || 'authenticated';

    const legacySecret = config.get<string>('SUPABASE_JWT_SECRET')?.trim();
    if (legacySecret) {
      const key = new TextEncoder().encode(legacySecret);
      this.verifyJwt = (token) =>
        jwtVerify(token, key, { issuer, audience, algorithms: ['HS256'] });
    } else {
      const jwksUrl =
        config.get<string>('SUPABASE_JWKS_URL')?.trim() || `${issuer}/.well-known/jwks.json`;
      const key = createRemoteJWKSet(new URL(jwksUrl), {
        timeoutDuration: 5_000,
        cooldownDuration: 30_000,
      });
      this.verifyJwt = (token) =>
        jwtVerify(token, key, { issuer, audience, algorithms: ['ES256', 'RS256'] });
    }
  }

  async verify(token: string): Promise<AuthTokenClaims> {
    if (!this.enabled) throw new UnauthorizedException('可信身份认证未启用');
    let result: JWTVerifyResult<JWTPayload>;
    try {
      result = await this.verifyJwt(token);
    } catch (error) {
      this.logger.warn(`Supabase access token rejected: ${(error as Error).name}`);
      throw new UnauthorizedException('登录已失效，请重新登录');
    }

    const subject = result.payload.sub;
    if (!subject || !UUID.test(subject)) {
      throw new UnauthorizedException('登录凭证缺少有效用户标识');
    }
    return { subject };
  }
}

function required(config: ConfigService, name: string): string {
  const value = config.get<string>(name)?.trim();
  if (!value) throw new Error(`${name} is required when AUTH_MODE=supabase`);
  return value;
}
