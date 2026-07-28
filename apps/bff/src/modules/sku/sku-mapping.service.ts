import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@supplier/db';
import { PrismaService } from '../../common/prisma.module';
import type { ConfirmSkuMappingDto } from './dto/confirm-sku-mapping.dto';
import {
  buildSkuSuggestion,
  parseConfirmedSkuMapping,
  type ConfirmedSkuMapping,
  type SkuSuggestion,
} from './sku-normalizer';

export interface SkuMappingView {
  sourceProductId: string;
  sourceTitle: string;
  platform: 'douyin';
  confirmed: boolean;
  stale: boolean;
  requiresConfirmation: boolean;
  dimensions: string[];
  skus: Array<{
    sourceSkuId: string;
    sourceSpecName: string;
    costPrice: number;
    stock: number;
    image: string | null;
    values: string[];
    enabled: boolean;
  }>;
  warnings: string[];
  confirmedAt: string | null;
}

@Injectable()
export class SkuMappingService {
  constructor(private readonly prisma: PrismaService) {}

  async get(
    userId: bigint,
    sourceProductId: string,
    platformValue: string,
  ): Promise<SkuMappingView> {
    const platform = parsePlatform(platformValue);
    const product = await this.findProduct(sourceProductId);
    const mapping = await this.prisma.productSkuMapping.findUnique({
      where: {
        uk_user_product_platform_sku: {
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
    dto: ConfirmSkuMappingDto,
  ): Promise<SkuMappingView> {
    const platform = parsePlatform(dto.platform);
    const product = await this.findProduct(sourceProductId);
    const suggestion = buildSkuSuggestion(product.skuList, Number(product.price));
    if (!suggestion.requiresConfirmation) {
      throw new BadRequestException('当前货源没有需要确认的多规格 SKU');
    }
    const confirmed = validateConfirmation(dto, suggestion);
    const now = new Date();
    const mapping = await this.prisma.productSkuMapping.upsert({
      where: {
        uk_user_product_platform_sku: {
          userId,
          sourceProductId: product.id,
          platform,
        },
      },
      create: {
        userId,
        sourceProductId: product.id,
        platform,
        dimensions: confirmed.dimensions,
        skus: confirmed.skus as unknown as Prisma.InputJsonValue,
        sourceFingerprint: confirmed.sourceFingerprint,
        confirmedAt: now,
      },
      update: {
        dimensions: confirmed.dimensions,
        skus: confirmed.skus as unknown as Prisma.InputJsonValue,
        sourceFingerprint: confirmed.sourceFingerprint,
        confirmedAt: now,
      },
    });
    return toView(product, platform, mapping);
  }

  async remove(userId: bigint, sourceProductId: string, platformValue: string) {
    const platform = parsePlatform(platformValue);
    const product = await this.findProduct(sourceProductId);
    await this.prisma.productSkuMapping.deleteMany({
      where: { userId, sourceProductId: product.id, platform },
    });
    return { deleted: true };
  }

  private async findProduct(sourceProductId: string) {
    const product = await this.prisma.sourceProduct.findUnique({
      where: { productId1688: sourceProductId },
      select: { id: true, productId1688: true, title: true, price: true, skuList: true },
    });
    if (!product) throw new NotFoundException('货源不存在');
    return product;
  }
}

function validateConfirmation(
  dto: ConfirmSkuMappingDto,
  suggestion: SkuSuggestion,
): ConfirmedSkuMapping {
  const dimensions = dto.dimensions.map((value) => value.trim());
  if (dimensions.some((dimension) => !dimension)) {
    throw new BadRequestException('SKU 规格维度不能为空');
  }
  if (new Set(dimensions).size !== dimensions.length) {
    throw new BadRequestException('SKU 规格维度不能重复');
  }

  const expectedIds = new Set(suggestion.skus.map((sku) => sku.sourceSkuId));
  const submittedIds = dto.skus.map((sku) => sku.sourceSkuId.trim());
  if (new Set(submittedIds).size !== submittedIds.length) {
    throw new BadRequestException('SKU ID 不能重复');
  }
  if (
    submittedIds.length !== expectedIds.size ||
    submittedIds.some((sourceSkuId) => !expectedIds.has(sourceSkuId))
  ) {
    throw new BadRequestException('货源 SKU 已变化，请刷新后重新确认');
  }

  const combinations = new Set<string>();
  const skus = dto.skus.map((sku) => {
    const values = sku.values.map((value) => value.trim());
    if (values.length !== dimensions.length || values.some((value) => !value)) {
      throw new BadRequestException(`SKU ${sku.sourceSkuId} 的规格值不完整`);
    }
    if (sku.enabled) {
      const combination = JSON.stringify(values);
      if (combinations.has(combination)) {
        throw new BadRequestException('启用的 SKU 规格组合不能重复');
      }
      combinations.add(combination);
    }
    return { sourceSkuId: sku.sourceSkuId.trim(), values, enabled: sku.enabled };
  });
  if (!skus.some((sku) => sku.enabled)) throw new BadRequestException('至少启用一个 SKU');

  return { dimensions, skus, sourceFingerprint: suggestion.sourceFingerprint };
}

function parsePlatform(value: string): 'douyin' {
  if (value !== 'douyin') throw new BadRequestException('当前仅支持抖店 SKU 映射');
  return value;
}

type ProductView = {
  id: bigint;
  productId1688: string;
  title: string;
  price: Prisma.Decimal;
  skuList: Prisma.JsonValue | null;
};

type MappingView = {
  dimensions: Prisma.JsonValue;
  skus: Prisma.JsonValue;
  sourceFingerprint: string;
  confirmedAt: Date;
} | null;

function toView(product: ProductView, platform: 'douyin', mapping: MappingView): SkuMappingView {
  const suggestion = buildSkuSuggestion(product.skuList, Number(product.price));
  const parsed = mapping
    ? parseConfirmedSkuMapping(mapping.dimensions, mapping.skus, mapping.sourceFingerprint)
    : null;
  const stale = !!mapping && (!parsed || parsed.sourceFingerprint !== suggestion.sourceFingerprint);
  const confirmed = !suggestion.requiresConfirmation || (!!parsed && !stale);
  const selectedById = new Map(parsed?.skus.map((sku) => [sku.sourceSkuId, sku]));
  const warnings = [...suggestion.warnings];
  if (stale) warnings.unshift('货源 SKU 已变化，之前的确认已失效');

  return {
    sourceProductId: product.productId1688,
    sourceTitle: product.title,
    platform,
    confirmed,
    stale,
    requiresConfirmation: suggestion.requiresConfirmation,
    dimensions: confirmed && parsed ? parsed.dimensions : suggestion.dimensions,
    skus: suggestion.skus.map((sku) => {
      const selected = confirmed ? selectedById.get(sku.sourceSkuId) : undefined;
      return {
        sourceSkuId: sku.sourceSkuId,
        sourceSpecName: sku.sourceSpecName,
        costPrice: sku.costPrice,
        stock: sku.stock,
        image: sku.image,
        values: selected?.values ?? sku.values,
        enabled: selected?.enabled ?? sku.enabled,
      };
    }),
    warnings,
    confirmedAt: confirmed && mapping && !stale ? mapping.confirmedAt.toISOString() : null,
  };
}
