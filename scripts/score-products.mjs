#!/usr/bin/env node
/**
 * 选品打分 CLI：
 *   1. 从 Supabase 读 source_products
 *   2. 调用 @supplier/scoring 计算 5 维分数
 *   3. 用 LLM 生成推荐理由（无 Key 时模板兜底）
 *   4. upsert 到 product_scores 表
 *
 * 用法：
 *   node scripts/score-products.mjs                  # 处理全部
 *   node scripts/score-products.mjs --limit=5        # 只处理前 5 个
 *   node scripts/score-products.mjs --dry-run        # 不写库
 *
 * 信号字段：scorer 期望 douyinHeat7d / taobaoSameStyleCount 等。
 * 这些字段实际由采集 worker 填入 source_products.attributes.signals。
 * PoC 阶段：从 attributes.signals 读取，没有就用 monthlySold 反推 + 默认值。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '..');

function loadEnv(path) {
  try {
    const text = readFileSync(path, 'utf8');
    for (const line of text.split('\n')) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m && !process.env[m[1]]) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  } catch {}
}
loadEnv(join(ROOT, 'packages/db/.env'));
loadEnv(join(ROOT, 'apps/bff/.env'));
loadEnv(join(ROOT, '.env'));

// ---- 解析参数 ----
const args = process.argv.slice(2);
const limitArg = args.find((a) => a.startsWith('--limit='));
const LIMIT = limitArg ? Number(limitArg.split('=')[1]) : undefined;
const DRY_RUN = args.includes('--dry-run');

// ---- 加载依赖 ----
let scoring, llmModule;
try {
  scoring = await import(join(ROOT, 'packages/scoring/dist/index.js'));
  llmModule = await import(join(ROOT, 'packages/llm-client/dist/index.js'));
} catch {
  console.error('❌ 包还没编译，先跑：pnpm build');
  process.exit(1);
}

const { scoreProductWithReason } = scoring;
const { LlmClient, createDeepSeek, createDashScope, createOpenAi, createAnthropic } = llmModule;

// ---- 装配 LLM（可选） ----
function buildLlmClient() {
  const primary = new Map();
  if (process.env.DEEPSEEK_API_KEY) {
    primary.set('deepseek-v3', createDeepSeek(process.env.DEEPSEEK_API_KEY));
  } else if (process.env.DASHSCOPE_API_KEY) {
    const ds = createDashScope(process.env.DASHSCOPE_API_KEY);
    primary.set('qwen-plus', ds);
  } else if (process.env.OPENAI_API_KEY) {
    primary.set('gpt-4o-mini', createOpenAi(process.env.OPENAI_API_KEY));
  } else if (process.env.ANTHROPIC_API_KEY) {
    primary.set('claude-haiku-4', createAnthropic(process.env.ANTHROPIC_API_KEY));
  }
  if (primary.size === 0) return { client: null, model: null };
  const client = new LlmClient({ primary, maxRetries: 1, retryBaseMs: 200 });
  const model = [...primary.keys()][0];
  return { client, model };
}

const { client: llm, model: llmModel } = buildLlmClient();
console.log(llm ? `✓ LLM: ${llmModel}` : '⚠ 无 LLM Key，理由用模板兜底');

// ---- DB ----
const { PrismaClient } = await import(join(ROOT, 'packages/db/dist/index.js'));
const prisma = new PrismaClient();

// ---- 特征构造 ----
function buildFeatures(p) {
  const attrs = (p.attributes && typeof p.attributes === 'object') ? p.attributes : {};
  const signals = attrs.signals && typeof attrs.signals === 'object' ? attrs.signals : {};

  // 月销缺失时给 0；用于 demand 维度
  const monthly = p.monthlySold ?? 0;
  // 没有真实信号时，把月销做一个粗略外推（仅 PoC）
  const douyinHeat7dGuess = monthly > 0 ? Math.round(monthly * 0.4) : undefined;
  const douyinHeat30dGuess = monthly > 0 ? Math.round(monthly * 1.5) : undefined;

  return {
    productId1688: p.productId1688,
    title: p.title,
    categoryL1: p.categoryL1 ?? undefined,
    categoryL2: p.categoryL2 ?? undefined,
    purchasePrice: Number(p.price),
    monthlySold1688: monthly,

    douyinHeat7d: signals.douyinHeat7d ?? douyinHeat7dGuess,
    douyinHeat30d: signals.douyinHeat30d ?? douyinHeat30dGuess,
    xhsNoteCount30d: signals.xhsNoteCount30d,

    taobaoSameStyleCount: signals.taobaoSameStyleCount,
    douyinSameStyleCount: signals.douyinSameStyleCount,
    competitorMedianPrice: signals.competitorMedianPrice ?? Number(p.price) * 2.2,

    estimatedShipping: signals.estimatedShipping ?? 4, // 默认 4 元运费

    categoryRiskLevel: signals.categoryRiskLevel ?? riskByCategory(p.categoryL1),
    sensitiveWordsHit: signals.sensitiveWordsHit ?? 0,

    growthRate30d: signals.growthRate30d ?? 0,
  };
}

function riskByCategory(l1) {
  if (!l1) return 'low';
  if (['食品', '保健', '医疗器械', '化妆品', '母婴'].some((k) => l1.includes(k))) return 'high';
  if (['宠物', '玩具'].some((k) => l1.includes(k))) return 'medium';
  return 'low';
}

// ---- 主流程 ----
async function main() {
  console.log('→ Connecting to DB...');
  await prisma.$connect();

  const products = await prisma.sourceProduct.findMany({
    take: LIMIT,
    orderBy: { id: 'asc' },
  });
  console.log(`→ Scoring ${products.length} products${DRY_RUN ? ' (dry-run)' : ''}...`);

  let llmCallsOk = 0;
  let llmCallsFailed = 0;
  const results = [];

  for (const p of products) {
    const features = buildFeatures(p);
    let result;
    try {
      result = await scoreProductWithReason(features, {
        llm: llm ?? undefined,
        model: llmModel ?? undefined,
      });
      if (llm) llmCallsOk++;
    } catch (err) {
      llmCallsFailed++;
      result = await scoreProductWithReason(features, { forceTemplate: true });
      console.warn(`  ⚠ LLM 失败 (${p.productId1688}): ${err.message}`);
    }

    results.push({ product: p, result });

    if (!DRY_RUN) {
      await prisma.productScore.upsert({
        where: { productId: p.id },
        create: {
          productId: p.id,
          demandScore: result.demand.score,
          competitionScore: result.competition.score,
          profitScore: result.profit.score,
          complianceScore: result.compliance.score,
          trendScore: result.trend.score,
          overallScore: result.overall,
          reason: result.reason,
          features: { input: features, weights: result.weights },
        },
        update: {
          demandScore: result.demand.score,
          competitionScore: result.competition.score,
          profitScore: result.profit.score,
          complianceScore: result.compliance.score,
          trendScore: result.trend.score,
          overallScore: result.overall,
          reason: result.reason,
          features: { input: features, weights: result.weights },
          scoredAt: new Date(),
        },
      });
    }
  }

  // ---- 报告 ----
  results.sort((a, b) => b.result.overall - a.result.overall);
  console.log('\n--- Top 排序 ---');
  for (const { product, result } of results) {
    const reason = result.reason.slice(0, 2).join('；');
    console.log(
      `  ${result.overall.toFixed(1).padStart(5)}  ${product.title.slice(0, 26).padEnd(28)}  | ${reason}`,
    );
  }

  console.log('');
  console.log(`✓ 打分完成：${products.length} 条${DRY_RUN ? '（未写库）' : '已 upsert'}`);
  if (llm) console.log(`  LLM 调用：成功 ${llmCallsOk}，失败 ${llmCallsFailed}`);
}

main()
  .catch((err) => {
    console.error('❌', err.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
