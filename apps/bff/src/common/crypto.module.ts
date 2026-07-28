import { Global, Injectable, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12; // GCM 推荐 96-bit IV

/**
 * 对称加密服务（AES-256-GCM）。
 * 用于加密用户 BYOK 的 LLM API Key、平台 OAuth Token 等敏感凭证。
 *
 * 密钥来源：环境变量 ENCRYPTION_KEY（任意长度字符串，内部经 SHA-256 归一为 32 字节）。
 * 生产环境务必配置；未配置时使用不安全的 dev key 并告警。
 * 生产推荐将 ENCRYPTION_KEY 托管在 KMS / Secrets Manager。
 */
@Injectable()
export class CryptoService {
  private readonly logger = new Logger('Crypto');
  private readonly key: Buffer;

  constructor(config: ConfigService) {
    const raw = config.get<string>('ENCRYPTION_KEY');
    if (!raw) {
      this.logger.warn('ENCRYPTION_KEY 未配置，正在使用不安全的开发密钥，请在生产环境设置该变量！');
    }
    this.key = createHash('sha256')
      .update(raw ?? 'dev-insecure-key-change-me')
      .digest();
  }

  /** 加密，返回 `base64(iv).base64(tag).base64(ciphertext)` */
  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv(ALGO, this.key, iv);
    const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join('.');
  }

  /** 解密；密文格式错误或被篡改（GCM 认证失败）会抛错 */
  decrypt(payload: string): string {
    const parts = payload.split('.');
    if (parts.length !== 3) {
      throw new Error('Invalid ciphertext format');
    }
    const [ivB64, tagB64, dataB64] = parts;
    const iv = Buffer.from(ivB64!, 'base64');
    const tag = Buffer.from(tagB64!, 'base64');
    const data = Buffer.from(dataB64!, 'base64');
    const decipher = createDecipheriv(ALGO, this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  }

  /** 脱敏展示：仅保留前后各 4 位，其余用 **** 遮蔽 */
  mask(plaintext: string): string {
    if (plaintext.length <= 8) return '****';
    return `${plaintext.slice(0, 4)}****${plaintext.slice(-4)}`;
  }
}

@Global()
@Module({
  providers: [
    {
      provide: CryptoService,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => new CryptoService(config),
    },
  ],
  exports: [CryptoService],
})
export class CryptoModule {}
