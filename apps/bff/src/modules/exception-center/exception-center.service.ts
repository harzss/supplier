import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  ExceptionCase,
  ExceptionCaseEvent,
  ExceptionDomain,
  ExceptionPriority,
  ExceptionResponsibleParty,
  Prisma,
} from '@supplier/db';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../common/prisma.module';
import { AfterSaleService } from '../after-sale/after-sale.service';
import { PURCHASE_EXCEPTION_CODE, purchaseExceptionDomain } from '../order/purchase-exception-code';
import { runtimeShopWhere } from '../shop/platform-adapter.factory';
import type { AcknowledgeExceptionCaseDto } from './dto/acknowledge-exception-case.dto';
import type {
  ExceptionCaseDomain,
  ExceptionCaseListQueryDto,
} from './dto/exception-case-list-query.dto';

const ORDER_SYNC_HANG_MS = 15 * 60_000;
const ORDER_SYNC_MIN_STALE_MS = 5 * 60_000;
const DEFAULT_ORDER_SYNC_INTERVAL_MS = 60_000;
const MAX_TRANSACTION_ATTEMPTS = 3;
const MAX_AFTER_SALE_SIGNAL_PAGES = 20;
const ACTIVE_ORDER_STATUSES = ['paid', 'purchasing', 'shipped', 'received'] as const;

interface CaseCatalogEntry {
  domain: ExceptionDomain;
  priority: ExceptionPriority;
  title: string;
  impact: string;
  nextAction: string;
  actionLabel: string;
  actionHref: string;
  responsibleParty: ExceptionResponsibleParty;
}

