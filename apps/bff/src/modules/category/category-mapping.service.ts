import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.module';
import { CategoryCatalogService } from './category-catalog.service';
import type { ConfirmCategoryMappingDto } from './dto/confirm-category-mapping.dto';

export interface CategoryMappingView {
  sourceProductId: string;
  sourceTitle: string;
  sourceCategoryPath: string | null;
  platform: 'douyin';
  confirmed: boolean;
  categoryId: string | null;
  categoryName: string | null;
  confirmedAt: string | null;
}

@Injectable()
export class CategoryMappingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: CategoryCatalogService,
  ) {}

  async get(
    userId: bigint,
    sourceProductId: string,
    platformValue: string,
  ): Promise<CategoryMappingView> {
    const platform = parsePlatform(platformValue);
    const product = await this.findProduct(sourceProductId);
    const mapping = await this.prisma.productCategoryMapping.findUnique({
      where: {
        uk_user_product_platform_category: {
          userId,
          sourceProductId: product.id,
          platform,
        },
      },
    });
    return toView(product, platform, mapping);
  }

  async confirm(
    userId: bigint,
    sourceProductId: string,
    dto: ConfirmCategoryMappingDto,
  ): Promise<CategoryMappingView> {
    const platform = parsePlatform(dto.platform);
    const product = await this.findProduct(sourceProductId);
    const categoryId = validateCategoryId(platform, dto.categoryId);
    if (dto.shopId) await this.catalog.assertSelectable(userId, dto.shopId, categoryId);
    const categoryName = dto.categoryName?.trim() || null;
    const now = new Date();
    const mapping = await this.prisma.productCategoryMapping.upsert({
      where: {
        uk_user_product_platform_category: {
          userId,
          sourceProductId: product.id,
          platform,
        },
      },
      create: {
        userId,
        sourceProductId: product.id,
        platform,
        categoryId,
        categoryName,
        confirmedAt: now,
      },
      update: { categoryId, categoryName, confirmedAt: now },
    });
    return toView(product, platform, mapping);
  }

  async remove(userId: bigint, sourceProductId: string, platformValue: string) {
    const platform = parsePlatform(platformValue);
    const product = await this.findProduct(sourceProductId);
    await this.prisma.productCategoryMapping.deleteMany({
      where: { userId, sourceProductId: product.id, platform },
    });
    return { deleted: true };
  }

  private async findProduct(sourceProductId: string) {
    const product = await this.prisma.sourceProduct.findUnique({
      where: { productId1688: sourceProductId },
      select: { id: true, productId1688: true, title: true, categoryPath: true },
    });
    if (!product) throw new NotFoundException('货源不存在');
    return product;
  }
}

function parsePlatform(value: string): 'douyin' {
  if (value !== 'douyin') throw new BadRequestException('当前仅支持抖店类目映射');
  return value;
}

function validateCategoryId(platform: 'douyin', value: string): string {
  const normalized = value.trim();
  const numericId = Number(normalized);
  if (
    platform === 'douyin' &&
    (!/^[1-9]\d*$/.test(normalized) || !Number.isSafeInteger(numericId) || numericId <= 0)
  ) {
    throw new BadRequestException('抖店叶子类目 ID 必须是正整数');
  }
  return normalized;
}

type ProductView = {
  id: bigint;
  productId1688: string;
  title: string;
  categoryPath: string | null;
};

type MappingView = {
  categoryId: string;
  categoryName: string | null;
  confirmedAt: Date;
} | null;

function toView(
  product: ProductView,
  platform: 'douyin',
  mapping: MappingView,
): CategoryMappingView {
  return {
    sourceProductId: product.productId1688,
    sourceTitle: product.title,
    sourceCategoryPath: product.categoryPath,
    platform,
    confirmed: !!mapping,
    categoryId: mapping?.categoryId ?? null,
    categoryName: mapping?.categoryName ?? null,
    confirmedAt: mapping?.confirmedAt.toISOString() ?? null,
  };
}
