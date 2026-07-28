import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@supplier/db';
import type {
  CategoryAttr,
  CategoryPropertyMap,
  CategoryPropertyValue,
} from '@supplier/platform-sdk';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../common/prisma.module';
import { PlatformAdapterFactory, isDemoShop } from '../shop/platform-adapter.factory';
import { ShopTokenService } from '../shop/shop-token.service';
import type { ConfirmCategoryPropertiesDto } from './dto/confirm-category-properties.dto';

export interface CategoryPropertyView {
  sourceProductId: string;
  sourceTitle: string;
  shopId: string;
  shopName: string | null;
  categoryId: string;
  categoryName: string | null;
  schemaFingerprint: string;
  attributes: CategoryAttr[];
  values: CategoryPropertyMap;
  confirmed: boolean;
  stale: boolean;
  blockers: string[];
  confirmedAt: string | null;
}

@Injectable()
export class CategoryPropertyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly adapters: PlatformAdapterFactory,
    private readonly shopTokens: ShopTokenService,
  ) {}

  async get(
    userId: bigint,
    sourceProductId: string,
    shopIdValue: string,
    forceRefresh = false,
  ): Promise<CategoryPropertyView> {
    const context = await this.loadContext(userId, sourceProductId, shopIdValue);
    const schema = await this.loadSchema(userId, context, forceRefresh);
    const mapping = await this.prisma.productCategoryPropertyMapping.findUnique({
      where: {
        uk_user_product_shop_category_properties: {
          userId,
          sourceProductId: context.product.id,
          shopId: context.shop.id,
        },
      },
    });
    const stale =
      !!mapping &&
      (mapping.categoryId !== context.category.categoryId ||
        mapping.schemaFingerprint !== schema.fingerprint);
    return {
      sourceProductId: context.product.productId1688,
      sourceTitle: context.product.title,
      shopId: context.shop.id.toString(),
      shopName: context.shop.shopName,
      categoryId: context.category.categoryId,
      categoryName: context.category.categoryName,
      schemaFingerprint: schema.fingerprint,
      attributes: schema.attributes,
      values: stale ? {} : parsePropertyMap(mapping?.values),
      confirmed: !!mapping && !stale,
      stale,
      blockers: schema.attributes.flatMap((attribute) =>
        attribute.required && attribute.inputType === 'unsupported'
          ? [
              `必填属性「${attribute.name}」暂不支持：${attribute.unsupportedReason ?? '复杂属性规则'}`,
            ]
          : [],
      ),
      confirmedAt: mapping && !stale ? mapping.confirmedAt.toISOString() : null,
    };
  }

  async sync(
    userId: bigint,
    sourceProductId: string,
    shopIdValue: string,
  ): Promise<CategoryPropertyView> {
    return this.get(userId, sourceProductId, shopIdValue, true);
  }

  async confirm(
    userId: bigint,
    sourceProductId: string,
    dto: ConfirmCategoryPropertiesDto,
  ): Promise<CategoryPropertyView> {
    const context = await this.loadContext(userId, sourceProductId, dto.shopId);
    const schema = await this.loadSchema(userId, context, false);
    const values = validatePropertyValues(schema.attributes, dto.values);
    const now = new Date();
    await this.prisma.productCategoryPropertyMapping.upsert({
      where: {
        uk_user_product_shop_category_properties: {
          userId,
          sourceProductId: context.product.id,
          shopId: context.shop.id,
        },
      },
      create: {
        userId,
        sourceProductId: context.product.id,
        shopId: context.shop.id,
        categoryId: context.category.categoryId,
        schemaFingerprint: schema.fingerprint,
        values: values as unknown as Prisma.InputJsonValue,
        confirmedAt: now,
      },
      update: {
        categoryId: context.category.categoryId,
        schemaFingerprint: schema.fingerprint,
        values: values as unknown as Prisma.InputJsonValue,
        confirmedAt: now,
      },
    });
    return this.get(userId, sourceProductId, dto.shopId);
  }

  async remove(userId: bigint, sourceProductId: string, shopIdValue: string) {
    const context = await this.loadContext(userId, sourceProductId, shopIdValue);
    await this.prisma.productCategoryPropertyMapping.deleteMany({
      where: { userId, sourceProductId: context.product.id, shopId: context.shop.id },
    });
    return { deleted: true };
  }

  async buildPublishSnapshot(
    userId: bigint,
    sourceProductId: bigint,
    targets: Array<{ shopId: bigint; categoryId: string }>,
    options: { refresh?: boolean } = {},
  ): Promise<Record<string, CategoryPropertyMap>> {
    if (targets.length === 0) return {};
    if (options.refresh) {
      const product = await this.prisma.sourceProduct.findUnique({
        where: { id: sourceProductId },
        select: { productId1688: true },
      });
      if (!product) throw new NotFoundException('货源不存在');
      for (const target of targets) {
        const context = await this.loadContext(
          userId,
          product.productId1688,
          target.shopId.toString(),
        );
        if (context.category.categoryId !== target.categoryId) {
          throw new BadRequestException(`店铺 ${target.shopId} 的类目属性与当前类目不一致`);
        }
        await this.loadSchema(userId, context, true);
      }
    }
    const [mappings, categories] = await Promise.all([
      this.prisma.productCategoryPropertyMapping.findMany({
        where: {
          userId,
          sourceProductId,
          shopId: { in: targets.map((target) => target.shopId) },
        },
      }),
      this.prisma.shopCategory.findMany({
        where: {
          channel: 0,
          shopId: { in: targets.map((target) => target.shopId) },
          categoryId: { in: targets.map((target) => target.categoryId) },
          isLeaf: true,
          enabled: true,
        },
        select: {
          shopId: true,
          categoryId: true,
          attributesFingerprint: true,
        },
      }),
    ]);
    const mappingByShop = new Map(mappings.map((mapping) => [mapping.shopId.toString(), mapping]));
    const categoryByTarget = new Map(
      categories.map((category) => [`${category.shopId}:${category.categoryId}`, category]),
    );
    const snapshot: Record<string, CategoryPropertyMap> = {};
    for (const target of targets) {
      const key = target.shopId.toString();
      const category = categoryByTarget.get(`${key}:${target.categoryId}`);
      if (!category?.attributesFingerprint) {
        throw new BadRequestException(`店铺 ${key} 尚未读取并确认类目必填属性`);
      }
      const mapping = mappingByShop.get(key);
      if (
        !mapping ||
        mapping.categoryId !== target.categoryId ||
        mapping.schemaFingerprint !== category.attributesFingerprint
      ) {
        throw new BadRequestException(`店铺 ${key} 的类目属性尚未确认或已失效`);
      }
      snapshot[key] = parsePropertyMap(mapping.values);
    }
    return snapshot;
  }

  private async loadContext(userId: bigint, sourceProductId: string, shopIdValue: string) {
    const shopId = parsePositiveId(shopIdValue, '店铺 ID');
    const [shop, product] = await Promise.all([
      this.prisma.shop.findFirst({
        where: { id: shopId, userId, platform: 'douyin', role: 'seller', status: 'active' },
      }),
      this.prisma.sourceProduct.findUnique({
        where: { productId1688: sourceProductId },
        select: { id: true, productId1688: true, title: true },
      }),
    ]);
    if (!shop) throw new NotFoundException('可用抖店店铺不存在');
    this.adapters.assertAllowed(shop);
    if (!product) throw new NotFoundException('货源不存在');
    const category = await this.prisma.productCategoryMapping.findUnique({
      where: {
        uk_user_product_platform_category: {
          userId,
          sourceProductId: product.id,
          platform: 'douyin',
        },
      },
    });
    if (!category) throw new BadRequestException('请先确认抖店叶子类目');
    const catalog = await this.prisma.shopCategory.findFirst({
      where: {
        shopId: shop.id,
        channel: 0,
        categoryId: category.categoryId,
        isLeaf: true,
        enabled: true,
      },
    });
    if (!catalog) throw new BadRequestException('已确认类目不在该店铺可用目录中，请重新同步');
    return { shop, product, category, catalog };
  }

  private async loadSchema(
    userId: bigint,
    context: Awaited<ReturnType<CategoryPropertyService['loadContext']>>,
    forceRefresh: boolean,
  ): Promise<{ attributes: CategoryAttr[]; fingerprint: string }> {
    const cached = parseAttributes(context.catalog.attributes);
    if (!forceRefresh && cached && context.catalog.attributesFingerprint) {
      return { attributes: cached, fingerprint: context.catalog.attributesFingerprint };
    }
    const adapter = this.adapters.create(context.shop);
    const token = isDemoShop(context.shop)
      ? 'mock-token'
      : await this.shopTokens.getAccessToken(context.shop.id, userId);
    const attributes = await adapter.getCategoryAttributes(token, context.category.categoryId);
    const fingerprint = attributeFingerprint(attributes);
    await this.prisma.shopCategory.update({
      where: { id: context.catalog.id },
      data: {
        attributes: attributes as unknown as Prisma.InputJsonValue,
        attributesFingerprint: fingerprint,
        attributesSyncedAt: new Date(),
      },
    });
    return { attributes, fingerprint };
  }
}

