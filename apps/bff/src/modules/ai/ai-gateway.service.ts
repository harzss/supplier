import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { LlmError, type ChatResult } from '@supplier/llm-client';
import type { LlmModel } from '@supplier/shared-types';
import { AiUsageService, type PlatformUsageReservation } from '../entitlement/ai-usage.service';
import { EntitlementService } from '../entitlement/entitlement.service';
import type { CurrentUser } from '../entitlement/user-context.service';
import type { TitleGenerateDto } from './dto/title-generate.dto';
import type { DetailGenerateDto } from './dto/detail-generate.dto';
import { LlmResolverService } from './llm-resolver.service';
import { ModelRouterService } from './model-router.service';
import { PromptCacheService } from './prompt-cache.service';
import { buildTitleMessages, parseAndFilterTitles } from './prompts/title.prompt';
import {
  buildDetailMessages,
  parseDetailContent,
  type DetailSection,
} from './prompts/detail.prompt';

export interface QuotaView {
  limit: number;
  used: number;
  remaining: number;
}

export interface BillingInfo {
  viaByok: boolean;
  /** 平台额度视图；BYOK 时为 null（不限额） */
  quota: QuotaView | null;
}

export interface TitleResponse {
  titles: string[];
  rejected: Array<{ title: string; reason: string }>;
  model: LlmModel | 'stub';
  cached: boolean;
  costCny: number;
  billing: BillingInfo;
}

type TitleCore = Omit<TitleResponse, 'billing'>;

export interface DetailResponse {
  summary: string;
  sections: DetailSection[];
  detailHtml: string;
  complianceFlags: string[];
  model: LlmModel | 'stub';
  cached: boolean;
  costCny: number;
  billing: BillingInfo;
}

type DetailCore = Omit<DetailResponse, 'billing'>;

@Injectable()
export class AiGatewayService {
  private readonly logger = new Logger(AiGatewayService.name);

  constructor(
    private readonly router: ModelRouterService,
    private readonly cache: PromptCacheService,
    private readonly resolver: LlmResolverService,
    private readonly entitlement: EntitlementService,
    private readonly usage: AiUsageService,
  ) {}

  async generateTitle(user: CurrentUser, dto: TitleGenerateDto): Promise<TitleResponse> {
    // 1. 功能门禁（ai.title 属基础功能，免费可用）
    this.entitlement.assertFeature(user.plan, 'ai.title');

    // 2. 选路：BYOK 优先
    const resolution = await this.resolver.resolve(user.userId);

    // 3. 缓存命中：直接返回，不消耗额度、不计量
    const cacheKey = this.cache.buildKey('title', {
      o: dto.originalTitle,
      c: dto.category,
      s: dto.sellingPoints,
      p: dto.targetPlatform,
    });
    const cached = await this.cache.get<TitleCore>(cacheKey);
    if (cached) {
      return {
        ...cached,
        cached: true,
        billing: await this.buildBilling(user, resolution.viaByok),
      };
    }

    // 4. 选模型；未配置平台供应商时保留本地 stub，且不预占平台额度
    const preferred = await this.router.pick({ module: 'title', userPlan: user.plan });
    const model = resolution.pickModel(preferred);
    const messages = buildTitleMessages(dto);

    let core: TitleCore;
    let billing: BillingInfo | undefined;
    if (!resolution.client.supports(model)) {
      await this.assertQuota(user, resolution.viaByok);
      this.logger.warn('Falling back to stub titles (no LLM provider configured)');
      core = this.stubResponse(dto);
    } else {
      // 5. 平台调用先原子预占额度；BYOK 由用户自付，不占平台额度
      const reservation = resolution.viaByok
        ? null
        : await this.usage.reservePlatform(user.userId, user.plan, 'title', model);
      let llmResult: ChatResult;
      try {
        llmResult = await resolution.client.chat({
          model,
          messages,
          temperature: 0.8,
          maxTokens: 500,
          jsonMode: true,
          timeoutMs: 20_000,
        });
      } catch (err) {
        if (reservation) await this.usage.cancel(reservation, llmFailureReason(err));
        if (
          err instanceof LlmError &&
          err.code === 'invalid_request' &&
          err.message.includes('No provider')
        ) {
          this.logger.warn('Falling back to stub titles (no LLM provider configured)');
          core = this.stubResponse(dto);
          await this.cache.set(cacheKey, core, 3600);
          return { ...core, billing: await this.buildBilling(user, resolution.viaByok) };
        }
        if (err instanceof LlmError && resolution.viaByok) {
          throw byokCallFailed(err);
        }
        throw err;
      }

      // 6. 收到供应商结果后先回填账本，再解析业务内容；解析失败也不能漏记费用
      await this.recordCompletedUsage(
        user.userId,
        'title',
        reservation,
        llmResult.model,
        llmResult.usage,
      );
      const parsed = parseAndFilterTitles(llmResult.content, dto.targetPlatform);
      core = {
        titles: parsed.titles,
        rejected: parsed.rejected,
        model: llmResult.model,
        costCny: llmResult.usage.costCny,
        cached: false,
      };
      billing = reservation ? billingFromReservation(reservation) : { viaByok: true, quota: null };
    }

    // 7. 写缓存（stub 也缓存，避免重复失败调用）
    await this.cache.set(
      cacheKey,
      {
        titles: core.titles,
        rejected: core.rejected,
        model: core.model,
        costCny: core.costCny,
        cached: false,
      },
      3600,
    );

    return { ...core, billing: billing ?? (await this.buildBilling(user, resolution.viaByok)) };
  }

