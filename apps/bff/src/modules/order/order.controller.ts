import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../entitlement/current-user.decorator';
import type { CurrentUser as CurrentUserType } from '../entitlement/user-context.service';
import { SimulateOrderDto } from './dto/simulate-order.dto';
import { FulfillmentService } from './fulfillment.service';
import { OrderService } from './order.service';
import { OrderSyncService } from './order-sync.service';
import { AuditAction } from '../observability/audit.decorator';
import { ConfirmRefundAmountDto } from './dto/confirm-refund-amount.dto';
import { OrderListQueryDto } from './dto/order-list-query.dto';
import { OrderReconciliationQueryDto } from './dto/order-reconciliation-query.dto';
import { ResolvePurchaseExceptionDto } from './dto/resolve-purchase-exception.dto';
import { ResumePurchaseDto } from './dto/resume-purchase.dto';
import { ResolvePartialRefundDto } from './dto/resolve-partial-refund.dto';
import { OrderLogisticsRepairService } from './order-logistics-repair.service';

@ApiTags('orders')
@Controller('orders')
export class OrderController {
  constructor(
    private readonly orders: OrderService,
    private readonly fulfillment: FulfillmentService,
    private readonly orderSync: OrderSyncService,
    private readonly logisticsRepairs: OrderLogisticsRepairService,
  ) {}

  /** 订单列表（脱敏） */
  @Get()
  list(@CurrentUser() user: CurrentUserType, @Query() query: OrderListQueryDto) {
    return this.orders.list(user, query.page, query.pageSize, query.shopId, query.status);
  }

  /** 当前用户全部财务待办，独立完整分页 */
  @Get('reconciliations')
  reconciliations(
    @CurrentUser() user: CurrentUserType,
    @Query() query: OrderReconciliationQueryDto,
  ) {
    return this.orders.listFinancialReconciliations(user, query.page, query.pageSize);
  }

  /** 模拟一笔买家订单（演示用） */
  @Post('simulate')
  simulate(@CurrentUser() user: CurrentUserType, @Body() dto: SimulateOrderDto) {
    return this.orders.simulate(user, dto.publishedProductId);
  }

  /** 从指定店铺按同步水位全分页拉取更新订单并幂等入库 */
  @AuditAction('order.sync', 'shop')
  @Post('sync/:shopId')
  sync(@CurrentUser() user: CurrentUserType, @Param('shopId') shopId: string) {
    return this.orderSync.sync(user, shopId);
  }

  /** 一键代发：向 1688 下单并回传物流 */
  @Post(':id/fulfill')
  fulfill(@CurrentUser() user: CurrentUserType, @Param('id') id: string) {
    return this.fulfillment.fulfill(user, id);
  }

  /** 确认部分退款后仅履约未退款子单，或停止整单自动履约 */
  @AuditAction('order.partial_refund.resolve', 'order')
  @Post(':id/resolve-partial-refund')
  resolvePartialRefund(
    @CurrentUser() user: CurrentUserType,
    @Param('id') id: string,
    @Body() dto: ResolvePartialRefundDto,
  ) {
    return this.fulfillment.resolvePartialRefund(user, id, dto.action, dto.note);
  }

  /** 核对平台未提供的累计实际退款金额，并绑定当前售后状态指纹 */
  @AuditAction('order.refund_amount.confirm', 'order')
  @Post(':id/confirm-refund-amount')
  confirmRefundAmount(
    @CurrentUser() user: CurrentUserType,
    @Param('id') id: string,
    @Body() dto: ConfirmRefundAmountDto,
  ) {
    return this.orders.confirmRefundAmount(user, id, dto.amount, dto.note);
  }

  /** 确认已在 1688 完成取消、退款或物流拦截等人工处置 */
  @AuditAction('order.purchase_exception.resolve', 'order')
  @Post(':orderId/purchases/:purchaseOrderId/resolve-exception')
  resolvePurchaseException(
    @CurrentUser() user: CurrentUserType,
    @Param('orderId') orderId: string,
    @Param('purchaseOrderId') purchaseOrderId: string,
    @Body() dto: ResolvePurchaseExceptionDto,
  ) {
    return this.orders.resolvePurchaseException(
      user,
      orderId,
      purchaseOrderId,
      dto.actualCost,
      dto.expectedRevision,
      dto.note,
    );
  }

  /** 归档已取消的 1688 尝试，核销本次成本并生成新的幂等采购单号 */
  @AuditAction('order.purchase.retry', 'order')
  @Post(':orderId/purchases/:purchaseOrderId/retry')
  retryFailedPurchase(
    @CurrentUser() user: CurrentUserType,
    @Param('orderId') orderId: string,
    @Param('purchaseOrderId') purchaseOrderId: string,
    @Body() dto: ResolvePurchaseExceptionDto,
  ) {
    return this.orders.retryFailedPurchase(
      user,
      orderId,
      purchaseOrderId,
      dto.actualCost,
      dto.expectedRevision,
      dto.note,
    );
  }

  /** 运营已在 1688 处理发货后异常，清除旧包裹并重新开放同一远端单校验 */
  @AuditAction('order.purchase.resume_logistics', 'order')
  @Post(':orderId/purchases/:purchaseOrderId/resume-logistics')
  resumePurchaseLogistics(
    @CurrentUser() user: CurrentUserType,
    @Param('orderId') orderId: string,
    @Param('purchaseOrderId') purchaseOrderId: string,
    @Body() dto: ResumePurchaseDto,
  ) {
    return this.orders.resumePurchaseLogistics(
      user,
      orderId,
      purchaseOrderId,
      dto.expectedRevision,
      dto.note,
    );
  }

  /** 读取 1688 新包裹，幂等更新抖店已发货物流，回读确认后替换本地快照 */
  @AuditAction('order.purchase.repair_settled_logistics', 'order')
  @Post(':orderId/purchases/:purchaseOrderId/repair-settled-logistics')
  repairSettledLogistics(
    @CurrentUser() user: CurrentUserType,
    @Param('orderId') orderId: string,
    @Param('purchaseOrderId') purchaseOrderId: string,
    @Body() dto: ResolvePurchaseExceptionDto,
  ) {
    return this.logisticsRepairs.repair(
      user,
      orderId,
      purchaseOrderId,
      dto.actualCost,
      dto.expectedRevision,
      dto.note,
    );
  }
}
