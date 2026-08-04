import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../common/prisma.module';
import type { SourceImportExecutionRecord, SourceImportService } from './source-import.service';
import { SourceImportWorker } from './source-import.worker';

describe('SourceImportWorker', () => {
  it('does not start polling when source import is disabled', () => {
    const fixture = createFixture(false);

    fixture.worker.onModuleInit();

    expect(fixture.imports.claimNext).not.toHaveBeenCalled();
  });

  it('returns false when no item is claimable', async () => {
    const fixture = createFixture();
    fixture.imports.claimNext.mockResolvedValue(null);

    await expect(fixture.worker.runOnce()).resolves.toBe(false);
    expect(fixture.imports.executeClaimed).not.toHaveBeenCalled();
  });

  it('executes one claimed item', async () => {
    const fixture = createFixture();
    const item = { id: 51n } as SourceImportExecutionRecord;
    fixture.imports.claimNext.mockResolvedValue(item);

    await expect(fixture.worker.runOnce()).resolves.toBe(true);
    expect(fixture.imports.executeClaimed).toHaveBeenCalledWith(item);
    expect(fixture.imports.failClaimedItem).not.toHaveBeenCalled();
  });

  it('hands execution failures back to the service state machine', async () => {
    const fixture = createFixture();
    const item = { id: 51n } as SourceImportExecutionRecord;
    const error = new Error('adapter failed');
    fixture.imports.claimNext.mockResolvedValue(item);
    fixture.imports.executeClaimed.mockRejectedValue(error);

    await expect(fixture.worker.runOnce()).resolves.toBe(true);
    expect(fixture.imports.failClaimedItem).toHaveBeenCalledWith(item, error);
  });

  it('attempts database reconnection and still surfaces connection failures to the poller', async () => {
    const fixture = createFixture();
    const error = Object.assign(new Error('database unavailable'), { code: 'P1001' });
    fixture.imports.claimNext.mockRejectedValue(error);

    await expect(fixture.worker.runOnce()).rejects.toBe(error);
    expect(fixture.prisma.reconnect).toHaveBeenCalledOnce();
  });
});

function createFixture(enabled = true) {
  const imports = {
    isEnabled: vi.fn().mockReturnValue(enabled),
    claimNext: vi.fn(),
    executeClaimed: vi.fn().mockResolvedValue('processed'),
    failClaimedItem: vi.fn().mockResolvedValue('failed'),
  };
  const prisma = { reconnect: vi.fn().mockResolvedValue(undefined) };
  const worker = new SourceImportWorker(
    { get: vi.fn().mockReturnValue('2000') } as unknown as ConfigService,
    imports as unknown as SourceImportService,
    prisma as unknown as PrismaService,
  );
  return { worker, imports, prisma };
}
