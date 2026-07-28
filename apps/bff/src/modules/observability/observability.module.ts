import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AlertService } from './alert.service';
import { AuditController } from './audit.controller';
import { AuditInterceptor } from './audit.interceptor';
import { AuditRetentionService } from './audit-retention.service';
import { AuditService } from './audit.service';
import { OperationalMonitorService } from './operational-monitor.service';
import { OperationsController } from './operations.controller';
import { OperationsTokenGuard } from './operations.guard';
import { OperationsService } from './operations.service';
import { RuntimeMetricsService } from './runtime-metrics.service';

@Global()
@Module({
  controllers: [AuditController, OperationsController],
  providers: [
    AuditService,
    AuditRetentionService,
    AlertService,
    RuntimeMetricsService,
    OperationalMonitorService,
    OperationsTokenGuard,
    OperationsService,
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
  exports: [AuditService, AlertService, RuntimeMetricsService, OperationalMonitorService],
})
export class ObservabilityModule {}
