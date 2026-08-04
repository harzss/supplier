#!/usr/bin/env node
/**
 * 写入演示用的种子数据（10 个货源 + 打分 + 1 个测试用户）
 *
 * 用法：
 *   1. apps/bff/.env 或 packages/db/.env 配好本地 DATABASE_URL；脚本拒绝任何 Supabase/staging 目标
 *   2. pnpm db:migrate -- --name init   # 第一次先建表
 *   3. pnpm db:seed
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
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
export function readSeedOptions(args, environment) {
  if (
    environment.STAGING_PROJECT_REF !== undefined ||
    isSupabaseDatabaseUrl(environment.DATABASE_URL)
  ) {
    throw new Error(
      'Refusing to run the full seed against staging. Use packages/db/scripts/backfill-staging-mock-supplier-ids.mjs for the targeted repair.',
    );
  }

  if (args.length > 0) {
    throw new Error('Usage: seed.mjs');
  }

  return {};
}

export function isSupabaseDatabaseUrl(value) {
  if (!value) return false;
  try {
    const hostname = new URL(value).hostname.replace(/\.$/, '');
    return (
      /^db\.[a-z0-9]{20}\.supabase\.co$/.test(hostname) ||
      /^[a-z0-9-]+\.pooler\.supabase\.com$/.test(hostname)
    );
  } catch {
    return false;
  }
}

// ---- 样本数据 ----
const PRODUCTS = [
  {
    productId1688: 'mock-1001',
    title: '【纯棉透气】夏季短袖T恤女ins潮 学生宽松休闲百搭',
    price: 18.9,
    priceMin: 16.9,
    priceMax: 22.0,
    mainImage: 'https://picsum.photos/seed/p1/800',
    categoryPath: '女装/T恤',
    categoryL1: '女装',
    categoryL2: 'T恤',
    monthlySold: 8200,
    isOnePieceDrop: true,
    score: {
      demand: 92,
      competition: 65,
      profit: 78,
      compliance: 95,
      trend: 88,
      overall: 84.6,
      reason: ['抖音 7 日热度 +210%', '同款利润空间 35%+', '类目合规度高'],
    },
  },
  {
    productId1688: 'mock-1002',
    title: '夏季冰丝凉感口罩透气防晒成人 男女骑行护脸',
    price: 4.5,
    priceMin: 3.8,
    priceMax: 6.0,
    mainImage: 'https://picsum.photos/seed/p2/800',
    categoryPath: '配饰/口罩',
    categoryL1: '配饰',
    categoryL2: '口罩',
    monthlySold: 23400,
    isOnePieceDrop: true,
    score: {
      demand: 88,
      competition: 72,
      profit: 60,
      compliance: 70,
      trend: 90,
      overall: 76.0,
      reason: ['夏季旺季', '小红书种草量大', '注意"防晒"宣称合规'],
    },
  },
  {
    productId1688: 'mock-1003',
    title: '不锈钢吸管杯 ins高颜值 大容量便携运动水杯',
    price: 22.0,
    priceMin: 19.5,
    priceMax: 28.0,
    mainImage: 'https://picsum.photos/seed/p3/800',
    categoryPath: '家居/水杯',
    categoryL1: '家居',
    categoryL2: '水杯',
    monthlySold: 5600,
    isOnePieceDrop: true,
    score: {
      demand: 75,
      competition: 55,
      profit: 82,
      compliance: 95,
      trend: 70,
      overall: 75.4,
      reason: ['利润空间大', '竞争中等'],
    },
  },
  {
    productId1688: 'mock-1004',
    title: '宠物自动饮水器 静音循环过滤 猫咪狗狗饮水机',
    price: 38.0,
    priceMin: 32.0,
    priceMax: 45.0,
    mainImage: 'https://picsum.photos/seed/p4/800',
    categoryPath: '宠物/饮水器',
    categoryL1: '宠物',
    categoryL2: '饮水器',
    monthlySold: 3100,
    isOnePieceDrop: true,
    score: {
      demand: 82,
      competition: 50,
      profit: 75,
      compliance: 90,
      trend: 85,
      overall: 78.4,
      reason: ['宠物赛道增长', '同款少'],
    },
  },
  {
    productId1688: 'mock-1005',
    title: '硅胶手机壳 创意可爱 适用 iPhone15 全包防摔',
    price: 8.8,
    priceMin: 7.5,
    priceMax: 12.0,
    mainImage: 'https://picsum.photos/seed/p5/800',
    categoryPath: '数码/手机壳',
    categoryL1: '数码',
    categoryL2: '手机壳',
    monthlySold: 18200,
    isOnePieceDrop: true,
    score: {
      demand: 80,
      competition: 90,
      profit: 50,
      compliance: 85,
      trend: 65,
      overall: 64.5,
      reason: ['竞争激烈', '需差异化设计'],
    },
  },
  {
    productId1688: 'mock-1006',
    title: '亚麻沙发垫四季通用 防滑加厚 ins简约客厅坐垫',
    price: 35.0,
    priceMin: 28.0,
    priceMax: 55.0,
    mainImage: 'https://picsum.photos/seed/p6/800',
    categoryPath: '家居/沙发垫',
    categoryL1: '家居',
    categoryL2: '沙发垫',
    monthlySold: 4500,
    isOnePieceDrop: true,
    score: {
      demand: 70,
      competition: 60,
      profit: 80,
      compliance: 92,
      trend: 72,
      overall: 73.4,
      reason: ['客单价较高', '类目稳定'],
    },
  },
  {
    productId1688: 'mock-1007',
    title: '便携式电动榨汁杯 USB充电 学生宿舍小型迷你果汁机',
    price: 45.0,
    priceMin: 38.0,
    priceMax: 60.0,
    mainImage: 'https://picsum.photos/seed/p7/800',
    categoryPath: '小家电/榨汁机',
    categoryL1: '小家电',
    categoryL2: '榨汁机',
    monthlySold: 6800,
    isOnePieceDrop: true,
    score: {
      demand: 78,
      competition: 70,
      profit: 70,
      compliance: 88,
      trend: 80,
      overall: 73.8,
      reason: ['暑期需求旺', '内容好做'],
    },
  },
  {
    productId1688: 'mock-1008',
    title: '收纳盒桌面整理盒 ins风 化妆品文具杂物分隔抽屉',
    price: 12.5,
    priceMin: 10.0,
    priceMax: 16.0,
    mainImage: 'https://picsum.photos/seed/p8/800',
    categoryPath: '家居/收纳',
    categoryL1: '家居',
    categoryL2: '收纳',
    monthlySold: 9100,
    isOnePieceDrop: true,
    score: {
      demand: 72,
      competition: 75,
      profit: 65,
      compliance: 95,
      trend: 68,
      overall: 65.4,
      reason: ['长青品类', '注意打差异'],
    },
  },
  {
    productId1688: 'mock-1009',
    title: '儿童益智拼图 木质卡通动物 早教启蒙2-6岁玩具',
    price: 18.0,
    priceMin: 14.0,
    priceMax: 25.0,
    mainImage: 'https://picsum.photos/seed/p9/800',
    categoryPath: '玩具/益智',
    categoryL1: '玩具',
    categoryL2: '益智',
    monthlySold: 4300,
    isOnePieceDrop: true,
    score: {
      demand: 76,
      competition: 55,
      profit: 78,
      compliance: 80,
      trend: 72,
      overall: 71.6,
      reason: ['母婴垂类好做', '注意 3C 认证'],
    },
  },
  {
    productId1688: 'mock-1010',
    title: '运动腰包跑步手机包 户外健身防水 男女通用斜挎',
    price: 16.0,
    priceMin: 13.0,
    priceMax: 22.0,
    mainImage: 'https://picsum.photos/seed/p10/800',
    categoryPath: '运动/腰包',
    categoryL1: '运动',
    categoryL2: '腰包',
    monthlySold: 7400,
    isOnePieceDrop: true,
    score: {
      demand: 74,
      competition: 68,
      profit: 70,
      compliance: 92,
      trend: 75,
      overall: 70.8,
      reason: ['夏季运动旺季'],
    },
  },
];

function mockSupplierId(productId1688) {
  return `mock-supplier-${productId1688}`;
}

async function seed(prisma) {
  console.log('→ Connecting...');
  await prisma.$connect();
  console.log('✓ Connected');

  console.log('→ Seeding test user...');
  const user = await prisma.user.upsert({
    where: { phone: '13800000001' },
    create: { phone: '13800000001', nickname: '测试用户', plan: 'pro' },
    update: { nickname: '测试用户', plan: 'pro' },
  });
  console.log(`✓ User #${user.id}`);

  console.log('→ Seeding source products...');
  let created = 0;
  for (const p of PRODUCTS) {
    const { score, ...productData } = p;
    const skuList = [
      {
        skuId: `${p.productId1688}-default`,
        specName: '默认',
        price: p.price,
        stock: 100,
        attributes: {},
      },
    ];
    const inventoryFingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          availability: 'available',
          inventory: [{ skuId: skuList[0].skuId, stock: 100 }],
          productId1688: p.productId1688,
        }),
      )
      .digest('hex');
    const sourceData = {
      ...productData,
      supplierId: mockSupplierId(p.productId1688),
      skuList,
      availability: 'available',
      totalStock: 100,
      inventoryFingerprint,
      inventoryVersion: 1,
    };
    const product = await prisma.sourceProduct.upsert({
      where: { productId1688: p.productId1688 },
      create: sourceData,
      update: sourceData,
    });
    await prisma.productScore.upsert({
      where: { productId: product.id },
      create: {
        productId: product.id,
        demandScore: score.demand,
        competitionScore: score.competition,
        profitScore: score.profit,
        complianceScore: score.compliance,
        trendScore: score.trend,
        overallScore: score.overall,
        reason: score.reason,
        features: {},
      },
      update: {
        demandScore: score.demand,
        competitionScore: score.competition,
        profitScore: score.profit,
        complianceScore: score.compliance,
        trendScore: score.trend,
        overallScore: score.overall,
        reason: score.reason,
      },
    });
    created++;
  }

  const seededProducts = await prisma.sourceProduct.findMany({
    where: { productId1688: { in: PRODUCTS.map((product) => product.productId1688) } },
    select: {
      productId1688: true,
      supplierId: true,
      availability: true,
      isOnePieceDrop: true,
    },
  });
  const seededProductById = new Map(
    seededProducts.map((product) => [product.productId1688, product]),
  );
  const invalidProductIds = PRODUCTS.flatMap((expected) => {
    const actual = seededProductById.get(expected.productId1688);
    return actual?.supplierId === mockSupplierId(expected.productId1688) &&
      actual.availability === 'available' &&
      actual.isOnePieceDrop
      ? []
      : [expected.productId1688];
  });
  if (invalidProductIds.length) {
    throw new Error(
      `Seeded source products are not publish-ready: ${invalidProductIds.join(', ')}`,
    );
  }
  console.log(`✓ ${created} products + scores (publish-ready metadata verified)`);

  const top = await prisma.sourceProduct.findMany({
    take: 3,
    orderBy: { score: { overallScore: 'desc' } },
    include: { score: true },
  });
  console.log('\n--- Top 3 推荐 ---');
  for (const p of top) {
    console.log(`  ${p.score?.overallScore.toFixed(1)}  ${p.title.slice(0, 30)}`);
  }
  console.log('\n✓ 完成。打开 Prisma Studio: pnpm db:studio');
}

async function main() {
  loadEnv(join(ROOT, 'packages/db/.env'));
  loadEnv(join(ROOT, 'apps/bff/.env'));
  loadEnv(join(ROOT, '.env'));

  readSeedOptions(process.argv.slice(2), process.env);
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL 未配置，请先填 packages/db/.env');
  }

  const { PrismaClient } = await import(join(ROOT, 'packages/db/dist/index.js'));
  const prisma = new PrismaClient();
  try {
    await seed(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  main().catch((err) => {
    console.error('❌', err.message);
    process.exitCode = 1;
  });
}
