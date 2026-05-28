import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { PrismaModule } from './common/prisma.module';
import { RedisModule } from './common/redis.module';
import { HealthController } from './modules/health/health.controller';
import { ProductModule } from './modules/product/product.module';
import { PublishModule } from './modules/publish/publish.module';
import { AiModule } from './modules/ai/ai.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
    PrismaModule,
    RedisModule,
    ProductModule,
    PublishModule,
    AiModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
