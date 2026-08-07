import {
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Platform, Shop } from '@supplier/db';
import {
  Alibaba1688Adapter,
  DouyinAdapter,
  PlatformTokenRefreshRejectedError,
  type PlatformAdapter,
} from '@supplier/platform-sdk';
import { CryptoService } from '../../common/crypto.module';
import { PrismaService } from '../../common/prisma.module';
import { RuntimeStateService } from '../../common/runtime-state.service';
import { OAuthConfigService } from './oauth-config.service';
import { AlertService } from '../observability/alert.service';

const REFRESH_WINDOW_MS = 5 * 60 * 1000;
const REFRESH_LOCK_TTL_MS = 60_000;
const REFRESH_RECOVERY_TTL_MS = 24 * 60 * 60 * 1000;
const REAUTHORIZE_MESSAGE = '店铺授权已过期，请重新授权';
const REFRESH_RETRY_MESSAGE = '店铺授权刷新暂时失败，请稍后重试';
const REFRESH_RECOVERY_MESSAGE = '店铺授权刷新结果待恢复，请稍后重试';

type TokenShop = Pick<
  Shop,
  | 'id'
  | 'userId'
  | 'platform'
  | 'platformShopId'
  | 'accessTokenEnc'
  | 'refreshTokenEnc'
  | 'tokenExpireAt'
  | 'status'
>;

interface PendingTokenRefresh {
  version: 1;
  userId: string;
  platform: Platform;
  platformShopId: string;
  previousAccessTokenEnc: string | null;
  previousRefreshTokenEnc: string;
  accessTokenEnc: string;
  refreshTokenEnc: string;
  tokenExpireAt: string;
}

