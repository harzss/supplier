import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@supplier/db';
import type { PlatformType } from '@supplier/shared-types';
import type {
  CategoryPropertyMap,
  PlatformAdapter,
  PlatformProductInventoryState,
  PlatformProductState,
  ProductQualification,
  PublishProductDto,
  PublishResult,
} from '@supplier/platform-sdk';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../common/prisma.module';
import { AiGatewayService } from '../ai/ai-gateway.service';
import { validateTitleForPlatform } from '../ai/prompts/title.prompt';
import { EntitlementService } from '../entitlement/entitlement.service';
import type { CurrentUser } from '../entitlement/user-context.service';
import { ShopTokenService } from '../shop/shop-token.service';
import {
  PlatformAdapterFactory,
  isDemoShop,
  runtimeShopWhere,
} from '../shop/platform-adapter.factory';
import { CategoryPropertyService } from '../category/category-property.service';
import { CategoryQualificationService } from '../category/category-qualification.service';
import { AssetStorageService } from './asset-storage.service';
import { DetailImageRenderer } from './detail-image-renderer.service';
import type {
  CreatePublishTaskDto,
  PricingPreviewDto,
  PricingStrategyDto,
} from './dto/create-publish-task.dto';
import type { UpdatePublishedProductDto } from './dto/update-published-product.dto';
import { ImagePipelineService, type MainImageProcessResult } from './image-pipeline.service';
import type { MainImageOperations } from './main-image.types';
import { calculatePricing, pricingInput, pricingSnapshot, type PricingQuote } from './pricing';
import { isPublishJobLeaseError, type PublishExecutionLease } from './publish-job-lease';
import { publishMaxAttempts } from './publish-queue.config';
import { PlatformProductLockService } from './platform-product-lock.service';
import {
  PricingPreviewReceiptService,
  type PricingPreviewReceipt,
} from './pricing-preview-receipt.service';
import { pricingSourceFingerprint } from './pricing-source-fingerprint';
import { PublishDraftService } from './publish-draft.service';
import {
  buildSkuSuggestion,
  materializeConfirmedSkus,
  parseConfirmedSkuMapping,
} from '../sku/sku-normalizer';

export interface PublishShopResult {
  shopId: string;
  shopName: string | null;
  platform: string;
  platformProductId?: string;
  url?: string;
  salePrice?: number;
  error?: string;
}

export interface PublishTaskResult {
  taskId: string;
  status: string;
  optimizedTitle: string;
  detailOptimized: boolean;
  detailImageHosted: boolean;
  mainImageRequested: boolean;
  mainImageProcessed: boolean;
  mainImageMessage: string | null;
  pricing: PricingQuote;
  skuCount: number;
  skuDimensions: string[];
  salePrice: number;
  results: PublishShopResult[];
}

export interface PublishTaskAccepted {
  taskId: string;
  status: 'pending';
  queued: true;
}

export type PricingPreviewResult = PricingQuote & PricingPreviewReceipt;

export interface PublishPreflightCheck {
  id: string;
  severity: 'blocker' | 'warning';
  scope?: 'entitlement' | 'source' | 'pricing' | 'shop' | 'title' | 'category' | 'sku' | 'quota';
  shopId?: string;
  message: string;
  actionHref?: string;
}

export interface PublishPreflightResult {
  ready: boolean;
  checks: PublishPreflightCheck[];
  sourcePricingFingerprint: string | null;
  pricingPreviewConfirmed: boolean;
  pricing: PricingQuote | null;
}

export interface PublishTaskReplay {
  taskId: string;
  status: string;
  queued: boolean;
  reused: true;
}

export interface PublishedItem {
  publishedProductId: string;
  shopName: string | null;
  platform: string;
  platformProductId: string | null;
  title: string;
  salePrice: number;
  status: string;
  inventorySyncStatus: string;
  inventorySyncReason: string | null;
  inventorySyncError: string | null;
  inventoryLastSyncedAt: string | null;
  editAttempts: number;
  lastEditAttemptAt: string | null;
  lastEditedAt: string | null;
  lastEditError: string | null;
  platformStatusSyncedAt: string | null;
  platformStatusError: string | null;
  publishedAt: string;
}

export interface PublishedProductUpdateResult {
  publishedProductId: string;
  title: string;
  status: string;
  lastEditedAt: string;
}

export interface PublishedProductStatusResult {
  publishedProductId: string;
  status: string;
  platformStatus: number | null;
  platformCheckStatus: number | null;
  syncedAt: string;
}

export interface PublishTaskSummary {
  taskId: string;
  status: string;
  sourceTitle: string;
  sourceProductId: string;
  sourceAvailability: string;
  sourceTotalStock: number;
  mainImage: string | null;
  detailOptimized: boolean;
  detailImageHosted: boolean;
  mainImageRequested: boolean;
  mainImageProcessed: boolean;
  pricing: PricingQuote | null;
  skuCount: number;
  skuDimensions: string[];
  queueStatus: string | null;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  createdAt: string;
  finishedAt: string | null;
  items: PublishedItem[];
}

export interface PublishTaskPage {
  items: PublishTaskSummary[];
  total: number;
  page: number;
  pageSize: number;
}

type SourceProductForPublish = Prisma.SourceProductGetPayload<{ include: { score: true } }>;
type ShopForPublish = Prisma.ShopGetPayload<Record<string, never>>;
type PublishTaskRecord = Prisma.PublishTaskGetPayload<Record<string, never>>;
type SkuMappingForPublish = Prisma.ProductSkuMappingGetPayload<Record<string, never>>;
type IdempotentPublishTask = Prisma.PublishTaskGetPayload<{
  include: {
    sourceProduct: { select: { productId1688: true; price: true } };
    job: { select: { id: true } };
  };
}>;
type QueuedTask = Prisma.PublishTaskGetPayload<{
  include: {
    user: true;
    sourceProduct: { include: { score: true } };
    publishedProducts: { select: { shopId: true } };
  };
}>;

interface PreparedPublish {
  product: SourceProductForPublish;
  shops: ShopForPublish[];
  categoryIdByPlatform: Map<string, string>;
  skuMappingByPlatform: Map<string, SkuMappingForPublish>;
  task: PublishTaskRecord;
  existingSuccessCount: number;
  totalTargetShopCount: number;
}

type PreparePublishResult =
  | { kind: 'prepared'; value: PreparedPublish }
  | { kind: 'replayed'; value: PublishTaskReplay };

