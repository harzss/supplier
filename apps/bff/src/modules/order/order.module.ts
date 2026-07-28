import { Module } from '@nestjs/common';
import { FulfillmentService } from './fulfillment.service';
import { OrderController } from './order.controller';
import { OrderService } from './order.service';
import { ShopModule } from '../shop/shop.module';
import { OrderSyncService } from './order-sync.service';
import { Alibaba1688PurchaseService } from './alibaba1688-purchase.service';
import { OrderSyncWorker } from './order-sync.worker';
import { Alibaba1688PurchaseAuditWorker } from './alibaba1688-purchase-audit.worker';
import { OrderLogisticsRepairService } from './order-logistics-repair.service';

@Module({
  imports: [ShopModule],
  controllers: [OrderController],
  providers: [
    OrderService,
    OrderSyncService,
    OrderSyncWorker,
    Alibaba1688PurchaseAuditWorker,
    Alibaba1688PurchaseService,
    OrderLogisticsRepairService,
    FulfillmentService,
  ],
  exports: [OrderService],
})
export class OrderModule {}
