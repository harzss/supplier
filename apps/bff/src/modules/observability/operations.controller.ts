import { Controller, Get, HttpCode, Post, Query, Res, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../entitlement/public.decorator';
import { AlertService } from './alert.service';
import { OperationsTokenGuard } from './operations.guard';
import { OperationsService } from './operations.service';

interface PassthroughReply {
  header(name: string, value: string): void;
}

@Public()
@UseGuards(OperationsTokenGuard)
@ApiTags('operations')
@Controller('operations')
export class OperationsController {
  constructor(
    private readonly operations: OperationsService,
    private readonly alerts: AlertService,
  ) {}

  @Get('status')
  status() {
    return this.operations.status();
  }

  @Post('check')
  @HttpCode(200)
  checkNow() {
    return this.operations.checkNow();
  }

  @Get('alerts')
  alertsList(@Query('status') status?: string, @Query('limit') limit?: string) {
    const normalizedStatus = status === 'resolved' || status === 'all' ? status : 'active';
    const parsedLimit = /^\d+$/.test(limit ?? '') ? Number(limit) : 50;
    return this.alerts.list(normalizedStatus, parsedLimit);
  }

  @Get('metrics')
  async metrics(@Res({ passthrough: true }) reply: PassthroughReply) {
    reply.header('content-type', 'text/plain; version=0.0.4; charset=utf-8');
    return this.operations.prometheus();
  }
}