  async generateDetail(user: CurrentUser, dto: DetailGenerateDto): Promise<DetailResponse> {
    this.entitlement.assertFeature(user.plan, 'ai.detail');
    const resolution = await this.resolver.resolve(user.userId);
    const cacheKey = this.cache.buildKey('detail', {
      t: dto.title,
      c: dto.category,
      s: dto.sellingPoints,
      a: dto.attributes,
      p: dto.targetPlatform,
    });
    const cached = await this.cache.get<DetailCore>(cacheKey);
    if (cached) {
      return {
        ...cached,
        cached: true,
        billing: await this.buildBilling(user, resolution.viaByok),
      };
    }

    const preferred = await this.router.pick({ module: 'detail', userPlan: user.plan });
    const model = resolution.pickModel(preferred);
    let core: DetailCore;
    let billing: BillingInfo | undefined;
    if (!resolution.client.supports(model)) {
      await this.assertQuota(user, resolution.viaByok);
      this.logger.warn('Falling back to stub detail (no LLM provider configured)');
      core = this.stubDetail(dto);
    } else {
      const reservation = resolution.viaByok
        ? null
        : await this.usage.reservePlatform(user.userId, user.plan, 'detail', model);
      let llmResult: ChatResult;
      try {
        llmResult = await resolution.client.chat({
          model,
          messages: buildDetailMessages(dto),
          temperature: 0.5,
          maxTokens: 1_200,
          jsonMode: true,
          timeoutMs: 30_000,
        });
      } catch (err) {
        if (reservation) await this.usage.cancel(reservation, llmFailureReason(err));
        if (
          err instanceof LlmError &&
          err.code === 'invalid_request' &&
          err.message.includes('No provider')
        ) {
          this.logger.warn('Falling back to stub detail (no LLM provider configured)');
          core = this.stubDetail(dto);
          await this.cache.set(cacheKey, core, 3600);
          return { ...core, billing: await this.buildBilling(user, resolution.viaByok) };
        }
        if (err instanceof LlmError && resolution.viaByok) {
          throw byokCallFailed(err);
        }
        throw err;
      }

      await this.recordCompletedUsage(
        user.userId,
        'detail',
        reservation,
        llmResult.model,
        llmResult.usage,
      );
      const parsed = parseDetailContent(llmResult.content);
      core = {
        ...parsed,
        model: llmResult.model,
        costCny: llmResult.usage.costCny,
        cached: false,
      };
      billing = reservation ? billingFromReservation(reservation) : { viaByok: true, quota: null };
    }

    await this.cache.set(cacheKey, core, 3600);
    return { ...core, billing: billing ?? (await this.buildBilling(user, resolution.viaByok)) };
  }

