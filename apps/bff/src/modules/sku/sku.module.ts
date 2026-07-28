import { Module } from '@nestjs/common';
import { SkuMappingController } from './sku-mapping.controller';
import { SkuMappingService } from './sku-mapping.service';

@Module({
  controllers: [SkuMappingController],
  providers: [SkuMappingService],
  exports: [SkuMappingService],
})
export class SkuModule {}
