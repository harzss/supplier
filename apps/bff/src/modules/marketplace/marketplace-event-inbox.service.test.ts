import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../common/prisma.module';
import type { AlertService } from '../observability/alert.service';
import {
  MARKETPLACE_MAX_RAW_PAYLOAD_BYTES,
  MarketplaceEventInboxService,
  type MarketplaceClaimedEvent,
  type VerifiedMarketplaceEventInput,
} from './marketplace-event-inbox.service';

const NOW = new Date('2026-08-18T04:00:00.000Z');
const RETRY_AT = new Date('2026-08-18T04:01:00.000Z');
const OWNER_A = '6ca0280f-3158-4cbc-a34c-4d957f4a3e7a';
const OWNER_B = 'df4dcac6-090a-4204-a163-13053f4e6d3b';

describe('MarketplaceEventInboxService.receiveVerified', () => {
  it('persists only a digest and sanitized normalized data while leaving unknown links received', async () => {
    const fixture = makeFixture();
    const rawPayload = Buffer.from('{"event":"paid","secret":"raw-secret-value"}');
    const expectedDigest = createHash('sha256').update(rawPayload).digest('hex');
    fixture.prisma.marketplaceEventInbox.create.mockResolvedValue(
      receipt({ payloadDigest: expectedDigest }),
    );

    const result = await fixture.service.receiveVerified(
      verifiedInput({
        rawPayload,
        normalizedPayload: {
          status: 'paid',
          token: 'normalized-token',
          nested: { signature: 'normalized-signature', count: 1 },
          accidentalBuffer: rawPayload,
        },
      }),
    );

    expect(result).toMatchObject({ outcome: 'created', event: { status: 'received' } });
    const data = fixture.prisma.marketplaceEventInbox.create.mock.calls[0]![0].data;
    expect(data).toMatchObject({
      provider: 'alibaba_1688',
      integrationKey: 'audit-test',
      dedupeKey: 'event-1',
      payloadDigest: expectedDigest,
      source: 'callback',
      verifierVersion: 'future-adapter-v1',
      signatureVerifiedAt: NOW,
      normalizedPayload: { status: 'paid', nested: { count: 1 } },
    });
    expect(data).not.toHaveProperty('createdAt');
    expect(data).not.toHaveProperty('lastReceivedAt');
    expect(data).not.toHaveProperty('updatedAt');
    expect(data).not.toHaveProperty('rawPayload');
    expect(data).not.toHaveProperty('accountBindingId');
    expect(data).not.toHaveProperty('planMappingId');
    expect(data).not.toHaveProperty('projectionId');
    expect(JSON.stringify(data)).not.toContain('raw-secret-value');
    expect(JSON.stringify(data)).not.toContain('normalized-token');
    expect(JSON.stringify(data)).not.toContain('normalized-signature');
  });

  it('rejects oversized raw payloads before hashing or persistence', async () => {
    const fixture = makeFixture();

    await expect(
      fixture.service.receiveVerified(
        verifiedInput({ rawPayload: Buffer.alloc(MARKETPLACE_MAX_RAW_PAYLOAD_BYTES + 1) }),
      ),
    ).rejects.toThrow('1 MiB');
    expect(fixture.prisma.marketplaceEventInbox.create).not.toHaveBeenCalled();
  });

  it('requires evidence that a future adapter verified callback authenticity', async () => {
    const fixture = makeFixture();

    await expect(
      fixture.service.receiveVerified(
        verifiedInput({ verifierVersion: undefined, signatureVerifiedAt: undefined }),
      ),
    ).rejects.toThrow('verified callback evidence');
    expect(fixture.prisma.marketplaceEventInbox.create).not.toHaveBeenCalled();
  });

  it('persists an explicit authoritative state only for reconciliation sources', async () => {
    const fixture = makeFixture();
    fixture.prisma.marketplaceEventInbox.create.mockResolvedValue(receipt());

    await fixture.service.receiveVerified(
      verifiedInput({
        source: 'reconciliation',
        verifierVersion: undefined,
        signatureVerifiedAt: undefined,
        normalizedKind: 'reconciled',
        authoritativeState: 'active',
      }),
    );

    expect(fixture.prisma.marketplaceEventInbox.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          source: 'reconciliation',
          normalizedKind: 'reconciled',
          authoritativeState: 'active',
        }),
      }),
    );
  });

  it.each([
    [{ source: 'reconciliation', normalizedKind: 'reconciled' }, 'requires an authoritative state'],
    [
      { source: 'callback', normalizedKind: 'reconciled', authoritativeState: 'active' },
      'requires a reconciliation or manual source',
    ],
    [
      { source: 'reconciliation', normalizedKind: 'subscribed', authoritativeState: 'active' },
      'allowed only for reconciliation events',
    ],
  ] as const)('rejects an invalid authoritative projection envelope', async (overrides, error) => {
    const fixture = makeFixture();

    await expect(fixture.service.receiveVerified(verifiedInput(overrides))).rejects.toThrow(error);
    expect(fixture.prisma.marketplaceEventInbox.create).not.toHaveBeenCalled();
  });

  it('atomically counts a same-digest delivery after a unique-key race', async () => {
    const fixture = makeFixture();
    const input = verifiedInput();
    const digest = createHash('sha256').update(input.rawPayload).digest('hex');
    fixture.prisma.marketplaceEventInbox.create.mockRejectedValue(uniqueConflict());
    fixture.prisma.$queryRaw.mockResolvedValueOnce([
      receipt({ payloadDigest: digest, deliveryCount: 2 }),
    ]);

    await expect(fixture.service.receiveVerified(input)).resolves.toMatchObject({
      outcome: 'replay',
      event: { deliveryCount: 2, conflictCount: 0 },
    });
    const call = fixture.prisma.$queryRaw.mock.calls[0]!;
    const sql = sqlText(call);
    expect(sql).toContain('clock_timestamp()');
    expect(sql).toContain('"delivery_count" = event."delivery_count" + 1');
    expect(sql).toContain('"last_received_at" = GREATEST(');
    expect(sql).toContain('event."created_at"');
    expect(sql).toContain('RETURNING');
    expect(call.slice(1)).toEqual(['alibaba_1688', 'audit-test', 'event-1', digest]);
    expect(fixture.alerts.raise).not.toHaveBeenCalled();
  });

  it('uses the database clock for a duplicate even when the process clock is stale', async () => {
    const fixture = makeFixture();
    const input = verifiedInput();
    const digest = createHash('sha256').update(input.rawPayload).digest('hex');
    fixture.prisma.marketplaceEventInbox.create.mockRejectedValue(uniqueConflict());
    fixture.prisma.$queryRaw.mockResolvedValueOnce([
      receipt({ payloadDigest: digest, deliveryCount: 2, lastReceivedAt: NOW }),
    ]);

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2000-01-01T00:00:00.000Z'));
    try {
      await expect(fixture.service.receiveVerified(input)).resolves.toMatchObject({
        outcome: 'replay',
        event: { deliveryCount: 2, lastReceivedAt: NOW },
      });
    } finally {
      vi.useRealTimers();
    }

    const call = fixture.prisma.$queryRaw.mock.calls[0]!;
    expect(sqlText(call)).toContain('clock_timestamp()');
    expect(call.slice(1).some((value) => value instanceof Date)).toBe(false);
  });

  it('records but never overwrites a conflicting digest and raises a critical alert', async () => {
    const fixture = makeFixture();
    const input = verifiedInput({ rawPayload: Buffer.from('conflicting-body') });
    const conflictingDigest = createHash('sha256').update(input.rawPayload).digest('hex');
    const storedDigest = 'a'.repeat(64);
    fixture.prisma.marketplaceEventInbox.create.mockRejectedValue(uniqueConflict());
    fixture.prisma.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([receipt({ payloadDigest: storedDigest, conflictCount: 1 })]);

    await expect(fixture.service.receiveVerified(input)).resolves.toMatchObject({
      outcome: 'conflict',
      event: { payloadDigest: storedDigest, conflictCount: 1 },
    });
    const conflictCall = fixture.prisma.$queryRaw.mock.calls[1]!;
    const conflictSql = sqlText(conflictCall);
    expect(conflictSql).toContain('clock_timestamp()');
    expect(conflictSql).toContain('"conflict_count" = event."conflict_count" + 1');
    expect(conflictSql).toContain('"last_conflict_digest" = ?');
    expect(conflictSql).toContain('"last_received_at" = GREATEST(');
    expect(conflictSql).toContain('RETURNING');
    expect(conflictCall.slice(1)).toEqual([
      conflictingDigest,
      'alibaba_1688',
      'audit-test',
      'event-1',
      conflictingDigest,
    ]);
    expect(fixture.alerts.raise).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'entitlement',
        severity: 'critical',
        details: expect.objectContaining({
          storedPayloadDigest: storedDigest,
          conflictingPayloadDigest: conflictingDigest,
        }),
      }),
    );
    expect(JSON.stringify(fixture.alerts.raise.mock.calls[0]![0])).not.toContain('event-1');
  });

  it('converges two concurrent creates to one row and one replay', async () => {
    const fixture = makeFixture();
    const input = verifiedInput();
    const digest = createHash('sha256').update(input.rawPayload).digest('hex');
    let stored = receipt({ payloadDigest: digest });
    let created = false;
    fixture.prisma.marketplaceEventInbox.create.mockImplementation(async () => {
      if (created) throw uniqueConflict();
      created = true;
      await Promise.resolve();
      return stored;
    });
    fixture.prisma.$queryRaw.mockImplementation(async () => {
      stored = { ...stored, deliveryCount: stored.deliveryCount + 1 };
      return [stored];
    });

    const results = await Promise.all([
      fixture.service.receiveVerified(input),
      fixture.service.receiveVerified(input),
    ]);

    expect(results.map((result) => result.outcome).sort()).toEqual(['created', 'replay']);
    expect(stored.deliveryCount).toBe(2);
  });
});