@Injectable()
export class PublishService {
  private readonly logger = new Logger('Publish');
  private readonly demoMode: boolean;
  private readonly queueMaxAttempts: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlement: EntitlementService,
    private readonly ai: AiGatewayService,
    private readonly shopTokens: ShopTokenService,
    private readonly adapters: PlatformAdapterFactory,
    private readonly categoryProperties: CategoryPropertyService,
    private readonly categoryQualifications: CategoryQualificationService,
    private readonly detailRenderer: DetailImageRenderer,
    private readonly assetStorage: AssetStorageService,
    private readonly imagePipeline: ImagePipelineService,
    private readonly platformProductLocks: PlatformProductLockService,
    private readonly pricingPreviewReceipts: PricingPreviewReceiptService,
    private readonly publishDrafts: PublishDraftService,
    config: ConfigService,
  ) {
    this.demoMode = (config.get<string>('AUTH_MODE') ?? 'demo') === 'demo';
    this.queueMaxAttempts = publishMaxAttempts(config);
  }

  /** 主流程：选品 → AI 优化 → 定价 → 按店铺选择平台 adapter 发布 → 落库 */
  async create(
    user: CurrentUser,
    dto: CreatePublishTaskDto,
  ): Promise<PublishTaskResult | PublishTaskReplay> {
    const result = await this.prepare(user, dto, 'optimizing');
    if (result.kind === 'replayed') return result.value;
    return this.executePrepared(user, dto, result.value);
  }

  /** 数据库队列模式：先完成权限、资源和额度校验，再持久化待执行任务。 */
  async enqueue(
    user: CurrentUser,
    dto: CreatePublishTaskDto,
  ): Promise<PublishTaskAccepted | PublishTaskReplay> {
    const result = await this.prepare(user, dto, 'pending');
    if (result.kind === 'replayed') return result.value;
    return { taskId: result.value.task.id.toString(), status: 'pending', queued: true };
  }

  /** 队列 worker 执行或续跑任务；已成功店铺不会重复发布。 */
  async executeQueued(taskId: bigint, lease?: PublishExecutionLease): Promise<PublishTaskResult> {
    await assertPublishExecutionOwned(lease);
    const queuedTask = await this.prisma.publishTask.findUnique({
      where: { id: taskId },
      include: {
        user: true,
        sourceProduct: { include: { score: true } },
        publishedProducts: { select: { shopId: true } },
      },
    });
    await assertPublishExecutionOwned(lease);
    if (!queuedTask) throw new NotFoundException('铺货任务不存在');

    const targetShopIds = jsonStringArray(queuedTask.targetShopIds);
    if (!targetShopIds.length) throw new BadRequestException('铺货任务缺少目标店铺');
    const publishedShopIds = new Set(
      queuedTask.publishedProducts.map((product) => product.shopId.toString()),
    );
    const pendingShopIds = targetShopIds.filter((id) => !publishedShopIds.has(id));
    if (!pendingShopIds.length) {
      await assertPublishExecutionOwned(lease);
      await this.prisma.publishTask.update({
        where: { id: taskId },
        data: { status: 'success', finishedAt: new Date(), errorMsg: null },
      });
      await assertPublishExecutionOwned(lease);
      return completedResult(queuedTask);
    }
    assertSourceAvailable(queuedTask.sourceProduct);
    assertPreviewPricingUnchanged(
      queuedTask.pricingStrategy ?? undefined,
      queuedTask.sourceProduct,
    );

    const shops = await this.prisma.shop.findMany({
      where: {
        id: { in: pendingShopIds.map((id) => BigInt(id)) },
        userId: queuedTask.userId,
        role: 'seller',
        status: 'active',
        ...runtimeShopWhere(this.demoMode),
      },
    });
    if (shops.length !== pendingShopIds.length) {
      throw new BadRequestException('待重试的部分目标销售店铺当前不可用');
    }

    const confirmedMappings = await this.prisma.productCategoryMapping.findMany({
      where: {
        userId: queuedTask.userId,
        sourceProductId: queuedTask.sourceProductId,
        platform: { in: shops.map((shop) => shop.platform) },
      },
      select: { platform: true, categoryId: true },
    });
    const skuMappings = await this.prisma.productSkuMapping.findMany({
      where: {
        userId: queuedTask.userId,
        sourceProductId: queuedTask.sourceProductId,
        platform: { in: shops.map((shop) => shop.platform) },
      },
    });
    const dto = taskDto(queuedTask);
    const user: CurrentUser = { userId: queuedTask.userId, plan: queuedTask.user.plan };
    const categoryIdByPlatform = new Map(
      confirmedMappings.map((mapping) => [mapping.platform, mapping.categoryId]),
    );
    await this.assertSyncedCategoryCatalog(queuedTask.sourceProduct, shops, categoryIdByPlatform);
    const existingPropertySnapshot = jsonRecord(queuedTask.categoryPropertySnapshot) ?? {};
    const missingPropertyTargets = realDouyinCategoryTargets(
      queuedTask.sourceProduct,
      shops,
      categoryIdByPlatform,
    ).filter((target) => !jsonRecord(existingPropertySnapshot[target.shopId.toString()]));
    if (missingPropertyTargets.length) await assertPublishExecutionOwned(lease);
    const propertySnapshot: Record<string, unknown> = missingPropertyTargets.length
      ? {
          ...existingPropertySnapshot,
          ...(await this.categoryProperties.buildPublishSnapshot(
            queuedTask.userId,
            queuedTask.sourceProductId,
            missingPropertyTargets,
            { refresh: true },
          )),
        }
      : existingPropertySnapshot;
    if (missingPropertyTargets.length) await assertPublishExecutionOwned(lease);
    const existingQualificationSnapshot =
      jsonRecord(queuedTask.categoryQualificationSnapshot) ?? {};
    const missingQualificationTargets = realDouyinCategoryTargets(
      queuedTask.sourceProduct,
      shops,
      categoryIdByPlatform,
    ).filter(
      (target) =>
        !Object.prototype.hasOwnProperty.call(
          existingQualificationSnapshot,
          target.shopId.toString(),
        ),
    );
    if (missingQualificationTargets.length) await assertPublishExecutionOwned(lease);
    const qualificationSnapshot: Record<string, unknown> = missingQualificationTargets.length
      ? {
          ...existingQualificationSnapshot,
          ...(await this.categoryQualifications.buildPublishSnapshot(
            queuedTask.userId,
            queuedTask.sourceProductId,
            missingQualificationTargets,
            { refresh: true },
          )),
        }
      : existingQualificationSnapshot;
    if (missingQualificationTargets.length) await assertPublishExecutionOwned(lease);
    const publishExternalIds = ensurePublishExternalIds(queuedTask.publishExternalIds, shops);
    if (
      missingPropertyTargets.length ||
      missingQualificationTargets.length ||
      publishExternalIds.changed
    ) {
      await assertPublishExecutionOwned(lease);
      await this.prisma.publishTask.update({
        where: { id: queuedTask.id },
        data: {
          ...(missingPropertyTargets.length
            ? { categoryPropertySnapshot: propertySnapshot as Prisma.InputJsonValue }
            : {}),
          ...(missingQualificationTargets.length
            ? {
                categoryQualificationSnapshot: qualificationSnapshot as Prisma.InputJsonValue,
              }
            : {}),
          ...(publishExternalIds.changed
            ? { publishExternalIds: publishExternalIds.value as Prisma.InputJsonValue }
            : {}),
        },
      });
      await assertPublishExecutionOwned(lease);
    }
    return this.executePrepared(
      user,
      dto,
      {
        product: queuedTask.sourceProduct,
        shops,
        categoryIdByPlatform,
        skuMappingByPlatform: new Map(skuMappings.map((mapping) => [mapping.platform, mapping])),
        task: {
          ...queuedTask,
          categoryPropertySnapshot: propertySnapshot as unknown as Prisma.JsonValue,
          categoryQualificationSnapshot: qualificationSnapshot as unknown as Prisma.JsonValue,
          publishExternalIds: publishExternalIds.value as unknown as Prisma.JsonValue,
        },
        existingSuccessCount: publishedShopIds.size,
        totalTargetShopCount: targetShopIds.length,
      },
      lease,
    );
  }

  async previewPricing(user: CurrentUser, dto: PricingPreviewDto): Promise<PricingPreviewResult> {
    this.assertPricingFeature(user, dto.pricingStrategy);
    const product = await this.prisma.sourceProduct.findUnique({
      where: { productId1688: dto.sourceProductId },
    });
    if (!product) throw new NotFoundException('货源不存在');
    assertSourceAvailable(product);
    const costPrice = Number(product.price);
    const sourcePricingFingerprint = pricingSourceFingerprint(product);
    return {
      ...calculatePricing(costPrice, dto.pricingStrategy),
      ...this.pricingPreviewReceipts.issue({
        userId: user.userId,
        sourceProductId: dto.sourceProductId,
        pricingStrategy: dto.pricingStrategy,
        costPrice,
        sourcePricingFingerprint,
      }),
    };
  }

  /**
   * 只读发布预检：聚合当前输入可独立发现的问题，不创建任务、不刷新平台缓存。
   * create/enqueue 仍会在提交时重新执行权威校验并 fail closed。
   */
  async preflight(user: CurrentUser, dto: CreatePublishTaskDto): Promise<PublishPreflightResult> {
    const checks: PublishPreflightCheck[] = [];
    let publishAllowed = true;
    let pricingAllowed = true;
    for (const assertion of this.publishFeatureAssertions(user, dto)) {
      try {
        assertion.run();
      } catch (error) {
        if (assertion.id === 'entitlement.publish') publishAllowed = false;
        if (assertion.id === 'entitlement.pricing') pricingAllowed = false;
        checks.push(
          preflightCheck(assertion.id, 'entitlement', error, {
            actionHref: '/settings#capacity-options',
          }),
        );
      }
    }
    if (!publishAllowed) {
      return {
        ready: false,
        checks,
        sourcePricingFingerprint: null,
        pricingPreviewConfirmed: false,
        pricing: null,
      };
    }

    let product: SourceProductForPublish | null = null;
    try {
      product = await this.prisma.sourceProduct.findUnique({
        where: { productId1688: dto.sourceProductId },
        include: { score: true },
      });
      if (!product) throw new NotFoundException('货源不存在');
    } catch (error) {
      checks.push(preflightCheck('source.lookup', 'source', error, { actionHref: '#publish' }));
    }

    let sourcePricingFingerprint: string | null = null;
    let pricing: PricingQuote | null = null;
    let pricingPreviewConfirmed = false;
    if (product) {
      try {
        assertSourceAvailable(product);
      } catch (error) {
        checks.push(
          preflightCheck('source.availability', 'source', error, { actionHref: '#publish' }),
        );
      }
      if (pricingAllowed) {
        try {
          sourcePricingFingerprint = pricingSourceFingerprint(product);
          pricing = calculatePricing(Number(product.price), dto.pricingStrategy);
        } catch (error) {
          checks.push(
            preflightCheck('pricing.quote', 'pricing', error, { actionHref: '#publish' }),
          );
        }
        if (pricing && sourcePricingFingerprint) {
          try {
            this.pricingPreviewReceipts.assertValid(dto.pricingPreviewToken, {
              userId: user.userId,
              sourceProductId: dto.sourceProductId,
              pricingStrategy: dto.pricingStrategy,
              costPrice: Number(product.price),
              sourcePricingFingerprint,
            });
            pricingPreviewConfirmed = true;
          } catch (error) {
            checks.push(
              preflightCheck('pricing.preview_receipt', 'pricing', error, {
                actionHref: '#publish',
              }),
            );
          }
          if (pricing.warning) {
            checks.push({
              id: 'pricing.margin_warning',
              severity: 'warning',
              scope: 'pricing',
              message: pricing.warning,
              actionHref: '#publish',
            });
          }
        }
      }
    }

    let shops: ShopForPublish[] | null = null;
    let allTargetShopsAvailable = false;
    try {
      const shopIds = dto.targetShopIds.map((id) => BigInt(id));
      const found = await this.prisma.shop.findMany({
        where: {
          id: { in: shopIds },
          userId: user.userId,
          role: 'seller',
          status: 'active',
          ...runtimeShopWhere(this.demoMode),
        },
      });
      const requestedIds = new Set(dto.targetShopIds);
      const visible = found.filter(
        (shop) =>
          shop.userId === user.userId &&
          requestedIds.has(shop.id.toString()) &&
          shop.role === 'seller' &&
          shop.status === 'active' &&
          (this.demoMode || !isDemoShop(shop)),
      );
      const byId = new Map(visible.map((shop) => [shop.id.toString(), shop]));
      shops = dto.targetShopIds.flatMap((id) => {
        const shop = byId.get(id);
        if (shop) return [shop];
        checks.push({
          id: 'shop.target_unavailable',
          severity: 'blocker',
          scope: 'shop',
          shopId: id,
          message: '目标店铺不可用、不是当前用户的销售店铺或尚未完成有效授权',
          actionHref: '/settings#shops',
        });
        return [];
      });
      allTargetShopsAvailable = shops.length === dto.targetShopIds.length;
    } catch (error) {
      checks.push(preflightCheck('shop.lookup', 'shop', error, { actionHref: '/settings#shops' }));
    }

    if (shops?.length) {
      const title =
        dto.aiOptions?.titleOverride ??
        (dto.aiOptions?.rewriteTitle === false ? product?.title : undefined);
      if (title !== undefined) {
        for (const shop of shops) {
          try {
            assertTitleForShops(
              title,
              [shop],
              dto.aiOptions?.titleOverride ? '所选标题' : '货源标题',
            );
          } catch (error) {
            checks.push(
              preflightCheck('title.compliance', 'title', error, {
                shopId: shop.id.toString(),
                actionHref: '#publish',
              }),
            );
          }
        }
      } else if (product) {
        checks.push({
          id: 'title.generated_on_submit',
          severity: 'warning',
          scope: 'title',
          message: '标题将在提交后由 AI 生成，并在调用平台前再次校验',
          actionHref: '#publish',
        });
      }
    }

    if (product && shops?.length) {
      let categoryIdByPlatform: Map<string, string> | null = null;
      try {
        const confirmedMappings = await this.prisma.productCategoryMapping.findMany({
          where: {
            userId: user.userId,
            sourceProductId: product.id,
            platform: { in: shops.map((shop) => shop.platform) },
          },
          select: { platform: true, categoryId: true },
        });
        categoryIdByPlatform = new Map(
          confirmedMappings.map((mapping) => [mapping.platform, mapping.categoryId]),
        );
      } catch (error) {
        checks.push(
          preflightCheck('category.mapping_lookup', 'category', error, {
            actionHref: '#category-setup',
          }),
        );
      }

      if (categoryIdByPlatform) {
        for (const shop of shops) {
          let categoryId: string;
          try {
            categoryId = resolveCategoryId(
              shop.platform,
              product.attributes,
              `mock-cat-${product.categoryL1 ?? 'general'}`,
              isDemoShop(shop),
              categoryIdByPlatform.get(shop.platform),
            );
          } catch (error) {
            checks.push(
              preflightCheck('category.mapping', 'category', error, {
                shopId: shop.id.toString(),
                actionHref: '#category-setup',
              }),
            );
            continue;
          }
          if (shop.platform !== 'douyin' || isDemoShop(shop)) continue;
          try {
            await this.assertSyncedCategoryCatalog(product, [shop], categoryIdByPlatform);
          } catch (error) {
            checks.push(
              preflightCheck('category.catalog', 'category', error, {
                shopId: shop.id.toString(),
                actionHref: '#category-setup',
              }),
            );
            continue;
          }

          let propertyValues: CategoryPropertyMap | null = null;
          try {
            const propertySnapshot = await this.categoryProperties.buildPublishSnapshot(
              user.userId,
              product.id,
              [{ shopId: shop.id, categoryId }],
              { refresh: false },
            );
            propertyValues = propertySnapshot[shop.id.toString()] ?? {};
          } catch (error) {
            checks.push(
              preflightCheck('category.properties', 'category', error, {
                shopId: shop.id.toString(),
                actionHref: '#category-setup',
              }),
            );
          }
          if (!propertyValues) continue;
          try {
            await this.categoryQualifications.buildPublishSnapshot(
              user.userId,
              product.id,
              [{ shopId: shop.id, categoryId }],
              { refresh: false, cachedOnly: true },
            );
          } catch (error) {
            checks.push(
              preflightCheck('category.qualifications', 'category', error, {
                shopId: shop.id.toString(),
                actionHref: '#category-setup',
              }),
            );
          }
        }
      }

      try {
        const skuMappings = await this.prisma.productSkuMapping.findMany({
          where: {
            userId: user.userId,
            sourceProductId: product.id,
            platform: { in: shops.map((shop) => shop.platform) },
          },
        });
        const skuMappingByPlatform = new Map(
          skuMappings.map((mapping) => [mapping.platform, mapping]),
        );
        const checkedPlatforms = new Set<string>();
        for (const shop of shops) {
          if (checkedPlatforms.has(shop.platform)) continue;
          checkedPlatforms.add(shop.platform);
          try {
            assertSkuMappingReady(product, shop.platform, skuMappingByPlatform);
          } catch (error) {
            checks.push(
              preflightCheck('sku.mapping', 'sku', error, {
                shopId: shop.id.toString(),
                actionHref: '#sku-setup',
              }),
            );
          }
        }
      } catch (error) {
        checks.push(
          preflightCheck('sku.mapping_lookup', 'sku', error, { actionHref: '#sku-setup' }),
        );
      }
    }

    if (shops && allTargetShopsAvailable) {
      try {
        const monthCount = await this.entitlement.getMonthlyPublishCount(user.userId);
        this.entitlement.assertWithinQuota(user.plan, 'publish.monthly', monthCount + shops.length);
      } catch (error) {
        checks.push(
          preflightCheck('quota.publish_monthly', 'quota', error, {
            actionHref: '/settings#capacity-options',
          }),
        );
      }
    }

    return {
      ready: !checks.some((check) => check.severity === 'blocker'),
      checks,
      sourcePricingFingerprint,
      pricingPreviewConfirmed,
      pricing,
    };
  }

  private async prepare(
    user: CurrentUser,
    dto: CreatePublishTaskDto,
    initialStatus: 'pending' | 'optimizing',
  ): Promise<PreparePublishResult> {
    const replay = await this.findIdempotentReplay(user.userId, dto);
    if (replay) return { kind: 'replayed', value: replay };

    this.assertPublishFeatures(user, dto);

    const product = await this.prisma.sourceProduct.findUnique({
      where: { productId1688: dto.sourceProductId },
      include: { score: true },
    });
    if (!product) throw new NotFoundException('货源不存在');
    assertSourceAvailable(product);
    const costPrice = Number(product.price);
    const sourcePricingFingerprint = pricingSourceFingerprint(product);
    const previewedPricing = calculatePricing(costPrice, dto.pricingStrategy);
    this.pricingPreviewReceipts.assertValid(dto.pricingPreviewToken, {
      userId: user.userId,
      sourceProductId: dto.sourceProductId,
      pricingStrategy: dto.pricingStrategy,
      costPrice,
      sourcePricingFingerprint,
    });

    const shopIds = dto.targetShopIds.map((s) => BigInt(s));
    const shops = await this.prisma.shop.findMany({
      where: {
        id: { in: shopIds },
        userId: user.userId,
        role: 'seller',
        status: 'active',
        ...runtimeShopWhere(this.demoMode),
      },
    });
    if (shops.length !== shopIds.length || shops.some((shop) => shop.role !== 'seller')) {
      throw new BadRequestException('部分目标店铺不可用或不是销售店铺，请重新选择');
    }
    assertTitleForShops(dto.aiOptions?.titleOverride, shops, '所选标题');
    const confirmedMappings = await this.prisma.productCategoryMapping.findMany({
      where: {
        userId: user.userId,
        sourceProductId: product.id,
        platform: { in: shops.map((shop) => shop.platform) },
      },
      select: { platform: true, categoryId: true },
    });
    const skuMappings = await this.prisma.productSkuMapping.findMany({
      where: {
        userId: user.userId,
        sourceProductId: product.id,
        platform: { in: shops.map((shop) => shop.platform) },
      },
    });
    const categoryIdByPlatform = new Map(
      confirmedMappings.map((mapping) => [mapping.platform, mapping.categoryId]),
    );
    this.assertCategoryMappingsForShops(product, shops, categoryIdByPlatform);
    await this.assertSyncedCategoryCatalog(product, shops, categoryIdByPlatform);
    const categoryPropertySnapshot = await this.categoryProperties.buildPublishSnapshot(
      user.userId,
      product.id,
      realDouyinCategoryTargets(product, shops, categoryIdByPlatform),
      { refresh: true },
    );
    const categoryQualificationSnapshot = await this.categoryQualifications.buildPublishSnapshot(
      user.userId,
      product.id,
      realDouyinCategoryTargets(product, shops, categoryIdByPlatform),
      { refresh: true },
    );
    const skuMappingByPlatform = new Map(skuMappings.map((mapping) => [mapping.platform, mapping]));
    const skuSnapshot = resolveSkuSnapshot(
      product,
      shops.map((shop) => shop.platform),
      skuMappingByPlatform,
      dto.pricingStrategy,
      null,
    );

    const monthCount = await this.entitlement.getMonthlyPublishCount(user.userId);
    this.entitlement.assertWithinQuota(user.plan, 'publish.monthly', monthCount + shops.length);

    const taskData: Prisma.PublishTaskUncheckedCreateInput = {
      userId: user.userId,
      clientRequestId: dto.clientRequestId,
      sourceProductId: product.id,
      targetShopIds: dto.targetShopIds,
      status: initialStatus,
      aiOptions: (dto.aiOptions ?? undefined) as Prisma.InputJsonValue,
      pricingStrategy: confirmedPricingSnapshot(
        dto.pricingStrategy,
        previewedPricing,
        sourcePricingFingerprint,
      ) as Prisma.InputJsonValue,
      skuSnapshot: skuSnapshot as unknown as Prisma.InputJsonValue,
      categoryPropertySnapshot: categoryPropertySnapshot as unknown as Prisma.InputJsonValue,
      categoryQualificationSnapshot:
        categoryQualificationSnapshot as unknown as Prisma.InputJsonValue,
      publishExternalIds: createPublishExternalIds(shops) as Prisma.InputJsonValue,
    };
    let task: PublishTaskRecord;
    try {
      task =
        initialStatus === 'pending' || dto.draftRevision !== undefined
          ? await this.prisma.$transaction(async (tx) => {
              const created = await tx.publishTask.create({ data: taskData });
              if (dto.draftRevision !== undefined) {
                await this.publishDrafts.consumeForPublish(tx, user.userId, dto);
              }
              if (initialStatus === 'pending') {
                await tx.publishJob.create({
                  data: { taskId: created.id, maxAttempts: this.queueMaxAttempts },
                });
              }
              return created;
            })
          : await this.prisma.publishTask.create({ data: taskData });
    } catch (error) {
      if (dto.clientRequestId && isPrismaUniqueConstraintError(error)) {
        const concurrentReplay = await this.findIdempotentReplay(user.userId, dto);
        if (concurrentReplay) return { kind: 'replayed', value: concurrentReplay };
      }
      throw error;
    }

    return {
      kind: 'prepared',
      value: {
        product,
        shops,
        categoryIdByPlatform,
        skuMappingByPlatform,
        task,
        existingSuccessCount: 0,
        totalTargetShopCount: shops.length,
      },
    };
  }

  private async findIdempotentReplay(
    userId: bigint,
    dto: CreatePublishTaskDto,
  ): Promise<PublishTaskReplay | null> {
    if (!dto.clientRequestId) return null;
    const task = await this.prisma.publishTask.findFirst({
      where: { userId, clientRequestId: dto.clientRequestId },
      include: {
        sourceProduct: { select: { productId1688: true, price: true } },
        job: { select: { id: true } },
      },
    });
    if (!task) return null;

    if (!this.demoMode) {
      const targetShopIds = jsonStringArray(task.targetShopIds).map((id) => BigInt(id));
      const visibleShopCount = targetShopIds.length
        ? await this.prisma.shop.count({
            where: {
              id: { in: targetShopIds },
              userId,
              role: 'seller',
              ...runtimeShopWhere(this.demoMode),
            },
          })
        : 0;
      if (visibleShopCount === 0) throw new NotFoundException('任务不存在');
    }

    assertSameIdempotentRequest(task, dto);
    return {
      taskId: task.id.toString(),
      status: task.status,
      queued: task.job !== null,
      reused: true,
    };
  }

  private publishFeatureAssertions(
    user: CurrentUser,
    dto: CreatePublishTaskDto,
  ): Array<{ id: string; run: () => void }> {
    const assertions: Array<{ id: string; run: () => void }> = [
      {
        id: 'entitlement.publish',
        run: () =>
          this.entitlement.assertFeature(
            user.plan,
            dto.targetShopIds.length > 1 ? 'publish.batch' : 'publish.single',
          ),
      },
      {
        id: 'entitlement.pricing',
        run: () => this.assertPricingFeature(user, dto.pricingStrategy),
      },
    ];
    if (dto.aiOptions?.rewriteDetail === true) {
      assertions.push({
        id: 'entitlement.ai_detail',
        run: () => this.entitlement.assertFeature(user.plan, 'ai.detail'),
      });
    }
    const imageOperations = resolveMainImageOperations(dto);
    if (imageOperations.removeWatermark) {
      assertions.push({
        id: 'entitlement.image_watermark',
        run: () => this.entitlement.assertFeature(user.plan, 'ai.image.watermark'),
      });
    }
    if (imageOperations.relight) {
      assertions.push({
        id: 'entitlement.image_relight',
        run: () => this.entitlement.assertFeature(user.plan, 'ai.image.relight'),
      });
    }
    if (imageOperations.backgroundStyle) {
      assertions.push({
        id: 'entitlement.image_compose',
        run: () => this.entitlement.assertFeature(user.plan, 'ai.image.compose'),
      });
    }
    return assertions;
  }

  private assertPublishFeatures(user: CurrentUser, dto: CreatePublishTaskDto): void {
    for (const assertion of this.publishFeatureAssertions(user, dto)) assertion.run();
  }

  private assertCategoryMappingsForShops(
    product: SourceProductForPublish,
    shops: ShopForPublish[],
    categoryIdByPlatform: Map<string, string>,
  ): void {
    const mockCategoryId = `mock-cat-${product.categoryL1 ?? 'general'}`;
    for (const shop of shops) {
      resolveCategoryId(
        shop.platform,
        product.attributes,
        mockCategoryId,
        isDemoShop(shop),
        categoryIdByPlatform.get(shop.platform),
      );
    }
  }

  private async assertSyncedCategoryCatalog(
    product: SourceProductForPublish,
    shops: ShopForPublish[],
    categoryIdByPlatform: Map<string, string>,
  ): Promise<void> {
    const realDouyinShops = shops.filter((shop) => shop.platform === 'douyin' && !isDemoShop(shop));
    for (const shop of realDouyinShops) {
      const categoryId = resolveCategoryId(
        shop.platform,
        product.attributes,
        '',
        false,
        categoryIdByPlatform.get(shop.platform),
      );
      const catalogCount = await this.prisma.shopCategory.count({
        where: { shopId: shop.id, channel: 0 },
      });
      if (catalogCount === 0) {
        throw new BadRequestException(`请先同步店铺「${shop.shopName ?? shop.id}」的官方类目目录`);
      }
      const category = await this.prisma.shopCategory.findFirst({
        where: {
          shopId: shop.id,
          channel: 0,
          categoryId,
          isLeaf: true,
          enabled: true,
        },
        select: { id: true },
      });
      if (!category) {
        throw new BadRequestException(
          `已确认类目 ${categoryId} 不在店铺「${shop.shopName ?? shop.id}」的可用叶子类目目录中`,
        );
      }
    }
  }

  private async executePrepared(
    user: CurrentUser,
    dto: CreatePublishTaskDto,
    prepared: PreparedPublish,
    lease?: PublishExecutionLease,
  ): Promise<PublishTaskResult> {
    const { product, shops, categoryIdByPlatform, skuMappingByPlatform, task } = prepared;
    const categoryPropertySnapshot = jsonRecord(task.categoryPropertySnapshot) ?? {};
    const categoryQualificationSnapshot = jsonRecord(task.categoryQualificationSnapshot) ?? {};
    assertSourceAvailable(product);
    assertPreviewPricingUnchanged(task.pricingStrategy ?? undefined, product);
    const wantDetail = dto.aiOptions?.rewriteDetail === true;
    const imageOperations = resolveMainImageOperations(dto);
    const wantMainImage = wantsMainImageProcessing(imageOperations);
    await assertPublishExecutionOwned(lease);
    await this.prisma.publishTask.update({
      where: { id: task.id },
      data: { status: 'optimizing', finishedAt: null, errorMsg: null },
    });
    await assertPublishExecutionOwned(lease);

    const existingAi = jsonRecord(task.aiOptimized ?? undefined);
    const aiCheckpoint: Record<string, unknown> = { ...(existingAi ?? {}) };
    const hadCheckpointedTitle = typeof existingAi?.title === 'string' && !!existingAi.title;
    let optimizedTitle = product.title;
    const titleOverride = dto.aiOptions?.titleOverride?.trim();
    const wantTitle = !titleOverride && dto.aiOptions?.rewriteTitle !== false;
    if (typeof existingAi?.title === 'string' && existingAi.title) {
      optimizedTitle = existingAi.title;
    } else if (titleOverride) {
      optimizedTitle = titleOverride;
    } else if (wantTitle) {
      await assertPublishExecutionOwned(lease);
      try {
        const r = await this.ai.generateTitle(user, {
          originalTitle: product.title,
          category: product.categoryPath ?? product.categoryL1 ?? '',
          sellingPoints: sellingPoints(product.categoryL2, product.isOnePieceDrop),
          targetPlatform: shops[0]!.platform as unknown as PlatformType,
        });
        const compatibleTitle = r.titles.find((title) => titleFitsShops(title, shops));
        if (compatibleTitle) optimizedTitle = compatibleTitle;
      } catch (err) {
        this.logger.warn(`AI 标题优化失败，用原标题：${(err as Error).message}`);
      }
      await assertPublishExecutionOwned(lease);
    }
    assertTitleForShops(optimizedTitle, shops, titleOverride ? '所选标题' : '最终标题');
    if (!hadCheckpointedTitle) {
      Object.assign(aiCheckpoint, {
        title: optimizedTitle,
        rewriteTitle: wantTitle,
        titleSelectedByUser: !!titleOverride,
      });
      await this.checkpointAi(task.id, aiCheckpoint, lease);
    }

    // 7. AI 详情优化（显式开启；失败则保留货源详情图片，不阻断铺货）
    let optimizedDetailHtml = stringOrNull(existingAi?.detailHtml);
    let detailComplianceFlags = jsonStringArray(existingAi?.detailComplianceFlags);
    const detailAlreadyAttempted = existingAi?.detailAttempted === true || !!optimizedDetailHtml;
    let detailAttemptedNow = false;
    if (wantDetail && !optimizedDetailHtml && !detailAlreadyAttempted) {
      detailAttemptedNow = true;
      await assertPublishExecutionOwned(lease);
      try {
        const result = await this.ai.generateDetail(user, {
          title: optimizedTitle,
          category: product.categoryPath ?? product.categoryL1 ?? '',
          sellingPoints: sellingPoints(product.categoryL2, product.isOnePieceDrop),
          attributes: stringAttributes(product.attributes),
          targetPlatform: shops[0]!.platform as unknown as PlatformType,
        });
        optimizedDetailHtml = result.detailHtml;
        detailComplianceFlags = result.complianceFlags;
      } catch (err) {
        this.logger.warn(`AI 详情优化失败，保留货源详情：${(err as Error).message}`);
      }
      await assertPublishExecutionOwned(lease);
    }
    if (detailAttemptedNow) {
      Object.assign(aiCheckpoint, {
        detailHtml: optimizedDetailHtml,
        rewriteDetail: wantDetail,
        detailComplianceFlags,
        detailAttempted: true,
      });
      await this.checkpointAi(task.id, aiCheckpoint, lease);
    }

    // 8. 详情 HTML 转长图并托管；未配置 Storage 或上传失败时保留原货源详情图
    let detailImageUrl = stringOrNull(existingAi?.detailImageUrl);
    let detailImageStoredNow = false;
    if (optimizedDetailHtml && !detailImageUrl) {
      try {
        await assertPublishExecutionOwned(lease);
        const image = await this.detailRenderer.render(optimizedDetailHtml);
        await assertPublishExecutionOwned(lease);
        detailImageUrl = await this.assetStorage.uploadDetailImage(user.userId, task.id, image);
        await assertPublishExecutionOwned(lease);
        detailImageStoredNow = true;
      } catch (err) {
        if (isPublishJobLeaseError(err)) throw err;
        this.logger.warn(`AI 详情图片生成或托管失败，保留货源详情：${(err as Error).message}`);
      }
    }
    if (detailImageStoredNow) {
      Object.assign(aiCheckpoint, { detailImageUrl });
      await this.checkpointAi(task.id, aiCheckpoint, lease);
    }

    // 9. 主图处理：远程 GPU 流水线 → 合规审核 → Storage；失败保留货源主图
    let processedMainImageUrl = stringOrNull(existingAi?.mainImageUrl);
    let mainImageResult: MainImageProcessResult | null = null;
    let mainImageError = stringOrNull(existingAi?.mainImageError);
    let mainImageProcessing = existingAi?.mainImageProcessing ?? null;
    const mainImageAlreadyAttempted =
      existingAi?.mainImageAttempted === true || !!processedMainImageUrl;
    let mainImageAttemptedNow = false;
    if (wantMainImage && !processedMainImageUrl && !mainImageAlreadyAttempted) {
      mainImageAttemptedNow = true;
      if (!product.mainImage) {
        mainImageError = '货源没有可处理的主图';
      } else {
        try {
          await assertPublishExecutionOwned(lease);
          this.assetStorage.assertConfigured();
          mainImageResult = await this.imagePipeline.process(
            user,
            product.mainImage,
            imageOperations,
          );
          await assertPublishExecutionOwned(lease);
          processedMainImageUrl = await this.assetStorage.uploadMainImage(
            user.userId,
            task.id,
            mainImageResult.image,
          );
          await assertPublishExecutionOwned(lease);
          mainImageProcessing = {
            provider: mainImageResult.provider,
            model: mainImageResult.model,
            watermarkDetected: mainImageResult.watermarkDetected,
            watermarkCount: mainImageResult.watermarkCount,
            steps: mainImageResult.steps,
            complianceFlags: mainImageResult.complianceFlags,
          };
          mainImageError = null;
        } catch (err) {
          if (isPublishJobLeaseError(err)) throw err;
          mainImageError = safeErrorMessage(err);
          this.logger.warn(`AI 主图处理失败，保留货源主图：${mainImageError}`);
        }
      }
    }
    if (mainImageAttemptedNow) {
      Object.assign(aiCheckpoint, {
        mainImageRequested: wantMainImage,
        mainImageUrl: processedMainImageUrl,
        mainImageError,
        mainImageProcessing,
        mainImageAttempted: true,
      });
      await this.checkpointAi(task.id, aiCheckpoint, lease);
    }

    // 10. 发布前再次核对采购价；排队或 AI 处理期间变化时禁止静默重算。
    await assertPublishExecutionOwned(lease);
    const currentProduct = await this.prisma.sourceProduct.findUnique({
      where: { id: product.id },
      select: { price: true, skuList: true },
    });
    await assertPublishExecutionOwned(lease);
    if (!currentProduct) throw new NotFoundException('货源不存在');
    const costPrice = Number(currentProduct.price);
    assertPreviewPricingUnchanged(task.pricingStrategy ?? undefined, currentProduct);
    const pricing = calculatePricing(costPrice, dto.pricingStrategy);
    const salePrice = pricing.suggestedPrice;
    const skuSnapshot = refreshSkuSnapshotStocks(
      resolveSkuSnapshot(
        product,
        shops.map((shop) => shop.platform),
        skuMappingByPlatform,
        dto.pricingStrategy,
        task.skuSnapshot,
      ),
      currentProduct.skuList,
    );
    const mockCategoryId = `mock-cat-${product.categoryL1 ?? 'general'}`;
    const detailImages = jsonStringArray(product.detailImages);
    const publishDetail = [detailImageUrl, ...detailImages].filter(Boolean).join('|');
    const publishMainImage = processedMainImageUrl ?? product.mainImage;

    await assertPublishExecutionOwned(lease);
    await this.prisma.publishTask.update({
      where: { id: task.id },
      data: {
        status: 'publishing',
        pricingStrategy: confirmedPricingSnapshot(
          dto.pricingStrategy,
          pricing,
          previewSourcePricingFingerprint(task.pricingStrategy),
        ) as Prisma.InputJsonValue,
        skuSnapshot: skuSnapshot as unknown as Prisma.InputJsonValue,
      },
    });
    await assertPublishExecutionOwned(lease);

    // 11. 逐店发布
    const results: PublishShopResult[] = [];
    let success = 0;
    for (const shop of shops) {
      await assertPublishExecutionOwned(lease);
      try {
        const adapter = this.adapters.create(shop);
        const externalProductId = publishExternalId(task.publishExternalIds, shop.id);
        const categoryId = resolveCategoryId(
          shop.platform,
          product.attributes,
          mockCategoryId,
          isDemoShop(shop),
          categoryIdByPlatform.get(shop.platform),
        );
        const accessToken = shop.accessTokenEnc
          ? await this.shopTokens.getAccessToken(shop.id, user.userId)
          : 'mock-token';
        await assertPublishExecutionOwned(lease);
        const publishInput: PublishProductDto = {
          externalProductId,
          title: optimizedTitle,
          detailHtml: publishDetail,
          mainImages: publishMainImage ? [publishMainImage] : [],
          categoryId,
          attributes: stringAttributes(product.attributes),
          categoryProperties: parseCategoryPropertyMap(
            categoryPropertySnapshot[shop.id.toString()],
          ),
          qualifications: parseProductQualifications(
            categoryQualificationSnapshot[shop.id.toString()],
          ),
          skus: skuSnapshot[shop.platform]?.skus ?? defaultPublishSkus(salePrice),
          salePrice,
          costPrice,
        };
        const pub = await this.publishWithRecovery(
          adapter,
          accessToken,
          publishInput,
          !isDemoShop(shop),
          lease,
        );
        const publishedPriceSnapshot = publishedSkuPriceSnapshot(publishInput.skus);
        const requestedInventorySnapshot = publishedSkuInventorySnapshot(publishInput.skus);
        const publishedInventoryState = isDemoShop(shop)
          ? null
          : await this.readPublishedProductInventory(adapter, accessToken, pub.platformProductId);
        const publishedInventorySnapshot = publishedInventoryState
          ? publishedSkuInventorySnapshotFromPlatform(publishedInventoryState.items)
          : requestedInventorySnapshot;
        if (
          !publishedInventorySnapshot ||
          !requestedInventorySnapshot ||
          !samePublishedSkuInventoryIds(publishedInventorySnapshot, requestedInventorySnapshot)
        ) {
          throw new ServiceUnavailableException('平台返回的 SKU 库存不完整，暂不保存发布结果');
        }
        const latestSourceInventory = await this.prisma.sourceProduct.findUnique({
          where: { id: product.id },
          select: { inventoryFingerprint: true, inventoryVersion: true },
        });
        if (!latestSourceInventory) {
          throw new ConflictException('1688 货源已不存在，暂不保存发布结果');
        }
        const platformInventoryMatchesRequest = samePublishedSkuInventory(
          publishedInventorySnapshot,
          requestedInventorySnapshot,
        );
        const sourceInventoryUnchanged =
          latestSourceInventory.inventoryFingerprint === product.inventoryFingerprint &&
          latestSourceInventory.inventoryVersion === product.inventoryVersion;
        const inventoryConfirmed = platformInventoryMatchesRequest && sourceInventoryUnchanged;
        const inventoryCheckedAt = new Date();
        const publishedStatus = publishedInventoryState
          ? mapPlatformProductState(publishedInventoryState, 'draft')
          : 'online';
        const priceSyncedAt = publishedPriceSnapshot ? new Date() : null;
        const publishedInventoryData = product.inventoryFingerprint
          ? {
              skuInventorySnapshot: publishedInventorySnapshot as unknown as Prisma.InputJsonValue,
              inventorySyncStatus: inventoryConfirmed ? ('synced' as const) : ('pending' as const),
              inventoryFingerprint: platformInventoryMatchesRequest
                ? product.inventoryFingerprint
                : null,
              inventoryTargetFingerprint: latestSourceInventory.inventoryFingerprint,
              inventoryVersion: platformInventoryMatchesRequest ? product.inventoryVersion : 0,
              inventoryTargetVersion: latestSourceInventory.inventoryVersion,
              inventoryNextRunAt: inventoryConfirmed ? null : inventoryCheckedAt,
              inventoryLastSyncedAt: inventoryConfirmed ? inventoryCheckedAt : null,
              inventorySyncReason: inventoryConfirmed
                ? 'published'
                : sourceInventoryUnchanged
                  ? 'publish_readback_mismatch'
                  : 'source_changed_during_publish',
              inventorySyncError: inventoryConfirmed
                ? null
                : sourceInventoryUnchanged
                  ? '平台发布后的 SKU 库存与请求不一致，已进入同步队列'
                  : '发布期间 1688 货源库存已变化，已进入同步队列',
            }
          : {
              skuInventorySnapshot: publishedInventorySnapshot as unknown as Prisma.InputJsonValue,
            };
        const publishedData: Prisma.PublishedProductUncheckedCreateInput = {
          taskId: task.id,
          shopId: shop.id,
          sourceProductId: product.id,
          platformProductId: pub.platformProductId,
          title: optimizedTitle,
          salePrice,
          costPrice,
          ...(publishedPriceSnapshot
            ? {
                skuPriceSnapshot: publishedPriceSnapshot as unknown as Prisma.InputJsonValue,
                priceSyncedAt,
              }
            : {}),
          ...publishedInventoryData,
          status: publishedStatus,
          ...(publishedInventoryState
            ? {
                platformStatusRaw: publishedInventoryState.status,
                platformCheckStatusRaw: publishedInventoryState.checkStatus,
                platformStatusSyncedAt: inventoryCheckedAt,
                platformStatusError: null,
              }
            : {}),
          categoryId,
          mainImage: publishMainImage,
        };
        await assertPublishExecutionOwned(lease);
        await this.prisma.publishedProduct.upsert({
          where: { uk_publish_task_shop: { taskId: task.id, shopId: shop.id } },
          create: publishedData,
          update: {
            taskId: task.id,
            shopId: shop.id,
            sourceProductId: product.id,
            platformProductId: pub.platformProductId,
            title: optimizedTitle,
            salePrice,
            costPrice,
            ...(publishedPriceSnapshot
              ? {
                  skuPriceSnapshot: publishedPriceSnapshot as unknown as Prisma.InputJsonValue,
                  priceSyncedAt,
                }
              : {}),
            ...publishedInventoryData,
            status: publishedStatus,
            ...(publishedInventoryState
              ? {
                  platformStatusRaw: publishedInventoryState.status,
                  platformCheckStatusRaw: publishedInventoryState.checkStatus,
                  platformStatusSyncedAt: inventoryCheckedAt,
                  platformStatusError: null,
                }
              : {}),
            categoryId,
            mainImage: publishMainImage,
            mutationRevision: { increment: 1 },
          },
        });
        await assertPublishExecutionOwned(lease);
        const sourceAfterPublishPersist = await this.prisma.sourceProduct.findUnique({
          where: { id: product.id },
          select: { inventoryFingerprint: true, inventoryVersion: true },
        });
        await assertPublishExecutionOwned(lease);
        if (!sourceAfterPublishPersist) {
          throw new ConflictException('1688 货源已不存在，发布结果需要人工核验');
        }
        if (
          sourceAfterPublishPersist.inventoryFingerprint !==
            latestSourceInventory.inventoryFingerprint ||
          sourceAfterPublishPersist.inventoryVersion !== latestSourceInventory.inventoryVersion
        ) {
          const sourceChangedAt = new Date();
          const reconciled = await this.prisma.publishedProduct.updateMany({
            where: {
              taskId: task.id,
              shopId: shop.id,
              platformProductId: pub.platformProductId,
              status: publishedStatus,
              sourceProduct: {
                inventoryFingerprint: sourceAfterPublishPersist.inventoryFingerprint,
                inventoryVersion: sourceAfterPublishPersist.inventoryVersion,
              },
            },
            data:
              publishedStatus === 'online'
                ? {
                    inventorySyncStatus: 'pending',
                    inventoryTargetFingerprint: sourceAfterPublishPersist.inventoryFingerprint,
                    inventoryTargetVersion: sourceAfterPublishPersist.inventoryVersion,
                    inventorySyncAttempts: 0,
                    inventoryNextRunAt: sourceChangedAt,
                    inventoryLockedAt: null,
                    inventoryLockedBy: null,
                    inventorySyncReason: 'source_changed_after_publish',
                    inventorySyncError: '发布落库期间 1688 货源库存已变化，已进入同步队列',
                  }
                : {
                    inventoryTargetFingerprint: sourceAfterPublishPersist.inventoryFingerprint,
                    inventoryTargetVersion: sourceAfterPublishPersist.inventoryVersion,
                  },
          });
          if (reconciled.count !== 1) {
            throw new ConflictException('发布落库期间货源或商品状态再次变化，请刷新后重试');
          }
        }
        await assertPublishExecutionOwned(lease);
        results.push({
          shopId: shop.id.toString(),
          shopName: shop.shopName,
          platform: shop.platform,
          platformProductId: pub.platformProductId,
          url: pub.url,
          salePrice,
        });
        success++;
      } catch (err) {
        if (isPublishJobLeaseError(err)) throw err;
        this.logger.warn(`店铺 ${shop.id} 发布失败：${(err as Error).message}`);
        results.push({
          shopId: shop.id.toString(),
          shopName: shop.shopName,
          platform: shop.platform,
          error: (err as Error).message,
        });
      }
    }

    // 12. 汇总状态
    const totalSuccess = prepared.existingSuccessCount + success;
    const status =
      totalSuccess === prepared.totalTargetShopCount
        ? 'success'
        : totalSuccess > 0
          ? 'partial'
          : 'failed';
    const errorMsg = results
      .map((result) => result.error)
      .filter((value): value is string => !!value)
      .join('；');
    await assertPublishExecutionOwned(lease);
    await this.prisma.publishTask.update({
      where: { id: task.id },
      data: {
        status,
        aiOptimized: {
          ...aiCheckpoint,
          title: optimizedTitle,
          rewriteTitle: wantTitle,
          titleSelectedByUser: !!titleOverride,
          detailHtml: optimizedDetailHtml,
          detailImageUrl,
          rewriteDetail: wantDetail,
          detailComplianceFlags,
          detailAttempted: wantDetail && (detailAlreadyAttempted || detailAttemptedNow),
          mainImageRequested: wantMainImage,
          mainImageUrl: processedMainImageUrl,
          mainImageError,
          mainImageProcessing,
          mainImageAttempted: wantMainImage && (mainImageAlreadyAttempted || mainImageAttemptedNow),
          mainImages: publishMainImage ? [publishMainImage] : [],
        } as Prisma.InputJsonValue,
        errorMsg: errorMsg || null,
        finishedAt: new Date(),
      },
    });
    await assertPublishExecutionOwned(lease);

    return {
      taskId: task.id.toString(),
      status,
      optimizedTitle,
      detailOptimized: !!optimizedDetailHtml,
      detailImageHosted: !!detailImageUrl,
      mainImageRequested: wantMainImage,
      mainImageProcessed: !!processedMainImageUrl,
      mainImageMessage:
        processedMainImageUrl && mainImageResult
          ? mainImageSuccessMessage(mainImageResult)
          : processedMainImageUrl
            ? '已复用上次主图处理结果'
            : mainImageError,
      pricing,
      skuCount: skuSnapshot[shops[0]!.platform]?.skus.length ?? 1,
      skuDimensions: skuSnapshot[shops[0]!.platform]?.dimensions ?? [],
      salePrice,
      results,
    };
  }

  private async checkpointAi(
    taskId: bigint,
    checkpoint: Record<string, unknown>,
    lease?: PublishExecutionLease,
  ): Promise<void> {
    await assertPublishExecutionOwned(lease);
    await this.prisma.publishTask.update({
      where: { id: taskId },
      data: { aiOptimized: { ...checkpoint } as Prisma.InputJsonValue },
    });
    await assertPublishExecutionOwned(lease);
  }

  private async publishWithRecovery(
    adapter: PlatformAdapter,
    accessToken: string,
    input: PublishProductDto,
    requireRecovery: boolean,
    lease?: PublishExecutionLease,
  ): Promise<PublishResult> {
    const externalProductId = input.externalProductId!;
    if (requireRecovery && !adapter.findProductByExternalId) {
      throw new Error('当前平台暂不支持安全幂等铺货');
    }
    try {
      await assertPublishExecutionOwned(lease);
      const result = await adapter.publishProduct(accessToken, input);
      await assertPublishExecutionOwned(lease);
      return result;
    } catch (publishError) {
      if (isPublishJobLeaseError(publishError)) throw publishError;
      if (!adapter.findProductByExternalId) throw publishError;
      try {
        await assertPublishExecutionOwned(lease);
        const recovered = await adapter.findProductByExternalId(accessToken, externalProductId);
        await assertPublishExecutionOwned(lease);
        if (recovered) {
          this.logger.warn(`平台发布结果已按外部编码恢复：${externalProductId}`);
          return recovered;
        }
      } catch (recoveryError) {
        if (isPublishJobLeaseError(recoveryError)) throw recoveryError;
        this.logger.warn(`平台发布结果恢复查询失败：${safeErrorMessage(recoveryError)}`);
      }
      throw publishError;
    }
  }

  private async readPublishedProductInventory(
    adapter: PlatformAdapter,
    accessToken: string,
    platformProductId: string,
  ): Promise<PlatformProductInventoryState> {
    if (!adapter.getProductInventory) {
      throw new ServiceUnavailableException('当前平台无法回读 SKU 库存，暂不保存发布结果');
    }
    return adapter.getProductInventory(accessToken, platformProductId);
  }

  private assertPricingFeature(
    user: CurrentUser,
    strategy: CreatePublishTaskDto['pricingStrategy'],
  ): void {
    if (strategy && strategy.mode !== 'fixed_markup') {
      this.entitlement.assertFeature(user.plan, 'ai.pricing');
    }
  }

  async updatePublishedProduct(
    user: CurrentUser,
    idValue: string,
    dto: UpdatePublishedProductDto,
  ): Promise<PublishedProductUpdateResult> {
    const publishedProductId = parsePositiveId(idValue, '已发布商品 ID');
    const record = await this.prisma.publishedProduct.findFirst({
      where: {
        id: publishedProductId,
        task: { userId: user.userId },
        shop: {
          role: 'seller',
          status: 'active',
          ...runtimeShopWhere(this.demoMode),
        },
      },
      include: {
        shop: true,
        task: true,
        sourceProduct: { include: { score: true } },
      },
    });
    if (!record) throw new NotFoundException('已发布商品不存在或目标店铺不可用');
    if (!record.platformProductId) throw new BadRequestException('平台商品 ID 不存在');
    const unresolvedPlatformMutation = await this.prisma.productBatchItem.findFirst({
      where: {
        publishedProductId: record.id,
        status: { in: ['running', 'retry_wait', 'failed'] },
        OR: [
          {
            errorCode: { in: ['TITLE_WRITE_STARTED', 'TITLE_RESULT_UNKNOWN'] },
            task: { userId: user.userId, action: 'edit_title' },
          },
          {
            errorCode: { in: ['ONLINE_WRITE_STARTED', 'ONLINE_RESULT_UNKNOWN'] },
            task: { userId: user.userId, action: 'online' },
          },
        ],
      },
      select: { id: true },
    });
    if (unresolvedPlatformMutation) {
      throw new ConflictException('商品存在结果待核验的平台写入，请先在原批量任务完成核验');
    }
    assertSourceAvailable(record.sourceProduct);

    const shop = record.shop;
    if (!isDemoShop(shop) && shop.platform !== 'douyin') {
      throw new BadRequestException('当前仅支持修正已发布的抖店商品');
    }
    const title = dto.title?.trim() || record.title;
    assertTitleForShops(title, [shop], '修正标题');
    let categoryId = record.categoryId;
    let categoryProperties: CategoryPropertyMap | undefined;
    let qualifications: ProductQualification[] | undefined;

    if (shop.platform === 'douyin' && !isDemoShop(shop)) {
      const mapping = await this.prisma.productCategoryMapping.findUnique({
        where: {
          uk_user_product_platform_category: {
            userId: user.userId,
            sourceProductId: record.sourceProductId,
            platform: 'douyin',
          },
        },
      });
      if (!mapping) throw new BadRequestException('请先确认抖店叶子类目');
      if (record.categoryId && record.categoryId !== mapping.categoryId) {
        throw new BadRequestException('抖店不支持修改已发布商品类目，请按新类目重新铺货');
      }
      categoryId = mapping.categoryId;
      await this.assertSyncedCategoryCatalog(
        record.sourceProduct,
        [shop],
        new Map([['douyin', categoryId]]),
      );
      const target = [{ shopId: shop.id, categoryId }];
      const [propertySnapshot, qualificationSnapshot] = await Promise.all([
        this.categoryProperties.buildPublishSnapshot(user.userId, record.sourceProductId, target, {
          refresh: true,
        }),
        this.categoryQualifications.buildPublishSnapshot(
          user.userId,
          record.sourceProductId,
          target,
          { refresh: true },
        ),
      ]);
      categoryProperties = parseCategoryPropertyMap(propertySnapshot[shop.id.toString()]);
      qualifications = parseProductQualifications(qualificationSnapshot[shop.id.toString()]);
    }

    categoryId ??= resolveCategoryId(
      shop.platform,
      record.sourceProduct.attributes,
      `mock-cat-${record.sourceProduct.categoryL1 ?? 'general'}`,
      isDemoShop(shop),
    );
    const skuMappings = await this.prisma.productSkuMapping.findMany({
      where: {
        userId: user.userId,
        sourceProductId: record.sourceProductId,
        platform: shop.platform,
      },
    });
    const skuSnapshot = refreshSkuSnapshotStocks(
      resolveSkuSnapshot(
        record.sourceProduct,
        [shop.platform],
        new Map(skuMappings.map((mapping) => [mapping.platform, mapping])),
        (record.task.pricingStrategy ?? undefined) as
          | CreatePublishTaskDto['pricingStrategy']
          | undefined,
        record.task.skuSnapshot,
      ),
      record.sourceProduct.skuList,
    );
    const baseEditSkus =
      skuSnapshot[shop.platform]?.skus ?? defaultPublishSkus(Number(record.salePrice));
    let confirmedPriceSnapshot = parsePublishedSkuPriceSnapshot(record.skuPriceSnapshot);
    let confirmedInventorySnapshot = parsePublishedSkuInventorySnapshot(
      record.skuInventorySnapshot,
    );
    let confirmedEditPlatformState: PlatformProductState | null = null;
    const sourceInventorySnapshot = publishedSkuInventorySnapshot(baseEditSkus);
    let editSkus = applyPublishedSkuPrices(baseEditSkus, record.skuPriceSnapshot);
    let editSalePrice = Number(record.salePrice);
    const aiOptimized = jsonRecord(record.task.aiOptimized ?? undefined);
    const detailImages = jsonStringArray(record.sourceProduct.detailImages ?? undefined);
    const detailImageUrl = stringOrNull(aiOptimized?.detailImageUrl);
    const mainImage = record.mainImage ?? record.sourceProduct.mainImage;
    const platformLock = await this.platformProductLocks.acquire(record.id);
    try {
      const unresolvedPlatformMutationAfterLock = await this.prisma.productBatchItem.findFirst({
        where: {
          publishedProductId: record.id,
          status: { in: ['running', 'retry_wait', 'failed'] },
          OR: [
            {
              errorCode: { in: ['TITLE_WRITE_STARTED', 'TITLE_RESULT_UNKNOWN'] },
              task: { userId: user.userId, action: 'edit_title' },
            },
            {
              errorCode: { in: ['ONLINE_WRITE_STARTED', 'ONLINE_RESULT_UNKNOWN'] },
              task: { userId: user.userId, action: 'online' },
            },
          ],
        },
        select: { id: true },
      });
      if (unresolvedPlatformMutationAfterLock) {
        throw new ConflictException('商品存在结果待核验的平台写入，请先在原批量任务完成核验');
      }
      const currentProduct = await this.prisma.publishedProduct.findFirst({
        where: {
          id: record.id,
          task: { userId: user.userId },
          shop: {
            role: 'seller',
            status: 'active',
            ...runtimeShopWhere(this.demoMode),
          },
        },
        select: {
          shopId: true,
          platformProductId: true,
          status: true,
          mutationRevision: true,
        },
      });
      if (
        !currentProduct ||
        currentProduct.shopId !== record.shopId ||
        currentProduct.platformProductId !== record.platformProductId ||
        currentProduct.mutationRevision !== record.mutationRevision
      ) {
        throw new ConflictException('商品已在修正前发生变化，请刷新后重试');
      }
      const currentSource = await this.prisma.sourceProduct.findUnique({
        where: { id: record.sourceProductId },
        select: { inventoryFingerprint: true, inventoryVersion: true },
      });
      if (
        !currentSource ||
        currentSource.inventoryFingerprint !== record.sourceProduct.inventoryFingerprint ||
        currentSource.inventoryVersion !== record.sourceProduct.inventoryVersion
      ) {
        throw new ConflictException('货源库存已变化，请刷新后重新修正商品');
      }

      const attemptAt = new Date();
      await this.prisma.publishedProduct.update({
        where: { id: record.id },
        data: {
          editAttempts: { increment: 1 },
          lastEditAttemptAt: attemptAt,
          lastEditError: null,
        },
      });

      try {
        const adapter = this.adapters.create(shop);
        const token = shop.accessTokenEnc
          ? await this.shopTokens.getAccessToken(shop.id, user.userId)
          : 'mock-token';
        if (!isDemoShop(shop)) {
          if (!adapter.getProductPrices) {
            throw new ServiceUnavailableException('当前平台无法回读 SKU 价格，拒绝编辑商品');
          }
          const platformPrices = publishedSkuPriceSnapshotFromPlatform(
            (await adapter.getProductPrices(token, record.platformProductId)).items,
          );
          if (!platformPrices) {
            throw new ServiceUnavailableException('平台返回的 SKU 价格不完整，拒绝编辑商品');
          }
          if (
            confirmedPriceSnapshot &&
            !samePublishedSkuPrices(confirmedPriceSnapshot, platformPrices)
          ) {
            const synced = await this.prisma.publishedProduct.updateMany({
              where: {
                id: record.id,
                platformProductId: currentProduct.platformProductId,
                mutationRevision: currentProduct.mutationRevision,
              },
              data: {
                salePrice: publishedSkuStartPrice(platformPrices),
                skuPriceSnapshot: platformPrices as unknown as Prisma.InputJsonValue,
                priceSyncedAt: new Date(),
                lastEditError: '平台 SKU 价格已变化，请确认后重试商品编辑',
                mutationRevision: { increment: 1 },
              },
            });
            if (synced.count !== 1) {
              throw new ConflictException('商品已在价格同步期间发生变化，请刷新后重试');
            }
            throw new ConflictException('平台 SKU 价格已变化并同步，请确认后重新编辑');
          }
          confirmedPriceSnapshot = platformPrices;
          editSkus = applyPublishedSkuPrices(
            baseEditSkus,
            platformPrices as unknown as Prisma.JsonValue,
          );
          editSalePrice = publishedSkuStartPrice(platformPrices);

          const platformInventoryState = await this.readPublishedProductInventory(
            adapter,
            token,
            record.platformProductId,
          );
          assertFullProductEditState(platformInventoryState);
          const platformInventory = publishedSkuInventorySnapshotFromPlatform(
            platformInventoryState.items,
          );
          if (
            !platformInventory ||
            !sourceInventorySnapshot ||
            !samePublishedSkuInventoryIds(platformInventory, sourceInventorySnapshot)
          ) {
            throw new ServiceUnavailableException('平台返回的 SKU 库存不完整，拒绝编辑商品');
          }
          if (
            confirmedInventorySnapshot &&
            !samePublishedSkuInventory(confirmedInventorySnapshot, platformInventory)
          ) {
            const synced = await this.prisma.publishedProduct.updateMany({
              where: {
                id: record.id,
                platformProductId: currentProduct.platformProductId,
                mutationRevision: currentProduct.mutationRevision,
                sourceProduct: {
                  inventoryFingerprint: record.sourceProduct.inventoryFingerprint,
                  inventoryVersion: record.sourceProduct.inventoryVersion,
                },
              },
              data: {
                skuInventorySnapshot: platformInventory as unknown as Prisma.InputJsonValue,
                inventorySyncStatus: 'pending',
                inventoryTargetFingerprint: record.sourceProduct.inventoryFingerprint,
                inventoryTargetVersion: record.sourceProduct.inventoryVersion,
                inventoryNextRunAt: new Date(),
                inventorySyncReason: 'platform_inventory_changed',
                inventorySyncError: '平台 SKU 库存已变化，请确认后重试商品编辑',
                lastEditError: '平台 SKU 库存已变化，请确认后重试商品编辑',
                mutationRevision: { increment: 1 },
              },
            });
            if (synced.count !== 1) {
              throw new ConflictException('商品已在库存同步期间发生变化，请刷新后重试');
            }
            throw new ConflictException('平台 SKU 库存已变化并同步，请确认后重新编辑');
          }
          confirmedInventorySnapshot = platformInventory;
          editSkus = applyPublishedSkuInventory(editSkus, platformInventory);
        }
        await this.platformProductLocks.renew(record.id, platformLock);
        if (!isDemoShop(shop)) {
          // product.editV2 requires stock_num for every SKU and exposes no conditional stock write.
          // Only a platform-confirmed non-saleable product may cross this full-edit boundary.
          const platformStateBeforeWrite = await this.readPublishedProductInventory(
            adapter,
            token,
            record.platformProductId,
          );
          assertFullProductEditState(platformStateBeforeWrite);
          const platformInventoryBeforeWrite = publishedSkuInventorySnapshotFromPlatform(
            platformStateBeforeWrite.items,
          );
          if (
            !platformInventoryBeforeWrite ||
            !sourceInventorySnapshot ||
            !samePublishedSkuInventoryIds(platformInventoryBeforeWrite, sourceInventorySnapshot)
          ) {
            throw new ServiceUnavailableException('平台返回的 SKU 库存不完整，拒绝编辑商品');
          }
          if (
            !confirmedInventorySnapshot ||
            !samePublishedSkuInventory(platformInventoryBeforeWrite, confirmedInventorySnapshot)
          ) {
            const synced = await this.prisma.publishedProduct.updateMany({
              where: {
                id: record.id,
                platformProductId: currentProduct.platformProductId,
                mutationRevision: currentProduct.mutationRevision,
                sourceProduct: {
                  inventoryFingerprint: record.sourceProduct.inventoryFingerprint,
                  inventoryVersion: record.sourceProduct.inventoryVersion,
                },
              },
              data: {
                skuInventorySnapshot:
                  platformInventoryBeforeWrite as unknown as Prisma.InputJsonValue,
                inventorySyncStatus: 'pending',
                inventoryTargetFingerprint: record.sourceProduct.inventoryFingerprint,
                inventoryTargetVersion: record.sourceProduct.inventoryVersion,
                inventoryNextRunAt: new Date(),
                inventorySyncReason: 'platform_inventory_changed_before_edit',
                inventorySyncError: '商品编辑提交前平台 SKU 库存已变化',
                lastEditError: '商品编辑提交前平台 SKU 库存已变化',
                mutationRevision: { increment: 1 },
              },
            });
            if (synced.count !== 1) {
              throw new ConflictException('商品已在库存同步期间发生变化，请刷新后重试');
            }
            throw new ConflictException('平台 SKU 库存在提交前发生变化并已同步，请重新编辑');
          }
          confirmedInventorySnapshot = platformInventoryBeforeWrite;
          confirmedEditPlatformState = platformStateBeforeWrite;
          editSkus = applyPublishedSkuInventory(editSkus, platformInventoryBeforeWrite);
        }
        await adapter.updateProduct(token, {
          platformProductId: record.platformProductId,
          title,
          detailHtml: [detailImageUrl, ...detailImages].filter(Boolean).join('|'),
          mainImages: mainImage ? [mainImage] : [],
          categoryId,
          attributes: stringAttributes(record.sourceProduct.attributes),
          categoryProperties,
          qualifications,
          skus: editSkus,
          salePrice: editSalePrice,
          costPrice: record.costPrice === null ? undefined : Number(record.costPrice),
        });
        await this.platformProductLocks.renew(record.id, platformLock);
        if (!isDemoShop(shop)) {
          const platformStateAfterEdit = await this.readPublishedProductInventory(
            adapter,
            token,
            record.platformProductId,
          );
          const platformInventoryAfterEdit = publishedSkuInventorySnapshotFromPlatform(
            platformStateAfterEdit.items,
          );
          if (
            !platformInventoryAfterEdit ||
            !confirmedInventorySnapshot ||
            !samePublishedSkuInventory(platformInventoryAfterEdit, confirmedInventorySnapshot)
          ) {
            if (platformInventoryAfterEdit) {
              await this.prisma.publishedProduct.updateMany({
                where: {
                  id: record.id,
                  platformProductId: currentProduct.platformProductId,
                  mutationRevision: currentProduct.mutationRevision,
                  sourceProduct: {
                    inventoryFingerprint: record.sourceProduct.inventoryFingerprint,
                    inventoryVersion: record.sourceProduct.inventoryVersion,
                  },
                },
                data: {
                  skuInventorySnapshot:
                    platformInventoryAfterEdit as unknown as Prisma.InputJsonValue,
                  inventorySyncStatus: 'pending',
                  inventoryTargetFingerprint: record.sourceProduct.inventoryFingerprint,
                  inventoryTargetVersion: record.sourceProduct.inventoryVersion,
                  inventoryNextRunAt: new Date(),
                  inventorySyncReason: 'product_edit_readback_mismatch',
                  inventorySyncError: '商品编辑后的平台 SKU 库存与提交前不一致',
                  lastEditError: '商品编辑后的平台 SKU 库存与提交前不一致',
                  mutationRevision: { increment: 1 },
                },
              });
            }
            throw new ConflictException('平台未确认商品编辑后的 SKU 库存，请刷新后重试');
          }
          confirmedInventorySnapshot = platformInventoryAfterEdit;
          confirmedEditPlatformState = platformStateAfterEdit;
        }
      } catch (error) {
        if (error instanceof ConflictException || error instanceof ServiceUnavailableException) {
          throw error;
        }
        const message = (error instanceof Error ? error.message : '平台商品更新失败').slice(
          0,
          1000,
        );
        await this.prisma.publishedProduct.update({
          where: { id: record.id },
          data: { lastEditError: message },
        });
        throw new BadRequestException(`平台商品更新失败：${message}`);
      }

      const lastEditedAt = new Date();
      const editedInventorySnapshot =
        confirmedInventorySnapshot ?? publishedSkuInventorySnapshot(editSkus);
      const inventoryMatchesSource =
        !!editedInventorySnapshot &&
        !!sourceInventorySnapshot &&
        samePublishedSkuInventory(editedInventorySnapshot, sourceInventorySnapshot);
      const fallbackStatus = currentProduct.status === 'rejected' ? 'draft' : currentProduct.status;
      const status = confirmedEditPlatformState
        ? mapPlatformProductState(confirmedEditPlatformState, fallbackStatus)
        : fallbackStatus;
      const updated = await this.prisma.publishedProduct.updateMany({
        where: {
          id: record.id,
          platformProductId: currentProduct.platformProductId,
          mutationRevision: currentProduct.mutationRevision,
          sourceProduct: {
            inventoryFingerprint: record.sourceProduct.inventoryFingerprint,
            inventoryVersion: record.sourceProduct.inventoryVersion,
          },
        },
        data: {
          title,
          categoryId,
          mainImage,
          status,
          salePrice: editSalePrice,
          ...(confirmedPriceSnapshot
            ? {
                skuPriceSnapshot: confirmedPriceSnapshot as unknown as Prisma.InputJsonValue,
                priceSyncedAt: lastEditedAt,
              }
            : {}),
          ...(editedInventorySnapshot
            ? {
                skuInventorySnapshot: editedInventorySnapshot as unknown as Prisma.InputJsonValue,
                inventorySyncStatus: inventoryMatchesSource
                  ? ('synced' as const)
                  : ('pending' as const),
                inventoryFingerprint: inventoryMatchesSource
                  ? record.sourceProduct.inventoryFingerprint
                  : record.inventoryFingerprint,
                inventoryTargetFingerprint: record.sourceProduct.inventoryFingerprint,
                inventoryVersion: inventoryMatchesSource
                  ? record.sourceProduct.inventoryVersion
                  : record.inventoryVersion,
                inventoryTargetVersion: record.sourceProduct.inventoryVersion,
                inventorySyncAttempts: 0,
                inventoryNextRunAt: inventoryMatchesSource ? null : lastEditedAt,
                inventoryLockedAt: null,
                inventoryLockedBy: null,
                inventoryLastSyncedAt: inventoryMatchesSource
                  ? lastEditedAt
                  : record.inventoryLastSyncedAt,
                inventorySyncReason: inventoryMatchesSource
                  ? 'product_edit'
                  : 'product_edit_inventory_pending',
                inventorySyncError: null,
              }
            : {}),
          lastEditedAt,
          lastEditError: null,
          ...(confirmedEditPlatformState
            ? {
                platformStatusRaw: confirmedEditPlatformState.status,
                platformCheckStatusRaw: confirmedEditPlatformState.checkStatus,
                platformStatusSyncedAt: lastEditedAt,
                platformStatusError: null,
              }
            : {
                platformStatusRaw: null,
                platformCheckStatusRaw: null,
                platformStatusSyncedAt: null,
                platformStatusError: null,
              }),
          mutationRevision: { increment: 1 },
        },
      });
      if (updated.count !== 1) {
        throw new ConflictException('商品已在修正期间发生变化，请刷新平台状态后重试');
      }
      return {
        publishedProductId: record.id.toString(),
        title,
        status,
        lastEditedAt: lastEditedAt.toISOString(),
      };
    } finally {
      await this.platformProductLocks.release(record.id, platformLock);
    }
  }

  async syncPublishedProductStatus(
    user: CurrentUser,
    idValue: string,
  ): Promise<PublishedProductStatusResult> {
    const publishedProductId = parsePositiveId(idValue, '已发布商品 ID');
    const record = await this.prisma.publishedProduct.findFirst({
      where: {
        id: publishedProductId,
        task: { userId: user.userId },
        shop: {
          role: 'seller',
          status: 'active',
          ...runtimeShopWhere(this.demoMode),
        },
      },
      include: { shop: true },
    });
    if (!record) throw new NotFoundException('已发布商品不存在或目标店铺不可用');
    if (!record.platformProductId) throw new BadRequestException('平台商品 ID 不存在');
    const unresolvedOnlineMutation = await this.prisma.productBatchItem.findFirst({
      where: {
        publishedProductId: record.id,
        status: { in: ['running', 'retry_wait', 'failed'] },
        errorCode: { in: ['ONLINE_WRITE_STARTED', 'ONLINE_RESULT_UNKNOWN'] },
        task: { userId: user.userId, action: 'online' },
      },
      select: { id: true },
    });
    if (unresolvedOnlineMutation) {
      throw new ConflictException('商品存在结果待核验的上架操作，请先在原批量任务完成核验');
    }
    const platformLock = await this.platformProductLocks.acquire(record.id);
    try {
      const current = await this.prisma.publishedProduct.findFirst({
        where: {
          id: record.id,
          task: { userId: user.userId },
          shop: {
            role: 'seller',
            status: 'active',
            ...runtimeShopWhere(this.demoMode),
          },
        },
        include: { shop: true },
      });
      if (!current?.platformProductId) {
        throw new ConflictException('商品已在状态同步前发生变化，请刷新后重试');
      }
      const unresolvedOnlineMutationAfterLock = await this.prisma.productBatchItem.findFirst({
        where: {
          publishedProductId: current.id,
          status: { in: ['running', 'retry_wait', 'failed'] },
          errorCode: { in: ['ONLINE_WRITE_STARTED', 'ONLINE_RESULT_UNKNOWN'] },
          task: { userId: user.userId, action: 'online' },
        },
        select: { id: true },
      });
      if (unresolvedOnlineMutationAfterLock) {
        throw new ConflictException('商品存在结果待核验的上架操作，请先在原批量任务完成核验');
      }
      const adapter = this.adapters.create(current.shop);
      if (!adapter.getProductState) {
        throw new BadRequestException('当前平台暂不支持商品状态同步');
      }
      const token = current.shop.accessTokenEnc
        ? await this.shopTokens.getAccessToken(current.shop.id, user.userId)
        : 'mock-token';
      await this.platformProductLocks.renew(current.id, platformLock);
      const platformState = await adapter.getProductState(token, current.platformProductId);
      await this.platformProductLocks.renew(current.id, platformLock);
      const status = mapPlatformProductState(platformState, current.status);
      const syncedAt = new Date();
      const inventoryBehindTarget =
        status === 'online' &&
        !!current.inventoryTargetFingerprint &&
        current.inventoryTargetVersion > 0 &&
        (current.inventoryFingerprint !== current.inventoryTargetFingerprint ||
          current.inventoryVersion !== current.inventoryTargetVersion);
      const updated = await this.prisma.publishedProduct.updateMany({
        where: {
          id: current.id,
          platformProductId: current.platformProductId,
          mutationRevision: current.mutationRevision,
        },
        data: {
          status,
          platformStatusRaw: platformState.status,
          platformCheckStatusRaw: platformState.checkStatus,
          platformStatusSyncedAt: syncedAt,
          platformStatusError: null,
          ...(inventoryBehindTarget
            ? {
                inventorySyncStatus: 'pending',
                inventorySyncAttempts: 0,
                inventoryNextRunAt: syncedAt,
                inventoryLockedAt: null,
                inventoryLockedBy: null,
                inventorySyncError: null,
              }
            : {}),
          mutationRevision: { increment: 1 },
        },
      });
      if (updated.count !== 1) {
        throw new ConflictException('商品已在状态同步期间发生变化，请刷新后重试');
      }
      return {
        publishedProductId: current.id.toString(),
        status,
        platformStatus: platformState.status,
        platformCheckStatus: platformState.checkStatus,
        syncedAt: syncedAt.toISOString(),
      };
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof ConflictException ||
        error instanceof ServiceUnavailableException
      ) {
        throw error;
      }
      const message = (error instanceof Error ? error.message : '平台商品状态同步失败').slice(
        0,
        1000,
      );
      await this.prisma.publishedProduct.update({
        where: { id: record.id },
        data: { platformStatusError: message },
      });
      throw new BadRequestException(`平台商品状态同步失败：${message}`);
    } finally {
      await this.platformProductLocks.release(record.id, platformLock);
    }
  }

  /** 铺货任务详情 */
  async detail(user: CurrentUser, id: string): Promise<PublishTaskSummary> {
    let taskId: bigint;
    try {
      taskId = BigInt(id);
    } catch {
      throw new BadRequestException('无效任务 ID');
    }
    const visibilityWhere = await this.publishTaskVisibilityWhere(user.userId);
    if (!visibilityWhere) throw new NotFoundException('任务不存在');
    const task = await this.prisma.publishTask.findFirst({
      where: { id: taskId, ...visibilityWhere },
      include: {
        publishedProducts: {
          ...(this.demoMode ? {} : { where: { shop: runtimeShopWhere(this.demoMode) } }),
          include: { shop: true },
        },
        sourceProduct: true,
        job: true,
      },
    });
    if (!task) throw new NotFoundException('任务不存在');
    return toSummary(task);
  }

  /** 通过客户端请求标识恢复当前用户的铺货任务。 */
  async detailByClientRequestId(
    user: CurrentUser,
    clientRequestId: string,
  ): Promise<PublishTaskSummary> {
    const visibilityWhere = await this.publishTaskVisibilityWhere(user.userId);
    if (!visibilityWhere) throw new NotFoundException('任务不存在');
    const task = await this.prisma.publishTask.findFirst({
      where: { clientRequestId, ...visibilityWhere },
      include: {
        publishedProducts: {
          ...(this.demoMode ? {} : { where: { shop: runtimeShopWhere(this.demoMode) } }),
          include: { shop: true },
        },
        sourceProduct: true,
        job: true,
      },
    });
    if (!task) throw new NotFoundException('任务不存在');
    return toSummary(task);
  }

  /** 当前用户的铺货记录（完整分页；生产身份模式排除历史演示目标店铺）。 */
  async list(user: CurrentUser, page: number, pageSize: number): Promise<PublishTaskPage> {
    const where = await this.publishTaskVisibilityWhere(user.userId);
    if (!where) return { items: [], total: 0, page, pageSize };
    const [total, tasks] = await Promise.all([
      this.prisma.publishTask.count({ where }),
      this.prisma.publishTask.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          publishedProducts: {
            ...(this.demoMode ? {} : { where: { shop: runtimeShopWhere(this.demoMode) } }),
            include: { shop: true },
          },
          sourceProduct: true,
          job: true,
        },
      }),
    ]);
    return { items: tasks.map(toSummary), total, page, pageSize };
  }

  private async publishTaskVisibilityWhere(
    userId: bigint,
  ): Promise<Prisma.PublishTaskWhereInput | null> {
    if (this.demoMode) return { userId };
    const shops = await this.prisma.shop.findMany({
      where: {
        userId,
        role: 'seller',
        ...runtimeShopWhere(this.demoMode),
      },
      select: { id: true },
    });
    if (!shops.length) return null;
    return {
      userId,
      OR: shops.map((shop) => ({
        targetShopIds: { array_contains: [shop.id.toString()] },
      })),
    };
  }
}