  private async assertQuota(user: CurrentUser, viaByok: boolean): Promise<void> {
    if (viaByok) return;
    const quota = await this.entitlement.checkAiQuota(user.userId, user.plan);
    if (!quota.exceeded) return;
    throw new HttpException(
      {
        code: 'QUOTA_EXCEEDED',
        message: `本月 AI 额度已用完（${quota.used}/${quota.limit}）。可升级套餐，或在设置中配置自有 API Key 以继续使用。`,
        limit: quota.limit,
        used: quota.used,
      },
      HttpStatus.PAYMENT_REQUIRED,
    );
  }

  private async buildBilling(user: CurrentUser, viaByok: boolean): Promise<BillingInfo> {
    if (viaByok) return { viaByok: true, quota: null };
    const q = await this.entitlement.checkAiQuota(user.userId, user.plan);
    return { viaByok: false, quota: { limit: q.limit, used: q.used, remaining: q.remaining } };
  }

  private async recordCompletedUsage(
    userId: bigint,
    module: 'title' | 'detail',
    reservation: PlatformUsageReservation | null,
    model: LlmModel,
    usage: { inputTokens: number; outputTokens: number; costCny: number },
  ): Promise<void> {
    if (reservation) {
      await this.usage.completeLlm(reservation, { model, ...usage });
    } else {
      await this.usage.recordByok(userId, module, { model, ...usage });
    }
  }

  private stubResponse(dto: TitleGenerateDto): TitleCore {
    const points = dto.sellingPoints.slice(0, 2).join(' ');
    const parsed = parseAndFilterTitles(
      JSON.stringify({
        titles: [
          `${dto.originalTitle} ${points}`,
          `${dto.category} ${dto.originalTitle}`,
          `${dto.originalTitle} 日常实用`,
          `${dto.originalTitle} 多场景适用`,
          `${dto.originalTitle} 按需选购`,
        ],
      }),
      dto.targetPlatform,
    );
    return {
      titles: parsed.titles,
      rejected: parsed.rejected,
      model: 'stub',
      cached: false,
      costCny: 0,
    };
  }

  private stubDetail(dto: DetailGenerateDto): DetailCore {
    const parsed = parseDetailContent(
      JSON.stringify({
        summary: `${dto.title}，按已知货源信息整理。`,
        sections: [
          {
            heading: '核心卖点',
            body: dto.sellingPoints.join('；') || '保留货源已知信息，不添加未经验证的宣传。',
            bullets: dto.sellingPoints.slice(0, 4),
          },
          {
            heading: '材质与参数',
            body:
              Object.entries(dto.attributes ?? {})
                .slice(0, 8)
                .map(([key, value]) => `${key}：${value}`)
                .join('；') || '具体参数请以商品页面和实际到货为准。',
            bullets: [],
          },
          {
            heading: '适用场景',
            body: `适合${dto.category || '对应类目'}的日常使用场景，购买前请确认规格。`,
            bullets: ['按需选择规格', '实际颜色以实物为准'],
          },
        ],
      }),
    );
    return { ...parsed, model: 'stub', cached: false, costCny: 0 };
  }
}

function byokReason(code: string): string {
  switch (code) {
    case 'auth':
      return '密钥无效';
    case 'rate_limited':
      return '触发限流';
    case 'timeout':
      return '请求超时';
    default:
      return '服务异常';
  }
}

function byokCallFailed(error: LlmError): HttpException {
  return new HttpException(
    {
      code: 'BYOK_CALL_FAILED',
      message: `使用自有 API Key 调用失败（${byokReason(error.code)}），请到设置中检查密钥。`,
    },
    HttpStatus.BAD_GATEWAY,
  );
}

function llmFailureReason(error: unknown): string {
  if (error instanceof LlmError) return `llm_${error.code}`;
  return error instanceof Error ? error.name : 'unknown';
}

function billingFromReservation(reservation: PlatformUsageReservation): BillingInfo {
  return {
    viaByok: false,
    quota: {
      limit: reservation.quota.limit,
      used: reservation.quota.used,
      remaining: reservation.quota.remaining,
    },
  };
}
