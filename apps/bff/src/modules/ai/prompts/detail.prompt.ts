import type { ChatMessage } from '@supplier/llm-client';
import type { PlatformType } from '@supplier/shared-types';

export interface DetailPromptInput {
  title: string;
  category: string;
  sellingPoints: string[];
  attributes?: Record<string, string>;
  targetPlatform: PlatformType;
}

export interface DetailSection {
  heading: string;
  body: string;
  bullets: string[];
}

export interface ParsedDetail {
  summary: string;
  sections: DetailSection[];
  detailHtml: string;
  complianceFlags: string[];
}

const FORBIDDEN_REPLACEMENTS = new Map([
  ['最', '更'],
  ['第一', '优选'],
  ['国家级', '高标准'],
  ['官方认证', '品质可查'],
  ['根治', '日常使用'],
  ['疗效', '使用体验'],
  ['特效', '实用'],
  ['绝对', '更'],
  ['永久', '持久'],
]);

export function buildDetailMessages(input: DetailPromptInput): ChatMessage[] {
  const attributes = Object.entries(input.attributes ?? {})
    .slice(0, 20)
    .map(([key, value]) => `${key}：${value}`)
    .join('；');
  return [
    {
      role: 'system',
      content: [
        '你是电商商品详情页编辑，负责把货源信息改写为原创、克制、可验证的销售文案。',
        '要求：',
        '1. 输出 3-5 个结构化段落，每段包含 heading、body、bullets',
        '2. 段落至少覆盖：核心卖点、材质/参数、适用场景',
        '3. 不得编造未提供的材质、尺寸、认证、功效或销量',
        '4. 禁止极限词、医疗用语、虚假承诺和竞品贬损',
        '5. 不输出 HTML，只输出严格 JSON',
        '输出格式：{"summary":"一句话摘要","sections":[{"heading":"...","body":"...","bullets":["..."]}]}',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        `目标平台：${input.targetPlatform}`,
        `商品标题：${input.title}`,
        `类目：${input.category || '未提供'}`,
        `已知卖点：${input.sellingPoints.join('；') || '未提供'}`,
        `已知属性：${attributes || '未提供'}`,
        '只使用以上事实，生成详情结构。',
      ].join('\n'),
    },
  ];
}

export function parseDetailContent(raw: string): ParsedDetail {
  let parsed: { summary?: unknown; sections?: unknown };
  try {
    parsed = JSON.parse(extractJson(raw)) as { summary?: unknown; sections?: unknown };
  } catch {
    throw new Error('AI 详情返回格式无效');
  }
  if (!Array.isArray(parsed.sections)) throw new Error('AI 详情缺少段落');

  const complianceFlags = new Set<string>();
  const sections = parsed.sections
    .slice(0, 5)
    .map((value) => parseSection(value, complianceFlags))
    .filter((value): value is DetailSection => !!value);
  if (sections.length < 3) throw new Error('AI 详情有效段落不足 3 个');

  const summary = sanitizeText(parsed.summary, 180, complianceFlags);
  const detailHtml = [
    '<div class="supplier-detail">',
    summary ? `<p class="supplier-detail-summary">${escapeHtml(summary)}</p>` : '',
    ...sections.map(
      (section) =>
        `<section><h2>${escapeHtml(section.heading)}</h2><p>${escapeHtml(section.body)}</p>${
          section.bullets.length
            ? `<ul>${section.bullets.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
            : ''
        }</section>`,
    ),
    '</div>',
  ].join('');

  return { summary, sections, detailHtml, complianceFlags: [...complianceFlags] };
}

function parseSection(value: unknown, flags: Set<string>): DetailSection | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const heading = sanitizeText(record.heading, 40, flags);
  const body = sanitizeText(record.body, 360, flags);
  if (!heading || !body) return null;
  const bullets = Array.isArray(record.bullets)
    ? record.bullets
        .slice(0, 6)
        .map((item) => sanitizeText(item, 120, flags))
        .filter(Boolean)
    : [];
  return { heading, body, bullets };
}

function sanitizeText(value: unknown, maxLength: number, flags: Set<string>): string {
  if (typeof value !== 'string') return '';
  let text = value
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  for (const [word, replacement] of FORBIDDEN_REPLACEMENTS) {
    if (!text.includes(word)) continue;
    text = text.replaceAll(word, replacement);
    flags.add(`已替换禁用词：${word}`);
  }
  return text.slice(0, maxLength);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function extractJson(raw: string): string {
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) return fence[1].trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) return raw.slice(start, end + 1);
  return raw;
}
