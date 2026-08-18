import { MODULE_METADATA } from '@nestjs/common/constants';
import { APP_GUARD } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { CurrentUserGuard } from './current-user.guard';
import { EntitlementAccessGuard } from './entitlement-access.guard';
import { EntitlementModule } from './entitlement.module';
import { FeatureGuard } from './feature.guard';

describe('EntitlementModule', () => {
  it('runs identity, access-status and feature guards in fail-closed order', () => {
    const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, EntitlementModule) as Array<{
      provide?: unknown;
      useClass?: unknown;
    }>;
    expect(
      providers
        .filter((provider) => provider.provide === APP_GUARD)
        .map((provider) => provider.useClass),
    ).toEqual([CurrentUserGuard, EntitlementAccessGuard, FeatureGuard]);
  });
});
