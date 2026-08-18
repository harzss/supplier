import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ALLOW_SUSPENDED_ACCESS } from './allow-suspended-access.decorator';
import { IS_PUBLIC_ROUTE } from './public.decorator';
import type { CurrentUser } from './user-context.service';
import { currentUserContextMissing, entitlementSuspended } from './entitlement-access.service';

@Injectable()
export class EntitlementAccessGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_ROUTE, targets)) return true;

    const request = context.switchToHttp().getRequest<{ currentUser?: CurrentUser }>();
    const currentUser = request.currentUser;
    if (
      !currentUser ||
      !currentUser.entitlementSource ||
      !currentUser.accessStatus ||
      !Number.isSafeInteger(currentUser.entitlementRevision) ||
      currentUser.entitlementRevision <= 0
    ) {
      throw currentUserContextMissing();
    }
    if (this.reflector.getAllAndOverride<boolean>(ALLOW_SUSPENDED_ACCESS, targets)) return true;
    if (currentUser.accessStatus !== 'active') throw entitlementSuspended();
    return true;
  }
}
