import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { CategoryNode } from '@supplier/platform-sdk';
import { PrismaService } from '../../common/prisma.module';
import { PlatformAdapterFactory, isDemoShop } from '../shop/platform-adapter.factory';
import { ShopTokenService } from '../shop/shop-token.service';

const CHANNEL = 0;
const INSERT_BATCH_SIZE = 500;

export interface CategoryCatalogStatus {
  shopId: string;
  shopName: string | null;
  connectionType: 'demo' | 'oauth';
  synced: boolean;
  nodeCount: number;
  leafCount: number;
  syncedAt: string | null;
}

export interface CategorySuggestionView {
  shopId: string;
  sourceProductId: string;
  sourceTitle: string;
  catalogSyncedAt: string;
  recommendId: string | null;
  candidates: Array<{
    rank: number;
    categoryId: string;
    categoryName: string;
    categoryPath: string;
    qualificationStatus: 0 | 1 | 2 | null;
    confidence: null;
  }>;
}

@Injectable()
export class CategoryCatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly adapters: PlatformAdapterFactory,
    private readonly shopTokens: ShopTokenService,
  ) {}

  async status(userId: bigint, shopIdValue: string): Promise<CategoryCatalogStatus> {
    const shop = await this.findShop(userId, shopIdValue);
    const [nodeCount, leafCount, latest] = await Promise.all([
      this.prisma.shopCategory.count({ where: { shopId: shop.id, channel: CHANNEL } }),
      this.prisma.shopCategory.count({
        where: { shopId: shop.id, channel: CHANNEL, isLeaf: true, enabled: true },
      }),
      this.prisma.shopCategory.findFirst({
        where: { shopId: shop.id, channel: CHANNEL },
        orderBy: { syncedAt: 'desc' },
        select: { syncedAt: true },
      }),
    ]);
    return {
      shopId: shop.id.toString(),
      shopName: shop.shopName,
      connectionType: isDemoShop(shop) ? 'demo' : 'oauth',
      synced: nodeCount > 0,
      nodeCount,
      leafCount,
      syncedAt: latest?.syncedAt.toISOString() ?? null,
    };
  }

  async sync(userId: bigint, shopIdValue: string): Promise<CategoryCatalogStatus> {
    const shop = await this.findShop(userId, shopIdValue);
    const adapter = this.adapters.create(shop);
    const token = isDemoShop(shop)
      ? 'mock-token'
      : await this.shopTokens.getAccessToken(shop.id, userId);
    const nodes = await adapter.getCategoryTree(token);
    const syncedAt = new Date();
    const rows = materializeCatalog(nodes).map((node) => ({
      shopId: shop.id,
      channel: CHANNEL,
      categoryId: node.id,
      name: node.name,
      parentId: node.parentId ?? null,
      path: node.path,
      level: node.level,
      isLeaf: node.isLeaf,
      enabled: node.enabled,
      syncedAt,
    }));
    const operations = [
      this.prisma.shopCategory.deleteMany({ where: { shopId: shop.id, channel: CHANNEL } }),
      ...chunk(rows, INSERT_BATCH_SIZE).map((data) =>
        this.prisma.shopCategory.createMany({ data }),
      ),
    ];
    await this.prisma.$transaction(operations);
    return this.status(userId, shop.id.toString());
  }

  async suggestions(
    userId: bigint,
    sourceProductId: string,
    shopIdValue: string,
  ): Promise<CategorySuggestionView> {
    const shop = await this.findShop(userId, shopIdValue);
    const product = await this.prisma.sourceProduct.findUnique({
      where: { productId1688: sourceProductId },
      select: { productId1688: true, title: true },
    });
    if (!product) throw new NotFoundException('货源不存在');

    const latest = await this.prisma.shopCategory.findFirst({
      where: { shopId: shop.id, channel: CHANNEL },
      orderBy: { syncedAt: 'desc' },
      select: { syncedAt: true },
    });
    if (!latest) throw new BadRequestException('请先同步该店铺的官方类目目录');

    const adapter = this.adapters.create(shop);
    if (!adapter.recommendCategories) {
      throw new ServiceUnavailableException('当前平台暂不支持类目预测');
    }
    const token = isDemoShop(shop)
      ? 'mock-token'
      : await this.shopTokens.getAccessToken(shop.id, userId);
    const result = await adapter.recommendCategories(token, { title: product.title });
    const ids = result.recommendations.map((item) => item.categoryId);
    const categories = ids.length
      ? await this.prisma.shopCategory.findMany({
          where: {
            shopId: shop.id,
            channel: CHANNEL,
            categoryId: { in: ids },
            isLeaf: true,
            enabled: true,
          },
        })
      : [];
    const byId = new Map(categories.map((category) => [category.categoryId, category]));
    const candidates = result.recommendations.flatMap((recommendation, index) => {
      const category = byId.get(recommendation.categoryId);
      return category
        ? [
            {
              rank: index + 1,
              categoryId: category.categoryId,
              categoryName: category.name,
              categoryPath: category.path,
              qualificationStatus: recommendation.qualificationStatus,
              confidence: null,
            },
          ]
        : [];
    });
    if (candidates.length === 0) {
      throw new BadRequestException('官方预测未命中当前店铺的可用叶子类目，请重新同步目录');
    }
    return {
      shopId: shop.id.toString(),
      sourceProductId: product.productId1688,
      sourceTitle: product.title,
      catalogSyncedAt: latest.syncedAt.toISOString(),
      recommendId: result.recommendId ?? null,
      candidates,
    };
  }

  async assertSelectable(userId: bigint, shopIdValue: string, categoryId: string): Promise<void> {
    const shop = await this.findShop(userId, shopIdValue);
    const category = await this.prisma.shopCategory.findFirst({
      where: {
        shopId: shop.id,
        channel: CHANNEL,
        categoryId,
        isLeaf: true,
        enabled: true,
      },
      select: { id: true },
    });
    if (!category) {
      throw new BadRequestException('所选类目不在该店铺已同步的可用叶子类目目录中');
    }
  }

  private async findShop(userId: bigint, shopIdValue: string) {
    const shopId = parsePositiveId(shopIdValue, '店铺 ID');
    const shop = await this.prisma.shop.findFirst({
      where: { id: shopId, userId, platform: 'douyin', role: 'seller', status: 'active' },
    });
    if (!shop) throw new NotFoundException('可用抖店店铺不存在');
    this.adapters.assertAllowed(shop);
    return shop;
  }
}

