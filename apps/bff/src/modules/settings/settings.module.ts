import { Module } from '@nestjs/common';
import { SettingsController } from './settings.controller';
import { LlmCredentialService } from './llm-credential.service';

@Module({
  controllers: [SettingsController],
  providers: [LlmCredentialService],
  exports: [LlmCredentialService],
})
export class SettingsModule {}
