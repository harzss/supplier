import { Module } from '@nestjs/common';
import { AiController } from './ai.controller';
import { AiGatewayService } from './ai-gateway.service';
import { ModelRouterService } from './model-router.service';
import { PromptCacheService } from './prompt-cache.service';
import { LlmClientProvider } from './llm.provider';

@Module({
  controllers: [AiController],
  providers: [AiGatewayService, ModelRouterService, PromptCacheService, LlmClientProvider],
  exports: [AiGatewayService],
})
export class AiModule {}