const preflightLogger = new Logger('PublishPreflight');

function preflightCheck(
  id: string,
  scope: NonNullable<PublishPreflightCheck['scope']>,
  error: unknown,
  options: Pick<PublishPreflightCheck, 'shopId' | 'actionHref'> = {},
): PublishPreflightCheck {
  if (!(error instanceof HttpException)) {
    preflightLogger.error({
      event: 'publish.preflight.check_failed',
      checkId: id,
      errorType: preflightErrorType(error),
    });
  }
  return {
    id,
    severity: 'blocker',
    scope,
    message: exceptionMessage(error),
    ...options,
  };
}

function exceptionMessage(error: unknown): string {
  if (error instanceof HttpException) {
    const response = error.getResponse();
    if (typeof response === 'string') return response;
    const message = unknownRecord(response)?.message;
    if (typeof message === 'string' && message) return message;
    if (Array.isArray(message))
      return message.filter((item) => typeof item === 'string').join('；');
  }
  return '预检读取失败，请稍后重试';
}

function preflightErrorType(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  const name = Object.getPrototypeOf(error)?.constructor?.name;
  return typeof name === 'string' && /^[A-Za-z][A-Za-z0-9_$]{0,63}$/.test(name) ? name : 'Error';
}

function unknownRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function assertSameIdempotentRequest(task: IdempotentPublishTask, dto: CreatePublishTaskDto): void {
  const sameSource = task.sourceProduct.productId1688 === dto.sourceProductId;
  const storedTargets = [...jsonStringArray(task.targetShopIds)].sort();
  const requestedTargets = [...dto.targetShopIds].sort();
  const sameTargets =
    storedTargets.length === requestedTargets.length &&
    storedTargets.every((target, index) => target === requestedTargets[index]);
  const storedPricing = pricingInput(
    (task.pricingStrategy ?? undefined) as CreatePublishTaskDto['pricingStrategy'],
  );
  const samePricing = equivalentJson(
    calculatePricing(Number(task.sourceProduct.price), storedPricing),
    calculatePricing(Number(task.sourceProduct.price), dto.pricingStrategy),
  );
  const sameAiOptions = equivalentJson(task.aiOptions, dto.aiOptions);
  if (sameSource && sameTargets && samePricing && sameAiOptions) return;
  throw new ConflictException('该请求标识已用于不同的铺货参数，请生成新的请求标识后重试');
}

