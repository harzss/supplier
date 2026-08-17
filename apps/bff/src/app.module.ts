import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { PrismaModule } from './common/prisma.module';
import { RuntimeStateModule } from './common/runtime-state.module';
import { RuntimeStateService } from './common/runtime-state.service';
import {
  skipReadOnlyThrottle,
  SupabaseThrottlerStorage,
} from './common/supabase-throttler-storage';
import { CryptoModule } from './common/crypto.module';
import { HealthModule } from './modules/health/health.module';
import { ProductModule } from './modules/product/product.module';
import { PublishModule } from './modules/publish/publish.module';
import { AiModule } from './modules/ai/ai.module';
import { EntitlementModule } from './modules/entitlement/entitlement.module';
import { SettingsModule } from './modules/settings/settings.module';
import { ShopModule } from './modules/shop/shop.module';
import { OrderModule } from './modules/order/order.module';
import { CategoryModule } from './modules/category/category.module';
import { SkuModule } from './modules/sku/sku.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { FavoriteModule } from './modules/favorite/favorite.module';
import { validateEnvironment } from './config/environment';
import { ObservabilityModule } from './modules/observability/observability.module';
import { ActivationModule } from './modules/activation/activation.module';
import { SourceImportModule } from './modules/product/source-import.module';
import { ExceptionCenterModule } from './modules/exception-center/exception-center.module';
import { AfterSaleModule } from './modules/after-sale/after-sale.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnvironment }),
    ThrottlerModule.forRootAsync({
      imports: [RuntimeStateModule],
      inject: [RuntimeStateService],
      useFactory: (runtimeState: RuntimeStateService) => ({
        skipIf: skipReadOnlyThrottle,
        storage: new SupabaseThrottlerStorage(runtimeState),
        throttlers: [{ ttl: 60_000, limit: 120, blockDuration: 60_000 }],
      }),
    }),
    PrismaModule,
    RuntimeStateModule,
    CryptoModule,
    ObservabilityModule,
    AfterSaleModule,
    ExceptionCenterModule,
    HealthModule,
    EntitlementModule,
    SettingsModule,
    ShopModule,
    ProductModule,
    SourceImportModule,
    PublishModule,
    OrderModule,
    CategoryModule,
    SkuModule,
    AnalyticsModule,
    FavoriteModule,
    ActivationModule,
    AiModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
