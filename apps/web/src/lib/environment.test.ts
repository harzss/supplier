import { afterEach, describe, expect, it, vi } from 'vitest';

const originalAuditTestMode = process.env.NEXT_PUBLIC_AUDIT_TEST_MODE;
const originalLegalPagesEnabled = process.env.NEXT_PUBLIC_LEGAL_PAGES_ENABLED;

afterEach(() => {
  if (originalAuditTestMode === undefined) delete process.env.NEXT_PUBLIC_AUDIT_TEST_MODE;
  else process.env.NEXT_PUBLIC_AUDIT_TEST_MODE = originalAuditTestMode;
  if (originalLegalPagesEnabled === undefined) delete process.env.NEXT_PUBLIC_LEGAL_PAGES_ENABLED;
  else process.env.NEXT_PUBLIC_LEGAL_PAGES_ENABLED = originalLegalPagesEnabled;
  vi.resetModules();
});

describe('legal-page environment', () => {
  it('defaults to disabled when the build variable is absent', async () => {
    delete process.env.NEXT_PUBLIC_LEGAL_PAGES_ENABLED;
    vi.resetModules();

    const environment = await import('./environment');

    expect(environment.isLegalPagesEnabled).toBe(false);
    expect(environment.frontendConfigurationError()).toBeUndefined();
  });

  it('enables only the explicit true value', async () => {
    process.env.NEXT_PUBLIC_LEGAL_PAGES_ENABLED = ' true ';
    vi.resetModules();

    const environment = await import('./environment');

    expect(environment.isLegalPagesEnabled).toBe(true);
    expect(environment.frontendConfigurationError()).toBeUndefined();
  });

  it('rejects an invalid legal-page build value', async () => {
    process.env.NEXT_PUBLIC_LEGAL_PAGES_ENABLED = 'public';
    vi.resetModules();

    const environment = await import('./environment');

    expect(environment.isLegalPagesEnabled).toBe(false);
    expect(environment.frontendConfigurationError()).toBe(
      'NEXT_PUBLIC_LEGAL_PAGES_ENABLED 必须为 true 或 false',
    );
  });
});

describe('audit-test environment', () => {
  it('defaults to disabled when the build variable is absent', async () => {
    delete process.env.NEXT_PUBLIC_AUDIT_TEST_MODE;
    vi.resetModules();

    const environment = await import('./environment');

    expect(environment.isAuditTestMode).toBe(false);
    expect(environment.frontendConfigurationError()).toBeUndefined();
  });

  it('enables only the explicit true value', async () => {
    process.env.NEXT_PUBLIC_AUDIT_TEST_MODE = ' true ';
    vi.resetModules();

    const environment = await import('./environment');

    expect(environment.isAuditTestMode).toBe(true);
    expect(environment.frontendConfigurationError()).toBeUndefined();
  });

  it('rejects an invalid audit-test build value', async () => {
    process.env.NEXT_PUBLIC_AUDIT_TEST_MODE = 'enabled';
    vi.resetModules();

    const environment = await import('./environment');

    expect(environment.isAuditTestMode).toBe(false);
    expect(environment.frontendConfigurationError()).toBe(
      'NEXT_PUBLIC_AUDIT_TEST_MODE 必须为 true 或 false',
    );
  });
});
