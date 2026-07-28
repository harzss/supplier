import { Body, Controller, Delete, Get, Param, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../entitlement/current-user.decorator';
import type { CurrentUser as CurrentUserType } from '../entitlement/user-context.service';
import { CategoryMappingService } from './category-mapping.service';
import { ConfirmCategoryMappingDto } from './dto/confirm-category-mapping.dto';

@ApiTags('categories')
@Controller('categories/mappings')
export class CategoryMappingController {
  constructor(private readonly mappings: CategoryMappingService) {}

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
    @Body() dto: ConfirmCategoryMappingDto,
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
