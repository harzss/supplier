import { describe, expect, it } from 'vitest';
import { corsOrigins, swaggerEnabled, validateEnvironment } from './environment';

const PRODUCTION_ENV = {
  NODE_ENV: 'production',
  AUTH_MODE: 'supabase',
  DATABASE_URL: 'postgresql://supplier:secret@db.example.com:5432/supplier',
  REDIS_URL: 'rediss://cache.example.com:6379',
  ENCRYPTION_KEY: 'encryption-key-that-is-longer-than-32-characters',
  OPERATIONS_TOKEN: 'operations-token-that-is-longer-than-32-characters',
  ALERT_WEBHOOK_URL: 'https://alerts.example.com/hooks/supplier',
  ALERT_WEBHOOK_SECRET: 'alert-webhook-secret-longer-than-32-characters',
  SUPABASE_URL: 'https://project.supabase.co',
  CORS_ORIGINS: 'https://supplier.example.com,https://admin.example.com',
  PUBLISH_QUEUE_MODE: 'database',
};

const PRODUCTION_PURCHASE_ENV = {
  ...PRODUCTION_ENV,
  ALIBABA_1688_PURCHASE_ENABLED: 'true',
  ALIBABA_1688_PAYMENT_MODE: 'manual',
  ALIBABA_1688_APP_KEY: '1688-app-key',
  ALIBABA_1688_APP_SECRET: '1688-app-secret',
  ALIBABA_1688_OAUTH_REDIRECT_URI:
    'https://api.supplier.example.com/api/shops/oauth/alibaba_1688/callback',
};

const PRODUCTION_ORDER_SYNC_ENV = {
  ...PRODUCTION_ENV,
  DOUYIN_ORDER_SYNC_ENABLED: 'true',
  DOUYIN_APP_KEY: 'douyin-app-key',
  DOUYIN_APP_SECRET: 'douyin-app-secret',
  DOUYIN_SERVICE_ID: 'douyin-service-id',
  DOUYIN_OAUTH_REDIRECT_URI: 'https://api.supplier.example.com/api/shops/oauth/douyin/callback',
  OAUTH_CALLBACK_ALLOWLIST: 'https://api.supplier.example.com/api/shops/oauth/douyin/callback',
};

