import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@supplier/db';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../../common/redis.module';
import { PrismaService } from '../../common/prisma.module';
import { OAuthConfigService } from './oauth-config.service';

export interface DouyinReadinessCheck {
  id:
    | 'app_credentials'
    | 'oauth_security'
    | 'customer_mobile'
    | 'order_sync'
    | 'authorized_shop'
    | 'publish_candidate';
  label: string;
  ready: boolean;
  detail: string;
}

export interface DouyinReadinessView {
  ready: boolean;
  readyCount: number;
  totalCount: number;
  checks: DouyinReadinessCheck[];
}

@Injectable()
export class DouyinReadinessService {
  constructor(
    private readonly config: ConfigService,
    private readonly oauthConfig: OAuthConfigService,
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async get(userId: bigint): Promise<DouyinReadinessView> {
    const checks = this.configChecks();
    const [shop, confirmedMapping, products] = await Promise.all([
      this.prisma.shop.findFirst({
        where: {
          userId,
          platform: 'douyin',
          NOT: { platformShopId: { startsWith: 'demo-' } },
        },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          shopName: true,
          status: true,
          accessTokenEnc: true,
          refreshTokenEnc: true,
          tokenExpireAt: true,
        },
      }),
      this.prisma.productCategoryMapping.findFirst({
        where: {
          userId,
          platform: 'douyin',
          sourceProduct: { mainImage: { not: null } },
        },
        orderBy: { confirmedAt: 'desc' },
        select: {
          categoryId: true,
          categoryName: true,
          sourceProduct: { select: { productId1688: true, title: true } },
        },
      }),
      this.prisma.sourceProduct.findMany({
        where: { mainImage: { not: null } },
        orderBy: { syncedAt: 'desc' },
        take: 100,
        select: { productId1688: true, title: true, attributes: true },
      }),
    ]);

    const shopReady =
      !!shop && shop.status === 'active' && !!shop.accessTokenEnc && !!shop.refreshTokenEnc;
    checks.push({
      id: 'authorized_shop',
      label: '真实授权店铺',
      ready: shopReady,
      detail: shopReady
        ? `${shop.shopName ?? `店铺 ${shop.id}`}，Token 到期 ${shop.tokenExpireAt?.toISOString() ?? '未知'}`
        : shop
          ? `当前状态：${shop.status}，请重新授权`
          : '尚未完成抖店官方授权',
    });

    const legacyCandidate = products.find((product) => hasDouyinCategory(product.attributes));
    const candidate = confirmedMapping?.sourceProduct ?? legacyCandidate;
    checks.push({
      id: 'publish_candidate',
      label: '可发布测试商品',
      ready: !!candidate,
      detail: candidate
        ? `${candidate.productId1688} · ${candidate.title}${
            confirmedMapping
              ? ` · 类目 ${confirmedMapping.categoryName ?? confirmedMapping.categoryId}`
              : ' · 使用旧 attributes 映射'
          }`
        : '货源需有主图，并在商品详情页确认抖店叶子类目 ID',
    });

    const readyCount = checks.filter((check) => check.ready).length;
    return {
      ready: readyCount === checks.length,
      readyCount,
      totalCount: checks.length,
      checks,
    };
  }

  private configChecks(): DouyinReadinessCheck[] {
    const credentials = ['DOUYIN_APP_KEY', 'DOUYIN_APP_SECRET', 'DOUYIN_SERVICE_ID'];
    const missingCredentials = credentials.filter((key) => !this.hasValue(key));
    const callbackUri = this.value('DOUYIN_OAUTH_REDIRECT_URI');
    const callbackReady =
      !!callbackUri && safeCheck(() => this.oauthConfig.assertAllowedCallback(callbackUri));
    const resultRedirectReady = safeCheck(() => this.oauthConfig.buildResultRedirect({}));
    const encryptionReady = this.hasValue('ENCRYPTION_KEY');
    const redisReady = this.redis.status === 'ready';
    const securityMissing = [
      ...(callbackReady ? [] : ['OAuth 回调白名单']),
      ...(resultRedirectReady ? [] : ['Web 返回地址']),
      ...(encryptionReady ? [] : ['ENCRYPTION_KEY']),
      ...(redisReady ? [] : ['Redis state 存储']),
    ];

    return [
      {
        id: 'app_credentials',
        label: '抖店应用凭证',
        ready: missingCredentials.length === 0,
        detail:
          missingCredentials.length === 0
            ? 'AppKey、AppSecret、Service ID 已配置'
            : `缺少 ${missingCredentials.join('、')}`,
      },
      {
        id: 'oauth_security',
        label: 'OAuth 安全配置',
        ready: securityMissing.length === 0,
        detail:
          securityMissing.length === 0
            ? '回调、返回地址和加密密钥已配置'
            : `缺少或无效：${securityMissing.join('、')}`,
      },
      {
        id: 'customer_mobile',
        label: '商品客服电话',
        ready: this.hasValue('DOUYIN_CUSTOMER_MOBILE'),
        detail: this.hasValue('DOUYIN_CUSTOMER_MOBILE')
          ? '发布商品必填号码已配置'
          : '缺少 DOUYIN_CUSTOMER_MOBILE',
      },
      {
        id: 'order_sync',
        label: '后台订单同步',
        ready: this.value('DOUYIN_ORDER_SYNC_ENABLED') === 'true',
        detail:
          this.value('DOUYIN_ORDER_SYNC_ENABLED') === 'true'
            ? '持久同步水位与后台增量 worker 已启用'
            : '真实联调前保持关闭；上线验收时配置 DOUYIN_ORDER_SYNC_ENABLED=true',
      },
    ];
  }

  private hasValue(key: string): boolean {
    return !!this.value(key);
  }

  private value(key: string): string {
    return this.config.get<string>(key)?.trim() ?? '';
  }
}

function safeCheck(check: () => unknown): boolean {
  try {
    check();
    return true;
  } catch {
    return false;
  }
}

function hasDouyinCategory(value: Prisma.JsonValue): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, Prisma.JsonValue>;
  const direct = record.douyinCategoryId;
  if (positiveInteger(direct)) return true;
  const platformCategoryIds = record.platformCategoryIds;
  if (
    !platformCategoryIds ||
    typeof platformCategoryIds !== 'object' ||
    Array.isArray(platformCategoryIds)
  ) {
    return false;
  }
  return positiveInteger((platformCategoryIds as Record<string, Prisma.JsonValue>).douyin);
}

function positiveInteger(value: Prisma.JsonValue | undefined): boolean {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0;
}
