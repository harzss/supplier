import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Prisma } from '@supplier/db';
import type {
  CategoryPropertyMap,
  CategoryQualification,
  ProductQualification,
} from '@supplier/platform-sdk';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { PrismaService } from '../../common/prisma.module';
import { PlatformAdapterFactory, isDemoShop } from '../shop/platform-adapter.factory';
import { ShopTokenService } from '../shop/shop-token.service';
import type { ConfirmCategoryQualificationsDto } from './dto/confirm-category-qualifications.dto';

export interface CategoryQualificationView {
  sourceProductId: string;
  sourceTitle: string;
  shopId: string;
  shopName: string | null;
  categoryId: string;
  categoryName: string | null;
  schemaFingerprint: string;
  requirementFingerprint: string;
  qualifications: Array<{
    key: string;
    name: string;
    hints: string[];
    required: boolean;
    requiredReason: 'category' | 'property' | null;
    unsupportedReason?: string;
  }>;
  values: Record<
    string,
    {
      qualityContentName: string | null;
      attachmentUrls: string[];
    }
  >;
  confirmed: boolean;
  stale: boolean;
  blockers: string[];
  confirmedAt: string | null;
  syncedAt: string;
  warning: string;
}

interface ResolvedQualification {
  definition: CategoryQualification;
  required: boolean;
  requiredReason: 'category' | 'property' | null;
}

interface QualificationResolution {
  context: Awaited<ReturnType<CategoryQualificationService['loadContext']>>;
  schemaFingerprint: string;
  requirementFingerprint: string;
  qualifications: ResolvedQualification[];
  structuralBlockers: string[];
  mapping: {
    categoryId: string;
    schemaFingerprint: string;
    requirementFingerprint: string;
    values: unknown;
    confirmedAt: Date;
  } | null;
  values: ProductQualification[] | null;
  stale: boolean;
  syncedAt: Date;
}

const QUALIFICATION_WARNING =
  '平台可能根据店铺信息和商品属性在正式发布时追加资质要求；若平台返回新要求，任务会失败并保留明确错误。';

