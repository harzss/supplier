import { Prisma } from '@supplier/db';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../common/prisma.module';
import type { AlertService } from '../observability/alert.service';
import type { MarketplaceClaim, MarketplaceClaimedEvent } from './marketplace-event-inbox.service';
import {
  MarketplaceProjectionProcessingError,
  MarketplaceSubscriptionProjectionService,
} from './marketplace-subscription-projection.service';

const NOW = new Date('2026-08-18T05:00:00.000Z');
const OWNER = '6ca0280f-3158-4cbc-a34c-4d957f4a3e7a';

describe('MarketplaceSubscriptionProjectionService', () => {
  it('atomically creates a first subscription and grants the mapped plan', async () => {
    const fixture = makeFixture();

    await expect(fixture.service.processClaim(claim())).resolves.toEqual({
      outcome: 'applied',
      eventId: 41n,
      projectionId: 51n,
    });

    const projection = fixture.tx.marketplaceSubscriptionProjection.create.mock.calls[0]![0].data;
    expect(projection).toMatchObject({
      origin: 'marketplace',
      provider: 'alibaba_1688',
      integrationKey: 'audit-test',
      externalSubscriptionKey: 'subscription-1',
      accountBindingId: 11n,
      planMappingId: 21n,
      userId: 31n,
      internalPlan: 'pro',
      lifecycleState: 'active',
      accessStatus: 'active',
      projectionRevision: 1,
    });
    expect(projection.projectionKey).toMatch(/^[0-9a-f]{64}$/);
    expect(projection.projectionKey).not.toContain('audit-test');
    expect(fixture.tx.user.updateMany).toHaveBeenCalledWith({
      where: { id: 31n, entitlementRevision: 4 },
      data: {
        entitlementSource: 'marketplace',
        entitlementAccessStatus: 'active',
        plan: 'pro',
        entitlementRevision: { increment: 1 },
        entitlementUpdatedAt: expect.any(Date),
      },
    });
    expect(fixture.tx.marketplaceEventInbox.updateMany).toHaveBeenCalledWith({
      where: { id: 41n, status: 'processing', lockedBy: OWNER },
      data: expect.objectContaining({
        status: 'applied',
        accountBindingId: 11n,
        planMappingId: 21n,
        projectionId: 51n,
        lockedAt: null,
        lockedBy: null,
      }),
    });
  });

  it('renews an existing projection with a revision CAS', async () => {
    const fixture = makeFixture({
      event: event({ normalizedKind: 'renewed', providerRevision: decimal(6) }),
      projection: projection({ providerRevision: decimal(5), projectionRevision: 7 }),
    });

    await expect(fixture.service.processClaim(claim())).resolves.toMatchObject({
      outcome: 'applied',
      projectionId: 51n,
    });
    expect(fixture.tx.marketplaceSubscriptionProjection.updateMany).toHaveBeenCalledWith({
      where: { id: 51n, projectionRevision: 7 },
      data: expect.objectContaining({
        lifecycleState: 'active',
        accessStatus: 'active',
        providerRevision: expect.objectContaining({}),
        projectionRevision: { increment: 1 },
      }),
    });
    expect(fixture.tx.marketplaceSubscriptionProjection.create).not.toHaveBeenCalled();
  });

  it.each([
    ['refunded', 'refunded'],
    ['expired', 'expired'],
    ['uninstalled', 'uninstalled'],
  ] as const)('%s suspends access and atomically returns the user to free', async (kind, state) => {
    const fixture = makeFixture({
      event: event({ normalizedKind: kind, providerRevision: decimal(6) }),
      projection: projection({ providerRevision: decimal(5) }),
    });

    await expect(fixture.service.processClaim(claim())).resolves.toMatchObject({
      outcome: 'applied',
    });
    expect(fixture.tx.marketplaceSubscriptionProjection.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ lifecycleState: state, accessStatus: 'suspended' }),
      }),
    );
    expect(fixture.tx.user.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ entitlementAccessStatus: 'suspended', plan: 'free' }),
      }),
    );
  });

  it('does not let an older event revive a terminal projection', async () => {
    const fixture = makeFixture({
      event: event({ normalizedKind: 'subscribed', providerRevision: decimal(9) }),
      projection: projection({
        lifecycleState: 'refunded',
        accessStatus: 'suspended',
        providerRevision: decimal(10),
      }),
    });

    await expect(fixture.service.processClaim(claim())).resolves.toEqual({
      outcome: 'ignored_stale',
      eventId: 41n,
      projectionId: 51n,
    });
    expect(fixture.tx.marketplaceSubscriptionProjection.updateMany).not.toHaveBeenCalled();
    expect(fixture.tx.user.updateMany).not.toHaveBeenCalled();
    expect(fixture.tx.marketplaceEventInbox.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'ignored_stale' }) }),
    );
  });

  it('turns a same-revision same-state event into ignored_stale without another grant', async () => {
    const fixture = makeFixture({
      event: event({ normalizedKind: 'renewed', providerRevision: decimal(5) }),
      projection: projection({ lifecycleState: 'active', providerRevision: decimal(5) }),
    });

    await expect(fixture.service.processClaim(claim())).resolves.toMatchObject({
      outcome: 'ignored_stale',
    });
    expect(fixture.tx.user.updateMany).not.toHaveBeenCalled();
  });

  it('blocks a same-revision conflicting lifecycle without changing entitlement', async () => {
    const fixture = makeFixture({
      event: event({ normalizedKind: 'refunded', providerRevision: decimal(5) }),
      projection: projection({ lifecycleState: 'active', providerRevision: decimal(5) }),
    });

    await expect(fixture.service.processClaim(claim())).resolves.toEqual({
      outcome: 'blocked',
      eventId: 41n,
      code: 'LIFECYCLE.CONFLICT',
    });
    expect(fixture.tx.marketplaceSubscriptionProjection.updateMany).not.toHaveBeenCalled();
    expect(fixture.tx.user.updateMany).not.toHaveBeenCalled();
  });

  it('blocks an incomplete normalized event with a stable code', async () => {
    const fixture = makeFixture({ event: event({ normalizedKind: null }) });

    await expect(fixture.service.processClaim(claim())).resolves.toEqual({
      outcome: 'blocked',
      eventId: 41n,
      code: 'EVENT.KIND_MISSING',
    });
    expect(fixture.tx.marketplaceAccountBinding.findFirst).not.toHaveBeenCalled();
    expect(fixture.tx.user.updateMany).not.toHaveBeenCalled();
  });

  it('allows an authoritative reconciliation to recover a terminal projection', async () => {
    const fixture = makeFixture({
      event: event({
        normalizedKind: 'reconciled',
        authoritativeState: 'active',
        providerRevision: decimal(11),
      }),
      projection: projection({
        lifecycleState: 'expired',
        accessStatus: 'suspended',
        providerRevision: decimal(10),
      }),
    });

    await expect(fixture.service.processClaim(claim())).resolves.toMatchObject({
      outcome: 'applied',
    });
    expect(fixture.tx.marketplaceSubscriptionProjection.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          lifecycleState: 'active',
          accessStatus: 'active',
          lastReconciledAt: expect.any(Date),
        }),
      }),
    );
    expect(fixture.tx.user.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ entitlementAccessStatus: 'active', plan: 'pro' }),
      }),
    );
  });

  it.each([
    ['binding', { binding: null }, 'BINDING.NOT_FOUND'],
    ['mapping', { mapping: null }, 'PLAN_MAPPING.NOT_FOUND'],
  ] as const)(
    'blocks an event with an unknown %s and alerts after commit',
    async (_label, options, code) => {
      const fixture = makeFixture(options);
      const order: string[] = [];
      fixture.tx.marketplaceEventInbox.updateMany.mockImplementation(async () => {
        order.push('blocked');
        return { count: 1 };
      });
      fixture.alerts.raise.mockImplementation(async () => {
        order.push('alerted');
      });

      await expect(fixture.service.processClaim(claim())).resolves.toEqual({
        outcome: 'blocked',
        eventId: 41n,
        code,
      });
      expect(order).toEqual(['blocked', 'alerted']);
      expect(fixture.tx.marketplaceSubscriptionProjection.create).not.toHaveBeenCalled();
      expect(fixture.tx.user.updateMany).not.toHaveBeenCalled();
      expect(fixture.alerts.raise).toHaveBeenCalledWith(
        expect.objectContaining({
          severity: 'critical',
          details: expect.objectContaining({ code }),
        }),
      );
    },
  );

  it('blocks a projection already owned by a different user', async () => {
    const fixture = makeFixture({ projection: projection({ userId: 99n }) });

    await expect(fixture.service.processClaim(claim())).resolves.toEqual({
      outcome: 'blocked',
      eventId: 41n,
      code: 'PROJECTION.USER_MISMATCH',
    });
    expect(fixture.tx.user.updateMany).not.toHaveBeenCalled();
  });

  it('fails closed when claim ownership is already lost', async () => {
    const fixture = makeFixture({ event: null });

    await expect(fixture.service.processClaim(claim())).rejects.toMatchObject({
      code: 'CLAIM.OWNER_LOST',
    });
    expect(fixture.tx.marketplaceSubscriptionProjection.create).not.toHaveBeenCalled();
    expect(fixture.tx.user.updateMany).not.toHaveBeenCalled();
    expect(fixture.alerts.raise).not.toHaveBeenCalled();
  });

  it('retries a Serializable P2034 conflict at most three times', async () => {
    const fixture = makeFixture();
    const run = fixture.prisma.$transaction.getMockImplementation()!;
    fixture.prisma.$transaction
      .mockRejectedValueOnce(Object.assign(new Error('serialization'), { code: 'P2034' }))
      .mockRejectedValueOnce(Object.assign(new Error('serialization'), { code: 'P2034' }))
      .mockImplementation(run);

    await expect(fixture.service.processClaim(claim())).resolves.toMatchObject({
      outcome: 'applied',
    });
    expect(fixture.prisma.$transaction).toHaveBeenCalledTimes(3);
  });

  it.each(['projection', 'user'] as const)(
    're-reads and retries a %s revision CAS conflict',
    async (target) => {
      const fixture = makeFixture(
        target === 'projection'
          ? {
              event: event({ normalizedKind: 'renewed', providerRevision: decimal(6) }),
              projection: projection({ providerRevision: decimal(5) }),
            }
          : {},
      );
      const updater =
        target === 'projection'
          ? fixture.tx.marketplaceSubscriptionProjection.updateMany
          : fixture.tx.user.updateMany;
      updater.mockResolvedValueOnce({ count: 0 }).mockResolvedValue({ count: 1 });

      await expect(fixture.service.processClaim(claim())).resolves.toMatchObject({
        outcome: 'applied',
      });
      expect(fixture.prisma.$transaction).toHaveBeenCalledTimes(2);
      expect(updater).toHaveBeenCalledTimes(2);
    },
  );

  it('lets P2002 roll back the transaction without partially granting access', async () => {
    const fixture = makeFixture();
    fixture.tx.marketplaceSubscriptionProjection.create.mockRejectedValue(
      Object.assign(new Error('unique conflict'), { code: 'P2002' }),
    );

    await expect(fixture.service.processClaim(claim())).rejects.toMatchObject({ code: 'P2002' });
    expect(fixture.tx.user.updateMany).not.toHaveBeenCalled();
    expect(fixture.tx.marketplaceEventInbox.updateMany).not.toHaveBeenCalled();
  });

  it('updates entitlement fields without reactivating a disabled user', async () => {
    const fixture = makeFixture({ user: user({ status: 'disabled' }) });

    await expect(fixture.service.processClaim(claim())).resolves.toMatchObject({
      outcome: 'applied',
    });
    const update = fixture.tx.user.updateMany.mock.calls[0]![0];
    expect(update.data).not.toHaveProperty('status');
    expect(update.data).toMatchObject({ entitlementAccessStatus: 'active', plan: 'pro' });
  });

  it('rolls back every entitlement write when the event CAS loses ownership', async () => {
    const fixture = makeFixture();
    fixture.tx.marketplaceEventInbox.updateMany.mockResolvedValue({ count: 0 });

    await expect(fixture.service.processClaim(claim())).rejects.toBeInstanceOf(
      MarketplaceProjectionProcessingError,
    );
    expect(fixture.tx.marketplaceSubscriptionProjection.create).toHaveBeenCalled();
    expect(fixture.tx.user.updateMany).toHaveBeenCalled();
    expect(fixture.alerts.raise).not.toHaveBeenCalled();
  });
});

