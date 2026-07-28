import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@supplier/db';
import {
  DouyinAdapter,
  createMockAdapter,
  type PlatformAdapter,
  type PlatformType,
} from '@supplier/platform-sdk';
import { OAuthConfigService } from './oauth-config.service';

export interface ShopAdapterTarget {
  platform: PlatformType;
  platformShopId: string;
}

@Injectable()
export class PlatformAdapterFactory {
  private readonly demoMode: boolean;

  constructor(
    private readonly oauthConfig: OAuthConfigService,
    config: ConfigService,
  ) {
    this.demoMode = (config.get<string>('AUTH_MODE') ?? 'demo') === 'demo';
  }

  assertAllowed(shop: ShopAdapterTarget): void {
    if (isDemoShop(shop) && !this.demoMode) {
      throw new BadRequestException('当前环境不允许执行演示店铺操作');
    }
  }

  create(shop: ShopAdapterTarget): PlatformAdapter {
    this.assertAllowed(shop);
    if (isDemoShop(shop)) return createMockAdapter(shop.platform);
    if (shop.platform === 'douyin') {
      return new DouyinAdapter(this.oauthConfig.getPlatformConfig('douyin'));
    }
    throw new BadRequestException(`暂不支持真实平台：${shop.platform}`);
  }
}

export function isDemoShop(shop: Pick<ShopAdapterTarget, 'platformShopId'>): boolean {
  return shop.platformShopId.startsWith('demo-');
}

export function runtimeShopWhere(demoMode: boolean): Prisma.ShopWhereInput {
  return demoMode ? {} : { NOT: { platformShopId: { startsWith: 'demo-' } } };
}
