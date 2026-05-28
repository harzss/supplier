import { Global, Logger, Module, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@supplier/db';

export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Prisma');
  private connected = false;

  constructor(config: ConfigService) {
    super({
      datasources: {
        db: { url: config.get<string>('DATABASE_URL') ?? 'mysql://root:root@localhost:3306/supplier' },
      },
      log: [{ emit: 'event', level: 'error' }],
    });
  }

  async onModuleInit() {
    try {
      await this.$connect();
      this.connected = true;
      this.logger.log('Database connected');
    } catch (err) {
      // 数据库未启动时不阻塞应用启动；查询时再报错
      this.logger.warn(`Database unavailable at startup: ${(err as Error).message}`);
    }
  }

  async onModuleDestroy() {
    if (this.connected) await this.$disconnect();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: PrismaService,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => new PrismaService(config),
    },
  ],
  exports: [PrismaService],
})
export class PrismaModule {}
