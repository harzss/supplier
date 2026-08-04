import { Global, Module } from '@nestjs/common';
import { AfterSaleController } from './after-sale.controller';
import { AfterSaleService } from './after-sale.service';

@Global()
@Module({
  controllers: [AfterSaleController],
  providers: [AfterSaleService],
  exports: [AfterSaleService],
})
export class AfterSaleModule {}
