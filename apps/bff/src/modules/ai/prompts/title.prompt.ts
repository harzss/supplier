import type { PlatformType } from '@supplier/shared-types';
import type { ChatMessage } from '@supplier/llm-client';

interface PlatformRule {
  maxLength: number;
  forbidden: string[];
  styleHint: string;
}

const PLATFORM_RULES: Record<PlatformType, PlatformRule> = {
  douyin: {
    maxLength: 30,
    forbidden: ['最', '第一', '国家级', '官方认证', '根治', '疗效', '特效'],
    styleHint: '活泼，前 12 字必含核心关键词，目标人群 18-35 岁女性',
  },
  taobao: {
    maxLength: 60,
    forbidden: ['最', '第一', '国家级', '根治', '疗效'],
    styleHint: '关键词密集，长尾词覆盖；前 30 字含主词',
  },
  tmall: {
    maxLength: 60,
    forbidden: ['最', '第一', '国家级', '根治', '疗效'],
    styleHint: '品牌感强，关键词密集',
  },
  pdd: {
    maxLength: 30,
    forbidden: ['最', '第一', '国家级', '官方认证'],
    styleHint: '强调价格力与卖点；不夸大',
  },
  kuaishou: {
    maxLength: 30,
    forbidden: ['最', '第一', '国家级'],
    styleHint: '直白接地气，强调实用',
  },
  wechat_shop: {
    maxLength: 30,
    forbidden: ['最', '第一'],
    styleHint: '专业克制',
  },
  alibaba_1688: {
    maxLength: 60,
    forbidden: [],
    styleHint: '工业风，参数密集（不用于销售铺货，仅作 fallback）',
  },
};

export interface TitlePromptInput {
  originalTitle: string;
  category: string;
  sellingPoints: string[];
  targetPlatform: PlatformType;
}

export function buildTitleMessages(input: TitlePromptInput): ChatMessage[] {
  const rule = PLATFORM_RULES[input.targetPlatform];
  const system = [
    `你是${platformName(input.targetPlatform)}标题优化专家。`,
    `要求：`,
    `1. 标题不超过 ${rule.maxLength} 字`,
    `2. 风格：${rule.styleHint}`,
    `3. 严格禁用以下词汇：${rule.forbidden.join('、') || '（无额外禁用词）'}`,
    `4. 不得使用极限词、医疗用语、虚假宣传`,
    `5. 输出严格 JSON：{"titles": ["...", "...", "...", "...", "..."]}，5 条候选`,
  ].join('\n');

  const user = [
    `原标题：${input.originalTitle}`,
    `类目：${input.category}`,
    `卖点：${input.sellingPoints.join('；') || '（无）'}`,
    `请生成 5 个候选标题，仅输出 JSON。`,
  ].join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

function platformName(p: PlatformType): string {
  const names: Record<PlatformType, string> = {
    douyin: '抖音小店',
    taobao: '淘宝',
    tmall: '天猫',
    pdd: '拼多多',
    kuaishou: '快手小店',
    wechat_shop: '视频号小店',
    alibaba_1688: '1688',
  };
  return names[p];
}

export interface TitleParseResult {
  titles: string[];
  rejected: Array<{ title: string; reason: string }>;
}

/** 解析 LLM 返回的 JSON 并过滤违禁词 */
export function parseAndFilterTitles(
  raw: string,
  platform: PlatformType,
): TitleParseResult {
  const rule = PLATFORM_RULES[platform];
  let parsed: { titles?: unknown };
  try {
    parsed = JSON.parse(extractJson(raw));
  } catch {
    return { titles: [], rejected: [{ title: raw, reason: 'JSON 解析失败' }] };
  }

  const titles = Array.isArray(parsed.titles)
    ? parsed.titles.filter((t): t is string => typeof t === 'string')
    : [];

  const accepted: string[] = [];
  const rejected: Array<{ title: string; reason: string }> = [];

  for (const t of titles) {
    if (t.length > rule.maxLength) {
      rejected.push({ title: t, reason: `超过 ${rule.maxLength} 字` });
      continue;
    }
    const hit = rule.forbidden.find((w) => t.includes(w));
    if (hit) {
      rejected.push({ title: t, reason: `包含禁用词: ${hit}` });
      continue;
    }
    accepted.push(t);
  }

  return { titles: accepted, rejected };
}

/** LLM 输出可能裹着 ```json ... ``` 或额外文字，提取首个 JSON 对象 */
function extractJson(raw: string): string {
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) return fence[1].trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) return raw.slice(start, end + 1);
  return raw;
}