@Injectable()
export class ShopTokenService {
  private readonly logger = new Logger('ShopToken');

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly oauthConfig: OAuthConfigService,
    private readonly runtimeState: RuntimeStateService,
    private readonly alerts: AlertService,
  ) {}

  async getAccessToken(shopId: bigint, userId: bigint): Promise<string> {
    const shop = await this.loadShop(shopId, userId);
    this.assertUsable(shop);

    const now = Date.now();
    if (shop.tokenExpireAt && shop.tokenExpireAt.getTime() > now + REFRESH_WINDOW_MS) {
      return this.decryptAccessToken(shop);
    }

    const lock = await this.acquireRefreshLock(shop.id);
    if (!lock) {
      if (shop.tokenExpireAt && shop.tokenExpireAt.getTime() > now) {
        return this.decryptAccessToken(shop);
      }
      throw new ServiceUnavailableException('店铺授权正在刷新，请稍后重试');
    }

    try {
      let latest = await this.loadShop(shopId, userId);
      this.assertUsable(latest);
      latest = await this.recoverPendingRefresh(latest);
      this.assertUsable(latest);
      if (latest.tokenExpireAt && latest.tokenExpireAt.getTime() > Date.now() + REFRESH_WINDOW_MS) {
        return this.decryptAccessToken(latest);
      }
      return await this.refresh(latest);
    } finally {
      await this.releaseRefreshLock(shop.id, lock);
    }
  }

  private async refresh(shop: TokenShop): Promise<string> {
    if (!shop.refreshTokenEnc) {
      await this.markExpired(shop);
      throw new UnauthorizedException(REAUTHORIZE_MESSAGE);
    }

    let refreshToken: string;
    try {
      refreshToken = this.crypto.decrypt(shop.refreshTokenEnc);
    } catch (error) {
      await this.raiseCredentialAlert(shop, 'refresh_token_decrypt', error, 'critical');
      await this.markExpired(shop);
      throw new UnauthorizedException(REAUTHORIZE_MESSAGE);
    }

    let tokenSet: Awaited<ReturnType<PlatformAdapter['refreshToken']>>;
    try {
      const adapter = this.createAdapter(shop.platform);
      tokenSet = await adapter.refreshToken(refreshToken);
    } catch (err) {
      this.logger.warn(`店铺 ${shop.id} Token 刷新失败：${(err as Error).message}`);
      await this.raiseCredentialAlert(shop, 'token_refresh', err, 'warning');
      if (err instanceof PlatformTokenRefreshRejectedError) {
        await this.markExpired(shop);
        throw new UnauthorizedException(REAUTHORIZE_MESSAGE);
      }
      throw new ServiceUnavailableException(REFRESH_RETRY_MESSAGE);
    }
    if (tokenSet.platformShopId && tokenSet.platformShopId !== shop.platformShopId) {
      const error = new Error('platform shop mismatch');
      await this.raiseCredentialAlert(shop, 'token_refresh_identity_mismatch', error, 'critical');
      await this.markExpired(shop);
      throw new UnauthorizedException(REAUTHORIZE_MESSAGE);
    }

    const pending: PendingTokenRefresh = {
      version: 1,
      userId: shop.userId.toString(),
      platform: shop.platform,
      platformShopId: shop.platformShopId,
      previousAccessTokenEnc: shop.accessTokenEnc,
      previousRefreshTokenEnc: shop.refreshTokenEnc,
      accessTokenEnc: this.crypto.encrypt(tokenSet.accessToken),
      refreshTokenEnc: tokenSet.refreshToken
        ? this.crypto.encrypt(tokenSet.refreshToken)
        : shop.refreshTokenEnc,
      tokenExpireAt: tokenSet.expiresAt.toISOString(),
    };
    const recoveryStored = await this.storePendingRefresh(shop, pending);

    let updated: { count: number };
    try {
      updated = await this.persistPendingRefresh(shop, pending);
    } catch (error) {
      this.logger.error(`店铺 ${shop.id} Token 刷新结果保存失败`);
      await this.raiseCredentialAlert(shop, 'token_refresh_persist', error, 'critical');
      if (!recoveryStored && !(await this.storePendingRefresh(shop, pending))) {
        await this.raiseCredentialAlert(shop, 'token_refresh_recovery_store', error, 'critical');
      }
      throw new ServiceUnavailableException(REFRESH_RECOVERY_MESSAGE);
    }
    if (updated.count === 0) {
      await this.clearPendingRefresh(shop.id);
      throw new UnauthorizedException(REAUTHORIZE_MESSAGE);
    }
    await this.clearPendingRefresh(shop.id);
    await this.alerts.resolve(this.alertKey(shop.id), { status: 'refresh_ok' });
    return tokenSet.accessToken;
  }

  private async recoverPendingRefresh(shop: TokenShop): Promise<TokenShop> {
    let raw: string | null;
    try {
      raw = await this.runtimeState.read<string>(this.refreshRecoveryKey(shop.id));
    } catch {
      this.logger.warn(`店铺 ${shop.id} Token 刷新恢复状态不可用`);
      throw new ServiceUnavailableException(REFRESH_RECOVERY_MESSAGE);
    }
    if (!raw) return shop;

    const pending = parsePendingRefresh(raw);
    if (
      !pending ||
      pending.userId !== shop.userId.toString() ||
      pending.platform !== shop.platform ||
      pending.platformShopId !== shop.platformShopId
    ) {
      this.logger.error(`店铺 ${shop.id} Token 刷新恢复记录无效`);
      await this.raiseCredentialAlert(shop, 'token_refresh_recovery_invalid', null, 'critical');
      throw new ServiceUnavailableException(REFRESH_RECOVERY_MESSAGE);
    }

    if (
      shop.accessTokenEnc === pending.accessTokenEnc &&
      shop.refreshTokenEnc === pending.refreshTokenEnc
    ) {
      await this.clearPendingRefresh(shop.id);
      return shop;
    }
    if (
      shop.accessTokenEnc !== pending.previousAccessTokenEnc ||
      shop.refreshTokenEnc !== pending.previousRefreshTokenEnc
    ) {
      await this.clearPendingRefresh(shop.id);
      return shop;
    }

    let updated: { count: number };
    try {
      updated = await this.persistPendingRefresh(shop, pending);
    } catch (error) {
      await this.raiseCredentialAlert(shop, 'token_refresh_recovery_persist', error, 'critical');
      throw new ServiceUnavailableException(REFRESH_RECOVERY_MESSAGE);
    }
    if (updated.count === 0) {
      throw new ServiceUnavailableException(REFRESH_RECOVERY_MESSAGE);
    }
    await this.clearPendingRefresh(shop.id);
    await this.alerts.resolve(this.alertKey(shop.id), { status: 'refresh_recovered' });
    return {
      ...shop,
      accessTokenEnc: pending.accessTokenEnc,
      refreshTokenEnc: pending.refreshTokenEnc,
      tokenExpireAt: new Date(pending.tokenExpireAt),
      status: 'active',
    };
  }

  private async persistPendingRefresh(
    shop: TokenShop,
    pending: PendingTokenRefresh,
  ): Promise<{ count: number }> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.prisma.shop.updateMany({
          where: {
            id: shop.id,
            userId: shop.userId,
            status: 'active',
            accessTokenEnc: pending.previousAccessTokenEnc,
            refreshTokenEnc: pending.previousRefreshTokenEnc,
          },
          data: {
            accessTokenEnc: pending.accessTokenEnc,
            refreshTokenEnc: pending.refreshTokenEnc,
            tokenExpireAt: new Date(pending.tokenExpireAt),
            status: 'active',
          },
        });
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  private async storePendingRefresh(
    shop: TokenShop,
    pending: PendingTokenRefresh,
  ): Promise<boolean> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await this.runtimeState.store(
          this.refreshRecoveryKey(shop.id),
          JSON.stringify(pending),
          REFRESH_RECOVERY_TTL_MS,
        );
        return true;
      } catch {
        // Retry the same encrypted payload; the upsert is idempotent.
      }
    }
    this.logger.error(`店铺 ${shop.id} Token 刷新恢复记录保存失败`);
    return false;
  }

  private async clearPendingRefresh(shopId: bigint): Promise<void> {
    try {
      await this.runtimeState.remove(this.refreshRecoveryKey(shopId));
    } catch {
      this.logger.warn(`店铺 ${shopId} Token 刷新恢复记录清理失败`);
    }
  }

  private async loadShop(shopId: bigint, userId: bigint): Promise<TokenShop> {
    const shop = await this.prisma.shop.findFirst({
      where: { id: shopId, userId },
      select: {
        id: true,
        userId: true,
        platform: true,
        platformShopId: true,
        accessTokenEnc: true,
        refreshTokenEnc: true,
        tokenExpireAt: true,
        status: true,
      },
    });
    if (!shop) throw new NotFoundException('店铺不存在');
    return shop;
  }

  private assertUsable(shop: TokenShop): void {
    if (shop.status !== 'active' || !shop.accessTokenEnc) {
      throw new UnauthorizedException(REAUTHORIZE_MESSAGE);
    }
  }

  private async decryptAccessToken(shop: TokenShop): Promise<string> {
    try {
      const token = this.crypto.decrypt(shop.accessTokenEnc!);
      await this.alerts.resolve(this.alertKey(shop.id), { status: 'decrypt_ok' });
      return token;
    } catch (error) {
      await this.raiseCredentialAlert(shop, 'access_token_decrypt', error, 'critical');
      await this.markExpired(shop);
      throw new UnauthorizedException(REAUTHORIZE_MESSAGE);
    }
  }

  private createAdapter(platform: Platform): PlatformAdapter {
    switch (platform) {
      case 'douyin':
        return new DouyinAdapter(this.oauthConfig.getPlatformConfig('douyin'));
      case 'alibaba_1688':
        return new Alibaba1688Adapter(this.oauthConfig.getPlatformConfig('alibaba_1688'));
      default:
        throw new ServiceUnavailableException(`${platform} Token 刷新尚未接入`);
    }
  }

  private async markExpired(shop: TokenShop): Promise<void> {
    await this.prisma.shop.updateMany({
      where: {
        id: shop.id,
        userId: shop.userId,
        status: 'active',
        accessTokenEnc: shop.accessTokenEnc,
        refreshTokenEnc: shop.refreshTokenEnc,
      },
      data: { status: 'expired' },
    });
  }

  private async acquireRefreshLock(shopId: bigint): Promise<string | null> {
    try {
      return await this.runtimeState.acquireLease(`oauth:refresh:${shopId}`, REFRESH_LOCK_TTL_MS);
    } catch {
      this.logger.warn(`店铺 ${shopId} Token 刷新锁不可用`);
      return null;
    }
  }

  private async releaseRefreshLock(shopId: bigint, value: string): Promise<void> {
    try {
      await this.runtimeState.releaseLease(`oauth:refresh:${shopId}`, value);
    } catch {
      this.logger.warn(`店铺 ${shopId} Token 刷新锁释放失败`);
    }
  }

  private alertKey(shopId: bigint): string {
    return `credential.shop.${shopId}`;
  }

  private refreshRecoveryKey(shopId: bigint): string {
    return `oauth:refresh-result:${shopId}`;
  }

  private async raiseCredentialAlert(
    shop: TokenShop,
    failure: string,
    error: unknown,
    severity: 'warning' | 'critical',
  ): Promise<void> {
    await this.alerts.raise({
      key: this.alertKey(shop.id),
      type: 'credential',
      severity,
      summary:
        failure === 'token_refresh_identity_mismatch'
          ? '店铺授权刷新返回了不同主体'
          : failure === 'token_refresh_persist' || failure === 'token_refresh_recovery_store'
            ? '店铺授权刷新结果无法持久化'
            : severity === 'critical'
              ? '店铺授权凭证无法解密'
              : '店铺授权 Token 刷新失败',
      details: {
        shopId: shop.id,
        userId: shop.userId,
        platform: shop.platform,
        failure,
        errorType: error instanceof Error ? error.name : 'unknown',
      },
    });
  }
}

function parsePendingRefresh(raw: string): PendingTokenRefresh | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const tokenExpireAt = typeof value.tokenExpireAt === 'string' ? value.tokenExpireAt : '';
    if (
      value.version !== 1 ||
      typeof value.userId !== 'string' ||
      typeof value.platform !== 'string' ||
      typeof value.platformShopId !== 'string' ||
      (value.previousAccessTokenEnc !== null && typeof value.previousAccessTokenEnc !== 'string') ||
      typeof value.previousRefreshTokenEnc !== 'string' ||
      typeof value.accessTokenEnc !== 'string' ||
      typeof value.refreshTokenEnc !== 'string' ||
      !tokenExpireAt ||
      !Number.isFinite(new Date(tokenExpireAt).getTime())
    ) {
      return null;
    }
    return value as unknown as PendingTokenRefresh;
  } catch {
    return null;
  }
}