describe('validateEnvironment', () => {
  it('keeps safe development defaults', () => {
    expect(validateEnvironment({})).toMatchObject({
      NODE_ENV: 'development',
      AUTH_MODE: 'demo',
      PORT: 3001,
      HEALTH_CHECK_TIMEOUT_MS: 2000,
      ALERT_WEBHOOK_MAX_ATTEMPTS: 3,
      ALERT_WEBHOOK_RETRY_BASE_MS: 500,
      INVENTORY_SYNC_POLL_MS: 5000,
      INVENTORY_SYNC_MAX_ATTEMPTS: 3,
      PRODUCT_BATCH_POLL_MS: 2000,
      PRODUCT_BATCH_MAX_ATTEMPTS: 3,
    });
  });

  it('accepts a complete production runtime configuration', () => {
    expect(validateEnvironment(PRODUCTION_ENV)).toMatchObject({
      NODE_ENV: 'production',
      PORT: 3001,
      PUBLISH_QUEUE_MODE: 'database',
    });
  });

  it('rejects missing or insecure production secrets', () => {
    expect(() => validateEnvironment({ NODE_ENV: 'production' })).toThrow(
      'AUTH_MODE must be supabase in production',
    );
    expect(() =>
      validateEnvironment({
        NODE_ENV: 'production',
        AUTH_MODE: 'supabase',
        SUPABASE_URL: 'https://project.supabase.co',
      }),
    ).toThrow('DATABASE_URL is required in production');
    expect(() =>
      validateEnvironment({ ...PRODUCTION_ENV, ENCRYPTION_KEY: 'change-me-in-production' }),
    ).toThrow('ENCRYPTION_KEY must be a non-default secret');
  });

  it('requires Supabase Auth configuration when the mode is enabled', () => {
    expect(() => validateEnvironment({ AUTH_MODE: 'supabase' })).toThrow(
      'SUPABASE_URL is required when AUTH_MODE=supabase',
    );
    expect(() =>
      validateEnvironment({ AUTH_MODE: 'supabase', SUPABASE_URL: 'http://localhost:54321' }),
    ).not.toThrow();
  });

  it('rejects unsafe production origins and inline queue execution', () => {
    expect(() =>
      validateEnvironment({ ...PRODUCTION_ENV, CORS_ORIGINS: 'http://supplier.example.com' }),
    ).toThrow('CORS_ORIGINS must use HTTPS in production');
    expect(() => validateEnvironment({ ...PRODUCTION_ENV, PUBLISH_QUEUE_MODE: 'inline' })).toThrow(
      'PUBLISH_QUEUE_MODE must be database in production',
    );
    expect(() =>
      validateEnvironment({
        ...PRODUCTION_ENV,
        ALERT_WEBHOOK_URL: 'http://alerts.example.com/hook',
      }),
    ).toThrow('ALERT_WEBHOOK_URL must use https:');
    expect(() => validateEnvironment({ ...PRODUCTION_ENV, OPERATIONS_TOKEN: 'short' })).toThrow(
      'OPERATIONS_TOKEN must be a non-default secret',
    );
  });

  it('rejects unsafe alert delivery retry configuration', () => {
    expect(() => validateEnvironment({ ALERT_WEBHOOK_MAX_ATTEMPTS: 0 })).toThrow(
      'ALERT_WEBHOOK_MAX_ATTEMPTS must be an integer between 1 and 5',
    );
    expect(() => validateEnvironment({ ALERT_WEBHOOK_RETRY_BASE_MS: 99 })).toThrow(
      'ALERT_WEBHOOK_RETRY_BASE_MS must be an integer between 100 and 5000',
    );
  });

  it('rejects an invalid 1688 purchase switch value', () => {
    expect(() => validateEnvironment({ ALIBABA_1688_PURCHASE_ENABLED: 'enabled' })).toThrow(
      'ALIBABA_1688_PURCHASE_ENABLED must be true or false',
    );
  });

  it('requires safe and bounded 1688 purchase audit configuration', () => {
    expect(() => validateEnvironment({ ALIBABA_1688_PURCHASE_AUDIT_ENABLED: 'enabled' })).toThrow(
      'ALIBABA_1688_PURCHASE_AUDIT_ENABLED must be true or false',
    );
    expect(() => validateEnvironment({ ALIBABA_1688_PURCHASE_AUDIT_ENABLED: 'true' })).toThrow(
      'ALIBABA_1688_PURCHASE_AUDIT_ENABLED requires ALIBABA_1688_PURCHASE_ENABLED=true',
    );
    expect(() => validateEnvironment({ ALIBABA_1688_PURCHASE_AUDIT_INTERVAL_MS: 59_999 })).toThrow(
      'ALIBABA_1688_PURCHASE_AUDIT_INTERVAL_MS must be an integer between 60000 and 3600000',
    );
    expect(() => validateEnvironment({ ALIBABA_1688_PURCHASE_AUDIT_BATCH_SIZE: 501 })).toThrow(
      'ALIBABA_1688_PURCHASE_AUDIT_BATCH_SIZE must be an integer between 1 and 500',
    );
  });

  it('requires manual payment and complete 1688 credentials when production purchasing is enabled', () => {
    expect(() =>
      validateEnvironment({ ...PRODUCTION_ENV, ALIBABA_1688_PURCHASE_ENABLED: 'true' }),
    ).toThrow('ALIBABA_1688_PAYMENT_MODE must be manual');
    expect(() =>
      validateEnvironment({
        ...PRODUCTION_ENV,
        ALIBABA_1688_PURCHASE_ENABLED: 'true',
        ALIBABA_1688_PAYMENT_MODE: 'manual',
      }),
    ).toThrow('ALIBABA_1688_APP_KEY is required in production');
    expect(() =>
      validateEnvironment({
        ...PRODUCTION_ENV,
        ALIBABA_1688_PURCHASE_ENABLED: 'true',
        ALIBABA_1688_PAYMENT_MODE: 'manual',
        ALIBABA_1688_APP_KEY: '1688-app-key',
      }),
    ).toThrow('ALIBABA_1688_APP_SECRET is required in production');
    expect(() =>
      validateEnvironment({
        ...PRODUCTION_ENV,
        ALIBABA_1688_PURCHASE_ENABLED: 'true',
        ALIBABA_1688_PAYMENT_MODE: 'manual',
        ALIBABA_1688_APP_KEY: '1688-app-key',
        ALIBABA_1688_APP_SECRET: '1688-app-secret',
      }),
    ).toThrow('ALIBABA_1688_OAUTH_REDIRECT_URI is required in production');
    expect(() =>
      validateEnvironment({
        ...PRODUCTION_PURCHASE_ENV,
        ALIBABA_1688_OAUTH_REDIRECT_URI: 'http://api.supplier.example.com/callback',
      }),
    ).toThrow('ALIBABA_1688_OAUTH_REDIRECT_URI must use https:');
  });

  it('accepts complete production 1688 purchase configuration', () => {
    expect(validateEnvironment(PRODUCTION_PURCHASE_ENV)).toMatchObject({
      ALIBABA_1688_PURCHASE_ENABLED: 'true',
      ALIBABA_1688_PAYMENT_MODE: 'manual',
    });
  });

  it('rejects invalid or incomplete background order sync configuration', () => {
    expect(() => validateEnvironment({ DOUYIN_ORDER_SYNC_ENABLED: 'enabled' })).toThrow(
      'DOUYIN_ORDER_SYNC_ENABLED must be true or false',
    );
    expect(() =>
      validateEnvironment({ ...PRODUCTION_ENV, DOUYIN_ORDER_SYNC_ENABLED: 'true' }),
    ).toThrow('DOUYIN_APP_KEY is required in production');
    expect(() =>
      validateEnvironment({
        ...PRODUCTION_ORDER_SYNC_ENV,
        DOUYIN_OAUTH_REDIRECT_URI: 'http://api.supplier.example.com/callback',
      }),
    ).toThrow('DOUYIN_OAUTH_REDIRECT_URI must use https:');
    expect(() =>
      validateEnvironment({
        ...PRODUCTION_ORDER_SYNC_ENV,
        OAUTH_CALLBACK_ALLOWLIST: 'https://api.supplier.example.com/another-callback',
      }),
    ).toThrow('OAUTH_CALLBACK_ALLOWLIST must contain DOUYIN_OAUTH_REDIRECT_URI');
  });

  it('accepts complete production background order sync configuration', () => {
    expect(validateEnvironment(PRODUCTION_ORDER_SYNC_ENV)).toMatchObject({
      DOUYIN_ORDER_SYNC_ENABLED: 'true',
      DOUYIN_ORDER_SYNC_INTERVAL_MS: 60_000,
      DOUYIN_ORDER_SYNC_MAX_PAGES: 100,
    });
  });

  it('validates inventory sync configuration and reuses the Douyin production gate', () => {
    expect(() => validateEnvironment({ INVENTORY_SYNC_ENABLED: 'enabled' })).toThrow(
      'INVENTORY_SYNC_ENABLED must be true or false',
    );
    expect(() => validateEnvironment({ INVENTORY_SYNC_POLL_MS: 499 })).toThrow(
      'INVENTORY_SYNC_POLL_MS must be an integer between 500 and 60000',
    );
    expect(() =>
      validateEnvironment({ ...PRODUCTION_ENV, INVENTORY_SYNC_ENABLED: 'true' }),
    ).toThrow('DOUYIN_APP_KEY is required in production');
    expect(
      validateEnvironment({
        ...PRODUCTION_ORDER_SYNC_ENV,
        DOUYIN_ORDER_SYNC_ENABLED: 'false',
        INVENTORY_SYNC_ENABLED: 'true',
      }),
    ).toMatchObject({ INVENTORY_SYNC_ENABLED: 'true' });
  });

  it('validates bounded product batch worker configuration', () => {
    expect(() => validateEnvironment({ PRODUCT_BATCH_ENABLED: 'enabled' })).toThrow(
      'PRODUCT_BATCH_ENABLED must be true or false',
    );
    expect(() => validateEnvironment({ PRODUCT_BATCH_POLL_MS: 499 })).toThrow(
      'PRODUCT_BATCH_POLL_MS must be an integer between 500 and 60000',
    );
    expect(() => validateEnvironment({ PRODUCT_BATCH_POLL_MS: 60_001 })).toThrow(
      'PRODUCT_BATCH_POLL_MS must be an integer between 500 and 60000',
    );
    expect(() => validateEnvironment({ PRODUCT_BATCH_MAX_ATTEMPTS: 0 })).toThrow(
      'PRODUCT_BATCH_MAX_ATTEMPTS must be an integer between 1 and 10',
    );
    expect(() => validateEnvironment({ PRODUCT_BATCH_MAX_ATTEMPTS: 11 })).toThrow(
      'PRODUCT_BATCH_MAX_ATTEMPTS must be an integer between 1 and 10',
    );
    expect(
      validateEnvironment({
        PRODUCT_BATCH_ENABLED: true,
        PRODUCT_BATCH_POLL_MS: '500',
        PRODUCT_BATCH_MAX_ATTEMPTS: '10',
      }),
    ).toMatchObject({
      PRODUCT_BATCH_ENABLED: 'true',
      PRODUCT_BATCH_POLL_MS: 500,
      PRODUCT_BATCH_MAX_ATTEMPTS: 10,
    });
  });
});

describe('runtime helpers', () => {
  it('uses localhost only outside production and rejects wildcard origins', () => {
    expect(corsOrigins(undefined, false)).toEqual(['http://localhost:3000']);
    expect(() => corsOrigins('*', false)).toThrow('must not contain wildcard');
  });

  it('never exposes Swagger in production and allows development to opt out', () => {
    expect(swaggerEnabled('production', undefined)).toBe(false);
    expect(swaggerEnabled('development', undefined)).toBe(true);
    expect(swaggerEnabled('production', 'true')).toBe(false);
    expect(swaggerEnabled('development', 'false')).toBe(false);
  });
});
