import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../common/prisma.module';
import type { AuthTokenService } from './auth-token.service';
import { UserContextService } from './user-context.service';

const SUBJECT = '9d278917-3e63-4f42-9b7f-981cabf48eb1';

function fixture(
  options: {
    mode?: 'demo' | 'supabase';
    status?: 'active' | 'disabled';
    accessStatus?: 'active' | 'suspended';
  } = {},
) {
  const upsert = vi.fn().mockResolvedValue({
    id: 42n,
    plan: 'pro',
    status: options.status ?? 'active',
    entitlementSource: 'marketplace',
    entitlementAccessStatus: options.accessStatus ?? 'active',
    entitlementRevision: 7,
  });
  const prisma = {
    user: { upsert, findUnique: vi.fn().mockResolvedValue(null) },
  } as unknown as PrismaService;
  const tokens = {
    verify: vi.fn().mockResolvedValue({ subject: SUBJECT }),
  } as unknown as AuthTokenService;
  const config = {
    get: (key: string) => (key === 'AUTH_MODE' ? (options.mode ?? 'supabase') : undefined),
  } as unknown as ConfigService;
  return { service: new UserContextService(prisma, tokens, config), upsert };
}

describe('UserContextService', () => {
  it('maps a verified Supabase subject to one internal user', async () => {
    const { service, upsert } = fixture();
    await expect(service.authenticate('access-token')).resolves.toEqual({
      userId: 42n,
      plan: 'pro',
      entitlementSource: 'marketplace',
      accessStatus: 'active',
      entitlementRevision: 7,
    });
    expect(upsert).toHaveBeenCalledWith({
      where: { authSubject: SUBJECT },
      create: { authSubject: SUBJECT },
      update: {},
      select: {
        id: true,
        plan: true,
        status: true,
        entitlementSource: true,
        entitlementAccessStatus: true,
        entitlementRevision: true,
      },
    });
  });

  it('authenticates a suspended account but forces its request plan to free', async () => {
    await expect(
      fixture({ accessStatus: 'suspended' }).service.authenticate('access-token'),
    ).resolves.toEqual({
      userId: 42n,
      plan: 'free',
      entitlementSource: 'marketplace',
      accessStatus: 'suspended',
      entitlementRevision: 7,
    });
  });

  it('rejects disabled users after token verification', async () => {
    await expect(
      fixture({ status: 'disabled' }).service.authenticate('access-token'),
    ).rejects.toMatchObject({
      status: 403,
    });
  });

  it('keeps plan preview confined to explicit demo mode', async () => {
    const { service } = fixture({ mode: 'demo' });
    await expect(service.loadDemo(undefined, 'flagship')).resolves.toEqual({
      userId: 1n,
      plan: 'flagship',
      entitlementSource: 'internal_beta',
      accessStatus: 'active',
      entitlementRevision: 1,
    });
  });
});
