import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@supplier/db';
import { PrismaService } from '../../common/prisma.module';
import type { ProductQueryDto } from './dto/product-query.dto';

export interface ProductDto {
  id: string;
  productId1688: string;
  title: string;
  price: string;
  priceRange: [string, string] | null;
  mainImage: string | null;
  categoryPath: string | null;
  categoryL1: string | null;
  categoryL2: string | null;
  monthlySold: number;
  isOnePieceDrop: boolean;
  availability: 'available' | 'out_of_stock' | 'offline' | 'unknown';
  totalStock: number;
  availabilityChangedAt: string;
  score: {
    overall: number;
    demand: number;
    competition: number;
    profit: number;
    compliance: number;
    trend: number;
    reason: unknown;
  } | null;
  syncedAt: string;
}

export interface RecommendationListDto {
  total: number;
  items: ProductDto[];
  degraded?: boolean;
}

export interface ProductFacetsDto {
  categories: Array<{ name: string; count: number }>;
  priceRange: { min: number; max: number } | null;
  degraded?: boolean;
}

@Injectable()
export class ProductService {
  private readonly logger = new Logger(ProductService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 今日推荐：source_products JOIN product_scores，按 overallScore 降序
   */
  async getDailyRecommendations(query: ProductQueryDto): Promise<RecommendationListDto> {
    assertValidPriceRange(query);
    const where: Prisma.SourceProductWhereInput = {
      availability: 'available',
      score: { isNot: null },
    };
    const categoryL1 = query.categoryL1?.trim();
    if (categoryL1) where.categoryL1 = categoryL1;
    if (query.priceMin !== undefined || query.priceMax !== undefined) {
      where.price = {};
      if (query.priceMin !== undefined) where.price.gte = query.priceMin;
      if (query.priceMax !== undefined) where.price.lte = query.priceMax;
    }

    try {
      const items = await this.prisma.sourceProduct.findMany({
        where,
        take: query.limit,
        orderBy: { score: { overallScore: 'desc' } },
        include: { score: true },
      });
      return {
        total: items.length,
        items: items.map(serializeProduct),
      };
    } catch (err) {
      this.logger.warn(`Recommendations query failed: ${(err as Error).message}`);
      return { total: 0, items: [], degraded: true };
    }
  }

  async getFacets(): Promise<ProductFacetsDto> {
    try {
      const groups = await this.prisma.sourceProduct.groupBy({
        by: ['categoryL1'],
        where: { availability: 'available', score: { isNot: null } },
        _count: { _all: true },
        _min: { price: true },
        _max: { price: true },
      });
      let priceMin = Number.POSITIVE_INFINITY;
      let priceMax = Number.NEGATIVE_INFINITY;
      const categories: ProductFacetsDto['categories'] = [];
      for (const group of groups) {
        if (group._min.price) priceMin = Math.min(priceMin, Number(group._min.price));
        if (group._max.price) priceMax = Math.max(priceMax, Number(group._max.price));
        if (group.categoryL1) categories.push({ name: group.categoryL1, count: group._count._all });
      }
      categories.sort(
        (left, right) => right.count - left.count || left.name.localeCompare(right.name),
      );
      return {
        categories,
        priceRange:
          Number.isFinite(priceMin) && Number.isFinite(priceMax)
            ? { min: priceMin, max: priceMax }
            : null,
      };
    } catch (err) {
      this.logger.warn(`Product facets query failed: ${(err as Error).message}`);
      return { categories: [], priceRange: null, degraded: true };
    }
  }

  async getDetail(productId1688: string): Promise<ProductDto> {
    const product = await this.prisma.sourceProduct.findUnique({
      where: { productId1688 },
      include: { score: true },
    });
    if (!product) throw new NotFoundException(`Source product not found: ${productId1688}`);
    return serializeProduct(product);
  }
}

function assertValidPriceRange(query: ProductQueryDto): void {
  if (
    query.priceMin !== undefined &&
    query.priceMax !== undefined &&
    query.priceMin > query.priceMax
  ) {
    throw new BadRequestException('最低采购价不能高于最高采购价');
  }
}

/** Prisma 返回 BigInt / Decimal，转换为 JSON 友好格式 */
export function serializeProduct(
  p: Prisma.SourceProductGetPayload<{ include: { score: true } }>,
): ProductDto {
  return {
    id: p.id.toString(),
    productId1688: p.productId1688,
    title: p.title,
    price: p.price.toString(),
    priceRange: p.priceMin && p.priceMax ? [p.priceMin.toString(), p.priceMax.toString()] : null,
    mainImage: p.mainImage,
    categoryPath: p.categoryPath,
    categoryL1: p.categoryL1,
    categoryL2: p.categoryL2,
    monthlySold: p.monthlySold,
    isOnePieceDrop: p.isOnePieceDrop,
    availability: p.availability,
    totalStock: p.totalStock,
    availabilityChangedAt: p.availabilityChangedAt.toISOString(),
    score: p.score
      ? {
          overall: p.score.overallScore,
          demand: p.score.demandScore,
          competition: p.score.competitionScore,
          profit: p.score.profitScore,
          compliance: p.score.complianceScore,
          trend: p.score.trendScore,
          reason: p.score.reason,
        }
      : null,
    syncedAt: p.syncedAt.toISOString(),
  };
}
