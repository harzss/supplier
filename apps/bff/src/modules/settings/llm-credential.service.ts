import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import type { LlmCredentialStatus, LlmProviderName } from '@supplier/db';
import { CryptoService } from '../../common/crypto.module';
import { PrismaService } from '../../common/prisma.module';
import { AlertService } from '../observability/alert.service';

export interface LlmKeyView {
  configured: boolean;
  usable?: boolean;
  provider?: LlmProviderName;
  masked?: string;
  status?: LlmCredentialStatus;
  lastUsedAt?: string | null;
}

export interface ResolvedCredential {
  provider: LlmProviderName;
  apiKey: string;
}

/** 用户 BYOK LLM 密钥管理：加密存储、脱敏读取、内部解密选路 */
@Injectable()
export class LlmCredentialService {
  private readonly logger = new Logger('LlmCredential');

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly alerts: AlertService,
  ) {}

  /** 保存 / 覆盖用户密钥（按用户唯一），返回脱敏视图 */
  async save(
    userId: bigint,
    provider: LlmProviderName,
    apiKey: string,
    label?: string,
  ): Promise<LlmKeyView> {
    const apiKeyEnc = this.crypto.encrypt(apiKey);
    try {
      await this.prisma.llmCredential.upsert({
        where: { userId },
        create: { userId, provider, apiKeyEnc, label, status: 'active' },
        update: { provider, apiKeyEnc, label, status: 'active' },
      });
    } catch (err) {
      this.logger.error(`密钥保存失败：${(err as Error).message}`);
      throw new ServiceUnavailableException('密钥保存失败，请稍后重试');
    }
    await this.alerts.resolve(this.alertKey(userId), { status: 'credential_replaced' });
    return {
      configured: true,
      usable: true,
      provider,
      masked: this.crypto.mask(apiKey),
      status: 'active',
    };
  }

  /** 读取脱敏视图（绝不返回明文）；数据库故障不能伪装成未配置。 */
  async get(userId: bigint): Promise<LlmKeyView> {
    try {
      const cred = await this.prisma.llmCredential.findUnique({ where: { userId } });
      if (!cred) return { configured: false };
      let masked = '****';
      let usable = cred.status === 'active';
      try {
        masked = this.crypto.mask(this.crypto.decrypt(cred.apiKeyEnc));
        await this.alerts.resolve(this.alertKey(userId), { status: 'decrypt_ok' });
      } catch (error) {
        usable = false;
        await this.raiseDecryptAlert(userId, error);
        // 密文损坏时不暴露细节，仅展示占位
      }
      return {
        configured: true,
        usable,
        provider: cred.provider,
        masked,
        status: cred.status,
        lastUsedAt: cred.lastUsedAt?.toISOString() ?? null,
      };
    } catch (err) {
      this.logger.warn(`密钥读取失败：${(err as Error).message}`);
      throw new ServiceUnavailableException('密钥状态读取失败，请稍后重试');
    }
  }

  /** 删除密钥（幂等） */
  async remove(userId: bigint): Promise<{ deleted: boolean }> {
    try {
      await this.prisma.llmCredential.deleteMany({ where: { userId } });
    } catch (error) {
      this.logger.error(`密钥删除失败：${(error as Error).message}`);
      throw new ServiceUnavailableException('密钥删除失败，请稍后重试');
    }
    await this.alerts.resolve(this.alertKey(userId), { status: 'credential_removed' });
    return { deleted: true };
  }

  /** 内部：解密取回明文密钥用于实际调用；无有效密钥返回 null */
  async resolve(userId: bigint): Promise<ResolvedCredential | null> {
    try {
      const cred = await this.prisma.llmCredential.findUnique({ where: { userId } });
      if (!cred || cred.status !== 'active') return null;
      try {
        const apiKey = this.crypto.decrypt(cred.apiKeyEnc);
        await this.alerts.resolve(this.alertKey(userId), { status: 'decrypt_ok' });
        return { provider: cred.provider, apiKey };
      } catch (error) {
        await this.raiseDecryptAlert(userId, error);
        throw new ServiceUnavailableException('自有 API Key 无法解密，请在设置中重新配置');
      }
    } catch (err) {
      if (err instanceof ServiceUnavailableException) throw err;
      this.logger.warn(`密钥解析失败：${(err as Error).message}`);
      throw new ServiceUnavailableException('模型密钥服务暂时不可用，请稍后重试');
    }
  }

  private alertKey(userId: bigint): string {
    return `credential.llm.decrypt.user.${userId}`;
  }

  private async raiseDecryptAlert(userId: bigint, error: unknown): Promise<void> {
    await this.alerts.raise({
      key: this.alertKey(userId),
      type: 'credential',
      severity: 'critical',
      summary: '用户 LLM 密钥无法解密',
      details: { userId, errorType: error instanceof Error ? error.name : 'unknown' },
    });
  }
}
