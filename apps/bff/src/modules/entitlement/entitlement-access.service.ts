import {
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Prisma } from '@supplier/db';
import { PrismaService } from '../../common/prisma.module';

type EntitlementReader = Pick<Prisma.TransactionClient, 'user'>;

export interface EntitlementAccessSnapshot {
  revision: number;
}

export type EntitlementAccessStopCode =
  | 'ENTITLEMENT_SUSPENDED'
  | 'ACCOUNT_DISABLED'
  | 'ENTITLEMENT_REVISION_CHANGED';

@Injectable()
export class EntitlementAccessService {
  constructor(private readonly prisma: PrismaService) {}

  async assertActive(
    userId: bigint,
    expectedRevision?: number,
    reader: EntitlementReader = this.prisma,
  ): Promise<EntitlementAccessSnapshot> {
    if (
      expectedRevision !== undefined &&
      (!Number.isSafeInteger(expectedRevision) || expectedRevision <= 0)
    ) {
      throw entitlementRevisionChanged();
    }
    let user: {
      status: 'active' | 'disabled';
      entitlementAccessStatus: 'active' | 'suspended';
      entitlementRevision: number;
    } | null;
    try {
      user = await reader.user.findUnique({
        where: { id: userId },
        select: {
          status: true,
          entitlementAccessStatus: true,
          entitlementRevision: true,
        },
      });
    } catch {
      throw entitlementAccessUnavailable();
    }
    if (!user) throw entitlementUserMissing();
    if (user.status !== 'active') throw accountDisabled();
    if (user.entitlementAccessStatus !== 'active') throw entitlementSuspended();
    if (expectedRevision !== undefined && user.entitlementRevision !== expectedRevision) {
      throw entitlementRevisionChanged();
    }
    return { revision: user.entitlementRevision };
  }
}

export function currentUserContextMissing(): UnauthorizedException {
  return new UnauthorizedException({
    code: 'CURRENT_USER_CONTEXT_MISSING',
    message: '当前用户上下文不可用，请重新登录',
  });
}

export function entitlementSuspended(): ForbiddenException {
  return new ForbiddenException({
    code: 'ENTITLEMENT_SUSPENDED',
    message: '当前订购权益已暂停，仅可查看权益与审计记录，或清理已保存的授权凭证',
  });
}

export function entitlementAccessStopCode(error: unknown): EntitlementAccessStopCode | null {
  if (!(error instanceof HttpException)) return null;
  const response = error.getResponse();
  if (!response || typeof response !== 'object' || Array.isArray(response)) return null;
  const code = (response as { code?: unknown }).code;
  return code === 'ENTITLEMENT_SUSPENDED' ||
    code === 'ACCOUNT_DISABLED' ||
    code === 'ENTITLEMENT_REVISION_CHANGED'
    ? code
    : null;
}

export function entitlementAccessStopMessage(error: unknown): string | null {
  const code = entitlementAccessStopCode(error);
  if (!code) return null;
  const response = (error as HttpException).getResponse() as { message?: unknown };
  const message = response.message;
  return `${code}: ${typeof message === 'string' && message ? message : '账号访问状态已变化'}`;
}

function accountDisabled(): ForbiddenException {
  return new ForbiddenException({
    code: 'ACCOUNT_DISABLED',
    message: '账号已停用',
  });
}

function entitlementRevisionChanged(): ConflictException {
  return new ConflictException({
    code: 'ENTITLEMENT_REVISION_CHANGED',
    message: '权益状态已变化，当前操作执行权已失效',
  });
}

function entitlementAccessUnavailable(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    code: 'ENTITLEMENT_ACCESS_UNAVAILABLE',
    message: '权益状态暂时无法确认，已停止外部操作',
  });
}

function entitlementUserMissing(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    code: 'ENTITLEMENT_USER_MISSING',
    message: '权益账号不存在，已停止外部操作',
  });
}
