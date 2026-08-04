import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  AfterSaleCase,
  AfterSaleCaseEvent,
  AfterSaleCaseEventType,
  AfterSaleCaseStatus,
  AfterSaleRemoteReferenceType,
  ExceptionPriority,
  Prisma,
} from '@supplier/db';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../common/prisma.module';
import { runtimeShopWhere } from '../shop/platform-adapter.factory';
import type { AfterSaleCaseCommandDto } from './dto/after-sale-case-command.dto';
import type { AfterSaleCaseListQueryDto } from './dto/after-sale-case-list-query.dto';
import type { ConfirmAfterSalePurchaseActionDto } from './dto/confirm-after-sale-purchase-action.dto';
import type { StartAfterSalePurchaseActionDto } from './dto/start-after-sale-purchase-action.dto';
import type { VerifyCloseAfterSaleCaseDto } from './dto/verify-close-after-sale-case.dto';

const MAX_TRANSACTION_ATTEMPTS = 3;
const MAX_REFRESH_ORDERS = 500;
const SALES_SOURCE_FRESH_MS = 5 * 60_000;
const CRITICAL_SLA_MS = 30 * 60_000;
const HIGH_SLA_MS = 2 * 60 * 60_000;
const MEDIUM_SLA_MS = 24 * 60 * 60_000;
const ACTIVE_AFTER_SALE_STATUSES = new Set([6, 7, 11, 12, 13, 14, 51, 53]);

const CASE_VIEW_INCLUDE = {
  order: {
    include: {
      shop: { select: { shopName: true, platform: true, platformShopId: true, userId: true } },
      items: {
        select: {
          id: true,
          orderId: true,
          platformOrderItemId: true,
          title: true,
          quantity: true,
          afterSaleStatusRaw: true,
          afterSaleTypeRaw: true,
          refundStatusRaw: true,
        },
      },
      purchaseOrders: {
        include: { items: { select: { id: true, orderItemId: true } } },
      },
    },
  },
  items: {
    include: {
      orderItem: {
        select: {
          id: true,
          platformOrderItemId: true,
          title: true,
          quantity: true,
          afterSaleStatusRaw: true,
          afterSaleTypeRaw: true,
          refundStatusRaw: true,
        },
      },
    },
  },
  links: {
    include: {
      purchaseOrder: {
        include: { items: { select: { id: true, orderItemId: true } } },
      },
    },
  },
} satisfies Prisma.AfterSaleCaseInclude;

const CASE_DETAIL_INCLUDE = {
  ...CASE_VIEW_INCLUDE,
  events: { orderBy: { caseRevision: 'asc' as const } },
} satisfies Prisma.AfterSaleCaseInclude;

const ORDER_MATERIALIZE_INCLUDE = {
  shop: {
    select: {
      userId: true,
      platform: true,
      platformShopId: true,
      shopName: true,
    },
  },
  items: {
    select: {
      id: true,
      orderId: true,
      platformOrderItemId: true,
      title: true,
      quantity: true,
      afterSaleStatusRaw: true,
      afterSaleTypeRaw: true,
      refundStatusRaw: true,
    },
  },
  purchaseOrders: {
    select: {
      id: true,
      orderId: true,
      orderId1688: true,
      status: true,
      exceptionStatus: true,
      exceptionCode: true,
      exceptionRevision: true,
      syncRevision: true,
      reconciledCost: true,
      everShipped: true,
    },
  },
} satisfies Prisma.OrderInclude;

type CaseViewGraph = Prisma.AfterSaleCaseGetPayload<{ include: typeof CASE_DETAIL_INCLUDE }>;
type MaterializeOrderGraph = Prisma.OrderGetPayload<{
  include: typeof ORDER_MATERIALIZE_INCLUDE;
}>;

export interface AfterSaleClosureBlocker {
  code: string;
  label: string;
  detail?: string;
  purchaseOrderId?: string;
}

export interface AfterSaleExceptionSignal {
  dedupeKey: string;
  code: 'after_sale_case_overdue' | 'after_sale_case_blocked';
  caseId: string;
  priority: ExceptionPriority;
  sourceFingerprint: string;
  subjectLabel: string;
  reason: string;
  nextAction: string;
  actionHref: '/after-sales';
  overdue: boolean;
}

export interface MaterializeResult {
  orderId: string;
  caseId: string | null;
  change: 'ignored' | 'created' | 'unchanged' | 'updated' | 'reopened';
}

