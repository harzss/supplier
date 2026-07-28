import { Controller, Delete, Get, Param, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../entitlement/current-user.decorator';
import type { CurrentUser as CurrentUserType } from '../entitlement/user-context.service';
import { FavoriteService } from './favorite.service';

@ApiTags('favorites')
@Controller('favorites')
export class FavoriteController {
  constructor(private readonly favorites: FavoriteService) {}

  @Get()
  list(@CurrentUser() user: CurrentUserType) {
    return this.favorites.list(user.userId);
  }

  @Put(':productId1688')
  add(@CurrentUser() user: CurrentUserType, @Param('productId1688') productId1688: string) {
    return this.favorites.add(user.userId, productId1688);
  }

  @Delete(':productId1688')
  remove(@CurrentUser() user: CurrentUserType, @Param('productId1688') productId1688: string) {
    return this.favorites.remove(user.userId, productId1688);
  }
}
