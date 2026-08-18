import { Body, Controller, Delete, Get, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { LlmProviderName } from '@supplier/db';
import { CurrentUser } from '../entitlement/current-user.decorator';
import type { CurrentUser as CurrentUserType } from '../entitlement/user-context.service';
import { SaveLlmKeyDto } from './dto/save-llm-key.dto';
import { LlmCredentialService } from './llm-credential.service';
import { AllowSuspendedAccess } from '../entitlement/allow-suspended-access.decorator';

@ApiTags('settings')
@Controller('settings')
export class SettingsController {
  constructor(private readonly credentials: LlmCredentialService) {}

  /** 查看当前 BYOK 密钥（脱敏） */
  @AllowSuspendedAccess()
  @Get('llm-key')
  getKey(@CurrentUser() user: CurrentUserType) {
    return this.credentials.get(user.userId);
  }

  /** 保存 / 更新 BYOK 密钥 */
  @Post('llm-key')
  saveKey(@CurrentUser() user: CurrentUserType, @Body() dto: SaveLlmKeyDto) {
    return this.credentials.save(
      user.userId,
      dto.provider as LlmProviderName,
      dto.apiKey,
      dto.label,
    );
  }

  /** 删除 BYOK 密钥 */
  @AllowSuspendedAccess()
  @Delete('llm-key')
  removeKey(@CurrentUser() user: CurrentUserType) {
    return this.credentials.remove(user.userId);
  }
}
