import { Body, Controller, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AiGatewayService } from './ai-gateway.service';
import { TitleGenerateDto } from './dto/title-generate.dto';
import { CurrentUser } from '../entitlement/current-user.decorator';
import type { CurrentUser as CurrentUserType } from '../entitlement/user-context.service';
import { DetailGenerateDto } from './dto/detail-generate.dto';

@ApiTags('ai')
@Controller('ai')
export class AiController {
  constructor(private readonly aiGateway: AiGatewayService) {}

  @Post('title')
  generateTitle(@CurrentUser() user: CurrentUserType, @Body() dto: TitleGenerateDto) {
    return this.aiGateway.generateTitle(user, dto);
  }

  @Post('detail')
  generateDetail(@CurrentUser() user: CurrentUserType, @Body() dto: DetailGenerateDto) {
    return this.aiGateway.generateDetail(user, dto);
  }
}
