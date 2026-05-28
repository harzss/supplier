import type { LlmModel } from '@supplier/shared-types';
import { LlmError } from './errors';
import type { ChatOptions, ChatResult, LlmProvider } from './types';

export interface LlmClientOptions {
  /** 模型 → 主供应商 */
  primary: Map<LlmModel, LlmProvider>;
  /** 模型 → 容灾备选供应商列表（按顺序尝试） */
  fallback?: Map<LlmModel, LlmProvider[]>;
  /** 重试次数（针对 retryable 错误） */
  maxRetries?: number;
  /** 重试退避起始毫秒 */
  retryBaseMs?: number;
  /** 日志钩子 */
  onEvent?: (event: LlmEvent) => void;
}

export type LlmEvent =
  | { type: 'attempt'; model: LlmModel; provider: string; attempt: number }
  | { type: 'success'; model: LlmModel; provider: string; usage: ChatResult['usage'] }
  | { type: 'failure'; model: LlmModel; provider: string; error: string; retryable: boolean };

/**
 * 统一 LLM 客户端：路由 → 主供应商 → 容灾备选 → 重试
 */
export class LlmClient {
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;

  constructor(private readonly opts: LlmClientOptions) {
    this.maxRetries = opts.maxRetries ?? 2;
    this.retryBaseMs = opts.retryBaseMs ?? 500;
  }

  async chat(options: ChatOptions): Promise<ChatResult> {
    const candidates = this.candidates(options.model);
    if (candidates.length === 0) {
      throw new LlmError(`No provider configured for model ${options.model}`, 'invalid_request');
    }

    let lastErr: unknown;
    for (let i = 0; i < candidates.length; i++) {
      const provider = candidates[i]!;
      const providerName = provider.constructor.name;
      for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
        this.opts.onEvent?.({
          type: 'attempt',
          model: options.model,
          provider: providerName,
          attempt,
        });
        try {
          const result = await provider.chat(options);
          this.opts.onEvent?.({
            type: 'success',
            model: options.model,
            provider: providerName,
            usage: result.usage,
          });
          return result;
        } catch (err) {
          lastErr = err;
          const isLlmErr = err instanceof LlmError;
          const retryable = isLlmErr ? err.retryable : true;
          this.opts.onEvent?.({
            type: 'failure',
            model: options.model,
            provider: providerName,
            error: (err as Error).message,
            retryable,
          });
          if (!retryable) break; // 非重试错误：换下一个供应商
          if (attempt < this.maxRetries) {
            const delay = this.retryBaseMs * Math.pow(2, attempt);
            await sleep(delay);
            continue;
          }
        }
      }
    }
    throw lastErr instanceof Error ? lastErr : new LlmError('All providers failed', 'unknown');
  }

  private candidates(model: LlmModel): LlmProvider[] {
    const list: LlmProvider[] = [];
    const primary = this.opts.primary.get(model);
    if (primary) list.push(primary);
    const fallbacks = this.opts.fallback?.get(model) ?? [];
    list.push(...fallbacks);
    return list;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
