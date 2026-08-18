import { Module } from '@nestjs/common';
import { MarketplaceEventInboxService } from './marketplace-event-inbox.service';
import { MarketplaceEventProcessingWorker } from './marketplace-event-processing.worker';
import { MarketplaceSubscriptionProjectionService } from './marketplace-subscription-projection.service';

@Module({
  providers: [
    MarketplaceEventInboxService,
    MarketplaceSubscriptionProjectionService,
    MarketplaceEventProcessingWorker,
  ],
  exports: [MarketplaceEventInboxService, MarketplaceSubscriptionProjectionService],
})
export class MarketplaceModule {}