function assertPreviewPricingUnchanged(
  snapshot: Prisma.JsonValue | undefined,
  source: { price: unknown; skuList: unknown },
): void {
  const value = previewCostPrice(snapshot);
  const expectedFingerprint = previewSourcePricingFingerprint(snapshot);
  if (value === null || !expectedFingerprint) {
    throw new ConflictException({
      code: 'PRICING_PREVIEW_MISSING',
      message: '铺货任务缺少已确认的成本快照，请重新完成利润试算并创建新任务',
    });
  }
  const currentCost = Number(source.price);
  const costMatches = Math.round(value * 100) === Math.round(currentCost * 100);
  const fingerprintMatches = expectedFingerprint === pricingSourceFingerprint(source);
  if (costMatches && fingerprintMatches) return;
  throw new ConflictException({
    code: 'PRICING_PREVIEW_STALE',
    message: '1688 采购价已变化，请返回商品重新完成利润试算并创建新任务',
  });
}

function confirmedPricingSnapshot(
  strategy: PricingStrategyDto | undefined,
  quote: PricingQuote,
  sourcePricingFingerprint: string,
): Record<string, unknown> {
  return { ...pricingSnapshot(strategy, quote), sourcePricingFingerprint };
}

function previewCostPrice(snapshot: Prisma.JsonValue | null | undefined): number | null {
  const value = jsonRecord(snapshot ?? undefined)?.costPrice;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function previewSourcePricingFingerprint(snapshot: Prisma.JsonValue | null | undefined): string {
  const value = jsonRecord(snapshot ?? undefined)?.sourcePricingFingerprint;
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : '';
}

function equivalentJson(left: unknown, right: unknown): boolean {
  if (left == null && right == null) return true;
  return JSON.stringify(normalizeJson(left)) === JSON.stringify(normalizeJson(right));
}

function normalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, normalizeJson(entry)]),
  );
}

