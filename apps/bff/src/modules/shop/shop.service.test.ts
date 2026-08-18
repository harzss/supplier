import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import { CryptoService } from '../../common/crypto.module';
import type { PrismaService } from '../../common/prisma.module';
import type { EntitlementService } from '../entitlement/entitlement.service';
import type { EntitlementAccessService } from '../entitlement/entitlement-access.service';
import type { AlertService } from '../observability/alert.service';
import { ShopService } from './shop.service';

function makeService(existing: Record<string, unknown> | null = null, authMode = 'demo') {
  const captured: { create?: Record<string, unknown>; update?: Record<string, unknown> } = {};
  const createdAt = new Date('2026-07-16T00:00:00.000Z');
  const database = {
    user: { findUnique: vi.fn().mockResolvedValue({ plan: 'pro' }) },
    shop: {
      findUnique: vi.fn().mockResolvedValue(existing),
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn(),
      count: vi.fn().mockResolvedValue(1),
      updateMany: vi.fn(),
      upsert: vi.fn().mockImplementation(async ({ create, update }) => {
        captured.create = create;
        captured.update = update;
        return {
          id: 9n,
          userId: 42n,
          platform: 'douyin',
          platformShopId: '4463798',
          shopName: '测试店铺',
          role: create.role,
          accessTokenEnc: create.accessTokenEnc,
          refreshTokenEnc: create.refreshTokenEnc,
          tokenExpireAt: create.tokenExpireAt,
          status: 'active',
          createdAt,
        };
      }),
    },
  };
  const transaction = vi
    .fn()
    .mockImplementation(async (callback: (tx: typeof database) => Promise<unknown>) =>
      callback(database),
    );
  const prisma = { ...database, $transaction: transaction } as unknown as PrismaService;
  const entitlement = {
    assertWithinQuota: vi.fn(),
  } as unknown as EntitlementService;
  const crypto = new CryptoService({ get: () => 'unit-test-key' } as unknown as ConfigService);
  const alerts = { resolve: vi.fn() } as unknown as AlertService;
  const access = { assertActive: vi.fn().mockResolvedValue({ revision: 1 }) };
  const config = { get: (key: string) => (key === 'AUTH_MODE' ? authMode : undefined) };
  return {
    service: new ShopService(
      prisma,
      entitlement,
      crypto,
      alerts,
      access as unknown as EntitlementAccessService,
      config as unknown as ConfigService,
    ),
    prisma,
    entitlement,
    alerts,
    access,
    database,
    captured,
    transaction,
  };
}

