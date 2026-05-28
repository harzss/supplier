import type { LlmModel } from '@supplier/shared-types';
import { LlmError } from '../errors';
import { calcCostCny } from '../pricing';
import type { ChatMessage, ChatOptions, ChatResult, LlmProvider } from '../types';

interface AnthropicConfig {
  apiKey: string;
  baseUrl?: string;
  modelMap?: Partial<Record<LlmModel, string>>;
}

/**
 * Anthropic Claude 客户端（messages API）
 */
export class AnthropicProvider implements LlmProvider {
  readonly supportedModels: readonly LlmModel[] = ['claude-sonnet-4', 'claude-haiku-4'];

  private readonly baseUrl: string;
  private readonly modelMap: Record<string, string>;

  constructor(private readonly config: AnthropicConfig) {
    this.baseUrl = config.baseUrl ?? 'https://api.anthropic.com/v1';
    this.modelMap = {
      'claude-sonnet-4': 'claude-sonnet-4-20250514',
      'claude-haiku-4': 'claude-haiku-4-20250514',
      ...(config.modelMap ?? {}),
    };
  }

  async chat(options: ChatOptions): Promise<ChatResult> {
    const realModel = this.modelMap[options.model];
    if (!realModel) {
      throw new LlmError(`Model ${options.model} not supported by Anthropic`, 'invalid_request');
    }

    const { system, conversation } = splitSystem(options.messages);

    const url = `${this.baseUrl.replace(/\/$/, '')}/messages`;
    const body: Record<string, unknown> = {
      model: realModel,
      max_tokens: options.maxTokens ?? 1024,
      temperature: options.temperature ?? 0.7,
      messages: conversation.map((m) => ({ role: m.role, content: m.content })),
    };
    if (system) body.system = system;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.config.apiKey,
          'anthropic-version': '2023-06-01',
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
      throw new LlmError(`Claude ${res.status}: ${text}`, code, res.status, text);
    }

    const json = (await res.json()) as {
      content: Array<{ type: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };

    const content = json.content
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('');

    const inputTokens = json.usage?.input_tokens ?? 0;
    const outputTokens = json.usage?.output_tokens ?? 0;

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

function splitSystem(messages: ChatMessage[]): {
  system: string | null;
  conversation: Array<{ role: 'user' | 'assistant'; content: string }>;
} {
  const systemParts: string[] = [];
  const conversation: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const m of messages) {
    if (m.role === 'system') {
      systemParts.push(m.content);
    } else {
      conversation.push({ role: m.role, content: m.content });
    }
  }
  return {
    system: systemParts.length ? systemParts.join('\n\n') : null,
    conversation,
  };
}

export function createAnthropic(apiKey: string): AnthropicProvider {
  return new AnthropicProvider({ apiKey });
}
