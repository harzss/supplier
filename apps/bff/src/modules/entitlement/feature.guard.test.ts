import { ForbiddenException, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { FeatureGuard } from './feature.guard';
import type { CurrentUser } from './user-context.service';

function context(currentUser?: CurrentUser): ExecutionContext {
  return {
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
    switchToHttp: () => ({ getRequest: () => ({ currentUser }) }),
  } as unknown as ExecutionContext;
}

function guard(feature: string | undefined) {
  const reflector = {
    getAllAndOverride: vi.fn().mockReturnValue(feature),
  } as unknown as Reflector;
  return new FeatureGuard(reflector);
}

describe('FeatureGuard', () => {
  it('allows an active account with the required feature', () => {
    expect(
      guard('analytics.dashboard').canActivate(
        context({
          userId: 1n,
          plan: 'pro',
          entitlementSource: 'marketplace',
          accessStatus: 'active',
          entitlementRevision: 3,
        }),
      ),
    ).toBe(true);
  });

  it('rejects suspended access before evaluating the downgraded plan', () => {
    expect(() =>
      guard('analytics.dashboard').canActivate(
        context({
          userId: 1n,
          plan: 'free',
          entitlementSource: 'marketplace',
          accessStatus: 'suspended',
          entitlementRevision: 4,
        }),
      ),
    ).toThrow(ForbiddenException);
    try {
      guard('analytics.dashboard').canActivate(
        context({
          userId: 1n,
          plan: 'free',
          entitlementSource: 'marketplace',
          accessStatus: 'suspended',
          entitlementRevision: 4,
        }),
      );
    } catch (error) {
      expect((error as ForbiddenException).getResponse()).toMatchObject({
        code: 'ENTITLEMENT_SUSPENDED',
      });
    }
  });

  it('fails closed when a feature route has no current user', () => {
    expect(() => guard('analytics.dashboard').canActivate(context())).toThrow(
      UnauthorizedException,
    );
  });

  it('leaves routes without a feature requirement to the access guard', () => {
    expect(guard(undefined).canActivate(context())).toBe(true);
  });
});
