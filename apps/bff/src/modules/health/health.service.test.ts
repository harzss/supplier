import type { ConfigService } from '@nestjs/config';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../common/prisma.module';
import type { RuntimeStateService } from '../../common/runtime-state.service';
import type { AlertService } from '../observability/alert.service';
import { HealthService, LATEST_REQUIRED_MIGRATION } from './health.service';

function makeService(
  options: {
    database?: Promise<unknown>;
    migration?: Promise<unknown>;
    runtimeState?: Promise<unknown>;
    revision?: string;
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
  const runtimeState = {
    ping: vi.fn().mockReturnValue(options.runtimeState ?? Promise.resolve()),
  } as unknown as RuntimeStateService;
  const config = {
    get: (key: string) =>
      key === 'HEALTH_CHECK_TIMEOUT_MS'
        ? 20
        : key === 'SUPPLIER_GIT_SHA'
          ? options.revision
          : undefined,
  } as unknown as ConfigService;
  const alerts = { raise: vi.fn(), resolve: vi.fn() } as unknown as AlertService;
  return new HealthService(prisma, runtimeState, config, alerts);
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

  it('reports ready only when database and runtime state respond', async () => {
    await expect(makeService().readiness()).resolves.toMatchObject({
      status: 'ready',
      checks: { database: { status: 'up' }, runtimeState: { status: 'up' } },
    });
  });

  it('exposes the validated build revision in liveness and readiness', async () => {
    const revision = 'a'.repeat(40);
    const service = makeService({ revision });
    expect(service.liveness()).toMatchObject({ revision });
    await expect(service.readiness()).resolves.toMatchObject({ revision });
  });

  it('reports unavailable when a dependency fails', async () => {
    await expect(
      makeService({ database: Promise.reject(new Error('db unavailable')) }).readiness(),
    ).resolves.toMatchObject({
      status: 'unavailable',
      checks: { database: { status: 'down' }, runtimeState: { status: 'up' } },
    });
  });

  it('reports unavailable when the database is reachable but the required schema is not applied', async () => {
    await expect(
      makeService({ migration: Promise.resolve([]) }).readiness(),
    ).resolves.toMatchObject({
      status: 'unavailable',
      checks: { database: { status: 'down' }, runtimeState: { status: 'up' } },
    });
  });

  it('bounds readiness latency when a dependency hangs', async () => {
    const never = new Promise<never>(() => undefined);
    const result = await makeService({ runtimeState: never }).readiness();
    expect(result.status).toBe('unavailable');
    expect(result.checks.runtimeState.status).toBe('down');
    expect(result.durationMs).toBeLessThan(200);
  });
});
