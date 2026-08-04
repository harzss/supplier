#!/usr/bin/env node
/**
 * 1688 采集 CLI。配置跨境代采方案凭证时使用官方 OpenAPI，否则使用 MockAdapter。
 *
 * 用法：
 *   node scripts/crawl-products.mjs --count=20            # 用类目搜索拉 20 个
 *   node scripts/crawl-products.mjs --ids=a,b,c           # 指定 ID 列表
 *   node scripts/crawl-products.mjs --count=10 --dry-run  # 不写库
 *   node scripts/crawl-products.mjs --count=10 --score    # 采集后顺带打分
 *
 * 官方采集需要先订购 1688 跨境代采解决方案，并配置
 * ALIBABA_1688_APP_KEY / ALIBABA_1688_APP_SECRET / ALIBABA_1688_ACCESS_TOKEN。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { persistCrawledProduct, persistOfflineProduct } from './crawl-products-inventory.mjs';

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

// ---- 参数解析 ----
const args = process.argv.slice(2);
function arg(name) {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : undefined;
}
const COUNT = arg('count') ? Number(arg('count')) : undefined;
const IDS = arg('ids') ? arg('ids').split(',').filter(Boolean) : undefined;
const DRY_RUN = args.includes('--dry-run');
const RUN_SCORE = args.includes('--score');
const CATEGORY = arg('category') ?? '女装';

if (!COUNT && !IDS) {
  console.error('请指定 --count=N 或 --ids=a,b,c');
  process.exit(1);
}

// ---- 加载依赖 ----
let crawler;
try {
  crawler = await import(join(ROOT, 'packages/crawler/dist/index.js'));
} catch {
  console.error('❌ 包未编译，先跑：pnpm build');
  process.exit(1);
}
const {
  CrawlWorker,
  MockAdapter,
  OpenApi1688Adapter,
  inventorySnapshot,
  offlineInventorySnapshot,
} = crawler;

// ---- 装配 Adapter ----
function buildAdapter() {
  const appKey = process.env.ALIBABA_1688_APP_KEY?.trim();
  const appSecret = process.env.ALIBABA_1688_APP_SECRET?.trim();
  const accessToken = process.env.ALIBABA_1688_ACCESS_TOKEN?.trim();
  const configured = [appKey, appSecret, accessToken].some(Boolean);
  if (configured) {
    if (!appKey || !appSecret || !accessToken) {
      throw new Error('1688 OpenAPI 配置不完整：需要 APP_KEY、APP_SECRET 和 ACCESS_TOKEN');
    }
    return new OpenApi1688Adapter({
      appKey,
      appSecret,
      accessToken,
      scenario: process.env.ALIBABA_1688_SEARCH_SCENARIO?.trim() || 'all',
      searchFilters: (process.env.ALIBABA_1688_SEARCH_FILTERS ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    });
  }
  return new MockAdapter({ latencyMs: 30, failureRate: 0 });
}

const { PrismaClient } = await import(join(ROOT, 'packages/db/dist/index.js'));
const prisma = new PrismaClient();

// ---- 主流程 ----
async function main() {
  const adapter = buildAdapter();
  console.log(`✓ Adapter: ${adapter.name}`);

  // 1. 决定要拉哪些 ID
  let ids;
  if (IDS) {
    ids = IDS;
  } else {
    if (!adapter.searchByCategory) {
      console.error('❌ 当前 adapter 不支持类目搜索，请用 --ids=...');
      process.exit(1);
    }
    ids = await adapter.searchByCategory(CATEGORY, COUNT);
  }
  console.log(`→ 待采集 ${ids.length} 个商品（类目: ${CATEGORY}）`);

  // 2. 采集
  if (!DRY_RUN) await prisma.$connect();

  const upsertedIds = []; // 记录刚入库的 productId1688，便于打分阶段定位

  const worker = new CrawlWorker({
    adapter,
    concurrency: 4,
    rateLimit: { capacity: 8, refillPerSec: 8 },
    maxRetries: 2,
    retryBaseMs: 300,
    onProduct: async (p) => {
      if (DRY_RUN) {
        console.log(
          `  ✓ ${p.productId1688}  ${p.title.slice(0, 22)}  ¥${p.price}  月销 ${p.monthlySold}`,
        );
        return;
      }
      await persistCrawledProduct(prisma, p, inventorySnapshot(p), new Date());
      upsertedIds.push(p.productId1688);
    },
    onNotFound: async (productId1688) => {
      if (DRY_RUN) {
        console.log(`  ↘ ${productId1688} 已下架或不存在`);
        return;
      }
      const now = new Date();
      const inventory = offlineInventorySnapshot(productId1688);
      await persistOfflineProduct(prisma, productId1688, inventory, now);
    },
    onProgress: (done, total) => {
      if (done % 5 === 0 || done === total) {
        process.stdout.write(`\r  进度 ${done}/${total}`);
      }
    },
  });

  const t0 = Date.now();
  const report = await worker.crawl(ids);
  const elapsed = Date.now() - t0;
  process.stdout.write('\n');

  // 3. 报告
  console.log('');
  console.log(`✓ 采集完成（${elapsed}ms）`);
  console.log(`  成功 ${report.succeeded} / 失败 ${report.failed} / 总计 ${report.total}`);
  console.log(
    `  耗时 P50=${report.durations.p50}ms  P95=${report.durations.p95}ms  Max=${report.durations.max}ms`,
  );
  if (report.errors.length) {
    console.log(`  错误样本：`);
    for (const e of report.errors.slice(0, 5)) {
      console.log(`    ${e.productId1688}: ${e.reason}${e.isFatal ? ' (fatal)' : ''}`);
    }
  }

  // 4. 顺带打分
  if (RUN_SCORE && !DRY_RUN && upsertedIds.length > 0) {
    console.log('\n→ 触发打分...');
    const scoring = await import(join(ROOT, 'packages/scoring/dist/index.js'));
    const { scoreProductWithReason } = scoring;
    const products = await prisma.sourceProduct.findMany({
      where: { productId1688: { in: upsertedIds } },
    });
    for (const p of products) {
      const features = featuresFromProduct(p);
      const result = await scoreProductWithReason(features, { forceTemplate: true });
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
    console.log(`✓ 打分完成（${products.length} 条）`);
  }
}

function featuresFromProduct(p) {
  const attrs = p.attributes && typeof p.attributes === 'object' ? p.attributes : {};
  const signals = attrs.signals && typeof attrs.signals === 'object' ? attrs.signals : {};
  return {
    productId1688: p.productId1688,
    title: p.title,
    categoryL1: p.categoryL1 ?? undefined,
    categoryL2: p.categoryL2 ?? undefined,
    purchasePrice: Number(p.price),
    monthlySold1688: p.monthlySold ?? 0,
    douyinHeat7d: signals.douyinHeat7d,
    douyinHeat30d: signals.douyinHeat30d,
    xhsNoteCount30d: signals.xhsNoteCount30d,
    taobaoSameStyleCount: signals.taobaoSameStyleCount,
    douyinSameStyleCount: signals.douyinSameStyleCount,
    competitorMedianPrice: signals.competitorMedianPrice,
    estimatedShipping: signals.estimatedShipping,
    categoryRiskLevel: signals.categoryRiskLevel,
    sensitiveWordsHit: signals.sensitiveWordsHit,
    growthRate30d: signals.growthRate30d,
  };
}

main()
  .catch((err) => {
    console.error('❌', err.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
