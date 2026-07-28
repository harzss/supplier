import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../common/prisma.module';
import type { AlertService } from './alert.service';
import { AuditRetentionService } from './audit-retention.service';

describe('AuditRetentionService', () => {
  it('deletes only records older than the configured retention window', async () => {
    const deleteMany = vi.fn().mockResolvedValue({ count: 3 });
    const prisma = { auditLog: { deleteMany } } as unknown as PrismaService;
    const alerts = { raise: vi.fn(), resolve: vi.fn() } as unknown as AlertService;
    const service = new AuditRetentionService(prisma, alerts, {
      get: () => 180,
    } as unknown as ConfigService);
    const now = new Date('2026-07-17T00:00:00.000Z');

    await expect(service.prune(now)).resolves.toBe(3);
    expect(deleteMany).toHaveBeenCalledWith({
      where: { createdAt: { lt: new Date('2026-01-18T00:00:00.000Z') } },
    });
  });
});
