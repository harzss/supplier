import { ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { HealthController } from './health.controller';
import type { HealthService, ReadinessResult } from './health.service';

const LIVE = {
  status: 'ok' as const,
  service: 'supplier-bff' as const,
  version: '0.0.1',
  timestamp: '2026-07-17T00:00:00.000Z',
};

function controller(result: ReadinessResult) {
  const health = {
    liveness: vi.fn().mockReturnValue(LIVE),
    readiness: vi.fn().mockResolvedValue(result),
  } as unknown as HealthService;
  return new HealthController(health);
}

describe('HealthController', () => {
  it('keeps the legacy health route as a liveness alias', () => {
    expect(controller(readiness('ready')).check()).toEqual(LIVE);
  });

  it('returns readiness details when dependencies are healthy', async () => {
    await expect(controller(readiness('ready')).ready()).resolves.toMatchObject({
      status: 'ready',
    });
  });

  it('returns HTTP 503 when a required dependency is unavailable', async () => {
    try {
      await controller(readiness('unavailable')).ready();
      throw new Error('expected readiness to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect((error as ServiceUnavailableException).getStatus()).toBe(503);
    }
  });
});

function readiness(status: ReadinessResult['status']): ReadinessResult {
  const dependency = status === 'ready' ? 'up' : 'down';
  return {
    status,
    service: 'supplier-bff',
    version: '0.0.1',
    checks: { database: { status: dependency }, runtimeState: { status: dependency } },
    timestamp: '2026-07-17T00:00:00.000Z',
    durationMs: 1,
  };
}
