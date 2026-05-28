import { Body, Controller, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AiGatewayService } from './ai-gateway.service';
import { TitleGenerateDto } from './dto/title-generate.dto';

@ApiTags('ai')
@Controller('ai')
export class AiController {
  constructor(private readonly aiGateway: AiGatewayService) {}

  @Post('title')
  generateTitle(@Body() dto: TitleGenerateDto) {
    return this.aiGateway.generateTitle(dto);
  }
}