describe('ShopService.saveAuthorized', () => {
  it('retries a Serializable authorization transaction after P2034', async () => {
    const conflict = Object.assign(new Error('transaction conflict'), { code: 'P2034' });
    const { service, transaction } = makeService();
    transaction.mockRejectedValueOnce(conflict);

    await expect(
      service.saveAuthorized(
        42n,
        'douyin',
        {
          accessToken: 'plain-access-token',
          platformShopId: '4463798',
          shopName: '测试店铺',
        },
        1,
      ),
    ).resolves.toMatchObject({ id: '9', role: 'seller' });

    expect(transaction).toHaveBeenCalledTimes(2);
    expect(transaction).toHaveBeenNthCalledWith(1, expect.any(Function), {
      isolationLevel: 'Serializable',
    });
    expect(transaction).toHaveBeenNthCalledWith(2, expect.any(Function), {
      isolationLevel: 'Serializable',
    });
  });

  it('rechecks entitlement inside a Serializable retry before persisting OAuth tokens', async () => {
    const conflict = Object.assign(new Error('transaction conflict'), { code: 'P2034' });
    const state = makeService();
    state.transaction.mockImplementationOnce(async (callback) => {
      await callback(state.database);
      throw conflict;
    });
    state.access.assertActive
      .mockResolvedValueOnce({ revision: 1 })
      .mockRejectedValueOnce(Object.assign(new Error('suspended'), { status: 403 }));

    await expect(
      state.service.saveAuthorized(
        42n,
        'douyin',
        {
          accessToken: 'plain-access-token',
          refreshToken: 'plain-refresh-token',
          platformShopId: '4463798',
        },
        1,
      ),
    ).rejects.toMatchObject({ status: 403 });

    expect(state.transaction).toHaveBeenCalledTimes(2);
    expect(state.access.assertActive).toHaveBeenNthCalledWith(1, 42n, 1, state.database);
    expect(state.access.assertActive).toHaveBeenNthCalledWith(2, 42n, 1, state.database);
    expect(state.database.shop.upsert).toHaveBeenCalledTimes(1);
    expect(state.alerts.resolve).not.toHaveBeenCalled();
  });

  it('encrypts tokens before creating an authorized shop', async () => {
    const { service, entitlement, alerts, captured, access, database } = makeService();

    const view = await service.saveAuthorized(
      42n,
      'douyin',
      {
        accessToken: 'plain-access-token',
        refreshToken: 'plain-refresh-token',
        expiresAt: new Date('2026-07-16T02:00:00.000Z'),
        platformShopId: '4463798',
        shopName: '测试店铺',
      },
      1,
    );

    expect(entitlement.assertWithinQuota).toHaveBeenCalledWith('pro', 'shops.max', 2);
    expect(access.assertActive).toHaveBeenCalledWith(42n, 1, database);
    expect(captured.create?.accessTokenEnc).not.toBe('plain-access-token');
    expect(captured.create?.refreshTokenEnc).not.toBe('plain-refresh-token');
    const storedValues = Object.values(captured.create ?? {})
      .map(String)
      .join('|');
    expect(storedValues).not.toContain('plain-access-token');
    expect(storedValues).not.toContain('plain-refresh-token');
    expect(view).toMatchObject({
      id: '9',
      connectionType: 'oauth',
      status: 'active',
      tokenExpiresAt: '2026-07-16T02:00:00.000Z',
    });
    expect(alerts.resolve).toHaveBeenCalledWith('credential.shop.9', {
      status: 'credential_replaced',
    });
  });

  it('updates an existing authorization without consuming another shop quota', async () => {
    const { service, entitlement } = makeService({
      id: 9n,
      role: 'seller',
      refreshTokenEnc: 'existing-refresh-token-enc',
      status: 'active',
    });

    await service.saveAuthorized(
      42n,
      'douyin',
      {
        accessToken: 'new-access-token',
        expiresAt: new Date('2026-07-16T02:00:00.000Z'),
        platformShopId: '4463798',
        shopName: '测试店铺',
      },
      1,
    );

    expect(entitlement.assertWithinQuota).not.toHaveBeenCalled();
  });

  it('rechecks quota before reactivating a revoked authorization', async () => {
    const { service, entitlement } = makeService({
      id: 9n,
      role: 'seller',
      refreshTokenEnc: null,
      status: 'revoked',
    });

    await service.saveAuthorized(
      42n,
      'douyin',
      {
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh-token',
        expiresAt: new Date('2026-07-16T02:00:00.000Z'),
        platformShopId: '4463798',
        shopName: '测试店铺',
      },
      1,
    );

    expect(entitlement.assertWithinQuota).toHaveBeenCalledWith('pro', 'shops.max', 2);
  });

  it('persists a 1688 authorization as a buyer account without consuming seller quota', async () => {
    const { service, prisma, entitlement, captured } = makeService();

    const view = await service.saveAuthorized(
      42n,
      'alibaba_1688',
      {
        accessToken: '1688-access-token',
        refreshToken: '1688-refresh-token',
        expiresAt: new Date('2026-07-16T10:00:00.000Z'),
        platformShopId: 'member-1688',
        shopName: 'buyer-login',
      },
      1,
      'buyer',
    );

    expect(captured.create?.role).toBe('buyer');
    expect(view.role).toBe('buyer');
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(prisma.shop.count).not.toHaveBeenCalled();
    expect(entitlement.assertWithinQuota).not.toHaveBeenCalled();
  });

  it('rejects a different buyer while another buyer is active', async () => {
    const { service, prisma, entitlement } = makeService();
    vi.mocked(prisma.shop.findFirst).mockResolvedValue({ id: 8n } as never);

    await expect(
      service.saveAuthorized(
        42n,
        'alibaba_1688',
        {
          accessToken: 'second-buyer-access-token',
          platformShopId: 'member-1688-new',
          shopName: 'new-buyer-login',
        },
        1,
        'buyer',
      ),
    ).rejects.toMatchObject({
      status: 409,
      response: {
        code: 'ACTIVE_BUYER_EXISTS',
        message: '当前工作区已有启用中的采购账号，请先停用旧账号后再授权新账号',
      },
    });

    expect(prisma.shop.upsert).not.toHaveBeenCalled();
    expect(prisma.shop.count).not.toHaveBeenCalled();
    expect(entitlement.assertWithinQuota).not.toHaveBeenCalled();
  });

  it('allows reauthorization of the same active buyer', async () => {
    const { service, prisma, entitlement, captured } = makeService({
      id: 9n,
      role: 'buyer',
      refreshTokenEnc: 'existing-refresh-token-enc',
      status: 'active',
    });
    vi.mocked(prisma.shop.findFirst).mockResolvedValue(null);

    await expect(
      service.saveAuthorized(
        42n,
        'alibaba_1688',
        {
          accessToken: 'renewed-buyer-access-token',
          platformShopId: 'member-1688',
          shopName: 'buyer-login',
        },
        1,
        'buyer',
      ),
    ).resolves.toMatchObject({ role: 'buyer', status: 'active' });

    expect(prisma.shop.findFirst).toHaveBeenCalledWith({
      where: {
        userId: 42n,
        role: 'buyer',
        status: 'active',
        id: { not: 9n },
      },
      select: { id: true },
    });
    expect(captured.update?.refreshTokenEnc).toBe('existing-refresh-token-enc');
    expect(prisma.shop.count).not.toHaveBeenCalled();
    expect(entitlement.assertWithinQuota).not.toHaveBeenCalled();
  });

  it('checks seller quota when an active buyer authorization becomes a seller', async () => {
    const { service, entitlement } = makeService({
      id: 9n,
      role: 'buyer',
      refreshTokenEnc: 'existing-refresh-token-enc',
      status: 'active',
    });

    await service.saveAuthorized(
      42n,
      'douyin',
      {
        accessToken: 'new-access-token',
        platformShopId: '4463798',
        shopName: '测试店铺',
      },
      1,
      'seller',
    );

    expect(entitlement.assertWithinQuota).toHaveBeenCalledWith('pro', 'shops.max', 2);
  });
});

