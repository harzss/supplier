import {
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { UserPlan } from '@supplier/shared-types';
import { PrismaService } from '../../common/prisma.module';
import { AuthTokenService } from './auth-token.service';

export interface CurrentUser {
  userId: bigint;
  plan: UserPlan;
}

const DEMO_USER_ID = 1n;
const VALID_PLANS: UserPlan[] = ['free', 'basic', 'pro', 'flagship', 'enterprise'];

/**
 * 解析当前请求的用户身份与套餐。
 *
 * - `supabase`：验证 Supabase access token，以 `sub` 幂等映射内部用户，套餐只读数据库。
 * - `demo`：仅供显式本地演示，可通过请求头选择演示用户或预览套餐。
 */
@Injectable()
export class UserContextService {
  private readonly logger = new Logger('UserContext');
  readonly authMode: 'demo' | 'supabase';

  constructor(
    private readonly prisma: PrismaService,
    private readonly authTokens: AuthTokenService,
    config: ConfigService,
  ) {
    this.authMode = config.get<string>('AUTH_MODE') === 'supabase' ? 'supabase' : 'demo';
  }

  async authenticate(accessToken: string): Promise<CurrentUser> {
    const claims = await this.authTokens.verify(accessToken);
    try {
      const user = await this.prisma.user.upsert({
        where: { authSubject: claims.subject },
        create: { authSubject: claims.subject },
        update: {},
        select: { id: true, plan: true, status: true },
      });
      if (user.status !== 'active') throw new ForbiddenException('账号已停用');
      return { userId: user.id, plan: user.plan as UserPlan };
    } catch (error) {
      if (error instanceof ForbiddenException) throw error;
      this.logger.error(`认证用户映射失败：${(error as Error).message}`);
      throw new ServiceUnavailableException('用户服务暂时不可用');
    }
  }

  async loadDemo(userIdHeader?: string, planHeader?: string): Promise<CurrentUser> {
    const planOverride = this.parsePlan(planHeader);

    if (!userIdHeader || !/^\d+$/.test(userIdHeader)) {
      return { userId: DEMO_USER_ID, plan: planOverride ?? 'free' };
    }

    const userId = BigInt(userIdHeader);
    try {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, plan: true },
      });
      if (user) {
        return { userId: user.id, plan: planOverride ?? (user.plan as UserPlan) };
      }
    } catch (err) {
      this.logger.warn(`演示用户查询失败，降级为免费套餐：${(err as Error).message}`);
    }
    return { userId, plan: planOverride ?? 'free' };
  }

  private parsePlan(value?: string): UserPlan | undefined {
    if (value && (VALID_PLANS as string[]).includes(value)) {
      return value as UserPlan;
    }
    return undefined;
  }
}
