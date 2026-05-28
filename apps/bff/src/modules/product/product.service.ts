import { Injectable, Logger, NotFoundException } from '@nestjs/common';
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

@Injectable()
export class ProductService {
  private readonly logger = new Logger(ProductService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 今日推荐：source_products JOIN product_scores，按 overallScore 降序
   */
  async getDailyRecommendations(query: ProductQueryDto): Promise<RecommendationListDto> {
    const where: Prisma.SourceProductWhereInput = {
      score: { isNot: null },
    };
    if (query.categoryL1) where.categoryL1 = query.categoryL1;
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

  async getDetail(productId1688: string): Promise<ProductDto> {
    const product = await this.prisma.sourceProduct
      .findUnique({
        where: { productId1688 },
        include: { score: true },
      })
      .catch((err: Error) => {
        this.logger.warn(`Detail query failed: ${err.message}`);
        return null;
      });
    if (!product) throw new NotFoundException(`Source product not found: ${productId1688}`);
    return serializeProduct(product);
  }
}

/** Prisma 返回 BigInt / Decimal，转换为 JSON 友好格式 */
function serializeProduct(
  p: Prisma.SourceProductGetPayload<{ include: { score: true } }>,
): ProductDto {
  return {
    id: p.id.toString(),
    productId1688: p.productId1688,
    title: p.title,
    price: p.price.toString(),
    priceRange:
      p.priceMin && p.priceMax ? [p.priceMin.toString(), p.priceMax.toString()] : null,
    mainImage: p.mainImage,
    categoryPath: p.categoryPath,
    categoryL1: p.categoryL1,
    categoryL2: p.categoryL2,
    monthlySold: p.monthlySold,
    isOnePieceDrop: p.isOnePieceDrop,
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
