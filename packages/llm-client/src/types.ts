import type { LlmModel } from '@supplier/shared-types';

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatOptions {
  model: LlmModel;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  /** 解析为 JSON 对象 */
  jsonMode?: boolean;
  /** 单次调用超时（毫秒） */
  timeoutMs?: number;
}

export interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
  costCny: number;
}

export interface ChatResult {
  content: string;
  model: LlmModel;
  usage: ChatUsage;
  /** 透传供应商的 raw 响应（调试用） */
  raw?: unknown;
}

export interface LlmProvider {
  /** 供应商支持的模型列表 */
  readonly supportedModels: readonly LlmModel[];
  chat(options: ChatOptions): Promise<ChatResult>;
}

export type ProviderName = 'openai' | 'anthropic' | 'deepseek' | 'dashscope';
