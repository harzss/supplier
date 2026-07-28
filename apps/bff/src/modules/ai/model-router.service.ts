import { Injectable } from '@nestjs/common';
import type { AiModule, LlmModel, UserPlan } from '@supplier/shared-types';

interface PickContext {
  module: AiModule;
  userPlan?: UserPlan;
  preferredModel?: LlmModel;
}

/**
 * 模型路由策略：按场景 × 用户等级 × 容灾选择最优模型
 * 详见 docs/05-ai-pipeline.md §2
 */
@Injectable()
export class ModelRouterService {
  private readonly defaultByModule: Record<AiModule, LlmModel> = {
    title: 'deepseek-v3',
    detail: 'qwen-max',
    image_remove_watermark: 'qwen-vl-max',
    image_relight: 'qwen-vl-max',
    image_compose: 'qwen-vl-max',
    category_mapping: 'qwen-plus',
    compliance_check: 'gpt-4o-mini',
    customer_service: 'claude-sonnet-4',
    recommendation_reason: 'claude-haiku-4',
  };

  private readonly upgradeForPlan: Partial<Record<UserPlan, Partial<Record<AiModule, LlmModel>>>> =
    {
      flagship: {
        title: 'gpt-4o',
        detail: 'gpt-4o',
        customer_service: 'claude-sonnet-4',
      },
      pro: {
        title: 'qwen-max',
        detail: 'qwen-max',
      },
    };

  async pick(ctx: PickContext): Promise<LlmModel> {
    if (ctx.preferredModel) return ctx.preferredModel;
    const upgraded = ctx.userPlan ? this.upgradeForPlan[ctx.userPlan]?.[ctx.module] : undefined;
    return upgraded ?? this.defaultByModule[ctx.module];
  }
}
