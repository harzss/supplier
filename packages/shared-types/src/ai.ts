export type AiModule =
  | 'title'
  | 'detail'
  | 'image_remove_watermark'
  | 'image_relight'
  | 'image_compose'
  | 'category_mapping'
  | 'compliance_check'
  | 'customer_service'
  | 'recommendation_reason';

export type LlmModel =
  | 'gpt-4o'
  | 'gpt-4o-mini'
  | 'claude-sonnet-4'
  | 'claude-haiku-4'
  | 'deepseek-v3'
  | 'qwen-max'
  | 'qwen-plus'
  | 'qwen-vl-max';

export interface AiUsage {
  id: string;
  userId: string;
  module: AiModule;
  model: LlmModel;
  inputTokens: number;
  outputTokens: number;
  imageCount: number;
  costCny: number;
  traceId: string;
  createdAt: Date;
}

export interface AiRequest<T = unknown> {
  module: AiModule;
  userId: string;
  payload: T;
  preferredModel?: LlmModel;
  cacheable?: boolean;
}

export interface AiResponse<T = unknown> {
  result: T;
  model: LlmModel;
  cached: boolean;
  costCny: number;
  traceId: string;
}