function isPrismaUniqueConstraintError(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'P2002';
}

function realDouyinCategoryTargets(
  product: SourceProductForPublish,
  shops: ShopForPublish[],
  categoryIdByPlatform: Map<string, string>,
): Array<{ shopId: bigint; categoryId: string }> {
  return shops.flatMap((shop) =>
    shop.platform === 'douyin' && !isDemoShop(shop)
      ? [
          {
            shopId: shop.id,
            categoryId: resolveCategoryId(
              shop.platform,
              product.attributes,
              '',
              false,
              categoryIdByPlatform.get(shop.platform),
            ),
          },
        ]
      : [],
  );
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

function mapPlatformProductState(
  state: PlatformProductState,
  currentStatus: 'online' | 'offline' | 'draft' | 'rejected',
): 'online' | 'offline' | 'draft' | 'rejected' {
  if (state.state === 'online') return 'online';
  if (state.state === 'rejected' || state.state === 'blocked' || state.state === 'deleted') {
    return 'rejected';
  }
  if (state.state === 'offline') return 'offline';
  if (
    state.state === 'draft' ||
    state.state === 'reviewing' ||
    state.state === 'approved_pending_online'
  ) {
    return 'draft';
  }
  return currentStatus;
}

function assertFullProductEditState(state: PlatformProductState): void {
  if (state.state === 'offline' || state.state === 'draft') return;
  if (state.state === 'online') {
    throw new ConflictException('在线商品不能执行完整编辑，请先下架商品后重试');
  }
  throw new ConflictException(`平台商品当前状态为 ${state.state}，不能执行完整编辑`);
}

function parseCategoryPropertyMap(value: unknown): CategoryPropertyMap | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as CategoryPropertyMap)
    : undefined;
}

