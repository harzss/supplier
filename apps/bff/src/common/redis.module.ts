import { Global, Logger, Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

const redisProvider: Provider = {
  provide: REDIS_CLIENT,
  inject: [ConfigService],
  useFactory: (config: ConfigService) => {
    const logger = new Logger('Redis');
    const url = config.get<string>('REDIS_URL') ?? 'redis://localhost:6379';
    const client = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      retryStrategy: (times) => {
        // 退避：1s, 2s, 5s 之后停止重连，让缓存层走内存降级
        if (times > 3) return null;
        return Math.min(times * 1000, 5000);
      },
    });

    let warned = false;
    client.on('error', (err) => {
      if (!warned) {
        logger.warn(`Redis unavailable, falling back to in-memory cache: ${err.message}`);
        warned = true;
      }
    });
    client.on('ready', () => {
      logger.log('Redis connected');
      warned = false;
    });

    void client.connect().catch(() => {});
    return client;
  },
};

@Global()
@Module({
  providers: [redisProvider],
  exports: [redisProvider],
})
export class RedisModule {}
