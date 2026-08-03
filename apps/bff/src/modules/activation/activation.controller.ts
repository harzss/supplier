import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../entitlement/current-user.decorator';
import type { CurrentUser as CurrentUserType } from '../entitlement/user-context.service';
import { ActivationService } from './activation.service';

@ApiTags('me')
@Controller('me')
export class ActivationController {
  constructor(private readonly activation: ActivationService) {}

  @Get('activation')
  getActivation(@CurrentUser() user: CurrentUserType) {
    return this.activation.get(user.userId);
  }
}