@Injectable()
export class CategoryQualificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly adapters: PlatformAdapterFactory,
    private readonly shopTokens: ShopTokenService,
  ) {}

  async get(
    userId: bigint,
    sourceProductId: string,
    shopIdValue: string,
  ): Promise<CategoryQualificationView> {
    return this.toView(await this.resolve(userId, sourceProductId, shopIdValue, false));
  }

  async sync(
    userId: bigint,
    sourceProductId: string,
    shopIdValue: string,
  ): Promise<CategoryQualificationView> {
    return this.toView(await this.resolve(userId, sourceProductId, shopIdValue, true));
  }

  async confirm(
    userId: bigint,
    sourceProductId: string,
    dto: ConfirmCategoryQualificationsDto,
  ): Promise<CategoryQualificationView> {
    const resolution = await this.resolve(userId, sourceProductId, dto.shopId, false);
    if (resolution.structuralBlockers.length) {
      throw new BadRequestException(resolution.structuralBlockers[0]);
    }
    const values = validateQualificationValues(resolution.qualifications, dto.qualifications);
    const now = new Date();
    await this.prisma.productCategoryQualificationMapping.upsert({
      where: {
        uk_user_product_shop_category_qualifications: {
          userId,
          sourceProductId: resolution.context.product.id,
          shopId: resolution.context.shop.id,
        },
      },
      create: {
        userId,
        sourceProductId: resolution.context.product.id,
        shopId: resolution.context.shop.id,
        categoryId: resolution.context.category.categoryId,
        schemaFingerprint: resolution.schemaFingerprint,
        requirementFingerprint: resolution.requirementFingerprint,
        values: values as unknown as Prisma.InputJsonValue,
        confirmedAt: now,
      },
      update: {
        categoryId: resolution.context.category.categoryId,
        schemaFingerprint: resolution.schemaFingerprint,
        requirementFingerprint: resolution.requirementFingerprint,
        values: values as unknown as Prisma.InputJsonValue,
        confirmedAt: now,
      },
    });
    return this.get(userId, sourceProductId, dto.shopId);
  }

  async remove(userId: bigint, sourceProductId: string, shopIdValue: string) {
    const context = await this.loadContext(userId, sourceProductId, shopIdValue);
    await this.prisma.productCategoryQualificationMapping.deleteMany({
      where: { userId, sourceProductId: context.product.id, shopId: context.shop.id },
    });
    return { deleted: true };
  }

  async buildPublishSnapshot(
    userId: bigint,
    sourceProductId: bigint,
    targets: Array<{ shopId: bigint; categoryId: string }>,
    options: { refresh?: boolean; cachedOnly?: boolean } = {},
  ): Promise<Record<string, ProductQualification[]>> {
    if (targets.length === 0) return {};
    const product = await this.prisma.sourceProduct.findUnique({
      where: { id: sourceProductId },
      select: { productId1688: true },
    });
    if (!product) throw new NotFoundException('货源不存在');

    const snapshot: Record<string, ProductQualification[]> = {};
    for (const target of targets) {
      const resolution = await this.resolve(
        userId,
        product.productId1688,
        target.shopId.toString(),
        options.refresh === true,
        options.cachedOnly === true,
      );
      const shopKey = target.shopId.toString();
      if (resolution.context.category.categoryId !== target.categoryId) {
        throw new BadRequestException(`店铺 ${shopKey} 的类目资质与当前类目不一致`);
      }
      if (resolution.structuralBlockers.length) {
        throw new BadRequestException(
          `店铺 ${shopKey} 的类目资质无法确认：${resolution.structuralBlockers[0]}`,
        );
      }
      if (resolution.stale) {
        throw new BadRequestException(`店铺 ${shopKey} 的类目资质确认已失效`);
      }
      const values = resolution.values ?? [];
      assertRequiredQualifications(resolution.qualifications, values);
      snapshot[shopKey] = values;
    }
    return snapshot;
  }

  private async resolve(
    userId: bigint,
    sourceProductId: string,
    shopIdValue: string,
    forceRefresh: boolean,
    cachedOnly = false,
  ): Promise<QualificationResolution> {
    const context = await this.loadContext(userId, sourceProductId, shopIdValue);
    const schema = await this.loadSchema(userId, context, forceRefresh, cachedOnly);
    const propertyState = await this.loadPropertyState(context, schema.qualifications);
    const qualifications = resolveQualificationRequirements(
      schema.qualifications,
      propertyState.values,
    );
    const structuralBlockers = [
      ...propertyState.blockers,
      ...schema.qualifications.flatMap((qualification) =>
        qualification.unsupportedReason
          ? [`资质「${qualification.name}」暂不支持：${qualification.unsupportedReason}`]
          : [],
      ),
    ];
    const requirementFingerprint = fingerprint({
      schemaFingerprint: schema.fingerprint,
      dynamicPropertyValues: schema.qualifications.some((item) => item.rules.length > 0)
        ? propertyState.values
        : {},
    });
    const mapping = await this.prisma.productCategoryQualificationMapping.findUnique({
      where: {
        uk_user_product_shop_category_qualifications: {
          userId,
          sourceProductId: context.product.id,
          shopId: context.shop.id,
        },
      },
    });
    const stale =
      !!mapping &&
      (mapping.categoryId !== context.category.categoryId ||
        mapping.schemaFingerprint !== schema.fingerprint ||
        mapping.requirementFingerprint !== requirementFingerprint);
    const values = stale ? null : parseProductQualifications(mapping?.values);
    return {
      context,
      schemaFingerprint: schema.fingerprint,
      requirementFingerprint,
      qualifications,
      structuralBlockers,
      mapping,
      values,
      stale,
      syncedAt: schema.syncedAt,
    };
  }

  private toView(resolution: QualificationResolution): CategoryQualificationView {
    const blockers = [...resolution.structuralBlockers];
    if (resolution.stale) blockers.push('类目资质确认已失效，请按最新规则重新确认');
    if (resolution.mapping && !resolution.stale && !resolution.values) {
      blockers.push('已保存的类目资质数据无效，请重新确认');
    }
    const values = resolution.values ?? [];
    if (!resolution.stale && resolution.structuralBlockers.length === 0) {
      const missing = missingRequiredQualificationNames(resolution.qualifications, values);
      if (missing.length) blockers.push(`请上传必填资质：${missing.join('、')}`);
    }
    const confirmed = blockers.length === 0;
    return {
      sourceProductId: resolution.context.product.productId1688,
      sourceTitle: resolution.context.product.title,
      shopId: resolution.context.shop.id.toString(),
      shopName: resolution.context.shop.shopName,
      categoryId: resolution.context.category.categoryId,
      categoryName: resolution.context.category.categoryName,
      schemaFingerprint: resolution.schemaFingerprint,
      requirementFingerprint: resolution.requirementFingerprint,
      qualifications: resolution.qualifications.map((item) => ({
        key: item.definition.key,
        name: item.definition.name,
        hints: item.definition.hints,
        required: item.required,
        requiredReason: item.requiredReason,
        ...(item.definition.unsupportedReason
          ? { unsupportedReason: item.definition.unsupportedReason }
          : {}),
      })),
      values: Object.fromEntries(
        values.map((value) => [
          value.qualityKey,
          {
            qualityContentName: value.qualityContentName ?? null,
            attachmentUrls: value.attachments.map((attachment) => attachment.url),
          },
        ]),
      ),
      confirmed,
      stale: resolution.stale,
      blockers,
      confirmedAt:
        resolution.mapping && !resolution.stale && resolution.values
          ? resolution.mapping.confirmedAt.toISOString()
          : null,
      syncedAt: resolution.syncedAt.toISOString(),
      warning: QUALIFICATION_WARNING,
    };
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
    context: Awaited<ReturnType<CategoryQualificationService['loadContext']>>,
    forceRefresh: boolean,
    cachedOnly: boolean,
  ): Promise<{ qualifications: CategoryQualification[]; fingerprint: string; syncedAt: Date }> {
    const cached = parseCategoryQualifications(context.catalog.qualifications);
    if (
      !forceRefresh &&
      cached &&
      context.catalog.qualificationsFingerprint &&
      context.catalog.qualificationsSyncedAt
    ) {
      return {
        qualifications: cached,
        fingerprint: context.catalog.qualificationsFingerprint,
        syncedAt: context.catalog.qualificationsSyncedAt,
      };
    }
    if (cachedOnly) {
      throw new BadRequestException('类目资质规则尚未缓存，请先同步后重试');
    }
    const adapter = this.adapters.create(context.shop);
    if (!adapter.getCategoryQualifications) {
      throw new ServiceUnavailableException('当前平台暂不支持类目资质读取');
    }
    const token = isDemoShop(context.shop)
      ? 'mock-token'
      : await this.shopTokens.getAccessToken(context.shop.id, userId);
    const qualifications = await adapter.getCategoryQualifications(
      token,
      context.category.categoryId,
    );
    const schemaFingerprint = fingerprint(qualifications);
    const syncedAt = new Date();
    await this.prisma.shopCategory.update({
      where: { id: context.catalog.id },
      data: {
        qualifications: qualifications as unknown as Prisma.InputJsonValue,
        qualificationsFingerprint: schemaFingerprint,
        qualificationsSyncedAt: syncedAt,
      },
    });
    return { qualifications, fingerprint: schemaFingerprint, syncedAt };
  }

  private async loadPropertyState(
    context: Awaited<ReturnType<CategoryQualificationService['loadContext']>>,
    qualifications: CategoryQualification[],
  ): Promise<{ values: CategoryPropertyMap; blockers: string[] }> {
    if (!qualifications.some((qualification) => qualification.rules.length > 0)) {
      return { values: {}, blockers: [] };
    }
    if (!context.catalog.attributesFingerprint) {
      return { values: {}, blockers: ['请先读取并确认类目属性，以计算动态资质要求'] };
    }
    const attributeIds = new Set(
      Array.isArray(context.catalog.attributes)
        ? context.catalog.attributes.flatMap((value) => {
            const attribute = recordValue(value);
            const id = stringValue(attribute?.id);
            return id ? [id] : [];
          })
        : [],
    );
    const referencedPropertyIds = new Set(
      qualifications.flatMap((qualification) =>
        qualification.rules.flatMap((rule) => rule.clauses.map((clause) => clause.propertyId)),
      ),
    );
    if (
      attributeIds.size === 0 ||
      [...referencedPropertyIds].some((propertyId) => !attributeIds.has(propertyId))
    ) {
      return {
        values: {},
        blockers: ['动态资质规则引用了未同步的类目属性，请重新读取并确认类目属性'],
      };
    }
    const mapping = await this.prisma.productCategoryPropertyMapping.findUnique({
      where: {
        uk_user_product_shop_category_properties: {
          userId: context.shop.userId,
          sourceProductId: context.product.id,
          shopId: context.shop.id,
        },
      },
    });
    if (
      !mapping ||
      mapping.categoryId !== context.category.categoryId ||
      mapping.schemaFingerprint !== context.catalog.attributesFingerprint
    ) {
      return { values: {}, blockers: ['请先确认最新类目属性，以计算动态资质要求'] };
    }
    return { values: parsePropertyMap(mapping.values), blockers: [] };
  }
}

