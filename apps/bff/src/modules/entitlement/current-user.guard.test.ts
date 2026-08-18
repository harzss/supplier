import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { CurrentUserGuard } from './current-user.guard';
import type { UserContextService } from './user-context.service';
import type { AuditService } from '../observability/audit.service';
import type { RuntimeMetricsService } from '../observability/runtime-metrics.service';

function context(headers: Record<string, string> = {}) {
  const request: { headers: Record<string, string>; currentUser?: unknown } = { headers };
  const ctx = {
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { ctx, request };
}

function guard(options: { mode: 'demo' | 'supabase'; publicRoute?: boolean }) {
  const userContext = {
    authMode: options.mode,
    loadDemo: vi.fn().mockResolvedValue({
      userId: 1n,
      plan: 'free',
      entitlementSource: 'internal_beta',
      accessStatus: 'active',
      entitlementRevision: 1,
    }),
    authenticate: vi.fn().mockResolvedValue({
      userId: 42n,
      plan: 'free',
      entitlementSource: 'marketplace',
      accessStatus: 'suspended',
      entitlementRevision: 7,
    }),
  } as unknown as UserContextService;
  const reflector = {
    getAllAndOverride: vi.fn().mockReturnValue(options.publicRoute ?? false),
  } as unknown as Reflector;
  const audit = { record: vi.fn() } as unknown as AuditService;
  const metrics = { record: vi.fn() } as unknown as RuntimeMetricsService;
  return {
    guard: new CurrentUserGuard(userContext, reflector, audit, metrics),
    userContext,
    audit,
    metrics,
  };
}

describe('CurrentUserGuard', () => {
  it('skips authentication only for explicitly public routes', async () => {
    const { guard: currentGuard, userContext } = guard({ mode: 'supabase', publicRoute: true });
    await expect(currentGuard.canActivate(context().ctx)).resolves.toBe(true);
    expect(userContext.authenticate).not.toHaveBeenCalled();
  });

  it('requires Bearer authentication and ignores forged demo headers in Supabase mode', async () => {
    const { guard: currentGuard, userContext, audit } = guard({ mode: 'supabase' });
    await expect(
      currentGuard.canActivate(context({ 'x-user-id': '1', 'x-user-plan': 'flagship' }).ctx),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth.access.denied', statusCode: 401 }),
    );

    const { ctx, request } = context({
      authorization: 'Bearer signed-token',
      'x-user-id': '1',
      'x-user-plan': 'flagship',
    });
    await expect(currentGuard.canActivate(ctx)).resolves.toBe(true);
    expect(userContext.authenticate).toHaveBeenCalledWith('signed-token');
    expect(request.currentUser).toEqual({
      userId: 42n,
      plan: 'free',
      entitlementSource: 'marketplace',
      accessStatus: 'suspended',
      entitlementRevision: 7,
    });
  });

  it('retains the existing demo identity path outside production', async () => {
    const { guard: currentGuard, userContext } = guard({ mode: 'demo' });
    await currentGuard.canActivate(context({ 'x-user-id': '1', 'x-user-plan': 'pro' }).ctx);
    expect(userContext.loadDemo).toHaveBeenCalledWith('1', 'pro');
  });
});
