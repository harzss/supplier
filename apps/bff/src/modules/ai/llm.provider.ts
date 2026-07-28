import { Logger, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  LlmClient,
  createAnthropic,
  createDashScope,
  createDeepSeek,
  createOpenAi,
  type LlmProvider,
} from '@supplier/llm-client';
import type { LlmModel } from '@supplier/shared-types';

export const LLM_CLIENT = Symbol('LLM_CLIENT');

/**
 * 根据环境变量装配 LlmClient：
 * - 缺哪个 API Key，就把哪一组模型摘掉；全缺就走 stub（开发友好）。
 * - fallback 顺序：DeepSeek → Qwen → OpenAI（按成本与可用性）。
 */
export const LlmClientProvider: Provider = {
  provide: LLM_CLIENT,
  inject: [ConfigService],
  useFactory: (config: ConfigService) => {
    const logger = new Logger('LlmClient');
    const primary = new Map<LlmModel, LlmProvider>();
    const fallback = new Map<LlmModel, LlmProvider[]>();

    const deepseekKey = config.get<string>('DEEPSEEK_API_KEY');
    const dashscopeKey = config.get<string>('DASHSCOPE_API_KEY');
    const openaiKey = config.get<string>('OPENAI_API_KEY');
    const anthropicKey = config.get<string>('ANTHROPIC_API_KEY');

    const deepseek = deepseekKey ? createDeepSeek(deepseekKey) : null;
    const dashscope = dashscopeKey ? createDashScope(dashscopeKey) : null;
    const openai = openaiKey ? createOpenAi(openaiKey) : null;
    const anthropic = anthropicKey ? createAnthropic(anthropicKey) : null;

    const register = (
      model: LlmModel,
      primaryProvider: LlmProvider | null,
      fallbacks: Array<LlmProvider | null>,
    ) => {
      const fb = fallbacks.filter((p): p is LlmProvider => p !== null);
      if (primaryProvider) {
        primary.set(model, primaryProvider);
        if (fb.length) fallback.set(model, fb);
      } else if (fb.length) {
        primary.set(model, fb[0]!);
        if (fb.length > 1) fallback.set(model, fb.slice(1));
      }
    };

    register('deepseek-v3', deepseek, [dashscope, openai]);
    register('qwen-plus', dashscope, [deepseek]);
    register('qwen-max', dashscope, [openai]);
    register('qwen-vl-max', dashscope, []);
    register('gpt-4o', openai, [anthropic]);
    register('gpt-4o-mini', openai, [deepseek, dashscope]);
    register('claude-sonnet-4', anthropic, [openai]);
    register('claude-haiku-4', anthropic, [openai]);

    if (primary.size === 0) {
      logger.warn('No LLM provider keys configured — using stub responses');
    } else {
      logger.log(`LLM providers configured: ${[...primary.keys()].join(', ')}`);
    }

    return new LlmClient({
      primary,
      fallback,
      maxRetries: 2,
      retryBaseMs: 500,
      onEvent: (e) => {
        if (e.type === 'failure') {
          logger.warn(`[${e.provider}] ${e.model} failed: ${e.error} (retryable=${e.retryable})`);
        }
      },
    });
  },
};
