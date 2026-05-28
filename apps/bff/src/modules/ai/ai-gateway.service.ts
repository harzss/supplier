import { Inject, Injectable, Logger } from '@nestjs/common';
import { LlmClient, LlmError } from '@supplier/llm-client';
import type { LlmModel } from '@supplier/shared-types';
import { ModelRouterService } from './model-router.service';
import { PromptCacheService } from './prompt-cache.service';
import { LLM_CLIENT } from './llm.provider';
import type { TitleGenerateDto } from './dto/title-generate.dto';
import { buildTitleMessages, parseAndFilterTitles } from './prompts/title.prompt';

export interface TitleResponse {
  titles: string[];
  rejected: Array<{ title: string; reason: string }>;
  model: LlmModel | 'stub';
  cached: boolean;
  costCny: number;
}

@Injectable()
export class AiGatewayService {
  private readonly logger = new Logger(AiGatewayService.name);

  constructor(
    private readonly router: ModelRouterService,
    private readonly cache: PromptCacheService,
    @Inject(LLM_CLIENT) private readonly llm: LlmClient,
  ) {}

  async generateTitle(dto: TitleGenerateDto): Promise<TitleResponse> {
    const cacheKey = this.cache.buildKey('title', {
      o: dto.originalTitle,
      c: dto.category,
      s: dto.sellingPoints,
      p: dto.targetPlatform,
    });

    const cached = await this.cache.get<Omit<TitleResponse, 'cached'>>(cacheKey);
    if (cached) {
      return { ...cached, cached: true };
    }

    const model = await this.router.pick({ module: 'title', userPlan: dto.userPlan });
    const messages = buildTitleMessages(dto);

    let result: TitleResponse;
    try {
      const llmResult = await this.llm.chat({
        model,
        messages,
        temperature: 0.8,
        maxTokens: 500,
        jsonMode: true,
        timeoutMs: 20_000,
      });
      const parsed = parseAndFilterTitles(llmResult.content, dto.targetPlatform);
      result = {
        titles: parsed.titles,
        rejected: parsed.rejected,
        model: llmResult.model,
        costCny: llmResult.usage.costCny,
        cached: false,
      };
    } catch (err) {
      if (
        err instanceof LlmError &&
        err.code === 'invalid_request' &&
        err.message.includes('No provider')
      ) {
        this.logger.warn('Falling back to stub titles (no LLM provider configured)');
        result = this.stubResponse(dto);
      } else {
        throw err;
      }
    }

    await this.cache.set(
      cacheKey,
      {
        titles: result.titles,
        rejected: result.rejected,
        model: result.model,
        costCny: result.costCny,
      },
      3600,
    );
    return result;
  }

  private stubResponse(dto: TitleGenerateDto): TitleResponse {
    const points = dto.sellingPoints.slice(0, 2).join(' ');
    return {
      titles: [
        `[stub] ${dto.originalTitle} ${points}`,
        `[stub] ${dto.category} 必备 ${dto.originalTitle}`,
        `[stub] 新款 ${dto.originalTitle}`,
        `[stub] ${dto.originalTitle} 限时优惠`,
        `[stub] 爆款 ${dto.originalTitle} ${points}`,
      ].map((t) => t.slice(0, 30)),
      rejected: [],
      model: 'stub',
      cached: false,
      costCny: 0,
    };
  }
}