function makeFixture(
  options: {
    event?: ReturnType<typeof event> | null;
    binding?: ReturnType<typeof binding> | null;
    mapping?: ReturnType<typeof mapping> | null;
    projection?: ReturnType<typeof projection> | null;
    user?: ReturnType<typeof user> | null;
  } = {},
) {
  const tx = {
    marketplaceEventInbox: {
      findFirst: vi.fn().mockResolvedValue(options.event === undefined ? event() : options.event),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    marketplaceAccountBinding: {
      findFirst: vi
        .fn()
        .mockResolvedValue(options.binding === undefined ? binding() : options.binding),
    },
    marketplacePlanMapping: {
      findFirst: vi
        .fn()
        .mockResolvedValue(options.mapping === undefined ? mapping() : options.mapping),
    },
    marketplaceSubscriptionProjection: {
      findUnique: vi
        .fn()
        .mockResolvedValue(options.projection === undefined ? null : options.projection),
      create: vi.fn().mockResolvedValue({ id: 51n }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    user: {
      findUnique: vi.fn().mockResolvedValue(options.user === undefined ? user() : options.user),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const transaction = vi.fn(async (operation: (client: typeof tx) => Promise<unknown>) =>
    operation(tx),
  );
  const prisma = { $transaction: transaction };
  const alerts = { raise: vi.fn() };
  return {
    service: new MarketplaceSubscriptionProjectionService(
      prisma as unknown as PrismaService,
      alerts as unknown as AlertService,
    ),
    prisma,
    tx,
    alerts,
  };
}

function event(overrides: Record<string, unknown> = {}) {
  return {
    id: 41n,
    provider: 'alibaba_1688',
    integrationKey: 'audit-test',
    normalizedKind: 'subscribed',
    authoritativeState: null,
    externalAccountKey: 'account-1',
    externalSubscriptionKey: 'subscription-1',
    providerPlanKey: 'plan-1',
    providerRevision: decimal(1),
    occurredAt: NOW,
    accountBindingId: null,
    planMappingId: null,
    projectionId: null,
    ...overrides,
  };
}

function binding(overrides: Record<string, unknown> = {}) {
  return { id: 11n, userId: 31n, status: 'active', ...overrides };
}

function mapping(overrides: Record<string, unknown> = {}) {
  return { id: 21n, internalPlan: 'pro', enabled: true, ...overrides };
}

function user(overrides: Record<string, unknown> = {}) {
  return { id: 31n, status: 'active', entitlementRevision: 4, ...overrides };
}

function projection(overrides: Record<string, unknown> = {}) {
  return {
    id: 51n,
    projectionKey: 'a'.repeat(64),
    origin: 'marketplace',
    legacySubscriptionId: null,
    provider: 'alibaba_1688',
    integrationKey: 'audit-test',
    externalSubscriptionKey: 'subscription-1',
    accountBindingId: 11n,
    planMappingId: 21n,
    userId: 31n,
    internalPlan: 'pro',
    lifecycleState: 'active',
    accessStatus: 'active',
    providerRevision: decimal(5),
    projectionRevision: 3,
    effectiveStartAt: null,
    effectiveEndAt: null,
    amountCny: null,
    currency: null,
    lastEventOccurredAt: NOW,
    lastReconciledAt: null,
    supersededAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function claim(): MarketplaceClaim {
  return { ownerToken: OWNER, event: claimedEvent() };
}

function claimedEvent(): MarketplaceClaimedEvent {
  return {
    id: 41n,
    provider: 'alibaba_1688',
    integrationKey: 'audit-test',
    dedupeKey: 'event-1',
    payloadDigest: 'b'.repeat(64),
    source: 'callback',
    externalEventType: 'provider-event',
    normalizedKind: 'subscribed',
    authoritativeState: null,
    externalAccountKey: 'account-1',
    externalSubscriptionKey: 'subscription-1',
    providerPlanKey: 'plan-1',
    providerRevision: '1',
    occurredAt: NOW,
    normalizedPayload: null,
    accountBindingId: null,
    planMappingId: null,
    projectionId: null,
    attempts: 1,
    maxAttempts: 5,
    createdAt: NOW,
  };
}

function decimal(value: number): Prisma.Decimal {
  return new Prisma.Decimal(value);
}
