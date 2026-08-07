import { ConflictException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { RuntimeStateService } from '../../common/runtime-state.service';

const PLATFORM_PRODUCT_LOCK_TTL_MS = 60_000;

@Injectable()
export class PlatformProductLockService {
  constructor(private readonly runtimeState: RuntimeStateService) {}

  async acquire(publishedProductId: bigint): Promise<string> {
    let token: string | null;
    try {
      token = await this.runtimeState.acquireLease(
        this.key(publishedProductId),
        PLATFORM_PRODUCT_LOCK_TTL_MS,
      );
    } catch {
      throw new ServiceUnavailableException('商品平台变更协调状态不可用，已拒绝执行');
    }
    if (!token) {
      throw new ConflictException('商品正在执行其他平台变更，请稍后重试');
    }
    return token;
  }

  async renew(publishedProductId: bigint, token: string): Promise<void> {
    let renewed: boolean;
    try {
      renewed = await this.runtimeState.renewLease(
        this.key(publishedProductId),
        token,
        PLATFORM_PRODUCT_LOCK_TTL_MS,
      );
    } catch {
      throw new ServiceUnavailableException('商品平台变更协调状态不可用，已拒绝执行');
    }
    if (!renewed) {
      throw new ConflictException('商品平台变更执行权已失效，请刷新后重试');
    }
  }

  async release(publishedProductId: bigint, token: string): Promise<void> {
    try {
      await this.runtimeState.releaseLease(this.key(publishedProductId), token);
    } catch {
      // TTL guarantees eventual recovery; release failure must not overwrite the operation result.
    }
  }

  private key(publishedProductId: bigint): string {
    return `platform-product:mutation:${publishedProductId}`;
  }
}
