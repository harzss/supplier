import type { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateEnvironment } from '../../config/environment';
import type { AlertService } from '../observability/alert.service';
import type {
  MarketplaceClaim,
  MarketplaceClaimedEvent,
  MarketplaceEventInboxService,
} from './marketplace-event-inbox.service';
import { MarketplaceEventProcessingWorker } from './marketplace-event-processing.worker';
import type { MarketplaceSubscriptionProjectionService } from './marketplace-subscription-projection.service';

const NOW = new Date('2026-08-18T06:00:00.000Z');

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('MarketplaceEventProcessingWorker', () => {
  it('does not create a timer or run while disabled', () => {
    vi.useFakeTimers();
    const fixture = makeFixture({ enabled: false });
    const runOnce = vi.spyOn(fixture.worker, 'runOnce');

    fixture.worker.onModuleInit();

    expect(vi.getTimerCount()).toBe(0);
    expect(runOnce).not.toHaveBeenCalled();
  });

  it('recovers expired claims before processing a bounded batch', async () => {
    const order: string[] = [];
    const fixture = makeFixture();
    fixture.inbox.recoverExpiredClaims.mockImplementation(async () => {
      order.push('recover');
      return { recovered: 1, retryWait: 1, dead: 0 };
    });
    fixture.inbox.claimNext
      .mockImplementationOnce(async () => {
        order.push('claim');
        return claim(41n, 1);
      })
      .mockImplementationOnce(async () => {
        order.push('empty');
        return null;
      });
    fixture.projections.processClaim.mockImplementation(async () => {
      order.push('project');
      return { outcome: 'applied', eventId: 41n, projectionId: 51n };
    });

    await expect(fixture.worker.runOnce(NOW)).resolves.toEqual({
      recovery: { recovered: 1, retryWait: 1, dead: 0 },
      claimed: 1,
      applied: 1,
      ignored: 0,
      blocked: 0,
      retried: 0,
      dead: 0,
      ownershipLost: 0,
    });
    expect(order).toEqual(['recover', 'claim', 'project', 'empty']);
    expect(fixture.inbox.recoverExpiredClaims).toHaveBeenCalledWith(
      new Date(NOW.getTime() - 60_000),
      NOW,
      20,
    );
  });

  it('never processes more than the configured batch size', async () => {
    const fixture = makeFixture({ batchSize: 2 });
    fixture.inbox.claimNext.mockResolvedValue(claim(41n, 1));
    fixture.projections.processClaim.mockResolvedValue({
      outcome: 'applied',
      eventId: 41n,
      projectionId: 51n,
    });

    const result = await fixture.worker.runOnce(NOW);

    expect(result.claimed).toBe(2);
    expect(fixture.inbox.claimNext).toHaveBeenCalledTimes(2);
    expect(fixture.projections.processClaim).toHaveBeenCalledTimes(2);
  });

  it('counts applied, ignored and blocked outcomes without retrying blocked events', async () => {
    const fixture = makeFixture();
    fixture.inbox.claimNext
      .mockResolvedValueOnce(claim(41n, 1))
      .mockResolvedValueOnce(claim(42n, 1))
      .mockResolvedValueOnce(claim(43n, 1))
      .mockResolvedValueOnce(null);
    fixture.projections.processClaim
      .mockResolvedValueOnce({ outcome: 'applied', eventId: 41n, projectionId: 51n })
      .mockResolvedValueOnce({ outcome: 'ignored_stale', eventId: 42n, projectionId: 51n })
      .mockResolvedValueOnce({ outcome: 'blocked', eventId: 43n, code: 'BINDING.NOT_FOUND' });

    await expect(fixture.worker.runOnce(NOW)).resolves.toMatchObject({
      claimed: 3,
      applied: 1,
      ignored: 1,
      blocked: 1,
      retried: 0,
      dead: 0,
    });
    expect(fixture.inbox.scheduleRetry).not.toHaveBeenCalled();
  });

  it('uses exponential retry delay and raises a critical alert when attempts are exhausted', async () => {
    const fixture = makeFixture();
    fixture.inbox.claimNext
      .mockResolvedValueOnce(claim(41n, 1, 5))
      .mockResolvedValueOnce(claim(42n, 5, 5))
      .mockResolvedValueOnce(null);
    fixture.projections.processClaim.mockRejectedValue(
      Object.assign(new Error('db'), { code: 'P2034' }),
    );
    fixture.inbox.scheduleRetry.mockResolvedValueOnce('retry_wait').mockResolvedValueOnce('dead');

    await expect(fixture.worker.runOnce(NOW)).resolves.toMatchObject({
      claimed: 2,
      retried: 1,
      dead: 1,
    });
    expect(fixture.inbox.scheduleRetry).toHaveBeenNthCalledWith(
      1,
      41n,
      expect.any(String),
      'PROCESS.P2034',
      new Date(NOW.getTime() + 1_000),
      NOW,
    );
    expect(fixture.inbox.scheduleRetry).toHaveBeenNthCalledWith(
      2,
      42n,
      expect.any(String),
      'PROCESS.P2034',
      new Date(NOW.getTime() + 16_000),
      NOW,
    );
    expect(fixture.alerts.raise).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'marketplace.event.dead.42',
        severity: 'critical',
      }),
    );
  });

  it('raises a critical aggregate alert for exhausted recovered claims', async () => {
    const fixture = makeFixture();
    fixture.inbox.recoverExpiredClaims.mockResolvedValue({ recovered: 2, retryWait: 1, dead: 1 });

    await fixture.worker.runOnce(NOW);

    expect(fixture.alerts.raise).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'marketplace.event.dead.recovered',
        severity: 'critical',
        details: { count: 1 },
      }),
    );
  });

  it('does not overlap two local drain loops', async () => {
    const fixture = makeFixture();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runOnce = vi.spyOn(fixture.worker, 'runOnce').mockImplementation(async () => {
      await pending;
      return emptyResult();
    });
    const drain = (fixture.worker as unknown as { drain(): Promise<void> }).drain.bind(
      fixture.worker,
    );

    const first = drain();
    await drain();
    expect(runOnce).toHaveBeenCalledTimes(1);
    release();
    await first;
  });
});

