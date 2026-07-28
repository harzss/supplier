import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export const LLM_PROVIDERS = ['openai', 'anthropic', 'deepseek', 'dashscope'] as const;
export type LlmProviderInput = (typeof LLM_PROVIDERS)[number];

export class SaveLlmKeyDto {
  @IsIn(LLM_PROVIDERS)
  provider!: LlmProviderInput;

  @IsString()
  @MinLength(8)
  @MaxLength(256)
  apiKey!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  label?: string;
}
