import { describe, expect, it } from 'vitest';
import {
  corsOrigins,
  swaggerEnabled,
  validateEnvironment,
  validateSupabaseDirectDatabase,
  validateSupabaseRuntimeDatabase,
} from './environment';

const PROJECT_REF = 'abcdefghijklmnopqrst';

const DEVELOPMENT_ENV = {
  NODE_ENV: 'development',
  AUTH_MODE: 'demo',
  DATABASE_URL: `postgresql://postgres.${PROJECT_REF}:secret@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=5&sslmode=require`,
  DIRECT_URL: `postgresql://postgres.${PROJECT_REF}:secret@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres?sslmode=require`,
  SUPABASE_URL: `https://${PROJECT_REF}.supabase.co`,
  PUBLISH_QUEUE_MODE: 'database',
};

const PRODUCTION_ENV = {
  NODE_ENV: 'production',
  AUTH_MODE: 'supabase',
  DATABASE_URL: `postgresql://postgres.${PROJECT_REF}:secret@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=5&sslmode=require`,
  ENCRYPTION_KEY: 'encryption-key-that-is-longer-than-32-characters',
  OPERATIONS_TOKEN: 'operations-token-that-is-longer-than-32-characters',
  ALERT_WEBHOOK_URL: 'https://alerts.example.com/hooks/supplier',
  ALERT_WEBHOOK_SECRET: 'alert-webhook-secret-longer-than-32-characters',
  SUPABASE_URL: `https://${PROJECT_REF}.supabase.co`,
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

function validateWithTestDefaults(environment: Record<string, unknown>) {
  return validateEnvironment({ NODE_ENV: 'test', ...environment });
}

describe('validateEnvironment', () => {
  it('accepts only an optional full lowercase build revision', () => {
    const gitSha = 'a'.repeat(40);
    expect(validateWithTestDefaults({ SUPPLIER_GIT_SHA: gitSha })).toMatchObject({
      SUPPLIER_GIT_SHA: gitSha,
    });
    for (const value of ['short', 'A'.repeat(40), 'g'.repeat(40)]) {
      expect(() => validateWithTestDefaults({ SUPPLIER_GIT_SHA: value })).toThrow(
        'SUPPLIER_GIT_SHA must be a 40-character lowercase Git SHA',
      );
    }
  });

  it('keeps safe development defaults', () => {
    expect(validateEnvironment(DEVELOPMENT_ENV)).toMatchObject({
      NODE_ENV: 'development',
      AUTH_MODE: 'demo',
      BFF_HOST: '0.0.0.0',
      PUBLISH_QUEUE_MODE: 'database',
      PORT: 3001,
      HEALTH_CHECK_TIMEOUT_MS: 2000,
      ALERT_WEBHOOK_MAX_ATTEMPTS: 3,
      ALERT_WEBHOOK_RETRY_BASE_MS: 500,
      INVENTORY_SYNC_POLL_MS: 5000,
      INVENTORY_SYNC_MAX_ATTEMPTS: 3,
      PRODUCT_BATCH_POLL_MS: 2000,
      PRODUCT_BATCH_MAX_ATTEMPTS: 3,
      SOURCE_IMPORT_POLL_MS: 2000,
      SOURCE_IMPORT_MAX_ATTEMPTS: 3,
      EXCEPTION_CENTER_SCAN_INTERVAL_MS: 300000,
      EXCEPTION_CENTER_SCAN_BATCH_SIZE: 50,
    });
  });

  it('accepts only explicit loopback or container bind hosts', () => {
    expect(validateWithTestDefaults({ BFF_HOST: '127.0.0.1' })).toMatchObject({
      BFF_HOST: '127.0.0.1',
    });
    expect(() => validateWithTestDefaults({ BFF_HOST: '192.168.1.10' })).toThrow(
      'BFF_HOST must be 127.0.0.1 or 0.0.0.0',
    );
  });

  it('accepts a complete production runtime configuration', () => {
    expect(validateWithTestDefaults(PRODUCTION_ENV)).toMatchObject({
      NODE_ENV: 'production',
      PORT: 3001,
      PUBLISH_QUEUE_MODE: 'database',
    });
  });

  it('rejects missing or insecure production secrets', () => {
    expect(() => validateWithTestDefaults({ NODE_ENV: 'production' })).toThrow(
      'AUTH_MODE must be supabase in production',
    );
    expect(() =>
      validateWithTestDefaults({
        NODE_ENV: 'production',
        AUTH_MODE: 'supabase',
        SUPABASE_URL: `https://${PROJECT_REF}.supabase.co`,
      }),
    ).toThrow('DATABASE_URL is required outside isolated tests');
    expect(() =>
      validateWithTestDefaults({ ...PRODUCTION_ENV, ENCRYPTION_KEY: 'change-me-in-production' }),
    ).toThrow('ENCRYPTION_KEY must be a non-default secret');
  });

  it('accepts only the matching Supabase runtime datasource', () => {
    expect(() =>
      validateSupabaseRuntimeDatabase(
        `postgresql://postgres.${PROJECT_REF}:secret@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres?connection_limit=5&sslmode=require`,
        `https://${PROJECT_REF}.supabase.co`,
      ),
    ).not.toThrow();
    expect(() =>
      validateSupabaseRuntimeDatabase(
        `postgresql://postgres.${PROJECT_REF}:secret@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=5&sslmode=require`,
        `https://${PROJECT_REF}.supabase.co`,
      ),
    ).not.toThrow();
    expect(() =>
      validateSupabaseRuntimeDatabase(
        `postgresql://postgres:secret@db.${PROJECT_REF}.supabase.co:5432/postgres?sslmode=require`,
        `https://${PROJECT_REF}.supabase.co`,
      ),
    ).not.toThrow();

    for (const databaseUrl of [
      'postgresql://postgres:secret@127.0.0.1:5432/postgres',
      `postgresql://postgres.differentprojectref1:secret@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1&sslmode=require`,
      `postgresql://postgres.${PROJECT_REF}:secret@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1&sslmode=require`,
      `postgresql://postgres.${PROJECT_REF}:secret@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres?pgbouncer=true&connection_limit=5&sslmode=require`,
      `postgresql://postgres.${PROJECT_REF}:secret@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres?connection_limit=1&sslmode=require`,
      `postgresql://postgres.${PROJECT_REF}:secret@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=100&sslmode=require`,
      `postgresql://postgres.${PROJECT_REF}:secret@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1&sslmode=disable`,
    ]) {
      expect(() =>
        validateSupabaseRuntimeDatabase(databaseUrl, `https://${PROJECT_REF}.supabase.co`),
      ).toThrow();
    }
  });

  it('accepts only a matching Supabase direct or session datasource', () => {
    for (const directUrl of [
      `postgresql://postgres.${PROJECT_REF}:secret@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres?sslmode=require`,
      `postgresql://postgres:secret@db.${PROJECT_REF}.supabase.co:5432/postgres?sslmode=require`,
    ]) {
      expect(() =>
        validateSupabaseDirectDatabase(directUrl, `https://${PROJECT_REF}.supabase.co`),
      ).not.toThrow();
    }
    for (const directUrl of [
      `postgresql://postgres.${PROJECT_REF}:secret@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres`,
      `postgresql://postgres.differentprojectref1:secret@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres`,
      'postgresql://postgres:secret@127.0.0.1:5432/postgres',
    ]) {
      expect(() =>
        validateSupabaseDirectDatabase(directUrl, `https://${PROJECT_REF}.supabase.co`),
      ).toThrow();
    }
  });

  it('rejects local middleware state outside isolated tests', () => {
    expect(() =>
      validateEnvironment({
        ...DEVELOPMENT_ENV,
        DATABASE_URL: 'postgresql://postgres:secret@127.0.0.1:5432/postgres',
      }),
    ).toThrow('matching Supabase');
    expect(() =>
      validateEnvironment({ ...DEVELOPMENT_ENV, REDIS_URL: 'redis://127.0.0.1:6379' }),
    ).toThrow('REDIS_URL must not be configured');
    expect(() => validateEnvironment({ ...DEVELOPMENT_ENV, PUBLISH_QUEUE_MODE: 'inline' })).toThrow(
      'PUBLISH_QUEUE_MODE must be database outside isolated tests',
    );
  });

  it('requires Supabase Auth configuration when the mode is enabled', () => {
    expect(() => validateWithTestDefaults({ AUTH_MODE: 'supabase' })).toThrow(
      'SUPABASE_URL is required when AUTH_MODE=supabase',
    );
    expect(() =>
      validateWithTestDefaults({ AUTH_MODE: 'supabase', SUPABASE_URL: 'http://localhost:54321' }),
    ).not.toThrow();
  });

  it('rejects unsafe production origins and inline queue execution', () => {
    expect(() =>
      validateWithTestDefaults({ ...PRODUCTION_ENV, CORS_ORIGINS: 'http://supplier.example.com' }),
    ).toThrow('CORS_ORIGINS must use HTTPS in production');
    expect(() =>
      validateWithTestDefaults({ ...PRODUCTION_ENV, PUBLISH_QUEUE_MODE: 'inline' }),
    ).toThrow('PUBLISH_QUEUE_MODE must be database outside isolated tests');
    expect(() =>
      validateWithTestDefaults({
        ...PRODUCTION_ENV,
        ALERT_WEBHOOK_URL: 'http://alerts.example.com/hook',
      }),
    ).toThrow('ALERT_WEBHOOK_URL must use https:');
    expect(() =>
      validateWithTestDefaults({ ...PRODUCTION_ENV, OPERATIONS_TOKEN: 'short' }),
    ).toThrow('OPERATIONS_TOKEN must be a non-default secret');
  });

  it('rejects unsafe alert delivery retry configuration', () => {
    expect(() => validateWithTestDefaults({ ALERT_WEBHOOK_MAX_ATTEMPTS: 0 })).toThrow(
      'ALERT_WEBHOOK_MAX_ATTEMPTS must be an integer between 1 and 5',
    );
    expect(() => validateWithTestDefaults({ ALERT_WEBHOOK_RETRY_BASE_MS: 99 })).toThrow(
      'ALERT_WEBHOOK_RETRY_BASE_MS must be an integer between 100 and 5000',
    );
  });

  it('rejects an invalid 1688 purchase switch value', () => {
    expect(() => validateWithTestDefaults({ ALIBABA_1688_PURCHASE_ENABLED: 'enabled' })).toThrow(
      'ALIBABA_1688_PURCHASE_ENABLED must be true or false',
    );
  });

  it('requires safe and bounded 1688 purchase audit configuration', () => {
    expect(() =>
      validateWithTestDefaults({ ALIBABA_1688_PURCHASE_AUDIT_ENABLED: 'enabled' }),
    ).toThrow('ALIBABA_1688_PURCHASE_AUDIT_ENABLED must be true or false');
    expect(() => validateWithTestDefaults({ ALIBABA_1688_PURCHASE_AUDIT_ENABLED: 'true' })).toThrow(
      'ALIBABA_1688_PURCHASE_AUDIT_ENABLED requires ALIBABA_1688_PURCHASE_ENABLED=true',
    );
    expect(() =>
      validateWithTestDefaults({ ALIBABA_1688_PURCHASE_AUDIT_INTERVAL_MS: 59_999 }),
    ).toThrow(
      'ALIBABA_1688_PURCHASE_AUDIT_INTERVAL_MS must be an integer between 60000 and 3600000',
    );
    expect(() => validateWithTestDefaults({ ALIBABA_1688_PURCHASE_AUDIT_BATCH_SIZE: 501 })).toThrow(
      'ALIBABA_1688_PURCHASE_AUDIT_BATCH_SIZE must be an integer between 1 and 500',
    );
  });

  it('requires safe and bounded exception center scan configuration', () => {
    expect(() => validateWithTestDefaults({ EXCEPTION_CENTER_SCAN_ENABLED: 'enabled' })).toThrow(
      'EXCEPTION_CENTER_SCAN_ENABLED must be true or false',
    );
    expect(() => validateWithTestDefaults({ EXCEPTION_CENTER_SCAN_INTERVAL_MS: 59_999 })).toThrow(
      'EXCEPTION_CENTER_SCAN_INTERVAL_MS must be an integer between 60000 and 3600000',
    );
    expect(() => validateWithTestDefaults({ EXCEPTION_CENTER_SCAN_BATCH_SIZE: 501 })).toThrow(
      'EXCEPTION_CENTER_SCAN_BATCH_SIZE must be an integer between 1 and 500',
    );
    expect(validateWithTestDefaults({ EXCEPTION_CENTER_SCAN_ENABLED: true })).toMatchObject({
      EXCEPTION_CENTER_SCAN_ENABLED: 'true',
    });
  });

  it('requires manual payment and complete 1688 credentials when production purchasing is enabled', () => {
    expect(() =>
      validateWithTestDefaults({ ...PRODUCTION_ENV, ALIBABA_1688_PURCHASE_ENABLED: 'true' }),
    ).toThrow('ALIBABA_1688_PAYMENT_MODE must be manual');
    expect(() =>
      validateWithTestDefaults({
        ...PRODUCTION_ENV,
        ALIBABA_1688_PURCHASE_ENABLED: 'true',
        ALIBABA_1688_PAYMENT_MODE: 'manual',
      }),
    ).toThrow('ALIBABA_1688_APP_KEY is required in production');
    expect(() =>
      validateWithTestDefaults({
        ...PRODUCTION_ENV,
        ALIBABA_1688_PURCHASE_ENABLED: 'true',
        ALIBABA_1688_PAYMENT_MODE: 'manual',
        ALIBABA_1688_APP_KEY: '1688-app-key',
      }),
    ).toThrow('ALIBABA_1688_APP_SECRET is required in production');
    expect(() =>
      validateWithTestDefaults({
        ...PRODUCTION_ENV,
        ALIBABA_1688_PURCHASE_ENABLED: 'true',
        ALIBABA_1688_PAYMENT_MODE: 'manual',
        ALIBABA_1688_APP_KEY: '1688-app-key',
        ALIBABA_1688_APP_SECRET: '1688-app-secret',
      }),
    ).toThrow('ALIBABA_1688_OAUTH_REDIRECT_URI is required in production');
    expect(() =>
      validateWithTestDefaults({
        ...PRODUCTION_PURCHASE_ENV,
        ALIBABA_1688_OAUTH_REDIRECT_URI: 'http://api.supplier.example.com/callback',
      }),
    ).toThrow('ALIBABA_1688_OAUTH_REDIRECT_URI must use https:');
  });

  it('accepts complete production 1688 purchase configuration', () => {
    expect(validateWithTestDefaults(PRODUCTION_PURCHASE_ENV)).toMatchObject({
      ALIBABA_1688_PURCHASE_ENABLED: 'true',
      ALIBABA_1688_PAYMENT_MODE: 'manual',
    });
  });

  it('rejects invalid or incomplete background order sync configuration', () => {
    expect(() => validateWithTestDefaults({ DOUYIN_ORDER_SYNC_ENABLED: 'enabled' })).toThrow(
      'DOUYIN_ORDER_SYNC_ENABLED must be true or false',
    );
    expect(() =>
      validateWithTestDefaults({ ...PRODUCTION_ENV, DOUYIN_ORDER_SYNC_ENABLED: 'true' }),
    ).toThrow('DOUYIN_APP_KEY is required in production');
    expect(() =>
      validateWithTestDefaults({
        ...PRODUCTION_ORDER_SYNC_ENV,
        DOUYIN_OAUTH_REDIRECT_URI: 'http://api.supplier.example.com/callback',
      }),
    ).toThrow('DOUYIN_OAUTH_REDIRECT_URI must use https:');
    expect(() =>
      validateWithTestDefaults({
        ...PRODUCTION_ORDER_SYNC_ENV,
        OAUTH_CALLBACK_ALLOWLIST: 'https://api.supplier.example.com/another-callback',
      }),
    ).toThrow('OAUTH_CALLBACK_ALLOWLIST must contain DOUYIN_OAUTH_REDIRECT_URI');
  });

  it('accepts complete production background order sync configuration', () => {
    expect(validateWithTestDefaults(PRODUCTION_ORDER_SYNC_ENV)).toMatchObject({
      DOUYIN_ORDER_SYNC_ENABLED: 'true',
      DOUYIN_ORDER_SYNC_INTERVAL_MS: 60_000,
      DOUYIN_ORDER_SYNC_MAX_PAGES: 100,
    });
  });

  it('validates inventory sync configuration and reuses the Douyin production gate', () => {
    expect(() => validateWithTestDefaults({ INVENTORY_SYNC_ENABLED: 'enabled' })).toThrow(
      'INVENTORY_SYNC_ENABLED must be true or false',
    );
    expect(() => validateWithTestDefaults({ INVENTORY_SYNC_POLL_MS: 499 })).toThrow(
      'INVENTORY_SYNC_POLL_MS must be an integer between 500 and 60000',
    );
    expect(() =>
      validateWithTestDefaults({ ...PRODUCTION_ENV, INVENTORY_SYNC_ENABLED: 'true' }),
    ).toThrow('DOUYIN_APP_KEY is required in production');
    expect(
      validateWithTestDefaults({
        ...PRODUCTION_ORDER_SYNC_ENV,
        DOUYIN_ORDER_SYNC_ENABLED: 'false',
        INVENTORY_SYNC_ENABLED: 'true',
      }),
    ).toMatchObject({ INVENTORY_SYNC_ENABLED: 'true' });
  });

  it('validates bounded product batch worker configuration', () => {
    expect(() => validateWithTestDefaults({ PRODUCT_BATCH_ENABLED: 'enabled' })).toThrow(
      'PRODUCT_BATCH_ENABLED must be true or false',
    );
    expect(() => validateWithTestDefaults({ PRODUCT_BATCH_POLL_MS: 499 })).toThrow(
      'PRODUCT_BATCH_POLL_MS must be an integer between 500 and 60000',
    );
    expect(() => validateWithTestDefaults({ PRODUCT_BATCH_POLL_MS: 60_001 })).toThrow(
      'PRODUCT_BATCH_POLL_MS must be an integer between 500 and 60000',
    );
    expect(() => validateWithTestDefaults({ PRODUCT_BATCH_MAX_ATTEMPTS: 0 })).toThrow(
      'PRODUCT_BATCH_MAX_ATTEMPTS must be an integer between 1 and 10',
    );
    expect(() => validateWithTestDefaults({ PRODUCT_BATCH_MAX_ATTEMPTS: 11 })).toThrow(
      'PRODUCT_BATCH_MAX_ATTEMPTS must be an integer between 1 and 10',
    );
    expect(() => validateWithTestDefaults({ PRODUCT_BATCH_SKU_EDIT_ENABLED: 'enabled' })).toThrow(
      'PRODUCT_BATCH_SKU_EDIT_ENABLED must be true or false',
    );
    expect(
      validateWithTestDefaults({
        PRODUCT_BATCH_ENABLED: true,
        PRODUCT_BATCH_SKU_EDIT_ENABLED: true,
        PRODUCT_BATCH_POLL_MS: '500',
        PRODUCT_BATCH_MAX_ATTEMPTS: '10',
      }),
    ).toMatchObject({
      PRODUCT_BATCH_ENABLED: 'true',
      PRODUCT_BATCH_SKU_EDIT_ENABLED: 'true',
      PRODUCT_BATCH_POLL_MS: 500,
      PRODUCT_BATCH_MAX_ATTEMPTS: 10,
    });
  });

  it('validates an independently bounded source import worker configuration', () => {
    expect(() => validateWithTestDefaults({ SOURCE_IMPORT_ENABLED: 'enabled' })).toThrow(
      'SOURCE_IMPORT_ENABLED must be true or false',
    );
    expect(() => validateWithTestDefaults({ SOURCE_IMPORT_POLL_MS: 499 })).toThrow(
      'SOURCE_IMPORT_POLL_MS must be an integer between 500 and 60000',
    );
    expect(() => validateWithTestDefaults({ SOURCE_IMPORT_MAX_ATTEMPTS: 11 })).toThrow(
      'SOURCE_IMPORT_MAX_ATTEMPTS must be an integer between 1 and 10',
    );
    expect(
      validateWithTestDefaults({
        SOURCE_IMPORT_ENABLED: true,
        SOURCE_IMPORT_POLL_MS: '500',
        SOURCE_IMPORT_MAX_ATTEMPTS: '10',
      }),
    ).toMatchObject({
      SOURCE_IMPORT_ENABLED: 'true',
      SOURCE_IMPORT_POLL_MS: 500,
      SOURCE_IMPORT_MAX_ATTEMPTS: 10,
    });
  });

  it('requires verified 1688 OAuth configuration for production source import', () => {
    expect(() =>
      validateWithTestDefaults({ ...PRODUCTION_ENV, SOURCE_IMPORT_ENABLED: 'true' }),
    ).toThrow('ALIBABA_1688_APP_KEY is required in production');
    expect(() =>
      validateWithTestDefaults({
        ...PRODUCTION_PURCHASE_ENV,
        ALIBABA_1688_PURCHASE_ENABLED: 'false',
        SOURCE_IMPORT_ENABLED: 'true',
        OAUTH_CALLBACK_ALLOWLIST:
          'https://api.supplier.example.com/api/shops/oauth/alibaba_1688/callback',
      }),
    ).toThrow('ALIBABA_1688_SOURCE_DATA_SCOPE must be global_offer when source import is enabled');
    expect(() =>
      validateWithTestDefaults({
        ...PRODUCTION_PURCHASE_ENV,
        ALIBABA_1688_PURCHASE_ENABLED: 'false',
        SOURCE_IMPORT_ENABLED: 'true',
        ALIBABA_1688_SOURCE_DATA_SCOPE: 'global_offer',
        OAUTH_CALLBACK_ALLOWLIST: 'https://api.supplier.example.com/another/callback',
      }),
    ).toThrow('OAUTH_CALLBACK_ALLOWLIST must contain ALIBABA_1688_OAUTH_REDIRECT_URI');
    expect(
      validateWithTestDefaults({
        ...PRODUCTION_PURCHASE_ENV,
        ALIBABA_1688_PURCHASE_ENABLED: 'false',
        SOURCE_IMPORT_ENABLED: 'true',
        ALIBABA_1688_SOURCE_DATA_SCOPE: 'global_offer',
        OAUTH_CALLBACK_ALLOWLIST:
          'https://api.supplier.example.com/api/shops/oauth/alibaba_1688/callback',
      }),
    ).toMatchObject({ SOURCE_IMPORT_ENABLED: 'true' });
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
