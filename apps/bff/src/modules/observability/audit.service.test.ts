import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../common/prisma.module';
import { AuditService } from './audit.service';

describe('AuditService', () => {
  it('stores redacted metadata and a one-way IP hash', async () => {
    const create = vi.fn().mockResolvedValue({});
    const prisma = { auditLog: { create } } as unknown as PrismaService;
    const config = {
      get: (key: string) => (key === 'ENCRYPTION_KEY' ? 'audit-test-secret' : undefined),
    } as unknown as ConfigService;
    const audit = new AuditService(prisma, config);

    await audit.record({
      userId: 42n,
      action: 'settings.llm-key.save',
      method: 'POST',
      route: '/settings/llm-key',
      outcome: 'success',
      statusCode: 201,
      requestId: 'req-1',
      ip: '203.0.113.8',
      metadata: { provider: 'openai', apiKey: 'sk-secret', nested: { token: 'hidden' } },
    });

    const data = create.mock.calls[0]?.[0].data;
    expect(data.user.connect.id).toBe(42n);
    expect(data.ipHash).toMatch(/^[a-f0-9]{64}$/);
    expect(data.ipHash).not.toContain('203.0.113.8');
    expect(data.metadata).toEqual({
      provider: 'openai',
      apiKey: '[redacted]',
      nested: { token: '[redacted]' },
    });
  });

  it('does not fail the business operation when persistence is unavailable', async () => {
    const prisma = {
      auditLog: { create: vi.fn().mockRejectedValue(new Error('db down')) },
    } as unknown as PrismaService;
    const audit = new AuditService(prisma, { get: vi.fn() } as unknown as ConfigService);

    await expect(
      audit.record({
        action: 'publish.create',
        outcome: 'failure',
        statusCode: 500,
      }),
    ).resolves.toBeUndefined();
  });
});
