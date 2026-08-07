import { defineConfig, devices } from '@playwright/test';

const webOrigin = 'http://127.0.0.1:3200';

export default defineConfig({
  testDir: './e2e',
  testMatch: 'product-batch-sku.spec.ts',
  timeout: 60_000,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: webOrigin,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    name: 'web',
    command: 'pnpm --filter @supplier/web exec next dev -H 127.0.0.1 -p 3200',
    url: webOrigin,
    timeout: 120_000,
    reuseExistingServer: false,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      NEXT_PUBLIC_AUTH_MODE: 'demo',
      NEXT_PUBLIC_BFF_URL: 'http://127.0.0.1:3201',
    },
  },
});
