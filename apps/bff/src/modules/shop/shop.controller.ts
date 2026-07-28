import { Body, Controller, Get, HttpException, Param, Post, Query, Redirect } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Platform } from '@supplier/db';
import { CurrentUser } from '../entitlement/current-user.decorator';
import type { CurrentUser as CurrentUserType } from '../entitlement/user-context.service';
import { ConnectShopDto } from './dto/connect-shop.dto';
import { DouyinReadinessService } from './douyin-readiness.service';
import { OAuthCallbackDto } from './dto/oauth-callback.dto';
import { OAuthFlowService } from './oauth-flow.service';
import { OAuthConfigService, type OAuthPlatform } from './oauth-config.service';
import { ShopService } from './shop.service';
import { Public } from '../entitlement/public.decorator';
import { AuditAction } from '../observability/audit.decorator';
import { AuditService } from '../observability/audit.service';
import { Alibaba1688ReadinessService } from './alibaba1688-readiness.service';

@ApiTags('shops')
@Controller('shops')
export class ShopController {
  constructor(
    private readonly shops: ShopService,
    private readonly oauth: OAuthFlowService,
    private readonly oauthConfig: OAuthConfigService,
    private readonly douyinReadiness: DouyinReadinessService,
    private readonly alibaba1688Readiness: Alibaba1688ReadinessService,
    private readonly audit: AuditService,
  ) {}

  /** 当前用户的店铺列表 */
  @Get()
  list(@CurrentUser() user: CurrentUserType) {
    return this.shops.list(user.userId);
  }

  /** 连接演示店铺（受 shops.max 限制） */
  @Post('connect')
  connect(@CurrentUser() user: CurrentUserType, @Body() dto: ConnectShopDto) {
    return this.shops.connectDemo(user.userId, user.plan, dto.platform as Platform, dto.shopName);
  }

  /** 停用本系统中的店铺授权并清除本地 Token，历史数据继续保留 */
  @AuditAction('shop.disconnect', 'shop')
  @Post(':id/disconnect')
  disconnect(@CurrentUser() user: CurrentUserType, @Param('id') id: string) {
    return this.shops.disconnect(user.userId, id);
  }

  /** 抖店真实联调前置条件，只返回配置状态，不返回任何密钥。 */
  @Get('oauth/douyin/readiness')
  readinessDouyin(@CurrentUser() user: CurrentUserType) {
    return this.douyinReadiness.get(user.userId);
  }

  /** 1688 真实采购前置条件，只返回状态，不返回任何密钥。 */
  @Get('oauth/alibaba_1688/readiness')
  readinessAlibaba1688(@CurrentUser() user: CurrentUserType) {
    return this.alibaba1688Readiness.get(user.userId);
  }

  /** 发起抖店 OAuth，返回商家授权页地址 */
  @AuditAction('shop.oauth.authorize', 'shop')
  @Get('oauth/douyin/authorize')
  authorizeDouyin(@CurrentUser() user: CurrentUserType) {
    return this.oauth.authorize(user.userId, 'douyin');
  }

  /** 发起 1688 买家 OAuth，返回官方授权页地址 */
  @AuditAction('shop.oauth.authorize', 'shop')
  @Get('oauth/alibaba_1688/authorize')
  authorizeAlibaba1688(@CurrentUser() user: CurrentUserType) {
    return this.oauth.authorize(user.userId, 'alibaba_1688');
  }

  /** 抖店 OAuth 回调：校验 state、交换 token 并加密保存授权店铺 */
  @Public()
  @Get('oauth/douyin/callback')
  @Redirect(undefined, 302)
  async callbackDouyin(@Query() query: OAuthCallbackDto) {
    return this.callbackPlatform('douyin', query);
  }

  /** 1688 买家 OAuth 回调：校验 state、交换 token 并加密保存 */
  @Public()
  @Get('oauth/alibaba_1688/callback')
  @Redirect(undefined, 302)
  async callbackAlibaba1688(@Query() query: OAuthCallbackDto) {
    return this.callbackPlatform('alibaba_1688', query);
  }

  private async callbackPlatform(platform: OAuthPlatform, query: OAuthCallbackDto) {
    const route = `/shops/oauth/${platform}/callback`;
    try {
      const result = await this.oauth.exchange(platform, query.code, query.state);
      await this.audit.record({
        userId: result.userId,
        action: 'shop.oauth.callback',
        method: 'GET',
        route,
        resourceType: 'shop',
        resourceId: result.shop.id,
        outcome: 'success',
        statusCode: 302,
        metadata: { platform: result.platform },
      });
      return {
        url: this.oauthConfig.buildResultRedirect({
          oauth: platform,
          result: 'success',
          shopId: result.shop.id,
          shopName: result.shop.shopName ?? undefined,
        }),
      };
    } catch (error) {
      await this.audit.record({
        action: 'shop.oauth.callback',
        method: 'GET',
        route,
        resourceType: 'shop',
        outcome: 'failure',
        statusCode: error instanceof HttpException ? error.getStatus() : 500,
        metadata: { errorType: error instanceof Error ? error.name : 'unknown' },
      });
      return {
        url: this.oauthConfig.buildResultRedirect({
          oauth: platform,
          result: 'error',
          message: publicOAuthError(error),
        }),
      };
    }
  }
}

function publicOAuthError(error: unknown): string {
  if (error instanceof HttpException) {
    const response = error.getResponse();
    if (typeof response === 'string') return response.slice(0, 120);
    if (response && typeof response === 'object') {
      const message = (response as { message?: unknown }).message;
      if (typeof message === 'string') return message.slice(0, 120);
      if (Array.isArray(message)) return message.map(String).join('；').slice(0, 120);
    }
  }
  return '授权失败，请重试';
}
