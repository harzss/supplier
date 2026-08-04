import { Module } from '@nestjs/common';
import { ShopModule } from '../shop/shop.module';
import {
  CollectedSourceProductController,
  SourceImportController,
} from './source-import.controller';
import {
  SourceImportAdapterFactory,
  SourceImportRateLimiter,
} from './source-import-adapter.service';
import { SourceImportService } from './source-import.service';
import { SourceImportWorker } from './source-import.worker';

@Module({
  imports: [ShopModule],
  controllers: [SourceImportController, CollectedSourceProductController],
  providers: [
    SourceImportAdapterFactory,
    SourceImportRateLimiter,
    SourceImportService,
    SourceImportWorker,
  ],
  exports: [SourceImportService],
})
export class SourceImportModule {}
