import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../entitlement/current-user.decorator';
import type { CurrentUser as CurrentUserType } from '../entitlement/user-context.service';
import { CategoryPropertyService } from './category-property.service';
import { ConfirmCategoryPropertiesDto } from './dto/confirm-category-properties.dto';

@ApiTags('categories')
@Controller('categories/mappings/:sourceProductId/properties')
export class CategoryPropertyController {
  constructor(private readonly properties: CategoryPropertyService) {}

  @Get()
  get(
    @CurrentUser() user: CurrentUserType,
    @Param('sourceProductId') sourceProductId: string,
    @Query('shopId') shopId: string,
  ) {
    return this.properties.get(user.userId, sourceProductId, shopId);
  }

  @Put()
  confirm(
    @CurrentUser() user: CurrentUserType,
    @Param('sourceProductId') sourceProductId: string,
    @Body() dto: ConfirmCategoryPropertiesDto,
  ) {
    return this.properties.confirm(user.userId, sourceProductId, dto);
  }

  @Post('sync')
  sync(
    @CurrentUser() user: CurrentUserType,
    @Param('sourceProductId') sourceProductId: string,
    @Query('shopId') shopId: string,
  ) {
    return this.properties.sync(user.userId, sourceProductId, shopId);
  }

  @Delete()
  remove(
    @CurrentUser() user: CurrentUserType,
    @Param('sourceProductId') sourceProductId: string,
    @Query('shopId') shopId: string,
  ) {
    return this.properties.remove(user.userId, sourceProductId, shopId);
  }
}
