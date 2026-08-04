import { Global, Module } from '@nestjs/common';
import { ExceptionCenterController } from './exception-center.controller';
import { ExceptionCenterService } from './exception-center.service';
import { ExceptionCenterWorker } from './exception-center.worker';

@Global()
@Module({
  controllers: [ExceptionCenterController],
  providers: [ExceptionCenterService, ExceptionCenterWorker],
  exports: [ExceptionCenterService],
})
export class ExceptionCenterModule {}
