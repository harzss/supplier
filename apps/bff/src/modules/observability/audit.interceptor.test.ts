import { BadRequestException, type ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { lastValueFrom, of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import type { AuditService } from './audit.service';
import { AuditInterceptor } from './audit.interceptor';
import type { RuntimeMetricsService } from './runtime-metrics.service';

function setup() {
  const request = {
    id: 'req-1',
    method: 'POST',
    url: '/api/publish-tasks',
    ip: '127.0.0.1',
    headers: { 'user-agent': 'vitest' },
    routeOptions: { url: '/publish-tasks' },
    params: {},
    body: undefined as unknown,
    currentUser: { userId: 42n, plan: 'pro' },
  };
  const reply = { statusCode: 201, header: vi.fn() };
  const context = {
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => reply }),
  } as unknown as ExecutionContext;
  const audit = { record: vi.fn().mockResolvedValue(undefined) } as unknown as AuditService;
  const metrics = { record: vi.fn() } as unknown as RuntimeMetricsService;
  const reflector = { getAllAndOverride: vi.fn() } as unknown as Reflector;
  return {
    interceptor: new AuditInterceptor(reflector, audit, metrics),
    context,
    audit,
    metrics,
    reflector,
    request,
  };
}

describe('AuditInterceptor', () => {
  it('audits successful mutating requests without recording the request body', async () => {
    const { interceptor, context, audit, metrics } = setup();
    await expect(
      lastValueFrom(interceptor.intercept(context, { handle: () => of({ ok: true }) })),
    ).resolves.toEqual({ ok: true });

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 42n,
        action: 'http.post.publish-tasks',
        outcome: 'success',
        statusCode: 201,
      }),
    );
    expect(metrics.record).toHaveBeenCalledWith(201, expect.any(Number));
  });

  it('audits failed mutating requests and preserves the original exception', async () => {
    const { interceptor, context, audit } = setup();
    const error = new BadRequestException('invalid');
    await expect(
      lastValueFrom(interceptor.intercept(context, { handle: () => throwError(() => error) })),
    ).rejects.toBe(error);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'failure', statusCode: 400 }),
    );
  });

  it('records only an explicitly allowed resource id field from the request body', async () => {
    const { interceptor, context, audit, reflector, request } = setup();
    request.body = { sourceProductId: 'mock-1001', apiKey: 'must-not-be-recorded' };
    vi.mocked(reflector.getAllAndOverride).mockReturnValue({
      action: 'publish.pricing.preview',
      resourceType: 'source_product',
      resourceIdBodyField: 'sourceProductId',
    });

    await lastValueFrom(interceptor.intercept(context, { handle: () => of({ ok: true }) }));

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'publish.pricing.preview',
        resourceType: 'source_product',
        resourceId: 'mock-1001',
      }),
    );
    expect(audit.record).not.toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ apiKey: expect.anything() }) }),
    );
  });
});
