import { defineConfig, devices } from '@playwright/test';

const webOrigin = 'http://127.0.0.1:3200';
const bffOrigin = 'http://127.0.0.1:3201';
const databaseUrl = process.env.CI
  ? process.env.DATABASE_URL
  : process.env.SUPPLIER_E2E_DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    'Full E2E requires CI DATABASE_URL or an explicit SUPPLIER_E2E_DATABASE_URL for a dedicated Supabase test project.',
  );
}
if (!process.env.CI && !isSupabaseDatabaseUrl(databaseUrl)) {
  throw new Error('Local full E2E must use a dedicated hosted Supabase database');
}
process.env.DATABASE_URL = databaseUrl;
process.env.DIRECT_URL = databaseUrl;
const inheritedEnvironment = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
);

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  timeout: 60_000,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['line'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: webOrigin,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      name: 'bff',
      command: 'pnpm --filter @supplier/bff start',
      url: `${bffOrigin}/api/health/ready`,
      timeout: 120_000,
      reuseExistingServer: false,
      env: {
        ...inheritedEnvironment,
        NODE_ENV: 'test',
        PORT: '3201',
        AUTH_MODE: 'demo',
        CORS_ORIGINS: webOrigin,
        DATABASE_URL: databaseUrl,
        DIRECT_URL: databaseUrl,
        PUBLISH_QUEUE_MODE: 'inline',
        DOUYIN_ORDER_SYNC_ENABLED: 'false',
        INVENTORY_SYNC_ENABLED: 'false',
        ALIBABA_1688_PURCHASE_ENABLED: 'false',
        ALIBABA_1688_PURCHASE_AUDIT_ENABLED: 'false',
      },
    },
    {
      name: 'web',
      command: 'pnpm --filter @supplier/web exec next dev -p 3200',
      url: webOrigin,
      timeout: 120_000,
      reuseExistingServer: false,
      env: {
        ...inheritedEnvironment,
        NODE_ENV: 'development',
        NEXT_PUBLIC_AUTH_MODE: 'demo',
        NEXT_PUBLIC_BFF_URL: bffOrigin,
      },
    },
  ],
});

function isSupabaseDatabaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      ['postgres:', 'postgresql:'].includes(url.protocol) &&
      (url.hostname.endsWith('.pooler.supabase.com') ||
        /^db\.[a-z0-9]{20}\.supabase\.co$/.test(url.hostname))
    );
  } catch {
    return false;
  }
}
