import { ConflictException, ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../common/prisma.module';
import {
  EntitlementAccessService,
  entitlementAccessStopCode,
  entitlementAccessStopMessage,
} from './entitlement-access.service';

function serviceWith(result: unknown) {
  const findUnique =
    result instanceof Error ? vi.fn().mockRejectedValue(result) : vi.fn().mockResolvedValue(result);
  return {
    service: new EntitlementAccessService({ user: { findUnique } } as unknown as PrismaService),
    findUnique,
  };
}

describe('EntitlementAccessService', () => {
  it('returns the current active revision from the supplied transaction reader', async () => {
    const fixture = serviceWith(null);
    const transactionFind = vi.fn().mockResolvedValue({
      status: 'active',
      entitlementAccessStatus: 'active',
      entitlementRevision: 7,
    });

    await expect(
      fixture.service.assertActive(1n, 7, { user: { findUnique: transactionFind } } as never),
    ).resolves.toEqual({ revision: 7 });
    expect(transactionFind).toHaveBeenCalledWith({
      where: { id: 1n },
      select: {
        status: true,
        entitlementAccessStatus: true,
        entitlementRevision: true,
      },
    });
    expect(fixture.findUnique).not.toHaveBeenCalled();
  });

  it('fails closed when the user is missing or the database read fails', async () => {
    await expect(serviceWith(null).service.assertActive(1n)).rejects.toMatchObject({ status: 503 });
    await expect(
      serviceWith(new Error('database unavailable')).service.assertActive(1n),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('rejects suspended and disabled users independently', async () => {
    await expect(
      serviceWith({
        status: 'active',
        entitlementAccessStatus: 'suspended',
        entitlementRevision: 8,
      }).service.assertActive(1n),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      serviceWith({
        status: 'disabled',
        entitlementAccessStatus: 'active',
        entitlementRevision: 9,
      }).service.assertActive(1n),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('rejects a changed revision as lost execution ownership', async () => {
    const error = await serviceWith({
      status: 'active',
      entitlementAccessStatus: 'active',
      entitlementRevision: 11,
    })
      .service.assertActive(1n, 10)
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({
      code: 'ENTITLEMENT_REVISION_CHANGED',
    });
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid expected revision %s without reading the database',
    async (revision) => {
      const fixture = serviceWith({
        status: 'active',
        entitlementAccessStatus: 'active',
        entitlementRevision: 1,
      });

      await expect(fixture.service.assertActive(1n, revision)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(fixture.findUnique).not.toHaveBeenCalled();
    },
  );

  it('identifies only durable access-stop errors for queue terminalization', () => {
    const suspended = new ForbiddenException({
      code: 'ENTITLEMENT_SUSPENDED',
      message: '当前订购权益已暂停',
    });

    expect(entitlementAccessStopCode(suspended)).toBe('ENTITLEMENT_SUSPENDED');
    expect(entitlementAccessStopMessage(suspended)).toBe(
      'ENTITLEMENT_SUSPENDED: 当前订购权益已暂停',
    );
    expect(entitlementAccessStopCode(new ServiceUnavailableException('database unavailable'))).toBe(
      null,
    );
  });
});