function resolveQualificationRequirements(
  qualifications: CategoryQualification[],
  propertyValues: CategoryPropertyMap,
): ResolvedQualification[] {
  return qualifications.map((definition) => {
    const requiredByProperty = definition.rules.some(
      (rule) =>
        rule.required && rule.clauses.every((clause) => matchesClause(clause, propertyValues)),
    );
    return {
      definition,
      required: definition.required || requiredByProperty,
      requiredReason: definition.required ? 'category' : requiredByProperty ? 'property' : null,
    };
  });
}

function matchesClause(
  clause: CategoryQualification['rules'][number]['clauses'][number],
  propertyValues: CategoryPropertyMap,
): boolean {
  const actual = new Set(
    (propertyValues[clause.propertyId] ?? []).flatMap((value) => [String(value.value), value.name]),
  );
  const intersects = clause.propertyValues.some((value) => actual.has(value));
  return clause.operand === 'equal' ? intersects : !intersects;
}

function validateQualificationValues(
  qualifications: ResolvedQualification[],
  input: ConfirmCategoryQualificationsDto['qualifications'],
): ProductQualification[] {
  const definitions = new Map(qualifications.map((item) => [item.definition.key, item]));
  const provided = new Set<string>();
  const values: ProductQualification[] = [];
  for (const item of input) {
    const key = item.qualificationKey.trim();
    const definition = definitions.get(key);
    if (!definition || provided.has(key)) {
      throw new BadRequestException('类目资质包含未知或重复资质项');
    }
    provided.add(key);
    if (definition.definition.unsupportedReason) {
      throw new BadRequestException(
        `资质「${definition.definition.name}」暂不支持：${definition.definition.unsupportedReason}`,
      );
    }
    const attachmentUrls = uniqueStrings(item.attachmentUrls.map((url) => normalizePublicUrl(url)));
    if (attachmentUrls.length === 0) continue;
    const qualityId = Number(key);
    if (!Number.isSafeInteger(qualityId) || qualityId <= 0) {
      throw new BadRequestException(`资质「${definition.definition.name}」的官方 ID 无效`);
    }
    const qualityContentName = item.qualityContentName?.trim();
    values.push({
      qualityKey: key,
      qualityName: definition.definition.name,
      ...(qualityContentName ? { qualityContentName } : {}),
      qualityId,
      attachments: attachmentUrls.map((url) => ({ mediaType: 1 as const, url })),
    });
  }
  assertRequiredQualifications(qualifications, values);
  return values.sort((left, right) => left.qualityKey.localeCompare(right.qualityKey));
}