const CASE_CATALOG = {
  publish_job_dead: {
    domain: 'publish',
    priority: 'critical',
    title: '铺货任务已进入死信',
    impact: '目标商品没有完成发布，继续等待不会自动恢复。',
    nextAction: '核对失败原因和目标店铺后，将任务重新入队。',
    actionLabel: '处理铺货任务',
    actionHref: '/published',
    responsibleParty: 'merchant',
  },
  publish_task_failed: {
    domain: 'publish',
    priority: 'high',
    title: '铺货任务执行失败',
    impact: '目标商品没有完成发布。',
    nextAction: '修复失败原因后重新执行铺货任务。',
    actionLabel: '处理铺货任务',
    actionHref: '/published',
    responsibleParty: 'merchant',
  },
  publish_task_partial: {
    domain: 'publish',
    priority: 'high',
    title: '部分店铺铺货失败',
    impact: '同一商品在部分目标店铺尚未完成发布。',
    nextAction: '核对逐店结果，只重试失败的发布任务。',
    actionLabel: '处理铺货任务',
    actionHref: '/published',
    responsibleParty: 'merchant',
  },
  published_product_rejected: {
    domain: 'publish',
    priority: 'high',
    title: '平台驳回商品发布',
    impact: '商品无法在目标销售平台正常销售。',
    nextAction: '刷新平台审核状态，按驳回原因修正后重新提交。',
    actionLabel: '修正并重提',
    actionHref: '/published',
    responsibleParty: 'merchant',
  },
  order_sync_failed: {
    domain: 'order',
    priority: 'critical',
    title: '店铺订单同步失败',
    impact: '新订单、退款或售后变化可能无法及时进入系统。',
    nextAction: '核对店铺授权和平台响应后手工同步订单。',
    actionLabel: '检查订单同步',
    actionHref: '/settings#shops',
    responsibleParty: 'merchant',
  },
  order_sync_authorization_invalid: {
    domain: 'order',
    priority: 'critical',
    title: '店铺授权已失效',
    impact: '新订单、退款或售后变化无法继续同步。',
    nextAction: '重新授权该店铺，然后完成一次成功订单同步。',
    actionLabel: '重新授权店铺',
    actionHref: '/settings#shops',
    responsibleParty: 'merchant',
  },
  order_sync_access_token_missing: {
    domain: 'order',
    priority: 'critical',
    title: '店铺访问凭证缺失',
    impact: '系统无法读取该店铺的新订单、退款或售后变化。',
    nextAction: '重新授权该店铺以恢复访问凭证，再完成一次成功订单同步。',
    actionLabel: '恢复店铺凭证',
    actionHref: '/settings#shops',
    responsibleParty: 'merchant',
  },
  order_sync_stalled: {
    domain: 'order',
    priority: 'critical',
    title: '店铺订单同步长时间未完成',
    impact: '同步水位停滞，可能遗漏最新订单与售后状态。',
    nextAction: '确认旧任务已停止后，重新发起该店铺的订单同步。',
    actionLabel: '检查订单同步',
    actionHref: '/settings#shops',
    responsibleParty: 'system',
  },
  sales_order_partial_refund: purchaseCatalog(
    '销售订单部分退款待处理',
    '部分退款后的采购与履约已暂停，未处理前不能安全继续。',
    '核对未退款商品和 1688 采购状态，完成剩余商品处置。',
    'after_sale',
  ),
  sales_order_refunded: purchaseCatalog(
    '退款订单仍有采购待处理',
    '销售订单已退款，但远端采购可能仍产生付款、发货或成本。',
    '在 1688 完成取消、退款或拦截后，记录最终实际成本。',
    'after_sale',
  ),
  sales_order_closed: purchaseCatalog(
    '关闭订单仍有采购待处理',
    '销售订单已关闭，但远端采购可能仍产生付款、发货或成本。',
    '在 1688 完成取消、退款或拦截后，记录最终实际成本。',
    'after_sale',
  ),
  purchase_remote_cancelled_retryable: purchaseCatalog(
    '1688 采购单已取消或关闭',
    '当前销售订单尚未完成采购履约。',
    '核对本次实际成本后，使用新的采购请求重新下单。',
    'purchase',
  ),
  purchase_remote_cancelled_manual: purchaseCatalog(
    '1688 采购单异常终止',
    '自动采购已停止，订单成本和后续履约状态尚未收敛。',
    '核对采购成本与远端状态后完成人工处置。',
    'purchase',
  ),
  purchase_remote_cancelled_after_shipment: purchaseCatalog(
    '发货后的 1688 采购状态异常',
    '销售平台与 1688 的采购、物流状态可能不一致。',
    '核对同一远端订单和包裹后重新校验物流。',
    'logistics',
  ),
  purchase_manual_review: purchaseCatalog(
    '采购单需要人工复核',
    '自动采购已暂停，当前状态无法安全自动恢复。',
    '核对远端采购单、成本和商品明细后完成人工处置。',
    'purchase',
  ),
  purchase_snapshot_mismatch: purchaseCatalog(
    '采购商品快照不一致',
    '系统已停止自动采购，避免采购错误商品、规格或数量。',
    '核对销售子单与 1688 商品明细，确认正确快照后再继续。',
    'purchase',
  ),
  purchase_cost_changed: purchaseCatalog(
    '已履约采购成本发生变化',
    '预计利润和最终采购成本可能不准确。',
    '核对 1688 最新金额并记录最终实际采购成本。',
    'purchase',
  ),
  logistics_snapshot_missing: purchaseCatalog(
    '1688 物流快照缺失',
    '系统无法证明采购包裹与销售订单之间的安全映射。',
    '在 1688 核对物流后重新校验同一采购单。',
    'logistics',
  ),
  logistics_mapping_mismatch: purchaseCatalog(
    '采购包裹商品映射不一致',
    '自动物流回传已停止，避免串包、漏包或数量错误。',
    '核对运单、承运商和商品项后重新校验物流。',
    'logistics',
  ),
  logistics_routing_changed: purchaseCatalog(
    '已发货订单的物流发生变化',
    '抖店与 1688 的运单或承运商可能不一致。',
    '核对最新包裹，并通过专用入口更新抖店物流。',
    'logistics',
  ),
  logistics_manual_review: purchaseCatalog(
    '采购物流需要人工复核',
    '自动物流处理已暂停，当前包裹状态无法安全自动收敛。',
    '核对 1688 和销售平台的包裹状态后选择恢复或修复入口。',
    'logistics',
  ),
  sales_order_after_sale_hold: purchaseCatalog(
    '销售售后导致采购暂停',
    '销售订单售后尚未处理完成，远端采购可能继续产生成本或物流。',
    '核对销售售后与 1688 采购状态并完成人工处置。',
    'after_sale',
  ),
  purchase_exception_unclassified: purchaseCatalog(
    '采购单需要人工核对',
    '自动采购或履约已停止，当前异常尚未归入安全的自动恢复路径。',
    '打开订单核对 1688 采购、成本和物流后完成人工处置。',
    'purchase',
  ),
  after_sale_pending: {
    domain: 'after_sale',
    priority: 'high',
    title: '订单售后正在处理中',
    impact: '采购和物流动作需要等待售后状态收敛。',
    nextAction: '同步平台最新状态，并跟进售后处理结果。',
    actionLabel: '处理售后订单',
    actionHref: '/after-sales',
    responsibleParty: 'merchant',
  },
  partial_refund_action_required: {
    domain: 'after_sale',
    priority: 'critical',
    title: '部分退款等待履约决策',
    impact: '整单采购和物流回传已暂停。',
    nextAction: '核对退款子单，选择仅履约剩余商品或停止整单。',
    actionLabel: '处理部分退款',
    actionHref: '/after-sales',
    responsibleParty: 'merchant',
  },
  refund_amount_reconciliation_required: {
    domain: 'after_sale',
    priority: 'high',
    title: '实际退款金额待核对',
    impact: '净 GMV、利润和退款损失暂时无法可靠计算。',
    nextAction: '按销售平台后台核对累计实际退款金额并保存依据。',
    actionLabel: '核对退款金额',
    actionHref: '/after-sales',
    responsibleParty: 'merchant',
  },
  after_sale_case_overdue: {
    domain: 'after_sale',
    priority: 'critical',
    title: '售后工单已超过处理时限',
    impact: '销售退款、采购成本或外部处理可能继续扩大损失。',
    nextAction: '打开售后工单，按当前销售与采购版本完成处置。',
    actionLabel: '处理售后工单',
    actionHref: '/after-sales',
    responsibleParty: 'merchant',
  },
  after_sale_case_blocked: {
    domain: 'after_sale',
    priority: 'high',
    title: '售后工单存在关闭阻塞',
    impact: '售后责任、退款或采购成本尚未形成可审计闭环。',
    nextAction: '打开售后工单，完成当前阻塞项后重新核验关闭。',
    actionLabel: '处理售后工单',
    actionHref: '/after-sales',
    responsibleParty: 'merchant',
  },
  entitlement_subscription_date_invalid: entitlementCatalog(
    '本地订购有效期异常',
    '订购记录状态与有效期矛盾，可能导致错误授权。',
  ),
  entitlement_active_subscription_missing: entitlementCatalog(
    '高权限套餐缺少有效订购',
    '账号仍保留非免费套餐，但当前没有可证明的有效订购，可能造成退款、到期或卸载后继续授权。',
  ),
  entitlement_multiple_active_subscriptions: entitlementCatalog(
    '存在重叠的有效订购',
    '系统无法唯一确定当前应生效的套餐权益。',
  ),
  entitlement_plan_mismatch: entitlementCatalog(
    '套餐与有效订购不一致',
    '当前功能权限可能高于或低于订购记录。',
  ),
  sales_platform_logistics_callback_failed: {
    domain: 'logistics',
    priority: 'critical',
    title: '销售平台物流回传失败',
    impact: '1688 已产生物流，但销售平台订单可能仍未标记发货。',
    nextAction: '先回读销售平台状态；未发货时使用原请求重新回传。',
    actionLabel: '处理物流回传',
    actionHref: '/orders',
    responsibleParty: 'merchant',
  },
  sales_platform_logistics_status_unknown: {
    domain: 'logistics',
    priority: 'critical',
    title: '销售平台物流结果待核验',
    impact: '平台调用结果未知，直接重复提交可能产生重复副作用。',
    nextAction: '先读取平台订单和包裹状态，确认结果后再决定是否重试。',
    actionLabel: '核验物流状态',
    actionHref: '/orders',
    responsibleParty: 'merchant',
  },
} as const satisfies Record<string, CaseCatalogEntry>;

type CaseCode = keyof typeof CASE_CATALOG;
type ProducerCaseCode =
  | 'sales_platform_logistics_callback_failed'
  | 'sales_platform_logistics_status_unknown';

export interface RecordProducerCaseInput {
  userId: bigint;
  code: ProducerCaseCode;
  sourceType: string;
  sourceId: string | bigint;
  sourceFingerprint: string;
  subjectLabel: string;
  reason: string;
  context?: unknown;
}

export interface ResolveProducerCaseInput {
  userId: bigint;
  code: ProducerCaseCode;
  sourceType: string;
  sourceId: string | bigint;
  evidence?: unknown;
}

