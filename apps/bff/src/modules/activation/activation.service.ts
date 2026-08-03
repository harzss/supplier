import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma.module';
import { runtimeShopWhere } from '../shop/platform-adapter.factory';

export type ActivationStepKey =
  | 'connect_shop'
  | 'select_product'
  | 'preview_pricing'
  | 'publish_product';

export interface ActivationStepView {
  key: ActivationStepKey;
  title: string;
  description: string;
  href: string;
  completedAt: string | null;
  readyNow: boolean;
}

export interface ActivationView {
  currentStep: ActivationStepKey | null;
  nextHref: string;
  completedSteps: number;
  totalSteps: number;
  steps: ActivationStepView[];
}

@Injectable()
export class ActivationService {
  private readonly demoMode: boolean;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.demoMode = (config.get<string>('AUTH_MODE') ?? 'demo') === 'demo';
  }

  async get(userId: bigint): Promise<ActivationView> {
    const shopWhere = runtimeShopWhere(this.demoMode);
    const [shops, draft, productView, favorite, publishTasks, publishedProduct] = await Promise.all(
      [
        this.prisma.shop.findMany({
          where: { userId, role: 'seller', ...shopWhere },
          orderBy: { createdAt: 'asc' },
          select: { id: true, status: true, createdAt: true },
        }),
        this.prisma.publishDraft.findUnique({
          where: { userId },
          select: {
            createdAt: true,
            sourceProduct: { select: { productId1688: true } },
          },
        }),
        this.prisma.auditLog.findFirst({
          where: { userId, action: 'product.detail.view', outcome: 'success' },
          orderBy: { createdAt: 'desc' },
          select: { resourceId: true, createdAt: true },
        }),
        this.prisma.userFavorite.findFirst({
          where: { userId },
          orderBy: { createdAt: 'desc' },
          select: {
            createdAt: true,
            sourceProduct: { select: { productId1688: true } },
          },
        }),
        this.prisma.publishTask.findMany({
          where: { userId },
          orderBy: { createdAt: 'desc' },
          take: 50,
          select: { targetShopIds: true },
        }),
        this.prisma.publishedProduct.findFirst({
          where: {
            platformProductId: { not: null },
            task: { userId },
            shop: { userId, role: 'seller', ...shopWhere },
          },
          orderBy: { publishedAt: 'asc' },
          select: { publishedAt: true },
        }),
      ],
    );

    const selectedProduct =
      draft?.sourceProduct.productId1688 ??
      productView?.resourceId ??
      favorite?.sourceProduct.productId1688;
    const pricingPreview = selectedProduct
      ? await this.prisma.auditLog.findFirst({
          where: {
            userId,
            action: 'publish.pricing.preview',
            outcome: 'success',
            resourceId: selectedProduct,
          },
          orderBy: { createdAt: 'asc' },
          select: { createdAt: true },
        })
      : null;
    const productHref = selectedProduct
      ? `/products?id=${encodeURIComponent(selectedProduct)}`
      : '/';
    const selectedAt = draft?.createdAt ?? productView?.createdAt ?? favorite?.createdAt ?? null;
    const visibleShopIds = new Set(shops.map((shop) => shop.id.toString()));
    const hasVisiblePublishTask = publishTasks.some((task) =>
      jsonStringArray(task.targetShopIds).some((shopId) => visibleShopIds.has(shopId)),
    );
    const steps: ActivationStepView[] = [
      {
        key: 'connect_shop',
        title: '连接销售店铺',
        description: '授权一个用于铺货的销售店铺',
        href: '/settings#shops',
        completedAt: iso(shops[0]?.createdAt),
        readyNow: shops.some((shop) => shop.status === 'active'),
      },
      {
        key: 'select_product',
        title: '选择货源商品',
        description: '查看或收藏一个准备铺货的商品',
        href: '/',
        completedAt: iso(selectedAt),
        readyNow: !!selectedAt,
      },
      {
        key: 'preview_pricing',
        title: '预览利润',
        description: '完成一次售价与利润试算',
        href: `${productHref}#publish`,
        completedAt: iso(pricingPreview?.createdAt),
        readyNow: !!pricingPreview,
      },
      {
        key: 'publish_product',
        title: '完成首次铺货',
        description: '将首个商品成功发布到销售店铺',
        href: hasVisiblePublishTask ? '/published' : `${productHref}#publish`,
        completedAt: iso(publishedProduct?.publishedAt),
        readyNow: !!publishedProduct,
      },
    ];
    const currentStep = steps.find((step) => !step.readyNow) ?? null;

    return {
      currentStep: currentStep?.key ?? null,
      nextHref: currentStep?.href ?? '/published',
      completedSteps: steps.filter((step) => step.readyNow).length,
      totalSteps: steps.length,
      steps,
    };
  }
}

function iso(value: Date | null | undefined): string | null {
  return value?.toISOString() ?? null;
}

function jsonStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}
