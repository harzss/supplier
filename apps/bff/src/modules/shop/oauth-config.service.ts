import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AdapterConfig } from '@supplier/platform-sdk';

export const OAUTH_PLATFORMS = ['douyin', 'alibaba_1688'] as const;
export type OAuthPlatform = (typeof OAUTH_PLATFORMS)[number];

const DEFAULT_STATE_TTL_SECONDS = 300;
const DEFAULT_DEV_CALLBACKS = [
  'http://localhost:3001/api/shops/oauth/douyin/callback',
  'http://localhost:3001/api/shops/oauth/alibaba_1688/callback',
];
const DEFAULT_DEV_RESULT_REDIRECT = 'http://localhost:3000/settings';
const UNSAFE_RETURN_TO_CHARACTERS = /[\\\u0000-\u001f\u007f]/;

@Injectable()
export class OAuthConfigService {
  private readonly allowedCallbacks: Set<string>;
  private readonly production: boolean;

  constructor(private readonly config: ConfigService) {
    this.production = config.get<string>('NODE_ENV') === 'production';
    const configured = config.get<string>('OAUTH_CALLBACK_ALLOWLIST');
    const values = (configured ?? (this.production ? '' : DEFAULT_DEV_CALLBACKS.join(',')))
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    this.allowedCallbacks = new Set(values.map((value) => this.normalizeCallback(value)));
  }

  getPlatformConfig(platform: OAuthPlatform): AdapterConfig {
    const prefix = platform.toUpperCase();
    const appKey = this.config.get<string>(`${prefix}_APP_KEY`)?.trim();
    const appSecret = this.config.get<string>(`${prefix}_APP_SECRET`)?.trim();
    const redirectUri = this.config.get<string>(`${prefix}_OAUTH_REDIRECT_URI`)?.trim();
    const serviceId = this.config.get<string>(`${prefix}_SERVICE_ID`)?.trim();

    if (!appKey || !appSecret || !redirectUri || (platform === 'douyin' && !serviceId)) {
      throw new ServiceUnavailableException(`${platform} OAuth is not configured`);
    }

    return {
      appKey,
      appSecret,
      customerMobile: this.config.get<string>(`${prefix}_CUSTOMER_MOBILE`)?.trim(),
      redirectUri: this.assertAllowedCallback(redirectUri),
      serviceId,
      sandbox: this.config.get<string>(`${prefix}_OAUTH_SANDBOX`) === 'true',
    };
  }

  getStateTtlSeconds(): number {
    const raw = this.config.get<string>('OAUTH_STATE_TTL_SECONDS');
    if (!raw) return DEFAULT_STATE_TTL_SECONDS;

    const ttl = Number(raw);
    if (!Number.isInteger(ttl) || ttl < 60 || ttl > 900) {
      throw new ServiceUnavailableException('OAUTH_STATE_TTL_SECONDS must be between 60 and 900');
    }
    return ttl;
  }

  normalizeReturnTo(value?: string): string {
    const fallback = this.getResultRedirectUrl();
    if (value === undefined) {
      return `${fallback.pathname}${fallback.search}${fallback.hash}`;
    }
    if (
      !value.startsWith('/') ||
      value.startsWith('//') ||
      UNSAFE_RETURN_TO_CHARACTERS.test(value)
    ) {
      throw new BadRequestException('OAuth returnTo must be an application-relative URL');
    }

    let url: URL;
    try {
      url = new URL(value, fallback);
    } catch {
      throw new BadRequestException('OAuth returnTo must be an application-relative URL');
    }
    if (
      url.origin !== fallback.origin ||
      !url.pathname.startsWith('/') ||
      url.pathname.startsWith('//')
    ) {
      throw new BadRequestException('OAuth returnTo must be an application-relative URL');
    }
    return `${url.pathname}${url.search}${url.hash}`;
  }

  buildResultRedirect(params: Record<string, string | undefined>, returnTo?: string): string {
    const fallback = this.getResultRedirectUrl();
    const url =
      returnTo === undefined
        ? new URL(fallback)
        : new URL(this.normalizeReturnTo(returnTo), fallback.origin);
    for (const [key, paramValue] of Object.entries(params)) {
      if (paramValue) url.searchParams.set(key, paramValue);
    }
    return url.toString();
  }

  private getResultRedirectUrl(): URL {
    const configured = this.config.get<string>('OAUTH_RESULT_REDIRECT_URL')?.trim();
    const value = configured || (this.production ? '' : DEFAULT_DEV_RESULT_REDIRECT);
    if (!value) {
      throw new ServiceUnavailableException('OAUTH_RESULT_REDIRECT_URL is not configured');
    }
    return new URL(this.normalizeCallback(value));
  }

  assertAllowedCallback(value: string): string {
    const normalized = this.normalizeCallback(value);
    if (!this.allowedCallbacks.has(normalized)) {
      throw new BadRequestException('OAuth callback URL is not allowed');
    }
    return normalized;
  }

  private normalizeCallback(value: string): string {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new BadRequestException('OAuth callback URL must be absolute');
    }

    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
      throw new BadRequestException('OAuth callback URL is invalid');
    }
    if (this.production && url.protocol !== 'https:') {
      throw new BadRequestException('OAuth callback URL must use HTTPS in production');
    }
    return url.toString();
  }
}
