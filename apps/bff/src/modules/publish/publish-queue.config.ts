import type { ConfigService } from '@nestjs/config';

export function publishMaxAttempts(config: ConfigService): number {
  const value = Number(config.get<string>('PUBLISH_MAX_ATTEMPTS') ?? 3);
  return Number.isInteger(value) && value >= 1 && value <= 10 ? value : 3;
}