describe('MarketplaceEventInboxService claims and ownership', () => {
  it('claims the oldest eligible event atomically with SKIP LOCKED', async () => {
    const fixture = makeFixture();
    fixture.prisma.$queryRaw.mockResolvedValueOnce([claimedEvent({ attempts: 1 })]);

    await expect(
      fixture.service.claimNext({ now: NOW, ownerToken: OWNER_A }),
    ).resolves.toMatchObject({
      ownerToken: OWNER_A,
      event: { id: 41n, attempts: 1 },
    });
    const sql = sqlText(fixture.prisma.$queryRaw.mock.calls[0]!);
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(sql).toContain('ORDER BY candidate."created_at", candidate."id"');
    expect(sql).toContain('candidate."attempts" < candidate."max_attempts"');
    expect(sql).toContain('candidate."status" = \'retry_wait\'');
    expect(sql).toContain('"authoritative_state"::text AS "authoritativeState"');
  });

  it('allows only one of two competing claims to acquire ownership', async () => {
    const fixture = makeFixture();
    fixture.prisma.$queryRaw
      .mockResolvedValueOnce([claimedEvent({ attempts: 1 })])
      .mockResolvedValueOnce([]);

    const [first, second] = await Promise.all([
      fixture.service.claimNext({ now: NOW, ownerToken: OWNER_A }),
      fixture.service.claimNext({ now: NOW, ownerToken: OWNER_B }),
    ]);

    expect(first?.ownerToken).toBe(OWNER_A);
    expect(second).toBeNull();
  });

  it('rejects a stale owner without mutating an applied event', async () => {
    const fixture = makeFixture();
    fixture.prisma.marketplaceEventInbox.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      fixture.service.markApplied(41n, OWNER_A, {
        normalizedKind: 'subscribed',
        providerRevision: '7',
        accountBindingId: 1n,
        planMappingId: 2n,
        projectionId: 3n,
        processedAt: NOW,
      }),
    ).resolves.toBe(false);
    expect(fixture.prisma.marketplaceEventInbox.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 41n, status: 'processing', lockedBy: OWNER_A },
      }),
    );
  });

  it('commits an applied result only with complete linkage and clears the lease', async () => {
    const fixture = makeFixture();
    fixture.prisma.marketplaceEventInbox.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      fixture.service.markApplied(41n, OWNER_A, {
        normalizedKind: 'subscribed',
        providerRevision: '7',
        accountBindingId: 1n,
        planMappingId: 2n,
        projectionId: 3n,
        occurredAt: NOW,
        normalizedPayload: { state: 'active', secret: 'drop-me' },
        processedAt: NOW,
      }),
    ).resolves.toBe(true);
    expect(fixture.prisma.marketplaceEventInbox.updateMany).toHaveBeenCalledWith({
      where: { id: 41n, status: 'processing', lockedBy: OWNER_A },
      data: expect.objectContaining({
        status: 'applied',
        normalizedKind: 'subscribed',
        authoritativeState: null,
        accountBindingId: 1n,
        planMappingId: 2n,
        projectionId: 3n,
        normalizedPayload: { state: 'active' },
        nextAttemptAt: null,
        lockedAt: null,
        lockedBy: null,
        processedAt: NOW,
        lastErrorCode: null,
      }),
    });
  });

  it('requires and stores the authoritative state when applying reconciliation', async () => {
    const fixture = makeFixture();
    fixture.prisma.marketplaceEventInbox.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      fixture.service.markApplied(41n, OWNER_A, {
        normalizedKind: 'reconciled',
        authoritativeState: 'expired',
        providerRevision: '8',
        accountBindingId: 1n,
        planMappingId: 2n,
        projectionId: 3n,
        processedAt: NOW,
      }),
    ).resolves.toBe(true);
    expect(fixture.prisma.marketplaceEventInbox.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          normalizedKind: 'reconciled',
          authoritativeState: 'expired',
        }),
      }),
    );

    await expect(
      fixture.service.markApplied(41n, OWNER_A, {
        normalizedKind: 'reconciled',
        providerRevision: '9',
        accountBindingId: 1n,
        planMappingId: 2n,
        projectionId: 3n,
        processedAt: NOW,
      }),
    ).rejects.toThrow('requires an authoritative state');
  });

  it('schedules a bounded retry and atomically turns an exhausted claim dead', async () => {
    const fixture = makeFixture();
    fixture.prisma.$queryRaw
      .mockResolvedValueOnce([{ status: 'retry_wait' }])
      .mockResolvedValueOnce([{ status: 'dead' }]);

    await expect(
      fixture.service.scheduleRetry(41n, OWNER_A, 'PROVIDER.TIMEOUT', RETRY_AT, NOW),
    ).resolves.toBe('retry_wait');
    await expect(
      fixture.service.scheduleRetry(42n, OWNER_B, 'PROVIDER.TIMEOUT', RETRY_AT, NOW),
    ).resolves.toBe('dead');

    const sql = sqlText(fixture.prisma.$queryRaw.mock.calls[0]!);
    expect(sql).toContain('WHEN "attempts" >= "max_attempts" THEN');
    expect(sql).toContain('AND "locked_by" =');
    expect(sql).toContain("ELSE 'retry_wait'");
  });

  it.each([
    ['markIgnoredStale', 'ignored_stale', undefined],
    ['markBlocked', 'blocked', 'BINDING.MISSING'],
    ['markDead', 'dead', 'EVENT.INVALID'],
  ] as const)('%s finishes only the current owner claim', async (method, status, errorCode) => {
    const fixture = makeFixture();
    fixture.prisma.marketplaceEventInbox.updateMany.mockResolvedValue({ count: 1 });

    const result =
      errorCode === undefined
        ? await fixture.service[method](41n, OWNER_A, NOW)
        : await fixture.service[method](41n, OWNER_A, errorCode, NOW);

    expect(result).toBe(true);
    expect(fixture.prisma.marketplaceEventInbox.updateMany).toHaveBeenCalledWith({
      where: { id: 41n, status: 'processing', lockedBy: OWNER_A },
      data: expect.objectContaining({
        status,
        lockedAt: null,
        lockedBy: null,
        processedAt: NOW,
        lastErrorCode: errorCode ?? null,
      }),
    });
  });

  it('recovers expired claims in a bounded SKIP LOCKED batch and separates exhausted rows', async () => {
    const fixture = makeFixture();
    const cutoff = new Date('2026-08-18T03:55:00.000Z');
    fixture.prisma.$queryRaw.mockResolvedValueOnce([{ recovered: 3, retryWait: 2, dead: 1 }]);

    await expect(fixture.service.recoverExpiredClaims(cutoff, NOW, 25)).resolves.toEqual({
      recovered: 3,
      retryWait: 2,
      dead: 1,
    });

    const call = fixture.prisma.$queryRaw.mock.calls[0]!;
    const sql = sqlText(call);
    expect(sql).toContain('candidate."locked_at" <=');
    expect(sql).toContain('ORDER BY candidate."locked_at", candidate."id"');
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(sql).toContain('LIMIT');
    expect(sql).toContain('WHEN event."attempts" >= event."max_attempts" THEN \'dead\'');
    expect(sql).toContain("ELSE 'retry_wait'");
    expect(sql).toContain('"last_error_code" = \'CLAIM.LEASE_EXPIRED\'');
    expect(call.slice(1)).toContain(cutoff);
    expect(call.slice(1)).toContain(25);
  });

  it('does not query when expired-claim recovery is unbounded or uses a future cutoff', async () => {
    const fixture = makeFixture();
    const future = new Date(NOW.getTime() + 1);

    await expect(fixture.service.recoverExpiredClaims(NOW, NOW, 0)).rejects.toThrow(
      'between 1 and 100',
    );
    await expect(fixture.service.recoverExpiredClaims(NOW, NOW, 101)).rejects.toThrow(
      'between 1 and 100',
    );
    await expect(fixture.service.recoverExpiredClaims(future, NOW, 10)).rejects.toThrow(
      'must not be in the future',
    );
    expect(fixture.prisma.$queryRaw).not.toHaveBeenCalled();
  });
});