describe('ShopService lifecycle', () => {
  it('hides legacy demo shops and excludes them from quota in supabase auth mode', async () => {
    const { service, prisma } = makeService(null, 'supabase');

    await service.list(42n);
    await service.saveAuthorized(
      42n,
      'douyin',
      {
        accessToken: 'new-access-token',
        platformShopId: '4463798',
      },
      1,
    );

    expect(prisma.shop.findMany).toHaveBeenCalledWith({
      where: {
        userId: 42n,
        NOT: { platformShopId: { startsWith: 'demo-' } },
      },
      orderBy: { createdAt: 'desc' },
    });
    expect(prisma.shop.count).toHaveBeenCalledWith({
      where: {
        userId: 42n,
        role: 'seller',
        status: 'active',
        NOT: { platformShopId: { startsWith: 'demo-' } },
      },
    });
  });

  it('rejects demo shops outside demo auth mode', async () => {
    const { service, prisma } = makeService(null, 'supabase');

    await expect(service.connectDemo(42n, 'pro', 'douyin')).rejects.toThrow(
      '当前环境不支持创建演示店铺',
    );
    expect(prisma.shop.count).not.toHaveBeenCalled();
  });

  it('disconnects only the current tenant shop and clears local credentials', async () => {
    const createdAt = new Date('2026-07-16T00:00:00.000Z');
    const shop = {
      id: 9n,
      userId: 42n,
      platform: 'douyin' as const,
      platformShopId: '4463798',
      shopName: '测试店铺',
      role: 'seller' as const,
      accessTokenEnc: 'access-ciphertext',
      refreshTokenEnc: 'refresh-ciphertext',
      tokenExpireAt: new Date('2026-07-16T02:00:00.000Z'),
      status: 'active' as 'active' | 'expired' | 'revoked',
      lastOrderSyncAt: null,
      orderSyncAttemptAt: null,
      orderSyncError: 'old error',
      createdAt,
    };
    const { service, prisma, alerts } = makeService();
    vi.mocked(prisma.shop.updateMany).mockImplementation(async ({ data }) => {
      Object.assign(shop, data);
      return { count: 1 };
    });
    vi.mocked(prisma.shop.findFirst).mockResolvedValue(shop);

    await expect(service.disconnect(42n, '9')).resolves.toMatchObject({
      id: '9',
      status: 'revoked',
      tokenExpiresAt: null,
      orderSyncError: null,
    });
    expect(prisma.shop.updateMany).toHaveBeenCalledWith({
      where: { id: 9n, userId: 42n },
      data: {
        accessTokenEnc: null,
        refreshTokenEnc: null,
        tokenExpireAt: null,
        status: 'revoked',
        orderSyncError: null,
      },
    });
    expect(alerts.resolve).toHaveBeenCalledWith('credential.shop.9', {
      status: 'credential_removed',
    });
    await expect(service.disconnect(42n, '9')).resolves.toMatchObject({
      id: '9',
      status: 'revoked',
      tokenExpiresAt: null,
    });
    expect(prisma.shop.updateMany).toHaveBeenCalledTimes(2);
  });

  it('rejects invalid shop IDs before querying the database', async () => {
    const { service, prisma } = makeService();

    await expect(service.disconnect(42n, '0')).rejects.toThrow('店铺 ID 无效');
    expect(prisma.shop.updateMany).not.toHaveBeenCalled();
  });

  it('does not disclose whether another tenant owns the shop', async () => {
    const { service, prisma } = makeService();
    vi.mocked(prisma.shop.updateMany).mockResolvedValue({ count: 0 });

    await expect(service.disconnect(42n, '9')).rejects.toThrow('店铺不存在');
    expect(prisma.shop.findFirst).not.toHaveBeenCalled();
  });
});
