import type { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../common/prisma.module';
import { AlertService } from './alert.service';

const CONFIG: Record<string, string | number> = {
  ALERT_WEBHOOK_URL: 'https://alerts.example.com/hooks/supplier',
  ALERT_WEBHOOK_SECRET: 'unit-test-alert-webhook-secret',
  ALERT_WEBHOOK_TIMEOUT_MS: 1000,
  ALERT_WEBHOOK_MAX_ATTEMPTS: 3,
  ALERT_WEBHOOK_RETRY_BASE_MS: 1,
  ALERT_RENOTIFY_SECONDS: 900,
};

afterEach(() => vi.unstubAllGlobals());

describe('AlertService', () => {
  it('persists, redacts and signs a new alert notification', async () => {
    const create = vi.fn().mockResolvedValue({});
    const update = vi.fn().mockResolvedValue({});
    const prisma = {
      operationalAlert: {
        findUnique: vi.fn().mockResolvedValue(null),
        create,
        update,
      },
    } as unknown as PrismaService;
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetcher);
    const service = new AlertService(prisma, config());

    await service.raise({
      key: 'credential.user.42',
      type: 'credential',
      severity: 'critical',
      summary: 'credential failed',
      details: { apiKey: 'sk-secret', userId: 42n },
    });

    expect(create.mock.calls[0]?.[0].data.details).toEqual({
      apiKey: '[redacted]',
      userId: '42',
    });
    const request = fetcher.mock.calls[0]?.[1];
    expect(request.headers['x-supplier-alert-delivery-id']).toMatch(/^[a-f0-9]{64}$/);
    expect(request.headers['x-supplier-alert-signature']).toMatch(/^sha256=[a-f0-9]{64}$/);
    expect(JSON.parse(String(request.body)).deliveryId).toBe(
      request.headers['x-supplier-alert-delivery-id'],
    );
    expect(String(request.body)).not.toContain('sk-secret');
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { lastNotifiedAt: expect.any(Date) } }),
    );
  });

  it('deduplicates an active alert inside the renotify window', async () => {
    const prisma = {
      operationalAlert: {
        findUnique: vi.fn().mockResolvedValue({
          id: 1n,
          key: 'queue.backlog',
          type: 'queue',
          severity: 'warning',
          status: 'active',
          summary: 'backlog',
          details: null,
          occurrences: 1,
          firstSeenAt: new Date(),
          lastSeenAt: new Date(),
          lastNotifiedAt: new Date(),
          resolvedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
        update: vi.fn().mockResolvedValue({}),
      },
    } as unknown as PrismaService;
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const service = new AlertService(prisma, config());

    await service.raise({
      key: 'queue.backlog',
      type: 'queue',
      severity: 'warning',
      summary: 'backlog',
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('retries a transient webhook failure with the same delivery id', async () => {
    const update = vi.fn().mockResolvedValue({});
    const prisma = {
      operationalAlert: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({}),
        update,
      },
    } as unknown as PrismaService;
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetcher);
    const service = new AlertService(prisma, config());

    await service.raise({
      key: 'database.unavailable',
      type: 'dependency',
      severity: 'critical',
      summary: 'database unavailable',
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
    const firstRequest = fetcher.mock.calls[0]?.[1];
    const secondRequest = fetcher.mock.calls[1]?.[1];
    expect(secondRequest.headers['x-supplier-alert-delivery-id']).toBe(
      firstRequest.headers['x-supplier-alert-delivery-id'],
    );
    expect(secondRequest.body).toBe(firstRequest.body);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { lastNotifiedAt: expect.any(Date) } }),
    );
  });

  it('does not retry a non-retryable webhook response', async () => {
    const update = vi.fn().mockResolvedValue({});
    const prisma = {
      operationalAlert: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({}),
        update,
      },
    } as unknown as PrismaService;
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 400 }));
    vi.stubGlobal('fetch', fetcher);
    const service = new AlertService(prisma, config());

    await service.raise({
      key: 'webhook.invalid',
      type: 'delivery',
      severity: 'warning',
      summary: 'invalid webhook request',
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
  });

  it('stops after the configured attempts for a rate-limited webhook', async () => {
    const update = vi.fn().mockResolvedValue({});
    const prisma = {
      operationalAlert: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({}),
        update,
      },
    } as unknown as PrismaService;
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 429 }));
    vi.stubGlobal('fetch', fetcher);
    const service = new AlertService(prisma, config());

    await service.raise({
      key: 'webhook.rate-limited',
      type: 'delivery',
      severity: 'warning',
      summary: 'webhook rate limited',
    });

    expect(fetcher).toHaveBeenCalledTimes(3);
    const deliveryIds = fetcher.mock.calls.map(
      (call) => call[1].headers['x-supplier-alert-delivery-id'],
    );
    expect(new Set(deliveryIds).size).toBe(1);
    expect(update).not.toHaveBeenCalled();
  });
});

function config(): ConfigService {
  return { get: (key: string) => CONFIG[key] } as unknown as ConfigService;
}
