import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../../common/redis.module';
import { PrismaService } from '../../common/prisma.module';
import { OAuthConfigService } from './oauth-config.service';

export interface Alibaba1688ReadinessCheck {
  id:
    | 'app_credentials'
    | 'oauth_security'
    | 'authorized_buyer'
    | 'payment_strategy'
    | 'purchase_enabled'
    | 'structured_address'
    | 'sku_binding'
    | 'multi_purchase_orders';
  label: string;
  ready: boolean;
  detail: string;
}

export interface Alibaba1688ReadinessView {
  ready: boolean;
  readyCount: number;
  totalCount: number;
  checks: Alibaba1688ReadinessCheck[];
}

@Injectable()
export class Alibaba1688ReadinessService {
  constructor(
    private readonly config: ConfigService,
    private readonly oauthConfig: OAuthConfigService,
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async get(userId: bigint): Promise<Alibaba1688ReadinessView> {
    const checks = this.configChecks();
    const [buyer, unstructuredOrders, unmappedOrderItems] = await Promise.all([
      this.prisma.shop.findFirst({
        where: {
          userId,
          platform: 'alibaba_1688',
          role: 'buyer',
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
      this.prisma.order.count({
        where: {
          status: 'paid',
          shop: {
            userId,
            role: 'seller',
            NOT: { platformShopId: { startsWith: 'demo-' } },
          },
          OR: [
            { receiverNameEnc: null },
            { receiverPhoneEnc: null },
            { receiverAddressDetailEnc: null },
          ],
        },
      }),
      this.prisma.orderItem.count({
        where: {
          order: {
            status: 'paid',
            shop: {
              userId,
              role: 'seller',
              NOT: { platformShopId: { startsWith: 'demo-' } },
            },
          },
          OR: [
            { sourceOfferId: null },
            { sourceSupplierId: null },
            { sourceSpecRequired: true, sourceSpecId: null },
            { publishedProduct: null },
            { publishedProduct: { sourceProduct: { isOnePieceDrop: false } } },
          ],
        },
      }),
    ]);
    const buyerReady =
      !!buyer && buyer.status === 'active' && !!buyer.accessTokenEnc && !!buyer.refreshTokenEnc;
    checks.push({
      id: 'authorized_buyer',
      label: '1688 买家授权',
      ready: buyerReady,
      detail: buyerReady
        ? `${buyer.shopName ?? `采购账号 ${buyer.id}`}，Token 到期 ${buyer.tokenExpireAt?.toISOString() ?? '未知'}`
        : buyer
          ? `当前状态：${buyer.status}，请重新授权`
          : '尚未完成 1688 官方买家授权',
    });

    checks.push(
      {
        id: 'structured_address',
        label: '结构化收货地址',
        ready: unstructuredOrders === 0,
        detail:
          unstructuredOrders === 0
            ? '新同步订单会加密保存省/市/区/街道/详细地址'
            : `仍有 ${unstructuredOrders} 笔待采购订单缺少结构化收货地址，需重新同步或人工处理`,
      },
      {
        id: 'sku_binding',
        label: '销售 SKU → 1688 规格',
        ready: unmappedOrderItems === 0,
        detail:
          unmappedOrderItems === 0
            ? '发布时写入 1688 specId 作为抖店 outer_sku_id，订单项已持久化 offerId/specId'
            : `仍有 ${unmappedOrderItems} 个待采购订单项缺少供应商、offerId、必需的 specId 或一件代发标记`,
      },
      {
        id: 'multi_purchase_orders',
        label: '多货源采购拆单',
        ready: true,
        detail: '已按 1688 供应商拆分采购单，并持久化包裹与销售子订单数量映射',
      },
    );

    const readyCount = checks.filter((check) => check.ready).length;
    return {
      ready: readyCount === checks.length,
      readyCount,
      totalCount: checks.length,
      checks,
    };
  }

  private configChecks(): Alibaba1688ReadinessCheck[] {
    const credentials = ['ALIBABA_1688_APP_KEY', 'ALIBABA_1688_APP_SECRET'];
    const missingCredentials = credentials.filter((key) => !this.hasValue(key));
    const callbackUri = this.value('ALIBABA_1688_OAUTH_REDIRECT_URI');
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
    const paymentMode = this.value('ALIBABA_1688_PAYMENT_MODE');
    const purchaseEnabled = this.value('ALIBABA_1688_PURCHASE_ENABLED') === 'true';

    return [
      {
        id: 'app_credentials',
        label: '1688 应用凭证',
        ready: missingCredentials.length === 0,
        detail:
          missingCredentials.length === 0
            ? 'AppKey 与 AppSecret 已配置'
            : `缺少 ${missingCredentials.join('、')}`,
      },
      {
        id: 'oauth_security',
        label: 'OAuth 安全配置',
        ready: securityMissing.length === 0,
        detail:
          securityMissing.length === 0
            ? '回调、返回地址、加密密钥和 state 存储已配置'
            : `缺少或无效：${securityMissing.join('、')}`,
      },
      {
        id: 'payment_strategy',
        label: '采购支付策略',
        ready: paymentMode === 'manual',
        detail:
          paymentMode === 'manual'
            ? '首期采用人工确认支付，不启用免密自动扣款'
            : '请显式配置 ALIBABA_1688_PAYMENT_MODE=manual',
      },
      {
        id: 'purchase_enabled',
        label: '真实采购开关',
        ready: purchaseEnabled,
        detail: purchaseEnabled
          ? '已显式启用真实 1688 下单'
          : '待其他准备度全部通过后，再配置 ALIBABA_1688_PURCHASE_ENABLED=true',
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
