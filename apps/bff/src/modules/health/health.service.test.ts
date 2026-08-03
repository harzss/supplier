import type { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../common/prisma.module';
import type { AlertService } from '../observability/alert.service';
import { HealthService, LATEST_REQUIRED_MIGRATION } from './health.service';

function makeService(
  options: {
    database?: Promise<unknown>;
    migration?: Promise<unknown>;
    redis?: Promise<unknown>;
  } = {},
) {
  const queryRaw = vi
    .fn()
    .mockReturnValueOnce(
      options.database ??
        options.migration ??
        Promise.resolve([{ migration_name: LATEST_REQUIRED_MIGRATION }]),
    );
  const prisma = {
    $queryRaw: queryRaw,
  } as unknown as PrismaService;
  const redis = {
    ping: vi.fn().mockReturnValue(options.redis ?? Promise.resolve('PONG')),
  } as unknown as Redis;
  const config = { get: () => 20 } as unknown as ConfigService;
  const alerts = { raise: vi.fn(), resolve: vi.fn() } as unknown as AlertService;
  return new HealthService(prisma, redis, config, alerts);
}

describe('HealthService', () => {
  it('tracks the newest repository migration in the readiness gate', () => {
    const migrations = readdirSync(resolve(process.cwd(), '../../packages/db/prisma/migrations'), {
      withFileTypes: true,
    })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(migrations.at(-1)).toBe(LATEST_REQUIRED_MIGRATION);
  });

  it('reports ready only when database and Redis respond', async () => {
    await expect(makeService().readiness()).resolves.toMatchObject({
      status: 'ready',
      checks: { database: { status: 'up' }, redis: { status: 'up' } },
    });
  });

  it('reports unavailable when a dependency fails', async () => {
    await expect(
      makeService({ database: Promise.reject(new Error('db unavailable')) }).readiness(),
    ).resolves.toMatchObject({
      status: 'unavailable',
      checks: { database: { status: 'down' }, redis: { status: 'up' } },
    });
  });

  it('reports unavailable when the database is reachable but the required schema is not applied', async () => {
    await expect(
      makeService({ migration: Promise.resolve([]) }).readiness(),
    ).resolves.toMatchObject({
      status: 'unavailable',
      checks: { database: { status: 'down' }, redis: { status: 'up' } },
    });
  });

  it('bounds readiness latency when a dependency hangs', async () => {
    const never = new Promise<never>(() => undefined);
    const result = await makeService({ redis: never }).readiness();
    expect(result.status).toBe('unavailable');
    expect(result.checks.redis.status).toBe('down');
    expect(result.durationMs).toBeLessThan(200);
  });
});