function assertRequiredQualifications(
  qualifications: ResolvedQualification[],
  values: ProductQualification[],
): void {
  const missing = missingRequiredQualificationNames(qualifications, values);
  if (missing.length) throw new BadRequestException(`请上传必填资质：${missing.join('、')}`);
}

function missingRequiredQualificationNames(
  qualifications: ResolvedQualification[],
  values: ProductQualification[],
): string[] {
  const provided = new Set(
    values.filter((value) => value.attachments.length > 0).map((value) => value.qualityKey),
  );
  return qualifications.flatMap((item) =>
    item.required && !provided.has(item.definition.key) ? [item.definition.name] : [],
  );
}

function parseProductQualifications(value: unknown): ProductQualification[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  const parsed: ProductQualification[] = [];
  for (const itemValue of value) {
    const item = recordValue(itemValue);
    const qualityKey = stringValue(item?.qualityKey);
    const qualityName = stringValue(item?.qualityName);
    const qualityId = Number(item?.qualityId);
    const attachmentsValue = item?.attachments;
    if (
      !item ||
      !qualityKey ||
      !qualityName ||
      !Number.isSafeInteger(qualityId) ||
      qualityId <= 0 ||
      !Array.isArray(attachmentsValue) ||
      attachmentsValue.length === 0
    ) {
      return null;
    }
    const attachments: ProductQualification['attachments'] = [];
    for (const attachmentValue of attachmentsValue) {
      const attachment = recordValue(attachmentValue);
      const url = stringValue(attachment?.url);
      if (!attachment || attachment.mediaType !== 1 || !isPublicHttpsUrl(url)) return null;
      attachments.push({ mediaType: 1, url });
    }
    const qualityContentName = stringValue(item.qualityContentName) || undefined;
    parsed.push({
      qualityKey,
      qualityName,
      ...(qualityContentName ? { qualityContentName } : {}),
      qualityId,
      attachments,
    });
  }
  return parsed;
}

