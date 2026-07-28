import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../observability/audit.service';
import { RuntimeMetricsService } from '../observability/runtime-metrics.service';
import { IS_PUBLIC_ROUTE } from './public.decorator';
import { UserContextService, type CurrentUser } from './user-context.service';

interface RequestWithUser {
  headers: Record<string, string | string[] | undefined>;
  id?: string | number;
  method?: string;
  url?: string;
  ip?: string;
  routeOptions?: { url?: string };
  currentUser?: CurrentUser;
}

/** 全局身份守卫：公开路由放行；其余路由按显式认证模式解析并验证当前用户。 */
@Injectable()
export class CurrentUserGuard implements CanActivate {
  constructor(
    private readonly userContext: UserContextService,
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
    private readonly metrics: RuntimeMetricsService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_ROUTE, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest<RequestWithUser>();
    const startedAt = Date.now();
    try {
      if (this.userContext.authMode === 'demo') {
        req.currentUser = await this.userContext.loadDemo(
          header(req.headers['x-user-id']),
          header(req.headers['x-user-plan']),
        );
        return true;
      }

      const token = bearerToken(header(req.headers.authorization));
      req.currentUser = await this.userContext.authenticate(token);
      return true;
    } catch (error) {
      const statusCode = error instanceof UnauthorizedException ? 401 : status(error);
      const durationMs = Date.now() - startedAt;
      this.metrics.record(statusCode, durationMs);
      await this.audit.record({
        action: 'auth.access.denied',
        method: req.method,
        route: req.routeOptions?.url ?? req.url?.split('?')[0],
        resourceType: 'auth',
        outcome: 'failure',
        statusCode,
        requestId: String(req.id ?? header(req.headers['x-request-id']) ?? randomUUID()),
        ip: req.ip,
        userAgent: header(req.headers['user-agent']),
        durationMs,
        metadata: { errorType: error instanceof Error ? error.name : 'unknown' },
      });
      throw error;
    }
  }
}

function header(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function bearerToken(value?: string): string {
  const token = value?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!token) throw new UnauthorizedException('请先登录');
  return token;
}

function status(error: unknown): number {
  const value = (error as { getStatus?: () => unknown } | null)?.getStatus?.();
  return typeof value === 'number' && value >= 400 && value <= 599 ? value : 500;
}
