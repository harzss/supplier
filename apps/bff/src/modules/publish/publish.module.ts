import { Module } from '@nestjs/common';
import { PublishController } from './publish.controller';
import { PublishService } from './publish.service';
import { AiModule } from '../ai/ai.module';
import { ShopModule } from '../shop/shop.module';
import { AssetStorageService } from './asset-storage.service';
import { DetailImageRenderer } from './detail-image-renderer.service';
import { ImagePipelineService } from './image-pipeline.service';
import { MediaController } from './media.controller';
import { PublishQueueService } from './publish-queue.service';
import { PublishQueueWorker } from './publish-queue.worker';
import { InventorySyncController } from './inventory-sync.controller';
import { InventorySyncService } from './inventory-sync.service';
import { InventorySyncWorker } from './inventory-sync.worker';
import { CategoryModule } from '../category/category.module';
import { PublishedProductController } from './published-product.controller';
import { PlatformProductLockService } from './platform-product-lock.service';
import { PricingPreviewReceiptService } from './pricing-preview-receipt.service';
import { PublishDraftController } from './publish-draft.controller';
import { PublishDraftService } from './publish-draft.service';
import { ProductBatchController } from './product-batch.controller';
import { ProductBatchService } from './product-batch.service';
import { ProductBatchWorker } from './product-batch.worker';

@Module({
  imports: [AiModule, ShopModule, CategoryModule],
  controllers: [
    PublishController,
    PublishDraftController,
    PublishedProductController,
    MediaController,
    InventorySyncController,
    ProductBatchController,
  ],
  providers: [
    PublishService,
    PublishQueueService,
    PublishQueueWorker,
    AssetStorageService,
    DetailImageRenderer,
    ImagePipelineService,
    InventorySyncService,
    InventorySyncWorker,
    PlatformProductLockService,
    PricingPreviewReceiptService,
    PublishDraftService,
    ProductBatchService,
    ProductBatchWorker,
  ],
  exports: [PublishService],
})
export class PublishModule {}