function parseProductQualifications(value: unknown): ProductQualification[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value as ProductQualification[];
}

function resolveCategoryId(
  platform: string,
  attributes: Prisma.JsonValue,
  mockCategoryId: string,
  demo: boolean,
  confirmedCategoryId?: string,
): string {
  if (demo) return mockCategoryId;
  if (confirmedCategoryId) return confirmedCategoryId;

  const record = jsonRecord(attributes);
  const categoryIds = jsonRecord(record?.platformCategoryIds);
  const directKey = `${platform}CategoryId`;
  const value = categoryIds?.[platform] ?? record?.[directKey];
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new BadRequestException(`货源缺少 ${platform} 叶子类目映射`);
  }
  return String(value);
}

function titleFitsShops(title: string, shops: ShopForPublish[]): boolean {
  return shops.every(
    (shop) => !validateTitleForPlatform(title, shop.platform as unknown as PlatformType),
  );
}

function assertTitleForShops(
  title: string | undefined,
  shops: ShopForPublish[],
  label: string,
): void {
  if (title === undefined) return;
  for (const shop of shops) {
    const reason = validateTitleForPlatform(title, shop.platform as unknown as PlatformType);
    if (!reason) continue;
    throw new BadRequestException({
      code: 'TITLE_COMPLIANCE_BLOCKED',
      message: `${label}不符合 ${shop.platform} 平台要求：${reason}`,
    });
  }
}

