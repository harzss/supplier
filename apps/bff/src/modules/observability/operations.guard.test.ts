import { type ExecutionContext, UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import { OperationsTokenGuard } from './operations.guard';

function context(authorization?: string): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers: { authorization } }),
    }),
  } as unknown as ExecutionContext;
}

describe('OperationsTokenGuard', () => {
  it('accepts only the exact independent operations bearer token', () => {
    const guard = new OperationsTokenGuard({
      get: () => 'operations-token-that-is-at-least-32-characters',
    } as unknown as ConfigService);

    expect(
      guard.canActivate(context('Bearer operations-token-that-is-at-least-32-characters')),
    ).toBe(true);
    expect(() => guard.canActivate(context('Bearer wrong-token'))).toThrow(UnauthorizedException);
  });
});
