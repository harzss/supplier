import { Body, Controller, Delete, Get, Param, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../entitlement/current-user.decorator';
import type { CurrentUser as CurrentUserType } from '../entitlement/user-context.service';
import { ConfirmSkuMappingDto } from './dto/confirm-sku-mapping.dto';
import { SkuMappingService } from './sku-mapping.service';

@ApiTags('skus')
@Controller('skus/mappings')
export class SkuMappingController {
  constructor(private readonly mappings: SkuMappingService) {}

  @Get(':sourceProductId')
  get(
    @CurrentUser() user: CurrentUserType,
    @Param('sourceProductId') sourceProductId: string,
    @Query('platform') platform = 'douyin',
  ) {
    return this.mappings.get(user.userId, sourceProductId, platform);
  }

  @Put(':sourceProductId')
  confirm(
    @CurrentUser() user: CurrentUserType,
    @Param('sourceProductId') sourceProductId: string,
    @Body() dto: ConfirmSkuMappingDto,
  ) {
    return this.mappings.confirm(user.userId, sourceProductId, dto);
  }

  @Delete(':sourceProductId')
  remove(
    @CurrentUser() user: CurrentUserType,
    @Param('sourceProductId') sourceProductId: string,
    @Query('platform') platform = 'douyin',
  ) {
    return this.mappings.remove(user.userId, sourceProductId, platform);
  }
}
