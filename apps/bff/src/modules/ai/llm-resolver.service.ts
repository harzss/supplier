import { Inject, Injectable, Logger } from '@nestjs/common';
import type { LlmProviderName } from '@supplier/db';
import {
  LlmClient,
  createAnthropic,
  createDashScope,
  createDeepSeek,
  createOpenAi,
  type LlmProvider,
} from '@supplier/llm-client';
import type { LlmModel } from '@supplier/shared-types';
import { LlmCredentialService } from '../settings/llm-credential.service';
import { LLM_CLIENT } from './llm.provider';

export interface LlmResolution {
  /** 实际用于调用的客户端（平台单例 或 用户 BYOK 临时客户端） */
  client: LlmClient;
  /** 是否走用户自带密钥 */
  viaByok: boolean;
  provider?: LlmProviderName;
  /** 将路由选中的模型钳制到当前客户端支持的模型 */
  pickModel(preferred: LlmModel): LlmModel;
}

/**
 * 选路：优先使用用户 BYOK 密钥（成本归用户、不限平台额度）；
 * 未配置则回退平台默认客户端（计入套餐额度）。
 */
@Injectable()
export class LlmResolverService {
  private readonly logger = new Logger('LlmResolver');

  constructor(
    @Inject(LLM_CLIENT) private readonly platform: LlmClient,
    private readonly credentials: LlmCredentialService,
  ) {}

  async resolve(userId: bigint): Promise<LlmResolution> {
    const cred = await this.credentials.resolve(userId);
    if (!cred) {
      return { client: this.platform, viaByok: false, pickModel: (m) => m };
    }

    const provider = buildProvider(cred.provider, cred.apiKey);
    const supported = provider.supportedModels;
    const primary = new Map<LlmModel, LlmProvider>(supported.map((m) => [m, provider]));
    const client = new LlmClient({ primary, maxRetries: 1, retryBaseMs: 400 });
    this.logger.log(`用户 ${userId} 使用 BYOK（${cred.provider}）`);

    return {
      client,
      viaByok: true,
      provider: cred.provider,
      pickModel: (m) => (supported.includes(m) ? m : supported[0]!),
    };
  }
}

function buildProvider(provider: LlmProviderName, apiKey: string): LlmProvider {
  switch (provider) {
    case 'openai':
      return createOpenAi(apiKey);
    case 'deepseek':
      return createDeepSeek(apiKey);
    case 'dashscope':
      return createDashScope(apiKey);
    case 'anthropic':
      return createAnthropic(apiKey);
    default:
      return createDeepSeek(apiKey);
  }
}
