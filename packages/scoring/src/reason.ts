import type { LlmClient } from '@supplier/llm-client';
import type { LlmModel } from '@supplier/shared-types';
import type { DimensionScore, ProductScoreResult, ScoringFeatures } from './types';
import { scoreProduct } from './scorer';

interface ReasonOptions {
  llm?: LlmClient;
  model?: LlmModel;
  /** LLM 不可用 / 关闭时使用模板兜底 */
  forceTemplate?: boolean;
}

/**
 * 生成完整 ProductScoreResult，含可读推荐理由。
 * - 有 LLM 时让模型把 Top3 维度的 notes 改写为一句自然语言（30 字内）
 * - 无 LLM 时拼接 notes 作为兜底
 */
export async function scoreProductWithReason(
  features: ScoringFeatures,
  options: ReasonOptions = {},
): Promise<ProductScoreResult> {
  const base = scoreProduct(features);

  const reason =
    options.forceTemplate || !options.llm
      ? templateReason(base)
      : await llmReason(features, base, options.llm, options.model ?? 'deepseek-v3').catch(() =>
          templateReason(base),
        );

  return { ...base, reason };
}

/** 取分数最高的 3 个维度的 notes 拼成兜底理由 */
function templateReason(r: Omit<ProductScoreResult, 'reason'>): string[] {
  const dims: Array<{ name: string; data: DimensionScore }> = [
    { name: '需求', data: r.demand },
    { name: '竞争', data: r.competition },
    { name: '利润', data: r.profit },
    { name: '合规', data: r.compliance },
    { name: '趋势', data: r.trend },
  ];
  const top = dims.sort((a, b) => b.data.score - a.data.score).slice(0, 3);
  const out: string[] = [];
  for (const d of top) {
    if (d.data.notes.length) out.push(d.data.notes[0]!);
  }
  if (out.length === 0) out.push('数据信号不足，建议补充采集');
  return out.slice(0, 3);
}

async function llmReason(
  f: ScoringFeatures,
  r: Omit<ProductScoreResult, 'reason'>,
  llm: LlmClient,
  model: LlmModel,
): Promise<string[]> {
  const dims = [
    { name: '需求', score: r.demand.score, notes: r.demand.notes },
    { name: '竞争', score: r.competition.score, notes: r.competition.notes },
    { name: '利润', score: r.profit.score, notes: r.profit.notes },
    { name: '合规', score: r.compliance.score, notes: r.compliance.notes },
    { name: '趋势', score: r.trend.score, notes: r.trend.notes },
  ];

  const prompt = [
    `商品：${f.title}`,
    `类目：${f.categoryL1 ?? '未知'}/${f.categoryL2 ?? ''}`,
    `综合分：${r.overall}`,
    '维度分：',
    ...dims.map(
      (d) => `  ${d.name}: ${d.score}${d.notes.length ? ` (${d.notes.join('；')})` : ''}`,
    ),
  ].join('\n');

  const result = await llm.chat({
    model,
    temperature: 0.5,
    maxTokens: 200,
    jsonMode: true,
    timeoutMs: 15_000,
    messages: [
      {
        role: 'system',
        content:
          '你是 1688 选品分析师。基于五维打分给商家"是否值得搬"的推荐理由。' +
          '只输出 JSON: {"reasons": ["...", "..."]}，最多 3 条，' +
          '每条不超过 25 字，必须基于输入分数，不要捏造数字，不用极限词。',
      },
      { role: 'user', content: prompt },
    ],
  });

  const parsed = parseReasons(result.content);
  return parsed.length ? parsed : templateReason(r);
}

function parseReasons(raw: string): string[] {
  const text = raw
    .replace(/```(?:json)?\s*/gi, '')
    .replace(/```/g, '')
    .trim();
  try {
    const j = JSON.parse(text) as { reasons?: unknown };
    if (Array.isArray(j.reasons)) {
      return j.reasons
        .filter((s): s is string => typeof s === 'string' && s.length > 0)
        .slice(0, 3);
    }
  } catch {
    // ignore
  }
  return [];
}