function jsonStringArray(value: Prisma.JsonValue | undefined): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function stringOrNull(value: Prisma.JsonValue | undefined): string | null {
  return typeof value === 'string' && value ? value : null;
}

function jsonRecord(
  value: Prisma.JsonValue | undefined,
): Record<string, Prisma.JsonValue> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, Prisma.JsonValue>)
    : undefined;
}

function createPublishExternalIds(shops: ShopForPublish[]): Record<string, string> {
  return Object.fromEntries(shops.map((shop) => [shop.id.toString(), newPublishExternalId()]));
}

function ensurePublishExternalIds(
  value: Prisma.JsonValue | null,
  shops: ShopForPublish[],
): { value: Record<string, Prisma.JsonValue>; changed: boolean } {
  const existing = jsonRecord(value ?? undefined) ?? {};
  const result = { ...existing };
  let changed = false;
  for (const shop of shops) {
    const key = shop.id.toString();
    if (result[key] === undefined) {
      result[key] = newPublishExternalId();
      changed = true;
      continue;
    }
    if (!isValidPublishExternalId(result[key])) {
      throw new Error(`店铺 ${key} 的铺货恢复标识无效`);
    }
  }
  return { value: result, changed };
}

function publishExternalId(value: Prisma.JsonValue | null, shopId: bigint): string {
  const externalId = jsonRecord(value ?? undefined)?.[shopId.toString()];
  if (!isValidPublishExternalId(externalId)) {
    throw new Error(`店铺 ${shopId} 缺少有效铺货恢复标识`);
  }
  return externalId;
}

function isValidPublishExternalId(value: Prisma.JsonValue | undefined): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 255 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function newPublishExternalId(): string {
  return `supplier-${randomUUID()}`;
}