describe('marketplace worker environment bounds', () => {
  it('defaults disabled and exposes bounded numeric defaults', () => {
    expect(validateWorkerEnvironment({})).toMatchObject({
      MARKETPLACE_EVENT_POLL_MS: 2_000,
      MARKETPLACE_EVENT_BATCH_SIZE: 20,
      MARKETPLACE_EVENT_LEASE_MS: 60_000,
    });
    expect(validateWorkerEnvironment({ MARKETPLACE_EVENT_PROCESSING_ENABLED: true })).toMatchObject(
      {
        MARKETPLACE_EVENT_PROCESSING_ENABLED: 'true',
      },
    );
  });

  it.each([
    ['MARKETPLACE_EVENT_PROCESSING_ENABLED', 'enabled', 'true or false'],
    ['MARKETPLACE_EVENT_POLL_MS', 499, 'between 500 and 60000'],
    ['MARKETPLACE_EVENT_POLL_MS', 60_001, 'between 500 and 60000'],
    ['MARKETPLACE_EVENT_BATCH_SIZE', 0, 'between 1 and 100'],
    ['MARKETPLACE_EVENT_BATCH_SIZE', 101, 'between 1 and 100'],
    ['MARKETPLACE_EVENT_LEASE_MS', 4_999, 'between 5000 and 300000'],
    ['MARKETPLACE_EVENT_LEASE_MS', 300_001, 'between 5000 and 300000'],
  ])('rejects unsafe %s=%s', (key, value, message) => {
    expect(() => validateWorkerEnvironment({ [key]: value })).toThrow(message);
  });
});

function validateWorkerEnvironment(environment: Record<string, unknown>) {
  return validateEnvironment({ NODE_ENV: 'test', ...environment });
}

function makeFixture(
  options: { enabled?: boolean; batchSize?: number; leaseMs?: number; pollMs?: number } = {},
) {
  const values: Record<string, string | number> = {
    MARKETPLACE_EVENT_PROCESSING_ENABLED: options.enabled === false ? 'false' : 'true',
    MARKETPLACE_EVENT_BATCH_SIZE: options.batchSize ?? 20,
    MARKETPLACE_EVENT_LEASE_MS: options.leaseMs ?? 60_000,
    MARKETPLACE_EVENT_POLL_MS: options.pollMs ?? 2_000,
  };
  const config = { get: vi.fn((key: string) => values[key]) } as unknown as ConfigService;
  const inbox = {
    recoverExpiredClaims: vi.fn().mockResolvedValue({ recovered: 0, retryWait: 0, dead: 0 }),
    claimNext: vi.fn().mockResolvedValue(null),
    scheduleRetry: vi.fn(),
  };
  const projections = { processClaim: vi.fn() };
  const alerts = { raise: vi.fn() };
  return {
    worker: new MarketplaceEventProcessingWorker(
      config,
      inbox as unknown as MarketplaceEventInboxService,
      projections as unknown as MarketplaceSubscriptionProjectionService,
      alerts as unknown as AlertService,
    ),
    config,
    inbox,
    projections,
    alerts,
  };
}

function claim(id: bigint, attempts: number, maxAttempts = 5): MarketplaceClaim {
  return {
    ownerToken: `6ca0280f-3158-4cbc-a34c-${id.toString().padStart(12, '0')}`,
    event: claimedEvent({ id, attempts, maxAttempts }),
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
    normalizedPayload: null,
    accountBindingId: null,
    planMappingId: null,
    projectionId: null,
    attempts: 1,
    maxAttempts: 5,
    createdAt: NOW,
    ...overrides,
  };
}

function emptyResult() {
  return {
    recovery: { recovered: 0, retryWait: 0, dead: 0 },
    claimed: 0,
    applied: 0,
    ignored: 0,
    blocked: 0,
    retried: 0,
    dead: 0,
    ownershipLost: 0,
  };
}
