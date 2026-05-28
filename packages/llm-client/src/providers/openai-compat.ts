import type { LlmModel } from '@supplier/shared-types';
import { LlmError } from '../errors';
import { calcCostCny } from '../pricing';
import type { ChatOptions, ChatResult, LlmProvider } from '../types';

interface OpenAiCompatConfig {
  baseUrl: string;
  apiKey: string;
  /** 把抽象 LlmModel 映射为该供应商真实模型名（如 deepseek-chat） */
  modelMap: Partial<Record<LlmModel, string>>;
  supportedModels: readonly LlmModel[];
}

/**
 * 兼容 OpenAI Chat Completions 协议的统一客户端。
 * 适用于：OpenAI、DeepSeek、Qwen DashScope（兼容模式）。
 */
export class OpenAiCompatProvider implements LlmProvider {
  readonly supportedModels: readonly LlmModel[];

  constructor(private readonly config: OpenAiCompatConfig) {
    this.supportedModels = config.supportedModels;
  }

  async chat(options: ChatOptions): Promise<ChatResult> {
    const realModel = this.config.modelMap[options.model];
    if (!realModel) {
      throw new LlmError(
        `Model ${options.model} not configured for this provider`,
        'invalid_request',
      );
    }

    const url = `${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const body: Record<string, unknown> = {
      model: realModel,
      messages: options.messages,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens ?? 1024,
      top_p: options.topP,
    };
    if (options.jsonMode) {
      body.response_format = { type: 'json_object' };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      const isAbort = err instanceof Error && err.name === 'AbortError';
      throw new LlmError(
        isAbort ? 'LLM request timeout' : `Network error: ${(err as Error).message}`,
        isAbort ? 'timeout' : 'server_error',
      );
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const code =
        res.status === 401
          ? 'auth'
          : res.status === 429
            ? 'rate_limited'
            : res.status >= 500
              ? 'server_error'
              : 'invalid_request';
      throw new LlmError(`LLM ${res.status}: ${text}`, code, res.status, text);
    }

    const json = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    const content = json.choices?.[0]?.message?.content ?? '';
    const inputTokens = json.usage?.prompt_tokens ?? 0;
    const outputTokens = json.usage?.completion_tokens ?? 0;

    return {
      content,
      model: options.model,
      usage: {
        inputTokens,
        outputTokens,
        costCny: calcCostCny(options.model, inputTokens, outputTokens),
      },
      raw: json,
    };
  }
}

// ---- 工厂方法：常用供应商 ----

export function createOpenAi(apiKey: string): OpenAiCompatProvider {
  return new OpenAiCompatProvider({
    baseUrl: 'https://api.openai.com/v1',
    apiKey,
    supportedModels: ['gpt-4o', 'gpt-4o-mini'],
    modelMap: {
      'gpt-4o': 'gpt-4o',
      'gpt-4o-mini': 'gpt-4o-mini',
    },
  });
}

export function createDeepSeek(apiKey: string): OpenAiCompatProvider {
  return new OpenAiCompatProvider({
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey,
    supportedModels: ['deepseek-v3'],
    modelMap: {
      'deepseek-v3': 'deepseek-chat',
    },
  });
}

export function createDashScope(apiKey: string): OpenAiCompatProvider {
  return new OpenAiCompatProvider({
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKey,
    supportedModels: ['qwen-max', 'qwen-plus', 'qwen-vl-max'],
    modelMap: {
      'qwen-max': 'qwen-max',
      'qwen-plus': 'qwen-plus',
      'qwen-vl-max': 'qwen-vl-max',
    },
  });
}