function stringAttributes(value: Prisma.JsonValue): Record<string, string> {
  const record = jsonRecord(value);
  if (!record) return {};
  return Object.fromEntries(
    Object.entries(record).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

type TaskWithRelations = Prisma.PublishTaskGetPayload<{
  include: {
    publishedProducts: { include: { shop: true } };
    sourceProduct: true;
    job: true;
  };
}>;

function toSummary(task: TaskWithRelations): PublishTaskSummary {
  const aiOptimized = jsonRecord(task.aiOptimized ?? undefined);
  const skuSummary = storedSkuSummary(task.skuSnapshot);
  return {
    taskId: task.id.toString(),
    status: task.status,
    sourceTitle: task.sourceProduct.title,
    sourceProductId: task.sourceProduct.productId1688,
    sourceAvailability: task.sourceProduct.availability,
    sourceTotalStock: task.sourceProduct.totalStock,
    mainImage:
      typeof aiOptimized?.mainImageUrl === 'string' && aiOptimized.mainImageUrl.length > 0
        ? aiOptimized.mainImageUrl
        : task.sourceProduct.mainImage,
    detailOptimized:
      typeof aiOptimized?.detailHtml === 'string' && aiOptimized.detailHtml.length > 0,
    detailImageHosted:
      typeof aiOptimized?.detailImageUrl === 'string' && aiOptimized.detailImageUrl.length > 0,
    mainImageRequested: aiOptimized?.mainImageRequested === true,
    mainImageProcessed:
      typeof aiOptimized?.mainImageUrl === 'string' && aiOptimized.mainImageUrl.length > 0,
    pricing: storedPricingQuote(task),
    skuCount: skuSummary.skuCount,
    skuDimensions: skuSummary.dimensions,
    queueStatus: task.job?.status ?? null,
    attempts: task.job?.attempts ?? 0,
    maxAttempts: task.job?.maxAttempts ?? 0,
    lastError: task.job?.lastError ?? task.errorMsg,
    createdAt: task.createdAt.toISOString(),
    finishedAt: task.finishedAt?.toISOString() ?? null,
    items: task.publishedProducts.map((pp) => ({
      publishedProductId: pp.id.toString(),
      shopName: pp.shop.shopName,
      platform: pp.shop.platform,
      platformProductId: pp.platformProductId,
      title: pp.title,
      salePrice: Number(pp.salePrice),
      status: pp.status,
      inventorySyncStatus: pp.inventorySyncStatus,
      inventorySyncReason: pp.inventorySyncReason,
      inventorySyncError: pp.inventorySyncError,
      inventoryLastSyncedAt: pp.inventoryLastSyncedAt?.toISOString() ?? null,
      editAttempts: pp.editAttempts,
      lastEditAttemptAt: pp.lastEditAttemptAt?.toISOString() ?? null,
      lastEditedAt: pp.lastEditedAt?.toISOString() ?? null,
      lastEditError: pp.lastEditError,
      platformStatusSyncedAt: pp.platformStatusSyncedAt?.toISOString() ?? null,
      platformStatusError: pp.platformStatusError,
      publishedAt: pp.publishedAt.toISOString(),
    })),
  };
}

function assertSourceAvailable(
  product: Pick<SourceProductForPublish, 'availability' | 'totalStock'>,
): void {
  if (!product.availability || product.availability === 'available') return;
  const message =
    product.availability === 'offline'
      ? '1688 货源已下架，不能继续铺货'
      : product.availability === 'out_of_stock'
        ? '1688 货源已缺货，不能继续铺货'
        : '1688 货源库存不可验证，不能继续铺货';
  throw new BadRequestException(message);
}

function storedPricingQuote(task: TaskWithRelations): PricingQuote | null {
  try {
    return calculatePricing(
      previewCostPrice(task.pricingStrategy) ?? Number(task.sourceProduct.price),
      (task.pricingStrategy ?? undefined) as unknown as PricingStrategyDto | undefined,
    );
  } catch {
    return null;
  }
}

interface PublishSkuSnapshotEntry {
  dimensions: string[];
  skus: Array<{
    sourceSkuId?: string;
    specName: string;
    price: number;
    stock: number;
    attributes: Record<string, string>;
    image?: string;
  }>;
}

type PublishSkuSnapshot = Record<string, PublishSkuSnapshotEntry>;

function assertSkuMappingReady(
  product: SourceProductForPublish,
  platform: string,
  mappings: Map<string, SkuMappingForPublish>,
): void {
  const suggestion = buildSkuSuggestion(product.skuList, Number(product.price));
  if (!suggestion.requiresConfirmation) return;
  if (platform !== 'douyin') {
    throw new BadRequestException('当前仅支持抖店多 SKU 发布');
  }
  const mappingRecord = mappings.get(platform);
  const mapping = mappingRecord
    ? parseConfirmedSkuMapping(
        mappingRecord.dimensions,
        mappingRecord.skus,
        mappingRecord.sourceFingerprint,
      )
    : null;
  if (!mapping || mapping.sourceFingerprint !== suggestion.sourceFingerprint) {
    throw new BadRequestException(`请先确认 ${platform} SKU 规格映射`);
  }
  if (!materializeConfirmedSkus(suggestion, mapping).length) {
    throw new BadRequestException(`${platform} 至少需要启用一个 SKU`);
  }
}

function resolveSkuSnapshot(
  product: SourceProductForPublish,
  platforms: string[],
  mappings: Map<string, SkuMappingForPublish>,
  strategy: CreatePublishTaskDto['pricingStrategy'],
  storedValue: Prisma.JsonValue | null,
): PublishSkuSnapshot {
  const stored = parseSkuSnapshot(storedValue);
  const uniquePlatforms = [...new Set(platforms)];
  if (stored && uniquePlatforms.every((platform) => stored[platform])) return stored;

  const suggestion = buildSkuSuggestion(product.skuList, Number(product.price));
  const snapshot: PublishSkuSnapshot = {};
  for (const platform of uniquePlatforms) {
    if (!suggestion.requiresConfirmation) {
      const sourceSku = suggestion.skus[0]!;
      snapshot[platform] = {
        dimensions: [],
        skus: [
          {
            sourceSkuId: sourceSku.sourceSkuId,
            specName: sourceSku.sourceSpecName,
            price: calculatePricing(sourceSku.costPrice, strategy).suggestedPrice,
            stock: sourceSku.stock,
            attributes: {},
            ...(sourceSku.image ? { image: sourceSku.image } : {}),
          },
        ],
      };
      continue;
    }
    if (platform !== 'douyin') {
      throw new BadRequestException('当前仅支持抖店多 SKU 发布');
    }
    const mappingRecord = mappings.get(platform);
    const mapping = mappingRecord
      ? parseConfirmedSkuMapping(
          mappingRecord.dimensions,
          mappingRecord.skus,
          mappingRecord.sourceFingerprint,
        )
      : null;
    if (!mapping || mapping.sourceFingerprint !== suggestion.sourceFingerprint) {
      throw new BadRequestException(`请先确认 ${platform} SKU 规格映射`);
    }
    const materialized = materializeConfirmedSkus(suggestion, mapping);
    if (!materialized.length) throw new BadRequestException(`${platform} 至少需要启用一个 SKU`);
    snapshot[platform] = {
      dimensions: mapping.dimensions,
      skus: materialized.map((sku) => ({
        sourceSkuId: sku.sourceSkuId,
        specName: sku.values.join('/'),
        price: calculatePricing(sku.costPrice, pricingInput(strategy)).suggestedPrice,
        stock: sku.stock,
        attributes: sku.mappedAttributes,
        ...(sku.image ? { image: sku.image } : {}),
      })),
    };
  }
  return snapshot;
}

function parseSkuSnapshot(value: Prisma.JsonValue | null): PublishSkuSnapshot | null {
  const record = jsonRecord(value ?? undefined);
  if (!record) return null;
  const snapshot: PublishSkuSnapshot = {};
  for (const [platform, entryValue] of Object.entries(record)) {
    const entry = jsonRecord(entryValue);
    if (!entry || !Array.isArray(entry.dimensions) || !Array.isArray(entry.skus)) return null;
    const dimensions = entry.dimensions.filter(
      (dimension): dimension is string => typeof dimension === 'string',
    );
    const skus = entry.skus
      .map((skuValue) => {
        const sku = jsonRecord(skuValue);
        if (!sku) return null;
        const specName = stringOrNull(sku.specName);
        const sourceSkuId = stringOrNull(sku.sourceSkuId);
        const price = typeof sku.price === 'number' ? sku.price : Number(sku.price);
        const stock = typeof sku.stock === 'number' ? sku.stock : Number(sku.stock);
        const attributes = stringAttributes(sku.attributes ?? {});
        if (!specName || !Number.isFinite(price) || !Number.isFinite(stock)) return null;
        const image = stringOrNull(sku.image);
        return {
          ...(sourceSkuId ? { sourceSkuId } : {}),
          specName,
          price,
          stock,
          attributes,
          ...(image ? { image } : {}),
        };
      })
      .filter((sku): sku is NonNullable<typeof sku> => !!sku);
    if (!skus.length || skus.length !== entry.skus.length) return null;
    snapshot[platform] = { dimensions, skus };
  }
  return Object.keys(snapshot).length ? snapshot : null;
}

function refreshSkuSnapshotStocks(
  snapshot: PublishSkuSnapshot,
  sourceSkuList: Prisma.JsonValue | null,
): PublishSkuSnapshot {
  const sourceStock = new Map(
    (Array.isArray(sourceSkuList) ? sourceSkuList : []).flatMap((value) => {
      const sku = jsonRecord(value);
      const sourceSkuId = stringOrNull(sku?.skuId ?? sku?.id);
      const stockValue = typeof sku?.stock === 'number' ? sku.stock : Number(sku?.stock);
      return sourceSkuId && Number.isFinite(stockValue) && stockValue >= 0
        ? ([[sourceSkuId, Math.trunc(stockValue)]] as Array<[string, number]>)
        : [];
    }),
  );
  if (
    sourceStock.size === 0 &&
    Object.values(snapshot).every((entry) =>
      entry.skus.every((sku) => sku.sourceSkuId === 'default'),
    )
  ) {
    return snapshot;
  }
  const refreshed: PublishSkuSnapshot = {};
  for (const [platform, entry] of Object.entries(snapshot)) {
    refreshed[platform] = {
      dimensions: entry.dimensions,
      skus: entry.skus.map((sku) => {
        const stock = sku.sourceSkuId ? sourceStock.get(sku.sourceSkuId) : undefined;
        if (stock === undefined) {
          throw new BadRequestException('1688 SKU 已变化，请重新确认规格后再铺货');
        }
        return { ...sku, stock };
      }),
    };
  }
  return refreshed;
}

function defaultPublishSkus(salePrice: number): PublishSkuSnapshotEntry['skus'] {
  return [{ specName: '默认', price: salePrice, stock: 999, attributes: {} }];
}

interface PublishedSkuPriceSnapshot {
  version: 1;
  items: Array<{ sourceSkuId: string; priceCents: number }>;
}

interface PublishedSkuInventorySnapshot {
  version: 1;
  items: Array<{ sourceSkuId: string; stock: number }>;
}

function publishedSkuPriceSnapshot(
  skus: PublishSkuSnapshotEntry['skus'],
): PublishedSkuPriceSnapshot | null {
  const items = skus.map((sku) => {
    const sourceSkuId = sku.sourceSkuId?.trim();
    const priceCents = Math.round(sku.price * 100);
    return sourceSkuId && Number.isSafeInteger(priceCents) && priceCents > 0
      ? { sourceSkuId, priceCents }
      : null;
  });
  if (!items.length || items.some((item) => !item)) return null;
  const normalized = items as Array<{ sourceSkuId: string; priceCents: number }>;
  if (new Set(normalized.map((item) => item.sourceSkuId)).size !== normalized.length) return null;
  normalized.sort((left, right) => left.sourceSkuId.localeCompare(right.sourceSkuId));
  return { version: 1, items: normalized };
}

function publishedSkuInventorySnapshot(
  skus: PublishSkuSnapshotEntry['skus'],
): PublishedSkuInventorySnapshot | null {
  const items = skus.map((sku) => {
    const sourceSkuId = sku.sourceSkuId?.trim();
    return sourceSkuId && Number.isSafeInteger(sku.stock) && sku.stock >= 0
      ? { sourceSkuId, stock: sku.stock }
      : null;
  });
  if (!items.length || items.some((item) => !item)) return null;
  const normalized = items as Array<{ sourceSkuId: string; stock: number }>;
  if (new Set(normalized.map((item) => item.sourceSkuId)).size !== normalized.length) return null;
  normalized.sort((left, right) => left.sourceSkuId.localeCompare(right.sourceSkuId));
  return { version: 1, items: normalized };
}

function publishedSkuInventorySnapshotFromPlatform(
  items: Array<{ sourceSkuId: string; stock: number }>,
): PublishedSkuInventorySnapshot | null {
  if (!items.length) return null;
  const normalized = items.map((item) => ({
    sourceSkuId: item.sourceSkuId.trim(),
    stock: item.stock,
  }));
  if (
    normalized.some(
      (item) =>
        !item.sourceSkuId ||
        item.sourceSkuId.length > 128 ||
        !Number.isSafeInteger(item.stock) ||
        item.stock < 0,
    ) ||
    new Set(normalized.map((item) => item.sourceSkuId)).size !== normalized.length
  ) {
    return null;
  }
  normalized.sort((left, right) => left.sourceSkuId.localeCompare(right.sourceSkuId));
  return { version: 1, items: normalized };
}

function parsePublishedSkuInventorySnapshot(
  value: Prisma.JsonValue | null,
): PublishedSkuInventorySnapshot | null {
  const record = jsonRecord(value ?? undefined);
  if (record?.version !== 1 || !Array.isArray(record.items) || !record.items.length) return null;
  const items = record.items.map((itemValue) => {
    const item = jsonRecord(itemValue);
    const sourceSkuId = stringOrNull(item?.sourceSkuId)?.trim();
    const stock = item?.stock;
    return sourceSkuId &&
      sourceSkuId.length <= 128 &&
      Number.isSafeInteger(stock) &&
      Number(stock) >= 0
      ? { sourceSkuId, stock: Number(stock) }
      : null;
  });
  if (items.some((item) => !item)) return null;
  return publishedSkuInventorySnapshotFromPlatform(
    items as Array<{ sourceSkuId: string; stock: number }>,
  );
}

function samePublishedSkuInventoryIds(
  left: PublishedSkuInventorySnapshot,
  right: PublishedSkuInventorySnapshot,
): boolean {
  return (
    left.items.length === right.items.length &&
    left.items.every((item, index) => item.sourceSkuId === right.items[index]?.sourceSkuId)
  );
}

function samePublishedSkuInventory(
  left: PublishedSkuInventorySnapshot,
  right: PublishedSkuInventorySnapshot,
): boolean {
  return (
    samePublishedSkuInventoryIds(left, right) &&
    left.items.every((item, index) => item.stock === right.items[index]?.stock)
  );
}

function applyPublishedSkuInventory(
  skus: PublishSkuSnapshotEntry['skus'],
  snapshot: PublishedSkuInventorySnapshot,
): PublishSkuSnapshotEntry['skus'] {
  const byId = new Map(snapshot.items.map((item) => [item.sourceSkuId, item.stock]));
  if (byId.size !== skus.length) {
    throw new ConflictException('商品 SKU 库存快照与原发布规格不一致，请先同步商品库存');
  }
  return skus.map((sku) => {
    const sourceSkuId = sku.sourceSkuId?.trim();
    const stock = sourceSkuId ? byId.get(sourceSkuId) : undefined;
    if (!sourceSkuId || stock === undefined) {
      throw new ConflictException('商品 SKU 库存快照与原发布规格不一致，请先同步商品库存');
    }
    return { ...sku, stock };
  });
}

function publishedSkuPriceSnapshotFromPlatform(
  items: Array<{ sourceSkuId: string; priceCents: number }>,
): PublishedSkuPriceSnapshot | null {
  if (!items.length) return null;
  const normalized = items.map((item) => ({
    sourceSkuId: item.sourceSkuId.trim(),
    priceCents: item.priceCents,
  }));
  if (
    normalized.some(
      (item) => !item.sourceSkuId || !Number.isSafeInteger(item.priceCents) || item.priceCents <= 0,
    ) ||
    new Set(normalized.map((item) => item.sourceSkuId)).size !== normalized.length
  ) {
    return null;
  }
  normalized.sort((left, right) => left.sourceSkuId.localeCompare(right.sourceSkuId));
  return { version: 1, items: normalized };
}

function samePublishedSkuPrices(
  left: PublishedSkuPriceSnapshot,
  right: PublishedSkuPriceSnapshot,
): boolean {
  return (
    left.items.length === right.items.length &&
    left.items.every(
      (item, index) =>
        item.sourceSkuId === right.items[index]?.sourceSkuId &&
        item.priceCents === right.items[index]?.priceCents,
    )
  );
}

function publishedSkuStartPrice(snapshot: PublishedSkuPriceSnapshot): number {
  return Math.min(...snapshot.items.map((item) => item.priceCents)) / 100;
}

function applyPublishedSkuPrices(
  skus: PublishSkuSnapshotEntry['skus'],
  value: Prisma.JsonValue | null,
): PublishSkuSnapshotEntry['skus'] {
  const snapshot = parsePublishedSkuPriceSnapshot(value);
  if (!snapshot) return skus;
  const byId = new Map(snapshot.items.map((item) => [item.sourceSkuId, item.priceCents]));
  if (byId.size !== skus.length) {
    throw new ConflictException('商品 SKU 价格快照与原发布规格不一致，请先同步商品价格');
  }
  return skus.map((sku) => {
    const sourceSkuId = sku.sourceSkuId?.trim();
    const priceCents = sourceSkuId ? byId.get(sourceSkuId) : undefined;
    if (!sourceSkuId || priceCents === undefined) {
      throw new ConflictException('商品 SKU 价格快照与原发布规格不一致，请先同步商品价格');
    }
    return { ...sku, price: priceCents / 100 };
  });
}

function parsePublishedSkuPriceSnapshot(
  value: Prisma.JsonValue | null,
): PublishedSkuPriceSnapshot | null {
  const record = jsonRecord(value ?? undefined);
  if (record?.version !== 1 || !Array.isArray(record.items) || !record.items.length) return null;
  const items = record.items.map((itemValue) => {
    const item = jsonRecord(itemValue);
    const sourceSkuId = stringOrNull(item?.sourceSkuId)?.trim();
    const priceCents = item?.priceCents;
    return sourceSkuId && Number.isSafeInteger(priceCents) && Number(priceCents) > 0
      ? { sourceSkuId, priceCents: Number(priceCents) }
      : null;
  });
  if (items.some((item) => !item)) return null;
  const normalized = items as Array<{ sourceSkuId: string; priceCents: number }>;
  if (new Set(normalized.map((item) => item.sourceSkuId)).size !== normalized.length) return null;
  normalized.sort((left, right) => left.sourceSkuId.localeCompare(right.sourceSkuId));
  return { version: 1, items: normalized };
}

function storedSkuSummary(value: Prisma.JsonValue | null): {
  skuCount: number;
  dimensions: string[];
} {
  const snapshot = parseSkuSnapshot(value);
  const first = snapshot ? Object.values(snapshot)[0] : undefined;
  return { skuCount: first?.skus.length ?? 1, dimensions: first?.dimensions ?? [] };
}

function sellingPoints(categoryL2: string | null, onePieceDrop: boolean): string[] {
  return [categoryL2 ?? '', onePieceDrop ? '一件代发' : ''].filter(Boolean);
}

function resolveMainImageOperations(dto: CreatePublishTaskDto): MainImageOperations {
  return {
    removeWatermark: dto.aiOptions?.removeWatermark === true,
    relight: dto.aiOptions?.relightImages === true,
    backgroundStyle: dto.aiOptions?.backgroundStyle,
  };
}

function wantsMainImageProcessing(operations: MainImageOperations): boolean {
  return operations.removeWatermark || operations.relight || !!operations.backgroundStyle;
}

async function assertPublishExecutionOwned(lease?: PublishExecutionLease): Promise<void> {
  await lease?.assertOwned();
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : '主图处理失败';
  return message.slice(0, 200);
}

function mainImageSuccessMessage(result: MainImageProcessResult): string {
  const watermark = result.watermarkDetected
    ? `检测到 ${result.watermarkCount} 处水印区域并完成处理`
    : '未检测到水印';
  return `${watermark}，主图已通过合规审核并托管`;
}

function taskDto(task: QueuedTask): CreatePublishTaskDto {
  return {
    sourceProductId: task.sourceProduct.productId1688,
    targetShopIds: jsonStringArray(task.targetShopIds),
    pricingStrategy: (task.pricingStrategy ?? undefined) as
      | CreatePublishTaskDto['pricingStrategy']
      | undefined,
    aiOptions: (task.aiOptions ?? undefined) as CreatePublishTaskDto['aiOptions'] | undefined,
  };
}

function completedResult(task: QueuedTask): PublishTaskResult {
  const dto = taskDto(task);
  const pricing = calculatePricing(
    previewCostPrice(task.pricingStrategy) ?? Number(task.sourceProduct.price),
    dto.pricingStrategy,
  );
  const aiOptimized = jsonRecord(task.aiOptimized ?? undefined);
  const mainImageUrl = stringOrNull(aiOptimized?.mainImageUrl);
  const detailHtml = stringOrNull(aiOptimized?.detailHtml);
  const skuSummary = storedSkuSummary(task.skuSnapshot);
  return {
    taskId: task.id.toString(),
    status: 'success',
    optimizedTitle: stringOrNull(aiOptimized?.title) ?? task.sourceProduct.title,
    detailOptimized: !!detailHtml,
    detailImageHosted: !!stringOrNull(aiOptimized?.detailImageUrl),
    mainImageRequested: aiOptimized?.mainImageRequested === true,
    mainImageProcessed: !!mainImageUrl,
    mainImageMessage: mainImageUrl ? '已复用上次主图处理结果' : null,
    pricing,
    skuCount: skuSummary.skuCount,
    skuDimensions: skuSummary.dimensions,
    salePrice: pricing.suggestedPrice,
    results: [],
  };
}