interface CatalogNode extends CategoryNode {
  path: string;
  enabled: boolean;
}

export function materializeCatalog(nodes: CategoryNode[]): CatalogNode[] {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw new BadRequestException('平台未返回可用类目目录');
  }
  const byId = new Map<string, CategoryNode>();
  for (const node of nodes) {
    if (!node.id || !node.name || byId.has(node.id)) {
      throw new BadRequestException('平台类目目录包含无效或重复节点');
    }
    byId.set(node.id, node);
  }
  const paths = new Map<string, string>();
  const resolving = new Set<string>();
  const resolvePath = (node: CategoryNode): string => {
    const cached = paths.get(node.id);
    if (cached) return cached;
    if (resolving.has(node.id)) throw new BadRequestException('平台类目目录存在循环父子关系');
    resolving.add(node.id);
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    if (node.parentId && !parent) throw new BadRequestException('平台类目目录缺少父节点');
    const path = parent ? `${resolvePath(parent)}/${node.name}` : node.name;
    resolving.delete(node.id);
    paths.set(node.id, path.slice(0, 512));
    return path.slice(0, 512);
  };
  return nodes.map((node) => ({
    ...node,
    path: resolvePath(node),
    enabled: node.enabled !== false,
  }));
}

function parsePositiveId(value: string, label: string): bigint {
  try {
    const id = BigInt(value);
    if (id <= 0n) throw new Error('invalid');
    return id;
  } catch {
    throw new BadRequestException(`无效${label}`);
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}