interface ObservedCase {
  dedupeKey: string;
  code: CaseCode;
  domain: ExceptionDomain;
  priority: ExceptionPriority;
  sourceFingerprint: string;
  subjectType: string;
  subjectId: string;
  subjectLabel: string;
  responsibleParty: ExceptionResponsibleParty;
  reason: string;
  impact: string;
  nextAction: string;
  actionLabel: string;
  actionHref: string;
  evidence?: Prisma.InputJsonObject;
}

export interface ReconcileStats {
  scanned: number;
  created: number;
  updated: number;
  reopened: number;
  resolved: number;
}

export interface RefreshError {
  domain: ExceptionCaseDomain;
  code: string;
  message: string;
}

@Injectable()
export class ExceptionCenterService {
  private readonly demoMode: boolean;
  private readonly orderSyncStaleMs: number;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
    private readonly afterSales: AfterSaleService,
  ) {
    this.demoMode = (config.get<string>('AUTH_MODE') ?? 'demo') === 'demo';
    const configuredIntervalMs = Number(
      config.get<string>('DOUYIN_ORDER_SYNC_INTERVAL_MS') ?? DEFAULT_ORDER_SYNC_INTERVAL_MS,
    );
    const intervalMs =
      Number.isInteger(configuredIntervalMs) && configuredIntervalMs > 0
        ? configuredIntervalMs
        : DEFAULT_ORDER_SYNC_INTERVAL_MS;
    this.orderSyncStaleMs = Math.max(ORDER_SYNC_MIN_STALE_MS, intervalMs * 3);
  }

  async list(userId: bigint, query: ExceptionCaseListQueryDto) {
    const q = query.q?.trim();
    const where: Prisma.ExceptionCaseWhereInput = {
      userId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.domain ? { domain: query.domain } : {}),
      ...(query.priority ? { priority: query.priority } : {}),
      ...(q
        ? {
            OR: [
              { code: { contains: q, mode: 'insensitive' } },
              { subjectLabel: { contains: q, mode: 'insensitive' } },
              { reason: { contains: q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [total, rows, grouped, criticalOpenCount] = await Promise.all([
      this.prisma.exceptionCase.count({ where }),
      this.prisma.exceptionCase.findMany({
        where,
        orderBy: [{ status: 'asc' }, { priority: 'asc' }, { updatedAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.exceptionCase.groupBy({
        by: ['status'],
        where: { userId },
        _count: { _all: true },
      }),
      this.prisma.exceptionCase.count({
        where: {
          userId,
          priority: 'critical',
          status: { in: ['open', 'acknowledged'] },
        },
      }),
    ]);
    const counts = { open: 0, acknowledged: 0, resolved: 0 };
    for (const row of grouped) counts[row.status] = row._count._all;
    return {
      items: rows.map(toCaseView),
      total,
      page: query.page,
      pageSize: query.pageSize,
      counts,
      criticalOpenCount,
    };
  }

  async detail(userId: bigint, idValue: string) {
    const id = positiveId(idValue);
    const row = await this.prisma.exceptionCase.findFirst({
      where: { id, userId },
      include: { events: { orderBy: { caseRevision: 'desc' } } },
    });
    if (!row) throw new NotFoundException('异常事项不存在');
    return { ...toCaseView(row), events: row.events.map(toEventView) };
  }

  async refresh(userId: bigint) {
    const now = new Date();
    const domains: Partial<Record<ExceptionCaseDomain, ReconcileStats>> = {};
    const errors: RefreshError[] = [];
    const scanners: Array<{
      domain: ExceptionCaseDomain;
      scan: () => Promise<ObservedCase[]>;
      scope: Prisma.ExceptionCaseWhereInput;
    }> = [
      {
        domain: 'publish',
        scan: () => this.scanPublish(userId),
        scope: { domain: 'publish' },
      },
      {
        domain: 'order',
        scan: () => this.scanOrderSync(userId, now),
        scope: { domain: 'order' },
      },
      {
        domain: 'purchase',
        scan: () => this.scanPurchaseExceptions(userId, 'purchase'),
        scope: { domain: 'purchase' },
      },
      {
        domain: 'logistics',
        scan: () => this.scanPurchaseExceptions(userId, 'logistics'),
        scope: { domain: 'logistics' },
      },
      {
        domain: 'after_sale',
        scan: async () => [
          ...(await this.scanAfterSaleOrders(userId)),
          ...(await this.scanPurchaseExceptions(userId, 'after_sale')),
          ...(await this.scanAfterSaleCases(userId, now)),
        ],
        scope: { domain: 'after_sale' },
      },
      {
        domain: 'entitlement',
        scan: () => this.scanEntitlement(userId, now),
        scope: { domain: 'entitlement' },
      },
    ];

    for (const scanner of scanners) {
      try {
        const observed = await scanner.scan();
        domains[scanner.domain] = await this.reconcileScannerCases(
          userId,
          scanner.scope,
          observed,
          now,
        );
      } catch (_error) {
        errors.push({
          domain: scanner.domain,
          code: 'DOMAIN_REFRESH_FAILED',
          message: `${domainLabel(scanner.domain)}检查失败，已保留原有事项`,
        });
      }
    }
    return { domains, errors, refreshedAt: now.toISOString() };
  }

  async acknowledge(userId: bigint, idValue: string, dto: AcknowledgeExceptionCaseDto) {
    const id = positiveId(idValue);
    const note = dto.note.trim();
    if (note.length < 2 || note.length > 500) {
      throw new BadRequestException('跟进说明需为 2～500 个字符');
    }
    await this.serializable(async (tx) => {
      const replay = await tx.exceptionCaseEvent.findUnique({
        where: { clientRequestId: dto.clientRequestId },
      });
      if (replay) {
        if (replay.userId !== userId || replay.caseId !== id || replay.type !== 'acknowledged') {
          throw new ConflictException('请求标识已被其他操作使用');
        }
        return;
      }

      const current = await tx.exceptionCase.findFirst({ where: { id, userId } });
      if (!current) throw new NotFoundException('异常事项不存在');
      if (!current.sourceActive || current.status === 'resolved') {
        throw new ConflictException('异常来源已恢复，无需继续确认');
      }
      if (current.status === 'acknowledged') {
        throw new ConflictException('异常事项已由当前账号确认跟进');
      }
      if (current.stateRevision !== dto.expectedRevision) {
        throw new ConflictException('异常事项已更新，请刷新后重试');
      }
      const now = new Date();
      const nextRevision = current.stateRevision + 1;
      const updated = await tx.exceptionCase.updateMany({
        where: {
          id,
          userId,
          sourceActive: true,
          status: 'open',
          stateRevision: dto.expectedRevision,
        },
        data: {
          status: 'acknowledged',
          stateRevision: { increment: 1 },
          acknowledgedAt: now,
          acknowledgedByUserId: userId,
          resolvedAt: null,
          resolutionReason: null,
        },
      });
      if (updated.count !== 1) throw new ConflictException('异常事项已更新，请刷新后重试');
      await tx.exceptionCaseEvent.create({
        data: {
          userId,
          caseId: id,
          caseRevision: nextRevision,
          type: 'acknowledged',
          clientRequestId: dto.clientRequestId,
          actorUserId: userId,
          note,
          fromStatus: 'open',
          toStatus: 'acknowledged',
          sourceFingerprint: current.sourceFingerprint,
        },
      });
    });
    return this.detail(userId, idValue);
  }

  async recordProducerCase(input: RecordProducerCaseInput): Promise<void> {
    const observed = producerObservedCase(input);
    await this.serializable(async (tx) => {
      await this.upsertObservedCase(tx, input.userId, observed, 'producer', new Date());
    });
  }

  async resolveProducerCase(input: ResolveProducerCaseInput): Promise<void> {
    assertProducerCode(input.code);
    const sourceType = requiredText(input.sourceType, 64, '异常来源类型');
    const sourceId = requiredText(String(input.sourceId), 128, '异常来源 ID');
    const dedupeKey = producerDedupeKey(input.code, sourceType, sourceId);
    await this.serializable(async (tx) => {
      const current = await tx.exceptionCase.findUnique({
        where: { uk_exception_case_user_dedupe: { userId: input.userId, dedupeKey } },
      });
      if (!current || current.sourceKind !== 'producer' || !current.sourceActive) return;
      await this.resolveCase(tx, current, new Date(), {
        items: [
          {
            type: 'producer_recovery',
            label: '生产者已确认异常来源恢复',
          },
        ],
        ...(input.evidence === undefined ? {} : { context: safeJson(input.evidence) }),
      });
    });
  }

  private async scanPublish(userId: bigint): Promise<ObservedCase[]> {
    const visibleTaskWhere: Prisma.PublishTaskWhereInput = this.demoMode
      ? { userId }
      : await this.productionPublishTaskWhere(userId);
    if (!this.demoMode && !('OR' in visibleTaskWhere)) return [];
    const [tasks, rejected] = await Promise.all([
      this.prisma.publishTask.findMany({
        where: {
          ...visibleTaskWhere,
          OR: [{ status: { in: ['failed', 'partial'] } }, { job: { is: { status: 'dead' } } }],
        },
        include: { job: true, sourceProduct: { select: { title: true } } },
      }),
      this.prisma.publishedProduct.findMany({
        where: {
          status: 'rejected',
          task: { userId },
          shop: { userId, ...runtimeShopWhere(this.demoMode) },
        },
        include: {
          task: { select: { userId: true } },
          shop: { select: { shopName: true, platform: true } },
        },
      }),
    ]);
    const observed = tasks.map((task): ObservedCase => {
      const code: CaseCode =
        task.job?.status === 'dead'
          ? 'publish_job_dead'
          : task.status === 'partial'
            ? 'publish_task_partial'
            : 'publish_task_failed';
      return observedFromCatalog({
        code,
        dedupeKey: `scanner:publish_task:${task.id}`,
        sourceFingerprint: fingerprint({
          status: task.status,
          queueStatus: task.job?.status ?? null,
          attempts: task.job?.attempts ?? 0,
          maxAttempts: task.job?.maxAttempts ?? 0,
          error: task.job?.lastError ?? task.errorMsg,
        }),
        subjectType: 'publish_task',
        subjectId: task.id.toString(),
        subjectLabel: boundedText(task.sourceProduct.title, 255) || `铺货任务 ${task.id}`,
        reason: boundedText(task.job?.lastError ?? task.errorMsg, 2_000) || '铺货任务未成功完成。',
      });
    });
    observed.push(
      ...rejected.map(
        (product): ObservedCase =>
          observedFromCatalog({
            code: 'published_product_rejected',
            dedupeKey: `scanner:published_product_rejected:${product.id}`,
            sourceFingerprint: fingerprint({
              mutationRevision: product.mutationRevision,
              platformStatus: product.platformStatusRaw,
              platformCheckStatus: product.platformCheckStatusRaw,
              platformStatusError: product.platformStatusError,
              lastEditError: product.lastEditError,
            }),
            subjectType: 'published_product',
            subjectId: product.id.toString(),
            subjectLabel: boundedText(
              `${product.shop.shopName ?? product.shop.platform} · ${product.title}`,
              255,
            ),
            reason:
              boundedText(product.platformStatusError ?? product.lastEditError, 2_000) ||
              '销售平台当前将商品标记为已驳回。',
          }),
      ),
    );
    return observed;
  }

  private async scanOrderSync(userId: bigint, now: Date): Promise<ObservedCase[]> {
    const shops = await this.prisma.shop.findMany({
      where: {
        userId,
        platform: 'douyin',
        role: 'seller',
        NOT: { platformShopId: { startsWith: 'demo-' } },
      },
      select: {
        id: true,
        shopName: true,
        platformShopId: true,
        status: true,
        accessTokenEnc: true,
        createdAt: true,
        lastOrderSyncAt: true,
        orderSyncAttemptAt: true,
        orderSyncError: true,
      },
    });
    const hungBefore = now.getTime() - ORDER_SYNC_HANG_MS;
    const staleBefore = now.getTime() - this.orderSyncStaleMs;
    return shops.flatMap((shop): ObservedCase[] => {
      const attemptMs = shop.orderSyncAttemptAt?.getTime();
      const successMs = shop.lastOrderSyncAt?.getTime();
      const createdMs = shop.createdAt.getTime();
      const authorizationInvalid = shop.status === 'expired';
      const accessTokenMissing = !shop.accessTokenEnc;
      const dedupeKey = `scanner:order_sync:shop:${shop.id}`;
      const sourceFingerprint = (code: CaseCode) =>
        fingerprint({
          code,
          status: shop.status,
          hasAccessToken: !accessTokenMissing,
          createdAt: shop.createdAt.toISOString(),
          lastOrderSyncAt: shop.lastOrderSyncAt?.toISOString() ?? null,
          orderSyncAttemptAt: shop.orderSyncAttemptAt?.toISOString() ?? null,
          error: shop.orderSyncError,
        });
      const observed = (code: CaseCode, reason: string): ObservedCase =>
        observedFromCatalog({
          code,
          dedupeKey,
          sourceFingerprint: sourceFingerprint(code),
          subjectType: 'shop',
          subjectId: shop.id.toString(),
          subjectLabel: boundedText(shop.shopName ?? `抖店 ${shop.platformShopId}`, 255),
          reason,
        });

      if (shop.status === 'revoked') return [];
      if (authorizationInvalid) {
        return [observed('order_sync_authorization_invalid', '抖店授权已过期，订单同步无法继续。')];
      }
      if (accessTokenMissing) {
        return [
          observed(
            'order_sync_access_token_missing',
            '店铺处于启用状态，但缺少可用的抖店访问凭证。',
          ),
        ];
      }

      const hung =
        attemptMs !== undefined &&
        attemptMs < hungBefore &&
        (successMs === undefined || attemptMs > successMs);
      const neverSynced =
        successMs === undefined && attemptMs === undefined && createdMs < staleBefore;
      const stale =
        successMs !== undefined && (successMs < staleBefore || successMs > now.getTime());
      if (!shop.orderSyncError && !hung && !neverSynced && !stale) return [];
      const code: CaseCode = shop.orderSyncError ? 'order_sync_failed' : 'order_sync_stalled';
      const reason =
        boundedText(shop.orderSyncError, 2_000) ||
        (neverSynced
          ? '店铺从未形成成功同步水位，新订单可能尚未进入系统。'
          : hung
            ? '订单同步开始后超过 15 分钟仍未形成新的成功水位。'
            : successMs! > now.getTime()
              ? '店铺订单同步水位时间异常，无法确认最新订单已同步。'
              : `店铺订单同步水位已超过 ${Math.ceil(this.orderSyncStaleMs / 60_000)} 分钟未更新。`);
      return [observed(code, reason)];
    });
  }

  private async scanPurchaseExceptions(
    userId: bigint,
    targetDomain: 'purchase' | 'logistics' | 'after_sale',
  ): Promise<ObservedCase[]> {
    const purchases = await this.prisma.purchaseOrder.findMany({
      where: {
        OR: [
          { exceptionStatus: 'action_required' },
          { exceptionStatus: 'resolved', reconciledCost: null },
        ],
        order: { shop: { userId, ...runtimeShopWhere(this.demoMode) } },
      },
      include: { order: { select: { platformOrderId: true } } },
    });
    return purchases.flatMap((purchase): ObservedCase[] => {
      const domain = purchaseExceptionDomain(purchase.exceptionCode);
      if (domain !== targetDomain) return [];
      const code = catalogPurchaseCode(purchase.exceptionCode);
      return [
        observedFromCatalog({
          code,
          dedupeKey: `scanner:purchase:${purchase.id}:${code}`,
          sourceFingerprint: fingerprint({
            code: purchase.exceptionCode,
            status: purchase.status,
            exceptionStatus: purchase.exceptionStatus,
            exceptionRevision: purchase.exceptionRevision,
            syncRevision: purchase.syncRevision,
            retryEligible: purchase.retryEligible,
            everShipped: purchase.everShipped,
            reconciledCost: purchase.reconciledCost?.toString() ?? null,
            reason: purchase.exceptionReason,
          }),
          subjectType: 'purchase_order',
          subjectId: purchase.id.toString(),
          subjectLabel: boundedText(
            `1688 采购 ${purchase.orderId1688 ?? purchase.outOrderId}`,
            255,
          ),
          reason:
            boundedText(purchase.exceptionReason ?? purchase.failureReason, 2_000) ||
            '采购单需要人工核对。',
        }),
      ];
    });
  }

  private async scanAfterSaleOrders(userId: bigint): Promise<ObservedCase[]> {
    const orders = await this.prisma.order.findMany({
      where: {
        shop: {
          userId,
          role: 'seller',
          ...runtimeShopWhere(this.demoMode),
        },
        status: { in: [...ACTIVE_ORDER_STATUSES] },
        OR: [
          { afterSaleStatus: 'pending' },
          { afterSaleStatus: 'partial_refund', partialRefundDisposition: 'none' },
          {
            refundAmount: null,
            OR: [
              { afterSaleStatus: 'partial_refund' },
              { items: { some: { refundStatusRaw: 3 } } },
            ],
          },
        ],
      },
      select: {
        id: true,
        platformOrderId: true,
        status: true,
        afterSaleStatus: true,
        partialRefundDisposition: true,
        partialRefundFingerprint: true,
        refundAmount: true,
        refundAmountFingerprint: true,
        items: {
          select: {
            platformOrderItemId: true,
            afterSaleStatusRaw: true,
            afterSaleTypeRaw: true,
            refundStatusRaw: true,
          },
        },
      },
    });
    return orders.map((order): ObservedCase => {
      const code: CaseCode =
        order.afterSaleStatus === 'pending'
          ? 'after_sale_pending'
          : order.afterSaleStatus === 'partial_refund' && order.partialRefundDisposition === 'none'
            ? 'partial_refund_action_required'
            : 'refund_amount_reconciliation_required';
      return observedFromCatalog({
        code,
        dedupeKey: `scanner:after_sale:order:${order.id}`,
        sourceFingerprint: fingerprint({
          code,
          status: order.status,
          afterSaleStatus: order.afterSaleStatus,
          disposition: order.partialRefundDisposition,
          partialRefundFingerprint: order.partialRefundFingerprint,
          refundAmount: order.refundAmount?.toString() ?? null,
          refundAmountFingerprint: order.refundAmountFingerprint,
          items: order.items
            .map((item) => ({
              id: item.platformOrderItemId,
              afterSaleStatus: item.afterSaleStatusRaw,
              afterSaleType: item.afterSaleTypeRaw,
              refundStatus: item.refundStatusRaw,
            }))
            .sort((left, right) => left.id.localeCompare(right.id)),
        }),
        subjectType: 'order',
        subjectId: order.id.toString(),
        subjectLabel: `销售订单 ${order.platformOrderId}`,
        reason:
          code === 'after_sale_pending'
            ? '销售平台子订单存在进行中的售后申请。'
            : code === 'partial_refund_action_required'
              ? '销售订单存在部分退款，尚未选择剩余商品履约方式。'
              : '平台未提供通用实际退款金额，当前订单尚未完成人工核对。',
      });
    });
  }

  private async scanAfterSaleCases(userId: bigint, now: Date): Promise<ObservedCase[]> {
    const observed: ObservedCase[] = [];
    let cursor: string | undefined;
    for (let pageNumber = 0; pageNumber < MAX_AFTER_SALE_SIGNAL_PAGES; pageNumber++) {
      const page = await this.afterSales.exceptionSignals(userId, now, cursor);
      observed.push(
        ...page.items.map((signal): ObservedCase => {
          const catalog = CASE_CATALOG[signal.code];
          return {
            dedupeKey: signal.dedupeKey,
            code: signal.code,
            domain: catalog.domain,
            priority: signal.priority,
            sourceFingerprint: signal.sourceFingerprint,
            subjectType: 'after_sale_case',
            subjectId: signal.caseId,
            subjectLabel: signal.subjectLabel,
            responsibleParty: catalog.responsibleParty,
            reason: signal.reason,
            impact: catalog.impact,
            nextAction: signal.nextAction,
            actionLabel: catalog.actionLabel,
            actionHref: signal.actionHref,
            evidence: {
              items: [
                {
                  type: signal.code,
                  label: signal.reason,
                  value: signal.caseId,
                },
              ],
              overdue: signal.overdue,
            },
          };
        }),
      );
      if (!page.hasMore) return observed;
      if (!page.nextCursor || page.nextCursor === cursor) {
        throw new Error('售后工单异常扫描游标未推进');
      }
      cursor = page.nextCursor;
    }
    throw new Error(
      `售后工单异常扫描超过 ${MAX_AFTER_SALE_SIGNAL_PAGES} 页安全上限，已保留原有事项`,
    );
  }

  private async scanEntitlement(userId: bigint, now: Date): Promise<ObservedCase[]> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        plan: true,
        entitlementSource: true,
        entitlementAccessStatus: true,
        subscriptions: {
          where: { status: 'active' },
          orderBy: [{ startDate: 'asc' }, { id: 'asc' }],
        },
        marketplaceProjections: {
          where: { origin: 'marketplace' },
          orderBy: [{ providerRevision: 'desc' }, { id: 'desc' }],
          select: {
            id: true,
            internalPlan: true,
            lifecycleState: true,
            accessStatus: true,
            providerRevision: true,
          },
        },
      },
    });
    if (!user) return [];
    const today = utcDateKey(now);
    const invalid = user.subscriptions.filter(
      (subscription) =>
        utcDateKey(subscription.startDate) > today || utcDateKey(subscription.endDate) < today,
    );
    const current = user.subscriptions.filter(
      (subscription) =>
        utcDateKey(subscription.startDate) <= today && utcDateKey(subscription.endDate) >= today,
    );
    let code: CaseCode | null = null;
    let reason = '';
    if (user.entitlementSource === 'marketplace') {
      const activeProjections = user.marketplaceProjections.filter(
        (projection) => projection.accessStatus === 'active',
      );
      if (user.entitlementAccessStatus === 'active' && activeProjections.length === 0) {
        code = 'entitlement_active_subscription_missing';
        reason = '服务市场账号仍为启用状态，但当前没有可证明的有效订购投影。';
      } else if (activeProjections.length > 1) {
        code = 'entitlement_multiple_active_subscriptions';
        reason = '当前账号存在多条同时生效的服务市场订购投影。';
      } else if (
        user.entitlementAccessStatus === 'suspended' &&
        (user.plan !== 'free' || activeProjections.length > 0)
      ) {
        code = 'entitlement_plan_mismatch';
        reason = '服务市场权益已暂停，但账号仍保留套餐或有效订购投影。';
      } else if (
        user.entitlementAccessStatus === 'active' &&
        activeProjections.length === 1 &&
        user.plan !== activeProjections[0]!.internalPlan
      ) {
        code = 'entitlement_plan_mismatch';
        reason = '账号套餐与当前有效的服务市场订购投影不一致。';
      }
    } else if (user.subscriptions.length === 0 && user.plan !== 'free') {
      code = 'entitlement_active_subscription_missing';
      reason = '账号套餐不是免费版，但当前没有任何标记为有效的本地订购记录。';
    } else if (invalid.length > 0) {
      code = 'entitlement_subscription_date_invalid';
      reason = '存在标记为有效、但当前日期不在有效期内的本地订购记录。';
    } else if (current.length > 1) {
      code = 'entitlement_multiple_active_subscriptions';
      reason = '当前日期存在多条同时生效的本地订购记录。';
    } else if (current.length === 1 && user.plan !== current[0]!.plan) {
      code = 'entitlement_plan_mismatch';
      reason = `账号套餐与当前有效订购记录不一致。`;
    }
    if (!code) return [];
    return [
      observedFromCatalog({
        code,
        dedupeKey: `scanner:entitlement:user:${userId}`,
        sourceFingerprint: fingerprint({
          code,
          userPlan: user.plan,
          entitlementSource: user.entitlementSource,
          entitlementAccessStatus: user.entitlementAccessStatus,
          subscriptions: user.subscriptions.map((subscription) => ({
            id: subscription.id.toString(),
            plan: subscription.plan,
            startDate: utcDateKey(subscription.startDate),
            endDate: utcDateKey(subscription.endDate),
            status: subscription.status,
          })),
          marketplaceProjections: user.marketplaceProjections.map((projection) => ({
            id: projection.id.toString(),
            plan: projection.internalPlan,
            lifecycleState: projection.lifecycleState,
            accessStatus: projection.accessStatus,
            providerRevision: projection.providerRevision?.toFixed(0) ?? null,
          })),
        }),
        subjectType: 'user',
        subjectId: userId.toString(),
        subjectLabel: '当前账号订购权益',
        reason,
      }),
    ];
  }

  private async productionPublishTaskWhere(userId: bigint): Promise<Prisma.PublishTaskWhereInput> {
    const shops = await this.prisma.shop.findMany({
      where: {
        userId,
        role: 'seller',
        status: 'active',
        ...runtimeShopWhere(this.demoMode),
      },
      select: { id: true },
    });
    return shops.length
      ? {
          userId,
          OR: shops.map((shop) => ({
            targetShopIds: { array_contains: [shop.id.toString()] },
          })),
        }
      : { userId, AND: [{ id: { lt: 0n } }] };
  }

  private async reconcileScannerCases(
    userId: bigint,
    scope: Prisma.ExceptionCaseWhereInput,
    observed: ObservedCase[],
    now: Date,
  ): Promise<ReconcileStats> {
    return this.serializable(async (tx) => {
      const stats: ReconcileStats = {
        scanned: observed.length,
        created: 0,
        updated: 0,
        reopened: 0,
        resolved: 0,
      };
      for (const item of observed) {
        const result = await this.upsertObservedCase(tx, userId, item, 'scanner', now);
        if (result !== 'unchanged') stats[result]++;
      }
      const active = await tx.exceptionCase.findMany({
        where: {
          userId,
          sourceKind: 'scanner',
          sourceActive: true,
          ...scope,
          ...(observed.length
            ? { dedupeKey: { notIn: observed.map((item) => item.dedupeKey) } }
            : {}),
        },
      });
      for (const current of active) {
        await this.resolveCase(tx, current, now, {
          items: [
            {
              type: 'source_recovered',
              label: '权威来源已恢复或不再满足异常条件',
            },
          ],
        });
        stats.resolved++;
      }
      return stats;
    });
  }

  private async upsertObservedCase(
    tx: Prisma.TransactionClient,
    userId: bigint,
    observed: ObservedCase,
    sourceKind: 'scanner' | 'producer',
    now: Date,
  ): Promise<'created' | 'updated' | 'reopened' | 'unchanged'> {
    const current = await tx.exceptionCase.findUnique({
      where: {
        uk_exception_case_user_dedupe: { userId, dedupeKey: observed.dedupeKey },
      },
    });
    if (!current) {
      const created = await tx.exceptionCase.create({
        data: {
          userId,
          ...caseData(observed),
          sourceKind,
          sourceActive: true,
          status: 'open',
          occurrences: 1,
          stateRevision: 1,
          lastSeenAt: now,
          acknowledgedAt: null,
          acknowledgedByUserId: null,
          resolvedAt: null,
          resolutionReason: null,
        },
      });
      await tx.exceptionCaseEvent.create({
        data: {
          userId,
          caseId: created.id,
          caseRevision: 1,
          type: 'opened',
          fromStatus: null,
          toStatus: 'open',
          sourceFingerprint: observed.sourceFingerprint,
          evidence: observed.evidence,
        },
      });
      return 'created';
    }
    if (current.sourceKind !== sourceKind) {
      throw new ConflictException('异常来源类型与既有事项不一致');
    }
    if (current.sourceActive && current.sourceFingerprint === observed.sourceFingerprint) {
      await tx.exceptionCase.update({
        where: { id: current.id },
        data: { lastSeenAt: now },
      });
      return 'unchanged';
    }

    const fromStatus = current.status;
    const eventType = fromStatus === 'open' ? 'updated' : 'reopened';
    const nextRevision = current.stateRevision + 1;
    const updated = await tx.exceptionCase.updateMany({
      where: { id: current.id, userId, stateRevision: current.stateRevision },
      data: {
        ...caseData(observed),
        sourceKind,
        sourceActive: true,
        status: 'open',
        occurrences: { increment: 1 },
        stateRevision: { increment: 1 },
        lastSeenAt: now,
        acknowledgedAt: null,
        acknowledgedByUserId: null,
        resolvedAt: null,
        resolutionReason: null,
      },
    });
    if (updated.count !== 1) throw new ConflictException('异常事项已并发更新');
    await tx.exceptionCaseEvent.create({
      data: {
        userId,
        caseId: current.id,
        caseRevision: nextRevision,
        type: eventType,
        fromStatus,
        toStatus: 'open',
        sourceFingerprint: observed.sourceFingerprint,
        evidence: observed.evidence,
      },
    });
    return eventType === 'reopened' ? 'reopened' : 'updated';
  }

  private async resolveCase(
    tx: Prisma.TransactionClient,
    current: ExceptionCase,
    now: Date,
    evidence: Prisma.InputJsonObject,
  ): Promise<void> {
    if (!current.sourceActive || current.status === 'resolved') return;
    const resolutionReason = '权威来源已恢复或不再满足异常条件。';
    const nextRevision = current.stateRevision + 1;
    const updated = await tx.exceptionCase.updateMany({
      where: {
        id: current.id,
        userId: current.userId,
        sourceActive: true,
        stateRevision: current.stateRevision,
        status: current.status,
      },
      data: {
        sourceActive: false,
        status: 'resolved',
        stateRevision: { increment: 1 },
        resolvedAt: now,
        resolutionReason,
      },
    });
    if (updated.count !== 1) throw new ConflictException('异常事项已并发更新');
    await tx.exceptionCaseEvent.create({
      data: {
        userId: current.userId,
        caseId: current.id,
        caseRevision: nextRevision,
        type: 'resolved',
        note: resolutionReason,
        evidence,
        fromStatus: current.status,
        toStatus: 'resolved',
        sourceFingerprint: current.sourceFingerprint,
      },
    });
  }

  private async serializable<T>(
    callback: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt++) {
      try {
        return await this.prisma.$transaction(callback, { isolationLevel: 'Serializable' });
      } catch (error) {
        lastError = error;
        if (!isRetryableTransactionError(error) || attempt === MAX_TRANSACTION_ATTEMPTS)
          throw error;
      }
    }
    throw lastError;
  }
}

function purchaseCatalog(
  title: string,
  impact: string,
  nextAction: string,
  domain: 'purchase' | 'logistics' | 'after_sale',
): CaseCatalogEntry {
  return {
    domain,
    priority: domain === 'logistics' || domain === 'after_sale' ? 'critical' : 'high',
    title,
    impact,
    nextAction,
    actionLabel: domain === 'after_sale' ? '处理售后订单' : '处理采购订单',
    actionHref: domain === 'after_sale' ? '/after-sales' : '/orders',
    responsibleParty: 'merchant',
  };
}

function entitlementCatalog(title: string, impact: string): CaseCatalogEntry {
  return {
    domain: 'entitlement',
    priority: 'high',
    title,
    impact,
    nextAction: '联系管理员核对本地订购记录；当前版本不会猜测外部服务市场权益。',
    actionLabel: '检查账号设置',
    actionHref: '/settings',
    responsibleParty: 'system',
  };
}

function observedFromCatalog(input: {
  code: CaseCode;
  dedupeKey: string;
  sourceFingerprint: string;
  subjectType: string;
  subjectId: string;
  subjectLabel: string;
  reason: string;
  evidence?: Prisma.InputJsonObject;
}): ObservedCase {
  const catalog = CASE_CATALOG[input.code];
  return {
    ...input,
    domain: catalog.domain,
    priority: catalog.priority,
    responsibleParty: catalog.responsibleParty,
    impact: catalog.impact,
    nextAction: catalog.nextAction,
    actionLabel: catalog.actionLabel,
    actionHref: catalog.actionHref,
  };
}

function producerObservedCase(input: RecordProducerCaseInput): ObservedCase {
  assertProducerCode(input.code);
  const sourceType = requiredText(input.sourceType, 64, '异常来源类型');
  const sourceId = requiredText(String(input.sourceId), 128, '异常来源 ID');
  return observedFromCatalog({
    code: input.code,
    dedupeKey: producerDedupeKey(input.code, sourceType, sourceId),
    sourceFingerprint: fingerprint({ producerFingerprint: input.sourceFingerprint }),
    subjectType: sourceType,
    subjectId: sourceId,
    subjectLabel: requiredText(input.subjectLabel, 255, '异常业务对象'),
    reason: requiredText(input.reason, 2_000, '异常原因'),
    evidence:
      input.context === undefined
        ? undefined
        : {
            items: [{ type: 'producer_context', label: '生产者异常上下文已记录' }],
            context: safeJson(input.context),
          },
  });
}

function producerDedupeKey(code: ProducerCaseCode, sourceType: string, sourceId: string): string {
  return `producer:${code}:${sourceType}:${fingerprint(sourceId).slice(0, 24)}`;
}

function assertProducerCode(code: string): asserts code is ProducerCaseCode {
  if (
    code !== 'sales_platform_logistics_callback_failed' &&
    code !== 'sales_platform_logistics_status_unknown'
  ) {
    throw new BadRequestException('不支持的生产者异常类型');
  }
}

function catalogPurchaseCode(value: string | null): CaseCode {
  if (
    value &&
    (Object.values(PURCHASE_EXCEPTION_CODE) as string[]).includes(value) &&
    value in CASE_CATALOG
  ) {
    return value as CaseCode;
  }
  return 'purchase_exception_unclassified';
}

function caseData(observed: ObservedCase) {
  return {
    dedupeKey: observed.dedupeKey,
    domain: observed.domain,
    code: observed.code,
    priority: observed.priority,
    sourceFingerprint: observed.sourceFingerprint,
    subjectType: observed.subjectType,
    subjectId: observed.subjectId,
    subjectLabel: observed.subjectLabel,
    responsibleParty: observed.responsibleParty,
    reason: observed.reason,
    impact: observed.impact,
    nextAction: observed.nextAction,
    actionLabel: observed.actionLabel,
    actionHref: observed.actionHref,
  };
}

function toCaseView(row: ExceptionCase) {
  const catalog = CASE_CATALOG[row.code as CaseCode];
  return {
    id: row.id.toString(),
    domain: row.domain,
    code: row.code,
    priority: row.priority,
    status: row.status,
    title: catalog?.title ?? '业务异常需要处理',
    subject: {
      type: row.subjectType,
      id: row.subjectId,
      label: row.subjectLabel,
      href: subjectHref(row.subjectType, row.actionHref),
    },
    impact: row.impact,
    reason: row.reason,
    nextAction: row.nextAction,
    actionLabel: row.actionLabel,
    actionHref: row.actionHref,
    responsibleParty: row.responsibleParty,
    assigneeUserId: row.acknowledgedByUserId?.toString() ?? null,
    sourceActive: row.sourceActive,
    occurrences: row.occurrences,
    stateRevision: row.stateRevision,
    firstSeenAt: row.createdAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toEventView(row: ExceptionCaseEvent) {
  return {
    id: row.id.toString(),
    caseRevision: row.caseRevision,
    type: row.type,
    actor: row.actorUserId
      ? { type: 'user' as const, userId: row.actorUserId.toString() }
      : { type: 'system' as const },
    note: row.note,
    evidence: evidenceItems(row.evidence),
    fromStatus: row.fromStatus,
    toStatus: row.toStatus,
    fromAssigneeUserId: null,
    toAssigneeUserId: row.type === 'acknowledged' ? (row.actorUserId?.toString() ?? null) : null,
    fromResponsibleParty: null,
    toResponsibleParty: null,
    createdAt: row.createdAt.toISOString(),
  };
}

function evidenceItems(value: Prisma.JsonValue | null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const items = (value as Record<string, Prisma.JsonValue>).items;
  if (!Array.isArray(items)) return [];
  return items.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const record = item as Record<string, Prisma.JsonValue>;
    if (typeof record.type !== 'string' || typeof record.label !== 'string') return [];
    return [
      {
        type: record.type,
        label: record.label,
        ...(typeof record.value === 'string' ? { value: record.value } : {}),
      },
    ];
  });
}

function subjectHref(subjectType: string, fallback: string): string {
  if (subjectType === 'shop' || subjectType === 'user') return '/settings';
  if (subjectType === 'publish_task' || subjectType === 'published_product') return '/published';
  if (subjectType === 'order' || subjectType === 'purchase_order') return '/orders';
  return fallback;
}

function positiveId(value: string): bigint {
  try {
    const id = BigInt(value);
    if (id <= 0n) throw new Error('invalid');
    return id;
  } catch {
    throw new NotFoundException('异常事项不存在');
  }
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function stableJson(value: unknown): string {
  if (value === null || value === undefined) return JSON.stringify(value ?? null);
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(',')}}`;
}

function requiredText(value: string, max: number, label: string): string {
  const result = boundedText(value, max);
  if (!result) throw new BadRequestException(`${label}不能为空`);
  return result;
}

function boundedText(value: string | null | undefined, max: number): string {
  return value?.trim().slice(0, max) ?? '';
}

function safeJson(value: unknown, depth = 0): Prisma.InputJsonValue | null {
  if (depth > 5 || value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.slice(0, 500);
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => safeJson(item, depth + 1));
  if (typeof value === 'object') {
    const result: Record<string, Prisma.InputJsonValue | null> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 50)) {
      const safeKey = key.slice(0, 100);
      result[safeKey] = /authorization|cookie|password|secret|token|api.?key|credential/i.test(
        safeKey,
      )
        ? '[redacted]'
        : safeJson(item, depth + 1);
    }
    return result;
  }
  return String(value).slice(0, 500);
}

function utcDateKey(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function domainLabel(domain: ExceptionCaseDomain): string {
  return {
    publish: '铺货',
    order: '订单',
    purchase: '采购',
    logistics: '物流',
    after_sale: '售后',
    entitlement: '权益',
  }[domain];
}

function isRetryableTransactionError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'P2002' || code === 'P2034';
}
