import { Controller, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../entitlement/current-user.decorator';
import type { CurrentUser as CurrentUserType } from '../entitlement/user-context.service';
import { InventorySyncService } from './inventory-sync.service';

@ApiTags('inventory')
@Controller('inventory-sync')
export class InventorySyncController {
  constructor(private readonly inventory: InventorySyncService) {}

  @Post(':publishedProductId/retry')
  retry(
    @CurrentUser() user: CurrentUserType,
    @Param('publishedProductId') publishedProductId: string,
  ) {
    return this.inventory.manualRetry(user.userId, publishedProductId);
  }
}
