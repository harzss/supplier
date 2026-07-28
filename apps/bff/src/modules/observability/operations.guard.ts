import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';

@Injectable()
export class OperationsTokenGuard implements CanActivate {
  private readonly token?: string;

  constructor(config: ConfigService) {
    this.token = config.get<string>('OPERATIONS_TOKEN')?.trim() || undefined;
  }

  canActivate(context: ExecutionContext): boolean {
    if (!this.token) throw new ServiceUnavailableException('运维接口未配置');
    const request = context.switchToHttp().getRequest<{
      headers: Record<string, string | string[] | undefined>;
    }>();
    const authorization = first(request.headers.authorization);
    const supplied = authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
    if (!supplied || !safeEqual(supplied, this.token)) {
      throw new UnauthorizedException('无效运维凭证');
    }
    return true;
  }
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
