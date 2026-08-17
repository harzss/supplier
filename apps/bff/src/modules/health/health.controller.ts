import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../entitlement/public.decorator';
import { HealthService } from './health.service';

@Public()
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  check() {
    return this.health.liveness();
  }

  @Get('live')
  live() {
    return this.health.liveness();
  }

  @Get('ready')
  async ready() {
    const result = await this.health.readiness();
    if (result.status !== 'ready') throw new ServiceUnavailableException(result);
    return result;
  }
}
