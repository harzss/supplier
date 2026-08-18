import { SetMetadata } from '@nestjs/common';

export const ALLOW_SUSPENDED_ACCESS = Symbol('allow-suspended-access');

/** Explicitly allows an authenticated suspended account to use this route. */
export const AllowSuspendedAccess = () => SetMetadata(ALLOW_SUSPENDED_ACCESS, true);