@Injectable()
export class AfterSaleService {
  private readonly demoMode: boolean;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.demoMode = (config.get<string>('AUTH_MODE') ?? 'demo') === 'demo';
  }

  async list(userId: bigint, query: AfterSaleCaseListQueryDto) {
    const now = new Date();
    const q = query.q?.trim();
    const scope = this.caseScope(userId);
    const filters: Prisma.AfterSaleCaseWhereInput[] = [];
    if (query.status) filters.push({ status: query.status });
    if (query.overdue === true) {
      filters.push({ status: { not: 'closed' }, nextActionDueAt: { lt: now } });
    } else if (query.overdue === false) {
      filters.push({ OR: [{ status: 'closed' }, { nextActionDueAt: { gte: now } }] });
    }
    if (q) {
      filters.push({
        OR: [
          { order: { platformOrderId: { contains: q, mode: 'insensitive' } } },
          { order: { shop: { shopName: { contains: q, mode: 'insensitive' } } } },
          { links: { some: { purchaseOrder: { orderId1688: { contains: q } } } } },
        ],
      });
    }
    const where: Prisma.AfterSaleCaseWhereInput = {
      ...scope,
      ...(filters.length ? { AND: filters } : {}),
    };
    const [total, rows, grouped, overdueCount] = await Promise.all([
      this.prisma.afterSaleCase.count({ where }),
      this.prisma.afterSaleCase.findMany({
        where,
        include: CASE_VIEW_INCLUDE,
        orderBy: [{ status: 'asc' }, { priority: 'asc' }, { updatedAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.afterSaleCase.groupBy({
        by: ['status'],
        where: scope,
        _count: { _all: true },
      }),
      this.prisma.afterSaleCase.count({
        where: { ...scope, status: { not: 'closed' }, nextActionDueAt: { lt: now } },
      }),
    ]);
    const counts = { open: 0, handling: 0, waitingExternal: 0, verifying: 0, closed: 0 };
    for (const row of grouped) {
      if (row.status === 'waiting_external') counts.waitingExternal = row._count._all;
      else counts[row.status] = row._count._all;
    }
    return {
      items: rows.map((row) => this.toView(row as CaseViewGraph, now)),
      total,
      page: query.page,
      pageSize: query.pageSize,
      counts,
      overdueCount,
    };
  }

  async detail(userId: bigint, idValue: string, now = new Date()) {
    const id = positiveId(idValue, '售后工单');
    const row = await this.prisma.afterSaleCase.findFirst({
      where: { id, ...this.caseScope(userId) },
      include: CASE_DETAIL_INCLUDE,
    });
    if (!row) throw new NotFoundException('售后工单不存在');
    return this.toView(row as CaseViewGraph, now, true);
  }

  async refreshUser(userId: bigint, now = new Date(), afterOrderId?: string) {
    const cursor = afterOrderId ? positiveCursor(afterOrderId, '订单游标') : null;
    const rows = await this.prisma.order.findMany({
      where: {
        shop: { userId, ...runtimeShopWhere(this.demoMode) },
        ...(cursor === null ? {} : { id: { gt: cursor } }),
        OR: [
          { afterSaleCase: { isNot: null } },
          { status: 'refunded' },
          {
            status: 'closed',
            purchaseOrders: {
              some: {
                exceptionCode: {
                  in: [
                    'sales_order_partial_refund',
                    'sales_order_refunded',
                    'sales_order_closed',
                    'sales_order_after_sale_hold',
                  ],
                },
              },
            },
          },
          { afterSaleStatus: { not: 'none' } },
          {
            items: {
              some: {
                OR: [
                  { afterSaleStatusRaw: { not: 0 } },
                  { afterSaleTypeRaw: { not: 0 } },
                  { refundStatusRaw: { not: 0 } },
                ],
              },
            },
          },
        ],
      },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: MAX_REFRESH_ORDERS + 1,
    });
    const hasMore = rows.length > MAX_REFRESH_ORDERS;
    const stats = { scanned: 0, created: 0, updated: 0, reopened: 0, closed: 0 };
    const errors: Array<{ code: string; message: string; orderId?: string }> = [];
    for (const row of rows.slice(0, MAX_REFRESH_ORDERS)) {
      stats.scanned++;
      try {
        const result = await this.serializable((tx) => this.materializeOrder(tx, row.id, now));
        if (result.change === 'created') stats.created++;
        else if (result.change === 'reopened') stats.reopened++;
        else if (result.change === 'updated') stats.updated++;
      } catch (_error) {
        errors.push({
          code: 'ORDER_MATERIALIZE_FAILED',
          message: '订单售后工单刷新失败，原状态已保留',
          orderId: row.id.toString(),
        });
      }
    }
    if (hasMore) {
      errors.push({
        code: 'REFRESH_LIMIT_REACHED',
        message: `本次最多刷新 ${MAX_REFRESH_ORDERS} 笔相关订单，仍有后续订单待下一轮处理`,
      });
    }
    const processedRows = rows.slice(0, MAX_REFRESH_ORDERS);
    return {
      ...stats,
      hasMore,
      nextCursor:
        hasMore && processedRows.length
          ? processedRows[processedRows.length - 1]!.id.toString()
          : null,
      errors,
      refreshedAt: now.toISOString(),
    };
  }

  /**
   * Materializes one order inside the caller's transaction. OrderSync can call
   * this immediately after persisting the authoritative item-level snapshot.
   */
  async materializeOrder(
    tx: Prisma.TransactionClient,
    orderId: bigint,
    now = new Date(),
  ): Promise<MaterializeResult> {
    const order = await tx.order.findUnique({
      where: { id: orderId },
      include: ORDER_MATERIALIZE_INCLUDE,
    });
    if (!order) throw new NotFoundException('销售订单不存在');
    if (!this.demoMode && order.shop.platformShopId.startsWith('demo-')) {
      return { orderId: orderId.toString(), caseId: null, change: 'ignored' };
    }
    const snapshot = sourceSnapshot(order);
    const sourceFingerprint = fingerprint(snapshot);
    const signal = sourceSignal(order);
    const current = await tx.afterSaleCase.findUnique({ where: { orderId } });
    if (!signal.exists && !current) {
      return { orderId: orderId.toString(), caseId: null, change: 'ignored' };
    }
    const priority = casePriority(order);
    const nextActionDueAt = new Date(now.getTime() + slaMs(priority));

    if (!current) {
      const created = await tx.afterSaleCase.create({
        data: {
          userId: order.shop.userId,
          orderId,
          status: 'open',
          waitingOn: 'merchant',
          priority,
          sourceActive: signal.active,
          sourceFingerprint,
          sourceRevision: 1,
          stateRevision: 1,
          occurrences: 1,
          firstDetectedAt: now,
          lastObservedAt: observedAt(order, now),
          nextActionDueAt,
        },
      });
      await tx.afterSaleCaseEvent.create({
        data: {
          userId: order.shop.userId,
          caseId: created.id,
          caseRevision: 1,
          type: 'opened',
          fromStatus: null,
          toStatus: 'open',
          sourceRevision: 1,
          sourceFingerprint,
          evidence: snapshotEvidence(order, signal),
        },
      });
      await this.syncCaseChildren(tx, created, order, 1, true, now);
      return { orderId: orderId.toString(), caseId: created.id.toString(), change: 'created' };
    }
    if (current.userId !== order.shop.userId) {
      throw new ConflictException('售后工单租户与销售订单不一致');
    }

    if (current.sourceFingerprint === sourceFingerprint) {
      await tx.afterSaleCase.update({
        where: { id: current.id },
        data: {
          sourceActive: current.status === 'closed' ? false : signal.active,
          priority,
          lastObservedAt: observedAt(order, now),
        },
      });
      const childChanged = await this.syncCaseChildren(
        tx,
        current,
        order,
        current.sourceRevision,
        false,
        now,
      );
      if (childChanged) {
        const nextStatus: AfterSaleCaseStatus = current.assigneeUserId ? 'handling' : 'open';
        const eventType: AfterSaleCaseEventType =
          current.status === 'closed' ? 'reopened' : 'source_updated';
        const updated = await tx.afterSaleCase.updateMany({
          where: {
            id: current.id,
            userId: current.userId,
            stateRevision: current.stateRevision,
            sourceRevision: current.sourceRevision,
            sourceFingerprint: current.sourceFingerprint,
          },
          data: {
            status: nextStatus,
            waitingOn: 'merchant',
            priority,
            sourceActive:
              signal.active ||
              order.purchaseOrders.some((purchase) => purchaseNeedsManualAction(purchase, order)),
            stateRevision: { increment: 1 },
            ...(current.status === 'closed' ? { occurrences: { increment: 1 } } : {}),
            lastObservedAt: observedAt(order, now),
            nextActionDueAt,
            resolutionCode: null,
            resolutionNote: null,
            closedAt: null,
            closedByUserId: null,
          },
        });
        if (updated.count !== 1) throw new ConflictException('售后工单采购状态已并发更新');
        await tx.afterSaleCaseEvent.create({
          data: {
            userId: current.userId,
            caseId: current.id,
            caseRevision: current.stateRevision + 1,
            type: eventType,
            fromStatus: current.status,
            toStatus: nextStatus,
            sourceRevision: current.sourceRevision,
            sourceFingerprint: current.sourceFingerprint,
            evidence: snapshotEvidence(order, signal),
          },
        });
      }
      return {
        orderId: orderId.toString(),
        caseId: current.id.toString(),
        change: childChanged ? (current.status === 'closed' ? 'reopened' : 'updated') : 'unchanged',
      };
    }

    const nextStatus: AfterSaleCaseStatus = current.assigneeUserId ? 'handling' : 'open';
    const nextSourceRevision = current.sourceRevision + 1;
    const nextStateRevision = current.stateRevision + 1;
    const eventType: AfterSaleCaseEventType =
      current.status === 'closed' ? 'reopened' : 'source_updated';
    const updated = await tx.afterSaleCase.updateMany({
      where: {
        id: current.id,
        userId: order.shop.userId,
        stateRevision: current.stateRevision,
        sourceRevision: current.sourceRevision,
        sourceFingerprint: current.sourceFingerprint,
      },
      data: {
        status: nextStatus,
        waitingOn: 'merchant',
        priority,
        sourceActive: signal.active,
        sourceFingerprint,
        sourceRevision: { increment: 1 },
        stateRevision: { increment: 1 },
        occurrences: { increment: 1 },
        lastObservedAt: observedAt(order, now),
        nextActionDueAt,
        resolutionCode: null,
        resolutionNote: null,
        closedAt: null,
        closedByUserId: null,
      },
    });
    if (updated.count !== 1) throw new ConflictException('售后工单来源已并发更新');
    await tx.afterSaleCaseEvent.create({
      data: {
        userId: order.shop.userId,
        caseId: current.id,
        caseRevision: nextStateRevision,
        type: eventType,
        fromStatus: current.status,
        toStatus: nextStatus,
        sourceRevision: nextSourceRevision,
        sourceFingerprint,
        evidence: snapshotEvidence(order, signal),
      },
    });
    const materialized: AfterSaleCase = {
      ...current,
      status: nextStatus,
      priority,
      sourceActive: signal.active,
      sourceFingerprint,
      sourceRevision: nextSourceRevision,
      stateRevision: nextStateRevision,
      occurrences: current.occurrences + 1,
      lastObservedAt: observedAt(order, now),
      nextActionDueAt,
      resolutionCode: null,
      resolutionNote: null,
      closedAt: null,
      closedByUserId: null,
      updatedAt: now,
    };
    await this.syncCaseChildren(tx, materialized, order, nextSourceRevision, true, now);
    return {
      orderId: orderId.toString(),
      caseId: current.id.toString(),
      change: eventType === 'reopened' ? 'reopened' : 'updated',
    };
  }

  async exceptionSignals(userId: bigint, now = new Date(), afterCaseId?: string) {
    const cursor = afterCaseId ? positiveCursor(afterCaseId, '工单游标') : null;
    const rows = await this.prisma.afterSaleCase.findMany({
      where: {
        ...this.caseScope(userId),
        status: { not: 'closed' },
        ...(cursor === null ? {} : { id: { gt: cursor } }),
      },
      include: CASE_VIEW_INCLUDE,
      orderBy: { id: 'asc' },
      take: MAX_REFRESH_ORDERS + 1,
    });
    const hasMore = rows.length > MAX_REFRESH_ORDERS;
    const page = rows.slice(0, MAX_REFRESH_ORDERS);
    const items = page.flatMap((row) => {
      const graph = row as CaseViewGraph;
      const overdue = graph.nextActionDueAt.getTime() < now.getTime();
      const blockers = closureBlockers(graph, now);
      const signals: AfterSaleExceptionSignal[] = [];
      if (overdue) {
        signals.push(
          exceptionSignal(graph, 'after_sale_case_overdue', '售后工单已超过处理时限', true),
        );
      }
      for (const blocker of blockers) {
        signals.push(
          exceptionSignal(
            graph,
            'after_sale_case_blocked',
            blocker.detail ? `${blocker.label}：${blocker.detail}` : blocker.label,
            overdue,
            `${blocker.code}:${blocker.purchaseOrderId ?? 'case'}`,
          ),
        );
      }
      return signals;
    });
    return {
      items,
      hasMore,
      nextCursor: hasMore && page.length ? page[page.length - 1]!.id.toString() : null,
    };
  }

  async claim(userId: bigint, idValue: string, dto: AfterSaleCaseCommandDto) {
    const id = positiveId(idValue, '售后工单');
    const note = commandNote(dto.note);
    const requestFingerprint = commandFingerprint({
      command: 'claim',
      caseId: idValue,
      expectedRevision: dto.expectedRevision,
      note,
    });
    await this.serializable(async (tx) => {
      if (
        await this.replayCommand(tx, userId, id, dto.clientRequestId, requestFingerprint, [
          'claimed',
        ])
      )
        return;
      const current = await tx.afterSaleCase.findFirst({
        where: { id, ...this.caseScope(userId) },
      });
      if (!current) throw new NotFoundException('售后工单不存在');
      if (current.status === 'closed') throw new ConflictException('售后工单已关闭');
      assertRevision(current.stateRevision, dto.expectedRevision);
      const nextRevision = current.stateRevision + 1;
      const updated = await tx.afterSaleCase.updateMany({
        where: {
          id,
          ...this.caseScope(userId),
          stateRevision: dto.expectedRevision,
          status: { not: 'closed' },
        },
        data: {
          status: 'handling',
          waitingOn: 'merchant',
          assigneeUserId: userId,
          stateRevision: { increment: 1 },
        },
      });
      if (updated.count !== 1) throw new ConflictException('售后工单已更新，请刷新后重试');
      await tx.afterSaleCaseEvent.create({
        data: {
          userId,
          caseId: id,
          caseRevision: nextRevision,
          type: 'claimed',
          clientRequestId: dto.clientRequestId,
          requestFingerprint,
          actorUserId: userId,
          note,
          fromStatus: current.status,
          toStatus: 'handling',
          sourceRevision: current.sourceRevision,
          sourceFingerprint: current.sourceFingerprint,
        },
      });
    });
    return this.detail(userId, idValue);
  }

  async startPurchaseAction(
    userId: bigint,
    caseIdValue: string,
    linkIdValue: string,
    dto: StartAfterSalePurchaseActionDto,
  ) {
    const caseId = positiveId(caseIdValue, '售后工单');
    const linkId = positiveId(linkIdValue, '采购关联');
    const note = commandNote(dto.note);
    const remoteReferenceId = requiredText(dto.remoteReferenceId, 128, '外部处理编号');
    const requestFingerprint = commandFingerprint({
      command: 'start_purchase_action',
      caseId: caseIdValue,
      linkId: linkIdValue,
      expectedRevision: dto.expectedRevision,
      expectedPurchaseExceptionRevision: dto.expectedPurchaseExceptionRevision,
      expectedPurchaseSyncRevision: dto.expectedPurchaseSyncRevision,
      action: dto.action,
      remoteReferenceType: dto.remoteReferenceType,
      remoteReferenceId,
      note,
    });
    await this.serializable(async (tx) => {
      if (
        await this.replayCommand(tx, userId, caseId, dto.clientRequestId, requestFingerprint, [
          'action_started',
        ])
      )
        return;
      const link = await tx.afterSalePurchaseLink.findFirst({
        where: { id: linkId, caseId, ...this.purchaseLinkScope(userId) },
        include: { case: true, purchaseOrder: true },
      });
      if (!link) throw new NotFoundException('售后采购关联不存在');
      if (link.case.status === 'closed') throw new ConflictException('售后工单已关闭');
      assertRevision(link.case.stateRevision, dto.expectedRevision);
      assertPurchaseRevisions(link.purchaseOrder, dto);
      if (
        link.boundSourceRevision !== link.case.sourceRevision ||
        link.purchaseFingerprint !== purchaseFingerprint(link.purchaseOrder) ||
        link.expectedPurchaseExceptionRevision !== dto.expectedPurchaseExceptionRevision ||
        link.expectedPurchaseSyncRevision !== dto.expectedPurchaseSyncRevision
      ) {
        throw new ConflictException('采购关联已更新，请刷新后重试');
      }
      if (!['action_required', 'failed'].includes(link.status)) {
        throw new ConflictException('当前采购关联不能重复发起人工动作');
      }
      const startedAt = new Date();
      const linkUpdated = await tx.afterSalePurchaseLink.updateMany({
        where: {
          id: linkId,
          caseId,
          ...this.purchaseLinkScope(userId),
          status: { in: ['action_required', 'failed'] },
          purchaseFingerprint: link.purchaseFingerprint,
          boundSourceRevision: link.case.sourceRevision,
          expectedPurchaseExceptionRevision: dto.expectedPurchaseExceptionRevision,
          expectedPurchaseSyncRevision: dto.expectedPurchaseSyncRevision,
        },
        data: {
          status: 'waiting_external',
          action: dto.action,
          result: null,
          remoteReferenceType: dto.remoteReferenceType,
          remoteReferenceId,
          startedAt,
          confirmedAt: null,
          confirmedByUserId: null,
        },
      });
      const caseUpdated = await tx.afterSaleCase.updateMany({
        where: {
          id: caseId,
          ...this.caseScope(userId),
          stateRevision: dto.expectedRevision,
          status: { not: 'closed' },
        },
        data: {
          status: 'waiting_external',
          waitingOn: 'supplier',
          assigneeUserId: userId,
          stateRevision: { increment: 1 },
        },
      });
      if (linkUpdated.count !== 1 || caseUpdated.count !== 1) {
        throw new ConflictException('售后工单或采购关联已更新，请刷新后重试');
      }
      await tx.afterSaleCaseEvent.create({
        data: {
          userId,
          caseId,
          caseRevision: link.case.stateRevision + 1,
          type: 'action_started',
          clientRequestId: dto.clientRequestId,
          requestFingerprint,
          actorUserId: userId,
          note,
          fromStatus: link.case.status,
          toStatus: 'waiting_external',
          sourceRevision: link.case.sourceRevision,
          sourceFingerprint: link.case.sourceFingerprint,
          evidence: {
            items: [
              { type: 'manual_action', label: '已记录人工外部动作', value: dto.action },
              {
                type: 'remote_reference',
                label: '外部处理编号',
                value: remoteReferenceId,
              },
            ],
            purchaseOrderId: link.purchaseOrderId.toString(),
            orderId1688: link.purchaseOrder.orderId1688,
            purchaseExceptionRevision: dto.expectedPurchaseExceptionRevision,
            purchaseSyncRevision: dto.expectedPurchaseSyncRevision,
          },
        },
      });
    });
    return this.detail(userId, caseIdValue);
  }

  async confirmPurchaseAction(
    userId: bigint,
    caseIdValue: string,
    linkIdValue: string,
    dto: ConfirmAfterSalePurchaseActionDto,
  ) {
    const caseId = positiveId(caseIdValue, '售后工单');
    const linkId = positiveId(linkIdValue, '采购关联');
    const note = commandNote(dto.note);
    const remoteReferenceId = dto.remoteReferenceId?.trim() || undefined;
    if ((dto.remoteReferenceType === undefined) !== (remoteReferenceId === undefined)) {
      throw new BadRequestException('外部处理类型与编号必须同时提供');
    }
    const requestFingerprint = commandFingerprint({
      command: 'confirm_purchase_action',
      caseId: caseIdValue,
      linkId: linkIdValue,
      expectedRevision: dto.expectedRevision,
      expectedPurchaseExceptionRevision: dto.expectedPurchaseExceptionRevision,
      expectedPurchaseSyncRevision: dto.expectedPurchaseSyncRevision,
      result: dto.result,
      remoteReferenceType: dto.remoteReferenceType ?? null,
      remoteReferenceId: remoteReferenceId ?? null,
      note,
      evidence: dto.evidence ?? null,
    });
    await this.serializable(async (tx) => {
      if (
        await this.replayCommand(tx, userId, caseId, dto.clientRequestId, requestFingerprint, [
          'action_confirmed',
        ])
      )
        return;
      const link = await tx.afterSalePurchaseLink.findFirst({
        where: { id: linkId, caseId, ...this.purchaseLinkScope(userId) },
        include: { case: true, purchaseOrder: true },
      });
      if (!link) throw new NotFoundException('售后采购关联不存在');
      if (link.case.status === 'closed') throw new ConflictException('售后工单已关闭');
      assertRevision(link.case.stateRevision, dto.expectedRevision);
      assertPurchaseRevisions(link.purchaseOrder, dto);
      if (
        link.status !== 'waiting_external' ||
        link.boundSourceRevision !== link.case.sourceRevision ||
        link.purchaseFingerprint !== purchaseFingerprint(link.purchaseOrder) ||
        link.expectedPurchaseExceptionRevision !== dto.expectedPurchaseExceptionRevision ||
        link.expectedPurchaseSyncRevision !== dto.expectedPurchaseSyncRevision
      ) {
        throw new ConflictException('采购状态已变化，请刷新后重试');
      }
      const confirmedAt = new Date();
      const linkUpdated = await tx.afterSalePurchaseLink.updateMany({
        where: {
          id: linkId,
          caseId,
          ...this.purchaseLinkScope(userId),
          status: 'waiting_external',
          purchaseFingerprint: link.purchaseFingerprint,
          boundSourceRevision: link.case.sourceRevision,
          expectedPurchaseExceptionRevision: dto.expectedPurchaseExceptionRevision,
          expectedPurchaseSyncRevision: dto.expectedPurchaseSyncRevision,
        },
        data: {
          status: dto.result === 'confirmed' ? 'confirmed' : 'failed',
          result: dto.result,
          ...(dto.remoteReferenceType
            ? { remoteReferenceType: dto.remoteReferenceType as AfterSaleRemoteReferenceType }
            : {}),
          ...(remoteReferenceId ? { remoteReferenceId } : {}),
          confirmedAt,
          confirmedByUserId: userId,
        },
      });
      const otherUnresolved = await tx.afterSalePurchaseLink.count({
        where: {
          ...this.purchaseLinkScope(userId),
          caseId,
          id: { not: linkId },
          status: { notIn: ['not_required', 'confirmed'] },
        },
      });
      const nextStatus: AfterSaleCaseStatus =
        dto.result === 'confirmed' && otherUnresolved === 0 ? 'verifying' : 'handling';
      const caseUpdated = await tx.afterSaleCase.updateMany({
        where: {
          id: caseId,
          ...this.caseScope(userId),
          stateRevision: dto.expectedRevision,
          status: { not: 'closed' },
        },
        data: {
          status: nextStatus,
          waitingOn: nextStatus === 'verifying' ? 'system' : 'merchant',
          assigneeUserId: userId,
          stateRevision: { increment: 1 },
        },
      });
      if (linkUpdated.count !== 1 || caseUpdated.count !== 1) {
        throw new ConflictException('售后工单或采购关联已更新，请刷新后重试');
      }
      await tx.afterSaleCaseEvent.create({
        data: {
          userId,
          caseId,
          caseRevision: link.case.stateRevision + 1,
          type: 'action_confirmed',
          clientRequestId: dto.clientRequestId,
          requestFingerprint,
          actorUserId: userId,
          note,
          fromStatus: link.case.status,
          toStatus: nextStatus,
          sourceRevision: link.case.sourceRevision,
          sourceFingerprint: link.case.sourceFingerprint,
          evidence: {
            items: [
              {
                type: 'manual_result',
                label: '人工确认外部处理结果',
                value: dto.result,
              },
              ...(remoteReferenceId
                ? [
                    {
                      type: 'remote_reference',
                      label: '外部处理编号',
                      value: remoteReferenceId,
                    },
                  ]
                : []),
            ],
            purchaseOrderId: link.purchaseOrderId.toString(),
            orderId1688: link.purchaseOrder.orderId1688,
            purchaseExceptionRevision: dto.expectedPurchaseExceptionRevision,
            purchaseSyncRevision: dto.expectedPurchaseSyncRevision,
            context: safeJson(dto.evidence),
          },
        },
      });
    });
    return this.detail(userId, caseIdValue);
  }

  async verifyClose(
    userId: bigint,
    idValue: string,
    dto: VerifyCloseAfterSaleCaseDto,
    now = new Date(),
  ) {
    const id = positiveId(idValue, '售后工单');
    const note = commandNote(dto.note);
    const requestFingerprint = commandFingerprint({
      command: 'verify_close',
      caseId: idValue,
      expectedRevision: dto.expectedRevision,
      resolutionCode: dto.resolutionCode ?? null,
      note,
    });
    const result = await this.serializable(async (tx) => {
      const replay = await this.replayCommand(
        tx,
        userId,
        id,
        dto.clientRequestId,
        requestFingerprint,
        ['verification_failed', 'closed'],
      );
      if (replay) {
        return replay.type === 'closed'
          ? { closed: true as const }
          : {
              closed: false as const,
              blockers: blockersFromEvidence(replay.evidence),
              currentRevision: replay.caseRevision,
            };
      }
      const current = await tx.afterSaleCase.findFirst({
        where: { id, ...this.caseScope(userId) },
        include: CASE_DETAIL_INCLUDE,
      });
      if (!current) throw new NotFoundException('售后工单不存在');
      if (current.status === 'closed') return { closed: true as const };
      assertRevision(current.stateRevision, dto.expectedRevision);
      const graph = current as CaseViewGraph;
      const blockers = closureBlockers(graph, now);
      const currentFingerprint = fingerprint(sourceSnapshot(graph.order));
      if (currentFingerprint !== graph.sourceFingerprint) {
        blockers.unshift({
          code: 'SALES_SOURCE_CHANGED',
          label: '销售售后来源已变化',
          detail: '请先刷新工单，再按最新售后状态重新处理。',
        });
      }
      if (blockers.length > 0) {
        const updated = await tx.afterSaleCase.updateMany({
          where: {
            id,
            ...this.caseScope(userId),
            stateRevision: dto.expectedRevision,
            status: { not: 'closed' },
          },
          data: { stateRevision: { increment: 1 } },
        });
        if (updated.count !== 1) throw new ConflictException('售后工单已更新，请刷新后重试');
        await tx.afterSaleCaseEvent.create({
          data: {
            userId,
            caseId: id,
            caseRevision: current.stateRevision + 1,
            type: 'verification_failed',
            clientRequestId: dto.clientRequestId,
            requestFingerprint,
            actorUserId: userId,
            note,
            fromStatus: current.status,
            toStatus: current.status,
            sourceRevision: current.sourceRevision,
            sourceFingerprint: current.sourceFingerprint,
            evidence: {
              items: blockers.map((blocker) => ({
                type: blocker.code,
                label: blocker.label,
                ...(blocker.detail ? { value: blocker.detail } : {}),
              })),
              blockers: blockers as unknown as Prisma.InputJsonValue,
            },
          },
        });
        return {
          closed: false as const,
          blockers,
          currentRevision: current.stateRevision + 1,
        };
      }
      const resolutionCode = dto.resolutionCode ?? inferredResolutionCode(graph);
      const updated = await tx.afterSaleCase.updateMany({
        where: {
          id,
          ...this.caseScope(userId),
          stateRevision: dto.expectedRevision,
          status: { not: 'closed' },
        },
        data: {
          status: 'closed',
          waitingOn: 'none',
          sourceActive: false,
          stateRevision: { increment: 1 },
          resolutionCode,
          resolutionNote: note,
          closedAt: now,
          closedByUserId: userId,
        },
      });
      if (updated.count !== 1) throw new ConflictException('售后工单已更新，请刷新后重试');
      await tx.afterSaleCaseEvent.create({
        data: {
          userId,
          caseId: id,
          caseRevision: current.stateRevision + 1,
          type: 'closed',
          clientRequestId: dto.clientRequestId,
          requestFingerprint,
          actorUserId: userId,
          note,
          fromStatus: current.status,
          toStatus: 'closed',
          sourceRevision: current.sourceRevision,
          sourceFingerprint: current.sourceFingerprint,
          evidence: closeEvidence(graph, resolutionCode),
        },
      });
      return { closed: true as const };
    });
    if (!result.closed) {
      throw new ConflictException({
        statusCode: 409,
        code: 'AFTER_SALE_NOT_CLOSABLE',
        message: '售后工单仍有未完成事项',
        blockers: result.blockers,
        currentRevision: result.currentRevision,
      });
    }
    return this.detail(userId, idValue, now);
  }

  private async syncCaseChildren(
    tx: Prisma.TransactionClient,
    current: AfterSaleCase,
    order: MaterializeOrderGraph,
    sourceRevision: number,
    reset: boolean,
    now: Date,
  ): Promise<boolean> {
    const activeItems = order.items.filter(itemHasAfterSaleSignal);
    const storedItems = await tx.afterSaleCaseItem.findMany({ where: { caseId: current.id } });
    const activeIds = new Set(activeItems.map((item) => item.id.toString()));
    let changed = storedItems.some(
      (item) => item.active !== activeIds.has(item.orderItemId.toString()),
    );
    await tx.afterSaleCaseItem.updateMany({
      where: { caseId: current.id, active: true },
      data: { active: false, sourceRevision, lastSeenAt: now },
    });
    for (const item of activeItems) {
      const stored = storedItems.find((candidate) => candidate.orderItemId === item.id);
      if (!stored || !stored.active || stored.sourceRevision !== sourceRevision) changed = true;
      await tx.afterSaleCaseItem.upsert({
        where: { uk_after_sale_case_item: { caseId: current.id, orderItemId: item.id } },
        create: {
          userId: current.userId,
          caseId: current.id,
          orderId: order.id,
          orderItemId: item.id,
          sourceRevision,
          active: true,
          firstSeenAt: now,
          lastSeenAt: now,
        },
        update: { sourceRevision, active: true, lastSeenAt: now },
      });
    }

    const storedLinks = await tx.afterSalePurchaseLink.findMany({
      where: { caseId: current.id },
    });
    for (const purchase of order.purchaseOrders) {
      const stored = storedLinks.find((candidate) => candidate.purchaseOrderId === purchase.id);
      const currentPurchaseFingerprint = purchaseFingerprint(purchase);
      const defaultStatus = purchaseNeedsManualAction(purchase, order)
        ? 'action_required'
        : 'not_required';
      const linkSemanticallyCurrent =
        !reset &&
        stored !== undefined &&
        stored.purchaseFingerprint === currentPurchaseFingerprint &&
        stored.boundSourceRevision === sourceRevision &&
        stored.expectedPurchaseExceptionRevision === purchase.exceptionRevision;
      const nextStatus = linkSemanticallyCurrent ? stored.status : defaultStatus;
      if (
        !stored ||
        stored.status !== nextStatus ||
        stored.purchaseFingerprint !== currentPurchaseFingerprint ||
        stored.boundSourceRevision !== sourceRevision ||
        stored.expectedPurchaseExceptionRevision !== purchase.exceptionRevision
      ) {
        changed = true;
      }
      await tx.afterSalePurchaseLink.upsert({
        where: {
          uk_after_sale_case_purchase: {
            caseId: current.id,
            purchaseOrderId: purchase.id,
          },
        },
        create: {
          userId: current.userId,
          caseId: current.id,
          orderId: order.id,
          purchaseOrderId: purchase.id,
          status: defaultStatus,
          action: 'none',
          purchaseFingerprint: currentPurchaseFingerprint,
          boundSourceRevision: sourceRevision,
          expectedPurchaseExceptionRevision: purchase.exceptionRevision,
          expectedPurchaseSyncRevision: purchase.syncRevision,
        },
        update: {
          status: nextStatus,
          purchaseFingerprint: currentPurchaseFingerprint,
          boundSourceRevision: sourceRevision,
          expectedPurchaseExceptionRevision: purchase.exceptionRevision,
          expectedPurchaseSyncRevision: purchase.syncRevision,
          ...(linkSemanticallyCurrent
            ? {}
            : {
                action: 'none',
                result: null,
                remoteReferenceType: null,
                remoteReferenceId: null,
                startedAt: null,
                confirmedAt: null,
                confirmedByUserId: null,
              }),
        },
      });
    }
    return changed;
  }

  private async replayCommand(
    tx: Prisma.TransactionClient,
    userId: bigint,
    caseId: bigint,
    clientRequestId: string,
    requestFingerprint: string,
    types: AfterSaleCaseEventType[],
  ): Promise<AfterSaleCaseEvent | null> {
    const replay = await tx.afterSaleCaseEvent.findUnique({ where: { clientRequestId } });
    if (!replay) return null;
    const visibleCase = await tx.afterSaleCase.findFirst({
      where: { id: replay.caseId, ...this.caseScope(userId) },
      select: { id: true },
    });
    if (!visibleCase) throw new NotFoundException('售后工单不存在');
    if (
      replay.userId !== userId ||
      replay.caseId !== caseId ||
      replay.requestFingerprint !== requestFingerprint ||
      !types.includes(replay.type)
    ) {
      throw new ConflictException('请求标识已被其他参数使用');
    }
    return replay;
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
        if (!isRetryableTransactionError(error) || attempt === MAX_TRANSACTION_ATTEMPTS) {
          throw error;
        }
      }
    }
    throw lastError;
  }

  private toView(row: CaseViewGraph, now: Date, withEvents = false) {
    const blockers = closureBlockers(row, now);
    const activeItemIds = new Set(
      row.items.filter((item) => item.active).map((item) => item.orderItemId.toString()),
    );
    const nextAction = blockers[0]?.label ?? statusNextAction(row.status);
    return {
      id: row.id.toString(),
      status: row.status,
      waitingOn: row.waitingOn,
      priority: row.priority,
      sourceRevision: row.sourceRevision,
      stateRevision: row.stateRevision,
      sourceActive: row.sourceActive,
      assigneeUserId: row.assigneeUserId?.toString() ?? null,
      nextAction,
      nextActionDueAt: row.nextActionDueAt.toISOString(),
      overdue: row.status !== 'closed' && row.nextActionDueAt.getTime() < now.getTime(),
      order: {
        id: row.order.id.toString(),
        platformOrderId: row.order.platformOrderId,
        shopName: row.order.shop.shopName,
        platform: row.order.shop.platform,
        status: row.order.status,
        afterSaleStatus: row.order.afterSaleStatus,
        amount: Number(row.order.amount),
      },
      items: row.items
        .filter((item) => item.active)
        .map((item) => ({
          id: item.id.toString(),
          orderItemId: item.orderItemId.toString(),
          platformOrderItemId: item.orderItem.platformOrderItemId,
          title: item.orderItem.title,
          quantity: item.orderItem.quantity,
          afterSaleStatusRaw: item.orderItem.afterSaleStatusRaw,
          afterSaleTypeRaw: item.orderItem.afterSaleTypeRaw,
          refundStatusRaw: item.orderItem.refundStatusRaw,
        })),
      purchaseLinks: row.links.map((link) => ({
        id: link.id.toString(),
        purchaseOrderId: link.purchaseOrderId.toString(),
        purchaseOrderItemId:
          link.purchaseOrder.items
            .find((item) => activeItemIds.has(item.orderItemId.toString()))
            ?.id.toString() ?? null,
        orderId1688: link.purchaseOrder.orderId1688,
        outOrderId: link.purchaseOrder.outOrderId,
        status: link.status,
        exceptionStatus: link.purchaseOrder.exceptionStatus,
        purchaseExceptionRevision: link.purchaseOrder.exceptionRevision,
        purchaseSyncRevision: link.purchaseOrder.syncRevision,
        action: link.action === 'none' ? null : link.action,
        remoteReferenceType: link.remoteReferenceType,
        remoteReferenceId: link.remoteReferenceId,
        result: link.result,
        actionStartedAt: link.startedAt?.toISOString() ?? null,
        actionConfirmedAt: link.confirmedAt?.toISOString() ?? null,
      })),
      closureBlockers: blockers.map(({ code, label, detail, purchaseOrderId }) => ({
        code,
        label,
        detail,
        purchaseOrderId,
      })),
      openedAt: row.firstDetectedAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      closedAt: row.closedAt?.toISOString() ?? null,
      ...(withEvents
        ? {
            events: (row.events ?? []).map((event) => ({
              id: event.id.toString(),
              caseRevision: event.caseRevision,
              stateRevision: event.caseRevision,
              type: event.type,
              actor: event.actorUserId
                ? { type: 'user' as const, userId: event.actorUserId.toString() }
                : { type: 'system' as const },
              note: event.note,
              evidence: evidenceItems(event.evidence),
              fromStatus: event.fromStatus,
              toStatus: event.toStatus,
              createdAt: event.createdAt.toISOString(),
            })),
          }
        : {}),
    };
  }

  private caseScope(userId: bigint): Prisma.AfterSaleCaseWhereInput {
    return {
      userId,
      ...(this.demoMode ? {} : { order: { shop: runtimeShopWhere(this.demoMode) } }),
    };
  }

  private purchaseLinkScope(userId: bigint): Prisma.AfterSalePurchaseLinkWhereInput {
    return {
      userId,
      ...(this.demoMode ? {} : { case: this.caseScope(userId) }),
    };
  }
}

function sourceSnapshot(order: MaterializeOrderGraph) {
  return {
    amount: Number(order.amount).toFixed(2),
    terminalOrderStatus: ['refunded', 'closed'].includes(order.status) ? order.status : null,
    afterSaleStatus: order.afterSaleStatus,
    items: order.items
      .map((item) => ({
        platformOrderItemId: item.platformOrderItemId,
        afterSaleStatus: item.afterSaleStatusRaw,
        afterSaleType: item.afterSaleTypeRaw,
        refundStatus: item.refundStatusRaw,
      }))
      .sort((left, right) => left.platformOrderItemId.localeCompare(right.platformOrderItemId)),
  };
}

function sourceSignal(order: MaterializeOrderGraph): { exists: boolean; active: boolean } {
  const itemSignal = order.items.some(itemHasAfterSaleSignal);
  const terminalRefund = order.status === 'refunded';
  const terminalClosedAfterSale =
    order.status === 'closed' &&
    order.purchaseOrders.some((purchase) => isAfterSalePurchaseException(purchase.exceptionCode));
  const exists =
    order.afterSaleStatus !== 'none' || itemSignal || terminalRefund || terminalClosedAfterSale;
  const active =
    terminalRefund ||
    terminalClosedAfterSale ||
    ['pending', 'partial_refund', 'refunded'].includes(order.afterSaleStatus) ||
    order.items.some(
      (item) =>
        item.refundStatusRaw === 1 ||
        item.refundStatusRaw === 3 ||
        (item.afterSaleStatusRaw !== null &&
          ACTIVE_AFTER_SALE_STATUSES.has(item.afterSaleStatusRaw)),
    );
  return { exists, active };
}

function itemHasAfterSaleSignal(item: {
  afterSaleStatusRaw: number | null;
  afterSaleTypeRaw: number | null;
  refundStatusRaw: number | null;
}): boolean {
  return [item.afterSaleStatusRaw, item.afterSaleTypeRaw, item.refundStatusRaw].some(
    (value) => value !== null && value !== 0,
  );
}

function casePriority(order: MaterializeOrderGraph): ExceptionPriority {
  if (
    order.status === 'refunded' ||
    (order.status === 'closed' &&
      order.purchaseOrders.some((purchase) =>
        isAfterSalePurchaseException(purchase.exceptionCode),
      )) ||
    order.purchaseOrders.some((purchase) => purchaseNeedsManualAction(purchase, order))
  ) {
    return 'critical';
  }
  if (['pending', 'partial_refund'].includes(order.afterSaleStatus)) return 'high';
  return 'medium';
}

function purchaseNeedsManualAction(
  purchase: {
    orderId1688: string | null;
    status: string;
    exceptionStatus: string;
    exceptionCode?: string | null;
  },
  order?: MaterializeOrderGraph,
): boolean {
  const sourceActive = order ? sourceSignal(order).active : true;
  if (!sourceActive && !isAfterSalePurchaseException(purchase.exceptionCode)) return false;
  return (
    (purchase.exceptionStatus === 'action_required' &&
      (sourceActive || isAfterSalePurchaseException(purchase.exceptionCode))) ||
    (sourceActive &&
      (purchase.orderId1688 !== null || !['pending', 'failed'].includes(purchase.status)))
  );
}

function purchaseFingerprint(purchase: {
  orderId1688: string | null;
  status: string;
  exceptionStatus: string;
  exceptionCode?: string | null;
  exceptionRevision: number;
  syncRevision: number;
  reconciledCost: { toString(): string } | number | string | null;
  everShipped: boolean;
}): string {
  return fingerprint({
    orderId1688: purchase.orderId1688,
    status: purchase.status,
    exceptionStatus: purchase.exceptionStatus,
    exceptionCode: purchase.exceptionCode ?? null,
    exceptionRevision: purchase.exceptionRevision,
    reconciledCost: purchase.reconciledCost?.toString() ?? null,
    everShipped: purchase.everShipped,
  });
}

function isAfterSalePurchaseException(code: string | null | undefined): boolean {
  return (
    code === 'sales_order_partial_refund' ||
    code === 'sales_order_refunded' ||
    code === 'sales_order_closed' ||
    code === 'sales_order_after_sale_hold'
  );
}

function slaMs(priority: ExceptionPriority): number {
  if (priority === 'critical') return CRITICAL_SLA_MS;
  if (priority === 'high') return HIGH_SLA_MS;
  return MEDIUM_SLA_MS;
}

function observedAt(order: MaterializeOrderGraph, fallback: Date): Date {
  return order.afterSaleSyncedAt && order.afterSaleSyncedAt <= fallback
    ? order.afterSaleSyncedAt
    : fallback;
}

function snapshotEvidence(
  order: MaterializeOrderGraph,
  signal: { exists: boolean; active: boolean },
): Prisma.InputJsonObject {
  return {
    items: [
      {
        type: 'sales_platform_snapshot',
        label: '销售平台售后快照',
        value: order.platformOrderId,
      },
    ],
    source: sourceSnapshot(order),
    purchaseVersions: order.purchaseOrders.map((purchase) => ({
      purchaseOrderId: purchase.id.toString(),
      orderId1688: purchase.orderId1688,
      status: purchase.status,
      exceptionStatus: purchase.exceptionStatus,
      exceptionRevision: purchase.exceptionRevision,
      syncRevision: purchase.syncRevision,
      reconciledCost: purchase.reconciledCost?.toString() ?? null,
    })),
    sourceExists: signal.exists,
    sourceActive: signal.active,
    observedAt: (order.afterSaleSyncedAt ?? new Date()).toISOString(),
  } as unknown as Prisma.InputJsonObject;
}

function closureBlockers(row: CaseViewGraph, now: Date): AfterSaleClosureBlocker[] {
  if (row.status === 'closed') return [];
  const blockers: AfterSaleClosureBlocker[] = [];
  const syncedAt = row.order.afterSaleSyncedAt;
  if (!syncedAt) {
    blockers.push({
      code: 'SALES_SOURCE_MISSING',
      label: '销售售后状态尚未回读',
      detail: '请先刷新销售平台订单详情。',
    });
  } else if (
    syncedAt.getTime() > now.getTime() ||
    now.getTime() - syncedAt.getTime() > SALES_SOURCE_FRESH_MS
  ) {
    blockers.push({
      code: 'SALES_SOURCE_STALE',
      label: '销售售后状态已过期',
      detail: '关闭前必须取得 5 分钟内的销售平台回读。',
    });
  }
  if (row.order.afterSaleStatus === 'pending') {
    blockers.push({
      code: 'SALES_AFTER_SALE_PENDING',
      label: '销售平台售后仍在处理中',
    });
  }
  const hasRefundedItem = row.order.items.some((item) => item.refundStatusRaw === 3);
  const fullyRefunded = row.order.status === 'refunded' || row.order.afterSaleStatus === 'refunded';
  if (
    row.order.afterSaleStatus === 'partial_refund' &&
    row.order.partialRefundDisposition === 'none'
  ) {
    blockers.push({
      code: 'PARTIAL_REFUND_DECISION_REQUIRED',
      label: '部分退款后的剩余履约方式尚未确认',
    });
  }
  if (hasRefundedItem && !fullyRefunded && row.order.refundAmount === null) {
    blockers.push({
      code: 'REFUND_AMOUNT_REQUIRED',
      label: '实际退款金额尚未核对',
    });
  } else if (
    hasRefundedItem &&
    !fullyRefunded &&
    row.order.refundAmountFingerprint !== row.order.partialRefundFingerprint
  ) {
    blockers.push({
      code: 'REFUND_AMOUNT_STALE',
      label: '退款金额核对依据已失效',
    });
  }
  const linksByPurchase = new Map(row.links.map((link) => [link.purchaseOrderId, link]));
  for (const purchase of row.order.purchaseOrders) {
    if (!purchaseNeedsManualAction(purchase, row.order as MaterializeOrderGraph)) continue;
    const link = linksByPurchase.get(purchase.id);
    if (!link) {
      blockers.push({
        code: 'PURCHASE_LINK_MISSING',
        label: '采购售后关联尚未建立',
        purchaseOrderId: purchase.id.toString(),
      });
      continue;
    }
    if (
      link.status !== 'confirmed' ||
      link.boundSourceRevision !== row.sourceRevision ||
      link.expectedPurchaseExceptionRevision !== purchase.exceptionRevision ||
      link.expectedPurchaseSyncRevision !== purchase.syncRevision
    ) {
      blockers.push({
        code: 'PURCHASE_ACTION_REQUIRED',
        label: '1688 人工处置尚未按当前版本确认',
        detail: purchase.orderId1688 ?? purchase.outOrderId,
        purchaseOrderId: purchase.id.toString(),
      });
    }
    if (
      purchase.everShipped &&
      link.status === 'confirmed' &&
      !['refund', 'return_refund', 'intercept', 'accept_loss'].includes(link.action)
    ) {
      blockers.push({
        code: 'SHIPPED_PURCHASE_DISPOSITION_REQUIRED',
        label: '已发货采购缺少退货、拦截或损失确认',
        purchaseOrderId: purchase.id.toString(),
      });
    }
    const requiresCostReconciliation =
      purchase.exceptionStatus === 'action_required' ||
      (purchase.exceptionStatus === 'resolved' &&
        isAfterSalePurchaseException(purchase.exceptionCode));
    if (purchase.exceptionStatus === 'action_required') {
      blockers.push({
        code: 'PURCHASE_EXCEPTION_UNRESOLVED',
        label: '采购异常尚未核销',
        purchaseOrderId: purchase.id.toString(),
      });
    }
    if (requiresCostReconciliation && purchase.reconciledCost === null) {
      blockers.push({
        code: 'PURCHASE_COST_RECONCILIATION_REQUIRED',
        label: '最终实际采购成本尚未核对',
        purchaseOrderId: purchase.id.toString(),
      });
    }
  }
  return uniqueBlockers(blockers);
}

function uniqueBlockers(blockers: AfterSaleClosureBlocker[]): AfterSaleClosureBlocker[] {
  const seen = new Set<string>();
  return blockers.filter((blocker) => {
    const key = `${blocker.code}:${blocker.purchaseOrderId ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function inferredResolutionCode(row: CaseViewGraph) {
  if (row.order.status === 'closed') return 'order_closed_handled' as const;
  if (row.order.status === 'refunded' || row.order.afterSaleStatus === 'refunded') {
    return 'full_refund_handled' as const;
  }
  if (row.order.afterSaleStatus === 'partial_refund') return 'partial_refund_handled' as const;
  if (row.order.items.some((item) => item.afterSaleTypeRaw === 6 && item.refundStatusRaw === 3)) {
    return 'price_protection_reconciled' as const;
  }
  return 'sales_rejected_or_withdrawn' as const;
}

function closeEvidence(row: CaseViewGraph, resolutionCode: string): Prisma.InputJsonObject {
  return {
    items: [
      {
        type: 'closure_verification',
        label: '关闭条件已按当前销售与采购版本验证',
        value: resolutionCode,
      },
    ],
    salesSourceRevision: row.sourceRevision,
    salesSourceFingerprint: row.sourceFingerprint,
    purchaseVersions: row.links.map((link) => ({
      purchaseOrderId: link.purchaseOrderId.toString(),
      purchaseExceptionRevision: link.purchaseOrder.exceptionRevision,
      purchaseSyncRevision: link.purchaseOrder.syncRevision,
      reconciledCost: link.purchaseOrder.reconciledCost?.toString() ?? null,
      linkStatus: link.status,
    })),
  } as unknown as Prisma.InputJsonObject;
}

function exceptionSignal(
  row: CaseViewGraph,
  code: AfterSaleExceptionSignal['code'],
  reason: string,
  overdue: boolean,
  suffix: string = code,
): AfterSaleExceptionSignal {
  return {
    dedupeKey: `scanner:after_sale_case:${row.id}:${suffix}`,
    code,
    caseId: row.id.toString(),
    priority: overdue ? 'critical' : row.priority,
    sourceFingerprint: fingerprint({
      caseId: row.id,
      sourceRevision: row.sourceRevision,
      stateRevision: row.stateRevision,
      sourceFingerprint: row.sourceFingerprint,
      code,
      suffix,
      reason,
    }),
    subjectLabel: `销售订单 ${row.order.platformOrderId}`,
    reason,
    nextAction: '打开售后工单，按当前销售与采购版本完成处置。',
    actionHref: '/after-sales',
    overdue,
  };
}

function statusNextAction(status: AfterSaleCaseStatus): string {
  if (status === 'closed') return '工单已关闭';
  if (status === 'waiting_external') return '等待外部平台处理结果';
  if (status === 'verifying') return '验证销售、采购与成本关闭条件';
  if (status === 'handling') return '继续处理售后工单';
  return '认领并开始处理售后工单';
}

function assertPurchaseRevisions(
  purchase: { exceptionRevision: number; syncRevision: number },
  dto: { expectedPurchaseExceptionRevision: number; expectedPurchaseSyncRevision: number },
) {
  if (
    purchase.exceptionRevision !== dto.expectedPurchaseExceptionRevision ||
    purchase.syncRevision !== dto.expectedPurchaseSyncRevision
  ) {
    throw new ConflictException('采购状态已变化，请刷新后重试');
  }
}

function assertRevision(current: number, expected: number) {
  if (!Number.isSafeInteger(expected) || expected < 1 || current !== expected) {
    throw new ConflictException('售后工单已更新，请刷新后重试');
  }
}

function positiveId(value: string, label: string): bigint {
  try {
    const id = BigInt(value);
    if (id <= 0n) throw new Error('invalid');
    return id;
  } catch {
    throw new NotFoundException(`${label}不存在`);
  }
}

function positiveCursor(value: string, label: string): bigint {
  try {
    const id = BigInt(value);
    if (id <= 0n) throw new Error('invalid');
    return id;
  } catch {
    throw new BadRequestException(`${label}无效`);
  }
}

function commandNote(value: string): string {
  const note = value.trim();
  if (note.length < 2 || note.length > 500) {
    throw new BadRequestException('处理说明需为 2～500 个字符');
  }
  return note;
}

function requiredText(value: string, max: number, label: string): string {
  const result = value.trim().slice(0, max);
  if (!result) throw new BadRequestException(`${label}不能为空`);
  return result;
}

function commandFingerprint(value: unknown): string {
  return fingerprint(value);
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

function safeJson(value: unknown, depth = 0): Prisma.InputJsonValue | null {
  if (value === undefined || value === null || depth > 5) return null;
  if (typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => safeJson(item, depth + 1));
  if (typeof value === 'object') {
    const result: Record<string, Prisma.InputJsonValue | null> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 50)) {
      result[key.slice(0, 100)] = /authorization|cookie|password|secret|token|api.?key/i.test(key)
        ? '[redacted]'
        : safeJson(item, depth + 1);
    }
    return result;
  }
  return String(value).slice(0, 500);
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

function blockersFromEvidence(value: Prisma.JsonValue | null): AfterSaleClosureBlocker[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const blockers = (value as Record<string, Prisma.JsonValue>).blockers;
  if (!Array.isArray(blockers)) return [];
  return blockers.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const row = item as Record<string, Prisma.JsonValue>;
    if (typeof row.code !== 'string' || typeof row.label !== 'string') return [];
    return [
      {
        code: row.code,
        label: row.label,
        ...(typeof row.detail === 'string' ? { detail: row.detail } : {}),
        ...(typeof row.purchaseOrderId === 'string'
          ? { purchaseOrderId: row.purchaseOrderId }
          : {}),
      },
    ];
  });
}

function isRetryableTransactionError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'P2002' || code === 'P2034';
}
