import { Module } from '@nestjs/common';
import { AiController } from './ai.controller';
import { AiGatewayService } from './ai-gateway.service';
import { ModelRouterService } from './model-router.service';
import { PromptCacheService } from './prompt-cache.service';
import { LlmClientProvider } from './llm.provider';
import { LlmResolverService } from './llm-resolver.service';
import { SettingsModule } from '../settings/settings.module';

@Module({
  imports: [SettingsModule],
  controllers: [AiController],
  providers: [
    AiGatewayService,
    ModelRouterService,
    PromptCacheService,
    LlmClientProvider,
    LlmResolverService,
  ],
  exports: [AiGatewayService],
})
export class AiModule {}
