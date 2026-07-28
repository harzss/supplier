import { Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../entitlement/current-user.decorator';
import type { CurrentUser as CurrentUserType } from '../entitlement/user-context.service';
import { CategoryCatalogService } from './category-catalog.service';

@ApiTags('categories')
@Controller('categories')
export class CategoryCatalogController {
  constructor(private readonly catalog: CategoryCatalogService) {}

  @Get('catalog/:shopId')
  status(@CurrentUser() user: CurrentUserType, @Param('shopId') shopId: string) {
    return this.catalog.status(user.userId, shopId);
  }

  @Post('catalog/:shopId/sync')
  sync(@CurrentUser() user: CurrentUserType, @Param('shopId') shopId: string) {
    return this.catalog.sync(user.userId, shopId);
  }

  @Get('mappings/:sourceProductId/suggestions')
  suggestions(
    @CurrentUser() user: CurrentUserType,
    @Param('sourceProductId') sourceProductId: string,
    @Query('shopId') shopId: string,
  ) {
    return this.catalog.suggestions(user.userId, sourceProductId, shopId);
  }
}