function validatePropertyValues(
  attributes: CategoryAttr[],
  input: ConfirmCategoryPropertiesDto['values'],
): CategoryPropertyMap {
  const definitions = new Map(attributes.map((attribute) => [attribute.id, attribute]));
  const provided = new Map<string, ConfirmCategoryPropertiesDto['values'][number]>();
  for (const item of input) {
    const propertyId = item.propertyId.trim();
    if (!definitions.has(propertyId) || provided.has(propertyId)) {
      throw new BadRequestException('类目属性包含未知或重复属性项');
    }
    provided.set(propertyId, item);
  }

  const result: CategoryPropertyMap = {};
  for (const attribute of attributes) {
    const selections = provided.get(attribute.id)?.selections ?? [];
    if (attribute.required && attribute.inputType === 'unsupported') {
      throw new BadRequestException(
        `必填属性「${attribute.name}」暂不支持：${attribute.unsupportedReason ?? '复杂属性规则'}`,
      );
    }
    if (attribute.required && selections.length === 0) {
      throw new BadRequestException(`请填写必填属性「${attribute.name}」`);
    }
    const maxSelections = attribute.multiValue ? (attribute.maxSelections ?? 20) : 1;
    if (selections.length > maxSelections) {
      throw new BadRequestException(`属性「${attribute.name}」最多选择 ${maxSelections} 项`);
    }
    if (selections.length === 0) continue;
    if (attribute.inputType === 'unsupported') {
      throw new BadRequestException(`属性「${attribute.name}」暂不支持填写`);
    }
    result[attribute.id] = selections.map((selection) =>
      normalizeSelection(attribute, selection.valueId, selection.name),
    );
  }
  return result;
}

function normalizeSelection(
  attribute: CategoryAttr,
  valueIdValue: string | undefined,
  nameValue: string,
): CategoryPropertyValue {
  const valueId = valueIdValue?.trim() ?? '';
  const name = nameValue.trim();
  if (!name) throw new BadRequestException(`属性「${attribute.name}」的值不能为空`);
  const option = attribute.values?.find((value) => value.id === valueId);
  if (option) {
    const value = Number(option.id);
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new BadRequestException(`属性「${attribute.name}」的官方选项 ID 无效`);
    }
    return { value, name: option.name, diyType: 0 };
  }
  if (!attribute.supportsCustom) {
    throw new BadRequestException(`属性「${attribute.name}」必须选择官方选项`);
  }
  return { value: 0, name, diyType: 1 };
}

function attributeFingerprint(attributes: CategoryAttr[]): string {
  return createHash('sha256').update(JSON.stringify(attributes)).digest('hex');
}

function parseAttributes(value: unknown): CategoryAttr[] | null {
  return Array.isArray(value) ? (value as CategoryAttr[]) : null;
}

function parsePropertyMap(value: unknown): CategoryPropertyMap {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as CategoryPropertyMap)
    : {};
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
