import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MockAdapter, OpenApi1688Adapter, type SourceAdapter } from '@supplier/crawler';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../../common/redis.module';
import { OAuthConfigService } from '../shop/oauth-config.service';
import { ShopTokenService } from '../shop/shop-token.service';
import { PrismaService } from '../../common/prisma.module';

const GLOBAL_OFFER_SCOPE = 'global_offer';
const GLOBAL_RATE_KEY = 'source-import:rate:alibaba-1688:global-offer';
const GLOBAL_RATE_LIMIT_PER_SECOND = 5;

export interface SourceImportAdapterContext {
  adapter: SourceAdapter;
  demo: boolean;
}

@Injectable()
export class SourceImportAdapterFactory {
  private readonly demoMode: boolean;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly oauthConfig: OAuthConfigService,
    private readonly shopTokens: ShopTokenService,
  ) {
    this.demoMode = (config.get<string>('AUTH_MODE') ?? 'demo') === 'demo';
  }

  async resolveBuyerShop(userId: bigint, requestedShopId?: string): Promise<bigint | null> {
    if (this.demoMode) {
      if (requestedShopId) {
        throw new BadRequestException('演示环境不接受真实 1688 买家账号');
      }
      return null;
    }
    this.assertGlobalOfferScope();
    const requestedId = requestedShopId
      ? parsePositiveInt64(requestedShopId, '1688 买家账号 ID')
      : undefined;
    const buyer = await this.prisma.shop.findFirst({
      where: {
        ...(requestedId ? { id: requestedId } : {}),
        userId,
        platform: 'alibaba_1688',
        role: 'buyer',
        status: 'active',
        accessTokenEnc: { not: null },
        refreshTokenEnc: { not: null },
        NOT: { platformShopId: { startsWith: 'demo-' } },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (!buyer) {
      if (requestedId) throw new NotFoundException('1688 买家账号不存在或不属于当前用户');
      throw new ServiceUnavailableException('尚未授权可用的 1688 买家账号');
    }
    return buyer.id;
  }

  async create(userId: bigint, buyerShopId: bigint | null): Promise<SourceImportAdapterContext> {
    if (this.demoMode) {
      if (buyerShopId !== null) throw new BadRequestException('演示采集任务买家账号无效');
      return { adapter: new MockAdapter({ latencyMs: 0, failureRate: 0 }), demo: true };
    }
    this.assertGlobalOfferScope();
    if (buyerShopId === null) throw new ServiceUnavailableException('采集任务缺少 1688 买家账号');
    const buyer = await this.prisma.shop.findFirst({
      where: {
        id: buyerShopId,
        userId,
        platform: 'alibaba_1688',
        role: 'buyer',
        status: 'active',
        accessTokenEnc: { not: null },
        refreshTokenEnc: { not: null },
        NOT: { platformShopId: { startsWith: 'demo-' } },
      },
      select: { id: true },
    });
    if (!buyer) throw new ServiceUnavailableException('1688 买家授权已失效，请重新授权');

    const token = await this.shopTokens.getAccessToken(buyer.id, userId);
    const platform = this.oauthConfig.getPlatformConfig('alibaba_1688');
    return {
      adapter: new OpenApi1688Adapter({
        appKey: platform.appKey,
        appSecret: platform.appSecret,
        accessToken: token,
      }),
      demo: false,
    };
  }

  private assertGlobalOfferScope(): void {
    // SourceProduct is intentionally a global offer cache. Enabling real collection is safe only
    // after the operator has verified that detail, price and inventory are invariant across buyer
    // accounts. Account-scoped data requires a separate snapshot model instead of this flag.
    if (this.config.get<string>('ALIBABA_1688_SOURCE_DATA_SCOPE') !== GLOBAL_OFFER_SCOPE) {
      throw new ServiceUnavailableException(
        '真实 1688 采集尚未启用：需先验证跨买家货源数据一致性并配置 ALIBABA_1688_SOURCE_DATA_SCOPE=global_offer',
      );
    }
  }
}

@Injectable()
export class SourceImportRateLimiter {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async take(demo: boolean): Promise<void> {
    if (demo) return;
    for (let attempt = 0; attempt < 10; attempt++) {
      let waitMs: unknown;
      try {
        waitMs = await this.redis.eval(
          `local current = redis.call('incr', KEYS[1])
           if current == 1 then redis.call('pexpire', KEYS[1], ARGV[2]) end
           if current <= tonumber(ARGV[1]) then return 0 end
           return redis.call('pttl', KEYS[1])`,
          1,
          GLOBAL_RATE_KEY,
          String(GLOBAL_RATE_LIMIT_PER_SECOND),
          '1000',
        );
      } catch {
        throw new ServiceUnavailableException('1688 采集依赖共享限流器，不可用时拒绝执行');
      }
      const delay = typeof waitMs === 'number' ? waitMs : Number(waitMs);
      if (!Number.isFinite(delay) || delay < 0) {
        throw new ServiceUnavailableException('1688 采集共享限流器状态异常，已拒绝执行');
      }
      if (delay === 0) return;
      await sleep(Math.min(Math.max(delay, 10), 1_000));
    }
    throw new ServiceUnavailableException('1688 采集共享配额繁忙，请稍后重试');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePositiveInt64(value: string, label: string): bigint {
  if (!/^[1-9]\d{0,18}$/.test(value)) throw new BadRequestException(`${label}无效`);
  const parsed = BigInt(value);
  if (parsed > 9_223_372_036_854_775_807n) {
    throw new BadRequestException(`${label}无效`);
  }
  return parsed;
}
