import { describe, expect, it, vi } from 'vitest';
import type { AiUsageService } from '../entitlement/ai-usage.service';
import type { EntitlementService } from '../entitlement/entitlement.service';
import type { CurrentUser } from '../entitlement/user-context.service';
import { AiGatewayService } from './ai-gateway.service';
import type { LlmResolverService } from './llm-resolver.service';
import type { ModelRouterService } from './model-router.service';
import type { PromptCacheService } from './prompt-cache.service';
import type { EntitlementAccessService } from '../entitlement/entitlement-access.service';

const USER: CurrentUser = {
  userId: 1n,
  plan: 'basic',
  entitlementSource: 'internal_beta',
  accessStatus: 'active',
  entitlementRevision: 1,
};

describe('AiGatewayService.generateDetail', () => {
  it('applies the detail entitlement, meters usage and returns structured HTML', async () => {
    const chat = vi.fn().mockResolvedValue({
      content: JSON.stringify({
        summary: '日常实穿单品',
        sections: [
          { heading: '核心卖点', body: '版型简洁', bullets: ['日常百搭'] },
          { heading: '材质参数', body: '已知材质为棉', bullets: [] },
          { heading: '适用场景', body: '适合通勤与休闲', bullets: ['按需选码'] },
        ],
      }),
      model: 'qwen-max',
      usage: { inputTokens: 120, outputTokens: 180, costCny: 0.02 },
    });
    const router = { pick: vi.fn().mockResolvedValue('qwen-max') } as unknown as ModelRouterService;
    const cache = {
      buildKey: vi.fn().mockReturnValue('ai:detail:key'),
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
    } as unknown as PromptCacheService;
    const resolver = {
      resolve: vi.fn().mockResolvedValue({
        client: { chat, supports: vi.fn().mockReturnValue(true) },
        viaByok: false,
        pickModel: (model: string) => model,
      }),
    } as unknown as LlmResolverService;
    const entitlement = {
      assertFeature: vi.fn(),
      checkAiQuota: vi.fn().mockResolvedValue({
        limit: 500,
        used: 1,
        remaining: 499,
        exceeded: false,
      }),
    } as unknown as EntitlementService;
    const reservePlatform = vi.fn().mockResolvedValue({
      id: 8n,
      module: 'detail',
      pendingModel: 'pending/qwen-max',
      traceId: 'usage-trace',
      quota: {
        key: 'ai.calls.monthly',
        limit: 500,
        used: 2,
        remaining: 498,
        exceeded: false,
      },
    });
    const completeLlm = vi.fn().mockResolvedValue(true);
    const recordByok = vi.fn().mockResolvedValue(undefined);
    const usage = {
      reservePlatform,
      completeLlm,
      recordByok,
      cancel: vi.fn().mockResolvedValue(true),
    } as unknown as AiUsageService;
    const assertActive = vi.fn().mockResolvedValue({ revision: USER.entitlementRevision });
    const access = { assertActive } as unknown as EntitlementAccessService;
    const service = new AiGatewayService(router, cache, resolver, entitlement, usage, access);

    const result = await service.generateDetail(USER, {
      title: '纯棉短袖 T 恤',
      category: '女装/T恤',
      sellingPoints: ['一件代发'],
      attributes: { material: '棉' },
      targetPlatform: 'douyin',
    });

    expect(entitlement.assertFeature).toHaveBeenCalledWith('basic', 'ai.detail');
    expect(assertActive).toHaveBeenCalledWith(1n, 1);
    expect(chat).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'qwen-max', jsonMode: true }),
    );
    expect(reservePlatform).toHaveBeenCalledWith(1n, 'basic', 'detail', 'qwen-max', 1);
    expect(completeLlm).toHaveBeenCalledWith(
      expect.objectContaining({ id: 8n, module: 'detail' }),
      {
        model: 'qwen-max',
        inputTokens: 120,
        outputTokens: 180,
        costCny: 0.02,
      },
    );
    expect(result.sections).toHaveLength(3);
    expect(result.detailHtml).toContain('<section>');
    expect(result.billing.quota?.remaining).toBe(498);

    reservePlatform.mockRejectedValueOnce(new Error('db unavailable'));
    await expect(
      service.generateDetail(USER, {
        title: '第二次请求',
        category: '女装/T恤',
        sellingPoints: [],
        attributes: {},
        targetPlatform: 'douyin',
      }),
    ).rejects.toThrow('db unavailable');
    expect(chat).toHaveBeenCalledTimes(1);

    vi.mocked(resolver.resolve).mockResolvedValueOnce({
      client: { chat, supports: vi.fn().mockReturnValue(true) },
      viaByok: true,
      pickModel: (model: string) => model,
    } as never);
    const byokResult = await service.generateDetail(USER, {
      title: '自有密钥请求',
      category: '女装/T恤',
      sellingPoints: [],
      attributes: {},
      targetPlatform: 'douyin',
    });
    expect(byokResult.billing).toEqual({ viaByok: true, quota: null });
    expect(chat).toHaveBeenCalledTimes(2);
    expect(reservePlatform).toHaveBeenCalledTimes(2);
    expect(recordByok).toHaveBeenCalledWith(1n, 'detail', {
      model: 'qwen-max',
      inputTokens: 120,
      outputTokens: 180,
      costCny: 0.02,
    });

    chat.mockResolvedValueOnce({
      content: 'not-json',
      model: 'qwen-max',
      usage: { inputTokens: 10, outputTokens: 20, costCny: 0.01 },
    });
    await expect(
      service.generateDetail(USER, {
        title: '无法解析的供应商结果',
        category: '女装/T恤',
        sellingPoints: [],
        attributes: {},
        targetPlatform: 'douyin',
      }),
    ).rejects.toThrow();
    expect(completeLlm).toHaveBeenLastCalledWith(expect.objectContaining({ module: 'detail' }), {
      model: 'qwen-max',
      inputTokens: 10,
      outputTokens: 20,
      costCny: 0.01,
    });

    vi.mocked(resolver.resolve).mockResolvedValueOnce({
      client: { chat, supports: vi.fn().mockReturnValue(false) },
      viaByok: false,
      pickModel: (model: string) => model,
    } as never);
    const stubResult = await service.generateDetail(USER, {
      title: '无平台供应商',
      category: '女装/T恤',
      sellingPoints: [],
      attributes: {},
      targetPlatform: 'douyin',
    });
    expect(stubResult.model).toBe('stub');
    expect(reservePlatform).toHaveBeenCalledTimes(3);
    expect(chat).toHaveBeenCalledTimes(3);
  });

  it('rejects suspended access before cache, BYOK resolution, routing or usage', async () => {
    const router = { pick: vi.fn() } as unknown as ModelRouterService;
    const cache = {
      buildKey: vi.fn(),
      get: vi.fn(),
      set: vi.fn(),
    } as unknown as PromptCacheService;
    const resolver = { resolve: vi.fn() } as unknown as LlmResolverService;
    const entitlement = { assertFeature: vi.fn() } as unknown as EntitlementService;
    const usage = { reservePlatform: vi.fn() } as unknown as AiUsageService;
    const access = {
      assertActive: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('suspended'), { status: 403 })),
    } as unknown as EntitlementAccessService;
    const service = new AiGatewayService(router, cache, resolver, entitlement, usage, access);

    await expect(
      service.generateTitle(
        { ...USER, plan: 'free', accessStatus: 'suspended', entitlementRevision: 2 },
        {
          originalTitle: '测试标题',
          category: '女装/T恤',
          sellingPoints: [],
          targetPlatform: 'douyin',
        },
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(cache.buildKey).not.toHaveBeenCalled();
    expect(resolver.resolve).not.toHaveBeenCalled();
    expect(router.pick).not.toHaveBeenCalled();
    expect(usage.reservePlatform).not.toHaveBeenCalled();
    expect(entitlement.assertFeature).not.toHaveBeenCalled();
  });
});
