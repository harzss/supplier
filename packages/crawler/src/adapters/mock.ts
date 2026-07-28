import type { SourceAdapter } from '../adapter';
import { CrawlerError } from '../adapter';
import type { CrawledProduct } from '../types';

/**
 * Mock Adapter — 用于本地开发与端到端测试。
 * 根据 productId1688 的种子值生成确定性的多样化商品。
 * 支持模拟 not_found / rate_limited 故障场景：
 *   id 包含 "missing" → 返回 null
 *   id 包含 "ratelimit" → 抛 rate_limited
 */
const CATEGORIES = [
  { l1: '女装', l2: 'T恤' },
  { l1: '女装', l2: '连衣裙' },
  { l1: '配饰', l2: '口罩' },
  { l1: '家居', l2: '水杯' },
  { l1: '家居', l2: '收纳' },
  { l1: '家居', l2: '沙发垫' },
  { l1: '宠物', l2: '饮水器' },
  { l1: '数码', l2: '手机壳' },
  { l1: '小家电', l2: '榨汁机' },
  { l1: '玩具', l2: '益智' },
  { l1: '运动', l2: '腰包' },
  { l1: '美妆', l2: '化妆刷' },
  { l1: '食品', l2: '零食' },
  { l1: '母婴', l2: '辅食' },
];

const TITLES = [
  ['【纯棉透气】夏季短袖T恤女ins潮 学生宽松休闲百搭'],
  ['法式碎花连衣裙女夏 显瘦温柔风度假裙'],
  ['夏季冰丝凉感口罩透气成人 男女骑行护脸'],
  ['不锈钢吸管杯 ins高颜值 大容量便携运动水杯'],
  ['桌面收纳盒 ins风 化妆品文具杂物分隔抽屉'],
  ['亚麻沙发垫四季通用 防滑加厚 ins简约客厅坐垫'],
  ['宠物自动饮水器 静音循环过滤 猫咪狗狗饮水机'],
  ['硅胶手机壳 创意可爱 适用 iPhone15 全包防摔'],
  ['便携式电动榨汁杯 USB充电 学生宿舍小型迷你果汁机'],
  ['儿童益智拼图 木质卡通动物 早教启蒙2-6岁玩具'],
  ['运动腰包跑步手机包 户外健身防水 男女通用斜挎'],
  ['化妆刷套装 12 支软毛便携初学者全套美妆工具'],
  ['手工坚果零食 大礼包 办公室解馋'],
  ['宝宝米粉婴幼儿辅食有机营养'],
];

export interface MockAdapterOptions {
  /** 模拟单次请求耗时（ms）。默认 50ms */
  latencyMs?: number;
  /** 失败率（0..1）— 每次请求按概率抛 network 错。默认 0 */
  failureRate?: number;
}

export class MockAdapter implements SourceAdapter {
  readonly name = 'mock-1688';

  constructor(private readonly opts: MockAdapterOptions = {}) {}

  async fetchProduct(productId1688: string): Promise<CrawledProduct | null> {
    await sleep(this.opts.latencyMs ?? 50);

    if (productId1688.includes('missing')) return null;
    if (productId1688.includes('ratelimit')) {
      throw new CrawlerError('mock rate limit', 'rate_limited', 429);
    }
    if (this.opts.failureRate && Math.random() < this.opts.failureRate) {
      throw new CrawlerError('mock network error', 'network');
    }

    const seed = hashStr(productId1688);
    const cat = CATEGORIES[seed % CATEGORIES.length]!;
    const title = TITLES[seed % TITLES.length]![0]!;
    const purchase = round2(5 + (seed % 50) + Math.random() * 5);
    const monthlySold = Math.floor(500 + (seed % 30_000));
    const skuList = buildMockSkus(productId1688, cat.l1, purchase, seed);

    // 类目敏感性 → 风险等级
    const risk: 'low' | 'medium' | 'high' = ['食品', '母婴', '化妆品'].some((k) =>
      cat.l1.includes(k),
    )
      ? 'high'
      : ['宠物', '玩具'].some((k) => cat.l1.includes(k))
        ? 'medium'
        : 'low';

    return {
      productId1688,
      supplierId: `supplier-${seed % 1000}`,
      title,
      price: purchase,
      priceMin: round2(purchase * 0.85),
      priceMax: round2(purchase * 1.15),
      mainImage: `https://picsum.photos/seed/${productId1688}/800`,
      detailImages: [1, 2, 3].map((i) => `https://picsum.photos/seed/${productId1688}-${i}/800`),
      categoryPath: `${cat.l1}/${cat.l2}`,
      categoryL1: cat.l1,
      categoryL2: cat.l2,
      monthlySold,
      isCrossBorder: false,
      isOnePieceDrop: true,
      skuList,
      attributes: { material: '棉/合成', source: 'mock' },
      // 模拟外部信号
      signals: {
        douyinHeat7d: Math.floor(monthlySold * (0.3 + Math.random() * 0.7)),
        douyinHeat30d: Math.floor(monthlySold * (1 + Math.random() * 2)),
        xhsNoteCount30d: Math.floor(monthlySold * 0.05),
        taobaoSameStyleCount: Math.floor((seed % 4000) + 50),
        douyinSameStyleCount: Math.floor((seed % 800) + 10),
        competitorMedianPrice: round2(purchase * (1.8 + Math.random() * 1.5)),
        estimatedShipping: round2(3 + (seed % 5)),
        categoryRiskLevel: risk,
        sensitiveWordsHit: title.includes('防摔') || title.includes('有机') ? 1 : 0,
        growthRate30d: round2(-0.3 + Math.random() * 1.5),
      },
    };
  }

  async searchByCategory(categoryL1: string, limit: number): Promise<string[]> {
    await sleep(30);
    const ids: string[] = [];
    for (let i = 0; i < limit; i++) {
      ids.push(`mock-${categoryL1}-${i + 1}`);
    }
    return ids;
  }
}

function buildMockSkus(productId: string, categoryL1: string, purchase: number, seed: number) {
  const secondDimension = categoryL1 === '女装' ? '尺码' : '款式';
  const secondValues = categoryL1 === '女装' ? ['M', 'L'] : ['标准款', '升级款'];
  return ['米白', '黑色'].flatMap((color, colorIndex) =>
    secondValues.map((secondValue, valueIndex) => ({
      skuId: `${productId}-sku-${colorIndex * 2 + valueIndex + 1}`,
      specName: `颜色:${color};${secondDimension}:${secondValue}`,
      price: round2(purchase + valueIndex * 1.5),
      stock: 80 + ((seed + colorIndex * 17 + valueIndex * 29) % 120),
      attributes: { 颜色: color, [secondDimension]: secondValue },
      image: `https://picsum.photos/seed/${productId}-${colorIndex + 1}/800`,
    })),
  );
}

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