function makeFixture() {
  const database = {
    marketplaceEventInbox: {
      create: vi.fn(),
      updateMany: vi.fn(),
    },
    $queryRaw: vi.fn(),
  };
  const alerts = { raise: vi.fn() };
  return {
    service: new MarketplaceEventInboxService(
      database as unknown as PrismaService,
      alerts as unknown as AlertService,
    ),
    prisma: database,
    alerts,
  };
}

function verifiedInput(
  overrides: Partial<VerifiedMarketplaceEventInput> = {},
): VerifiedMarketplaceEventInput {
  return {
    provider: 'alibaba_1688',
    integrationKey: 'audit-test',
    dedupeKey: 'event-1',
    rawPayload: Buffer.from('{"event":"paid"}'),
    source: 'callback',
    verifierVersion: 'future-adapter-v1',
    signatureVerifiedAt: NOW,
    ...overrides,
  };
}

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    id: 41n,
    provider: 'alibaba_1688',
    integrationKey: 'audit-test',
    dedupeKey: 'event-1',
    payloadDigest: 'a'.repeat(64),
    status: 'received',
    deliveryCount: 1,
    conflictCount: 0,
    lastConflictDigest: null,
    lastReceivedAt: NOW,
    ...overrides,
  };
}

function claimedEvent(overrides: Partial<MarketplaceClaimedEvent> = {}): MarketplaceClaimedEvent {
  return {
    id: 41n,
    provider: 'alibaba_1688',
    integrationKey: 'audit-test',
    dedupeKey: 'event-1',
    payloadDigest: 'a'.repeat(64),
    source: 'callback',
    externalEventType: 'provider-event',
    normalizedKind: 'subscribed',
    authoritativeState: null,
    externalAccountKey: 'account-1',
    externalSubscriptionKey: 'subscription-1',
    providerPlanKey: 'plan-1',
    providerRevision: '1',
    occurredAt: NOW,
    normalizedPayload: { state: 'active' },
    accountBindingId: null,
    planMappingId: null,
    projectionId: null,
    attempts: 1,
    maxAttempts: 5,
    createdAt: NOW,
    ...overrides,
  };
}

function uniqueConflict() {
  return Object.assign(new Error('unique conflict'), { code: 'P2002' });
}

function sqlText(call: unknown[]): string {
  const strings = call[0] as TemplateStringsArray;
  return Array.from(strings).join('?');
}
