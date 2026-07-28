import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Platform, Shop, ShopRole } from '@supplier/db';
import type { TokenSet, UserPlan } from '@supplier/shared-types';
import { CryptoService } from '../../common/crypto.module';
import { PrismaService } from '../../common/prisma.module';
import { EntitlementService } from '../entitlement/entitlement.service';
import { AlertService } from '../observability/alert.service';
import { runtimeShopWhere } from './platform-adapter.factory';

export interface ShopView {
  id: string;
  platform: string;
  platformLabel: string;
  platformShopId: string;
  shopName: string | null;
  role: ShopRole;
  connectionType: 'demo' | 'oauth';
  status: string;
  tokenExpiresAt: string | null;
  lastOrderSyncAt: string | null;
  orderSyncAttemptAt: string | null;
  orderSyncError: string | null;
  createdAt: string;
}

const PLATFORM_LABELS: Record<string, string> = {
  douyin: '抖音小店',
  taobao: '淘宝',
  tmall: '天猫',
  pdd: '拼多多',
  kuaishou: '快手小店',
  wechat_shop: '视频号小店',
  alibaba_1688: '1688',
};

@Injectable()
export class ShopService {
  private readonly demoMode: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlement: EntitlementService,
    private readonly crypto: CryptoService,
    private readonly alerts: AlertService,
    config: ConfigService,
  ) {
    this.demoMode = (config.get<string>('AUTH_MODE') ?? 'demo') === 'demo';
  }

  async list(userId: bigint): Promise<ShopView[]> {
    const shops = await this.prisma.shop.findMany({
      where: { userId, ...runtimeShopWhere(this.demoMode) },
      orderBy: { createdAt: 'desc' },
    });
    return shops.map(toView);
  }

  /**
   * 连接演示店铺（无真实 OAuth 时用于跑通铺货）。
   * 受套餐 shops.max 限制；真实接入时改为走平台 OAuth 回调建店。
   */
  async connectDemo(
    userId: bigint,
    plan: UserPlan,
    platform: Platform,
    shopName?: string,
  ): Promise<ShopView> {
    if (!this.demoMode) throw new ForbiddenException('当前环境不支持创建演示店铺');
    const active = await this.countActive(userId);
    this.entitlement.assertWithinQuota(plan, 'shops.max', active + 1);

    const platformShopId = `demo-${platform}-${Math.random().toString(36).slice(2, 8)}`;
    const shop = await this.prisma.shop.create({
      data: {
        userId,
        platform,
        platformShopId,
        shopName: shopName || `${PLATFORM_LABELS[platform] ?? platform}演示店`,
        role: 'seller',
        status: 'active',
      },
    });
    return toView(shop);
  }

  /** OAuth 成功后创建或更新真实店铺；Token 只以密文进入数据库。 */
  async saveAuthorized(
    userId: bigint,
    platform: Platform,
    tokenSet: TokenSet,
    role: ShopRole = 'seller',
  ): Promise<ShopView> {
    if (!tokenSet.platformShopId) {
      throw new BadRequestException('平台未返回店铺 ID');
    }
    if (!this.demoMode && tokenSet.platformShopId.startsWith('demo-')) {
      throw new BadRequestException('平台店铺 ID 与系统演示标识冲突');
    }

    const unique = {
      userId,
      platform,
      platformShopId: tokenSet.platformShopId,
    };
    const existing = await this.prisma.shop.findUnique({
      where: { uk_user_platform_shop: unique },
    });

    if (!existing || existing.status !== 'active') {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { plan: true },
      });
      if (!user) throw new NotFoundException('用户不存在');
      const active = await this.countActive(userId);
      this.entitlement.assertWithinQuota(user.plan as UserPlan, 'shops.max', active + 1);
    }

    const accessTokenEnc = this.crypto.encrypt(tokenSet.accessToken);
    const refreshTokenEnc = tokenSet.refreshToken
      ? this.crypto.encrypt(tokenSet.refreshToken)
      : existing?.refreshTokenEnc;
    const shop = await this.prisma.shop.upsert({
      where: { uk_user_platform_shop: unique },
      create: {
        ...unique,
        shopName: tokenSet.shopName,
        role,
        accessTokenEnc,
        refreshTokenEnc,
        tokenExpireAt: tokenSet.expiresAt,
        status: 'active',
      },
      update: {
        shopName: tokenSet.shopName,
        role,
        accessTokenEnc,
        refreshTokenEnc,
        tokenExpireAt: tokenSet.expiresAt,
        status: 'active',
      },
    });
    await this.alerts.resolve(`credential.shop.${shop.id}`, { status: 'credential_replaced' });
    return toView(shop);
  }

  /** 停用当前租户店铺，保留历史业务数据但清除本系统持有的 OAuth 凭证。 */
  async disconnect(userId: bigint, shopIdValue: string): Promise<ShopView> {
    const shopId = positiveShopId(shopIdValue);
    const result = await this.prisma.shop.updateMany({
      where: { id: shopId, userId },
      data: {
        accessTokenEnc: null,
        refreshTokenEnc: null,
        tokenExpireAt: null,
        status: 'revoked',
        orderSyncError: null,
      },
    });
    if (result.count === 0) throw new NotFoundException('店铺不存在');

    const shop = await this.prisma.shop.findFirst({ where: { id: shopId, userId } });
    if (!shop) throw new NotFoundException('店铺不存在');
    await this.alerts.resolve(`credential.shop.${shopId}`, { status: 'credential_removed' });
    return toView(shop);
  }

  private async countActive(userId: bigint): Promise<number> {
    return this.prisma.shop.count({
      where: { userId, status: 'active', ...runtimeShopWhere(this.demoMode) },
    });
  }
}

function positiveShopId(value: string): bigint {
  if (!/^[1-9]\d{0,18}$/.test(value)) throw new BadRequestException('店铺 ID 无效');
  const id = BigInt(value);
  if (id > 9_223_372_036_854_775_807n) throw new BadRequestException('店铺 ID 无效');
  return id;
}

function toView(shop: Shop): ShopView {
  return {
    id: shop.id.toString(),
    platform: shop.platform,
    platformLabel: PLATFORM_LABELS[shop.platform] ?? shop.platform,
    platformShopId: shop.platformShopId,
    shopName: shop.shopName,
    role: shop.role,
    connectionType: shop.platformShopId.startsWith('demo-') ? 'demo' : 'oauth',
    status: shop.status,
    tokenExpiresAt: shop.tokenExpireAt?.toISOString() ?? null,
    lastOrderSyncAt: shop.lastOrderSyncAt?.toISOString() ?? null,
    orderSyncAttemptAt: shop.orderSyncAttemptAt?.toISOString() ?? null,
    orderSyncError: shop.orderSyncError,
    createdAt: shop.createdAt.toISOString(),
  };
}