function parseCategoryQualifications(value: unknown): CategoryQualification[] | null {
  return Array.isArray(value) ? (value as CategoryQualification[]) : null;
}

function parsePropertyMap(value: unknown): CategoryPropertyMap {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as CategoryPropertyMap)
    : {};
}

function normalizePublicUrl(value: string): string {
  const url = value.trim();
  if (!isPublicHttpsUrl(url)) {
    throw new BadRequestException('资质附件必须是公开可访问的 HTTPS URL');
  }
  return url;
}

function isPublicHttpsUrl(value: string): boolean {
  if (!value || value.length > 2048) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return false;
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    !hostname ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal')
  ) {
    return false;
  }
  const ipVersion = isIP(hostname);
  if (ipVersion === 4) return isPublicIpv4(hostname);
  if (ipVersion === 6) return isPublicIpv6(hostname);
  return true;
}

function isPublicIpv4(hostname: string): boolean {
  const parts = hostname.split('.').map(Number);
  if (parts.length !== 4) return false;
  const a = parts[0]!;
  const b = parts[1]!;
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPublicIpv6(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === '::' || normalized === '::1') return false;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return false;
  if (/^fe[89ab]/.test(normalized)) return false;
  if (normalized.startsWith('::ffff:')) {
    const ipv4 = normalized.slice('::ffff:'.length);
    return isIP(ipv4) === 4 && isPublicIpv4(ipv4);
  }
  return true;
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortJson(child)]),
  );
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
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
