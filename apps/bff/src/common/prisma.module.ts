import { Global, Logger, Module, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@supplier/db';

export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Prisma');
  private connected = false;
  private reconnecting: Promise<void> | null = null;

  constructor(config: ConfigService) {
    super({
      datasources: {
        db: {
          url: config.get<string>('DATABASE_URL') ?? 'mysql://root:root@localhost:3306/supplier',
        },
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
    await this.$disconnect().catch((err: Error) => {
      this.logger.warn(`Database disconnect failed: ${err.message}`);
    });
    this.connected = false;
  }

  async reconnect(): Promise<void> {
    if (this.reconnecting) return this.reconnecting;
    this.reconnecting = (async () => {
      this.connected = false;
      await this.$disconnect().catch(() => undefined);
      await this.$connect();
      this.connected = true;
      this.logger.log('Database reconnected');
    })().finally(() => {
      this.reconnecting = null;
    });
    return this.reconnecting;
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
