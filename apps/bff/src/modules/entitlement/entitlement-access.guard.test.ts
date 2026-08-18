import { ForbiddenException, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { AuditController } from '../observability/audit.controller';
import { SettingsController } from '../settings/settings.controller';
import { ShopController } from '../shop/shop.controller';
import { ALLOW_SUSPENDED_ACCESS } from './allow-suspended-access.decorator';
import { EntitlementAccessGuard } from './entitlement-access.guard';
import { EntitlementController } from './entitlement.controller';
import { IS_PUBLIC_ROUTE } from './public.decorator';
import type { CurrentUser } from './user-context.service';

function currentUser(accessStatus: 'active' | 'suspended'): CurrentUser {
  return {
    userId: 1n,
    plan: accessStatus === 'active' ? 'pro' : 'free',
    entitlementSource: 'marketplace',
    accessStatus,
    entitlementRevision: 5,
  };
}

function context(user?: CurrentUser): ExecutionContext {
  return {
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
    switchToHttp: () => ({ getRequest: () => ({ currentUser: user }) }),
  } as unknown as ExecutionContext;
}

function guard(options: { publicRoute?: boolean; allowSuspended?: boolean } = {}) {
  const reflector = {
    getAllAndOverride: vi.fn((key: unknown) => {
      if (key === IS_PUBLIC_ROUTE) return options.publicRoute ?? false;
      if (key === ALLOW_SUSPENDED_ACCESS) return options.allowSuspended ?? false;
      return undefined;
    }),
  } as unknown as Reflector;
  return new EntitlementAccessGuard(reflector);
}

describe('EntitlementAccessGuard', () => {
  it('allows active access and rejects suspended access with a stable code', () => {
    expect(guard().canActivate(context(currentUser('active')))).toBe(true);
    try {
      guard().canActivate(context(currentUser('suspended')));
      throw new Error('expected suspended access to be rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(ForbiddenException);
      expect((error as ForbiddenException).getResponse()).toMatchObject({
        code: 'ENTITLEMENT_SUSPENDED',
      });
    }
  });

  it('allows explicit suspended routes but still requires an authenticated current user', () => {
    expect(guard({ allowSuspended: true }).canActivate(context(currentUser('suspended')))).toBe(
      true,
    );
    expect(() => guard({ allowSuspended: true }).canActivate(context())).toThrow(
      UnauthorizedException,
    );
  });

  it('leaves public routes untouched even without a current user', () => {
    expect(guard({ publicRoute: true }).canActivate(context())).toBe(true);
  });

  it('fails closed for an incomplete current-user context', () => {
    expect(() =>
      guard().canActivate(context({ userId: 1n, plan: 'free' } as unknown as CurrentUser)),
    ).toThrow(UnauthorizedException);
    expect(() =>
      guard().canActivate(
        context({
          ...currentUser('active'),
          entitlementRevision: 0,
        }),
      ),
    ).toThrow(UnauthorizedException);
  });
});

describe('suspended route allowlist', () => {
  const reflector = new Reflector();

  it('marks only the requested account-recovery operations', () => {
    expect(
      reflector.get(ALLOW_SUSPENDED_ACCESS, EntitlementController.prototype.getEntitlements),
    ).toBe(true);
    expect(reflector.get(ALLOW_SUSPENDED_ACCESS, ShopController.prototype.list)).toBe(true);
    expect(reflector.get(ALLOW_SUSPENDED_ACCESS, ShopController.prototype.disconnect)).toBe(true);
    expect(reflector.get(ALLOW_SUSPENDED_ACCESS, SettingsController.prototype.getKey)).toBe(true);
    expect(reflector.get(ALLOW_SUSPENDED_ACCESS, SettingsController.prototype.removeKey)).toBe(
      true,
    );
    expect(reflector.get(ALLOW_SUSPENDED_ACCESS, AuditController.prototype.list)).toBe(true);

    expect(reflector.get(ALLOW_SUSPENDED_ACCESS, ShopController.prototype.authorizeDouyin)).toBe(
      undefined,
    );
    expect(reflector.get(ALLOW_SUSPENDED_ACCESS, ShopController.prototype.readinessDouyin)).toBe(
      undefined,
    );
    expect(
      reflector.get(ALLOW_SUSPENDED_ACCESS, ShopController.prototype.readinessAlibaba1688),
    ).toBe(undefined);
    expect(reflector.get(ALLOW_SUSPENDED_ACCESS, SettingsController.prototype.saveKey)).toBe(
      undefined,
    );
  });
});
