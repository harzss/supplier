import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AuditOutcome, Prisma } from '@supplier/db';
import { createHmac, randomUUID } from 'node:crypto';
import { PrismaService } from '../../common/prisma.module';
import type { AuditQueryDto } from './dto/audit-query.dto';

export interface AuditEventInput {
  userId?: bigint;
  action: string;
  method?: string;
  route?: string;
  resourceType?: string;
  resourceId?: string;
  outcome: AuditOutcome;
  statusCode: number;
  requestId?: string;
  ip?: string;
  userAgent?: string;
  durationMs?: number;
  metadata?: unknown;
}

export interface AuditEventView {
  id: string;
  action: string;
  method: string | null;
  route: string | null;
  resourceType: string | null;
  resourceId: string | null;
  outcome: AuditOutcome;
  statusCode: number;
  requestId: string;
  userAgent: string | null;
  durationMs: number;
  metadata: unknown;
  createdAt: string;
}

/** 仅追加审计记录；写入失败时输出结构化 fallback 日志，不影响已完成的业务操作。 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger('Audit');
  private readonly hashSalt: string;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.hashSalt =
      config.get<string>('AUDIT_HASH_SALT') ??
      config.get<string>('ENCRYPTION_KEY') ??
      'supplier-audit-development-salt';
  }

  async record(input: AuditEventInput): Promise<void> {
    const event = normalizeEvent(input, this.hashSalt);
    try {
      await this.prisma.auditLog.create({ data: event });
    } catch (error) {
      this.logger.error(
        JSON.stringify({
          event: 'audit_fallback',
          action: event.action,
          outcome: event.outcome,
          statusCode: event.statusCode,
          requestId: event.requestId,
          userId: input.userId?.toString(),
          persistenceError: error instanceof Error ? error.name : 'unknown',
        }),
      );
    }
  }

  async list(userId: bigint, query: AuditQueryDto) {
    const where: Prisma.AuditLogWhereInput = {
      userId,
      ...(query.beforeId ? { id: { lt: BigInt(query.beforeId) } } : {}),
      ...(query.action ? { action: { startsWith: query.action } } : {}),
      ...(query.outcome ? { outcome: query.outcome } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
    };
    const rows = await this.prisma.auditLog.findMany({
      where,
      orderBy: { id: 'desc' },
      take: query.limit + 1,
    });
    const hasMore = rows.length > query.limit;
    const events = rows.slice(0, query.limit).map(toView);
    return {
      events,
      nextCursor: hasMore ? (events.at(-1)?.id ?? null) : null,
    };
  }
}

function normalizeEvent(input: AuditEventInput, hashSalt: string): Prisma.AuditLogCreateInput {
  return {
    ...(input.userId ? { user: { connect: { id: input.userId } } } : {}),
    action: truncate(input.action, 128) || 'unknown',
    method: optionalTruncate(input.method?.toUpperCase(), 8),
    route: optionalTruncate(input.route, 255),
    resourceType: optionalTruncate(input.resourceType, 64),
    resourceId: optionalTruncate(input.resourceId, 128),
    outcome: input.outcome,
    statusCode: clampInteger(input.statusCode, 100, 599),
    requestId: truncate(input.requestId ?? randomUUID(), 64),
    ipHash: input.ip
      ? createHmac('sha256', hashSalt).update(input.ip).digest('hex').slice(0, 64)
      : null,
    userAgent: optionalTruncate(input.userAgent, 256),
    durationMs: clampInteger(input.durationMs ?? 0, 0, 2_147_483_647),
    metadata: sanitizeJson(input.metadata),
  };
}

function sanitizeJson(value: unknown, depth = 0): Prisma.InputJsonValue | undefined {
  if (value === undefined || depth > 5) return undefined;
  if (value === null) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') return truncate(value, 500);
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitizeJson(item, depth + 1) ?? null);
  }
  if (typeof value === 'object') {
    const result: Record<string, Prisma.InputJsonValue> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 50)) {
      const safeKey = truncate(key, 100);
      if (/authorization|cookie|password|secret|token|api.?key|credential|code/i.test(safeKey)) {
        result[safeKey] = '[redacted]';
        continue;
      }
      const sanitized = sanitizeJson(item, depth + 1);
      if (sanitized !== undefined) result[safeKey] = sanitized;
    }
    return result;
  }
  return truncate(String(value), 500);
}

function toView(row: {
  id: bigint;
  userId?: bigint | null;
  action: string;
  method: string | null;
  route: string | null;
  resourceType: string | null;
  resourceId: string | null;
  outcome: AuditOutcome;
  statusCode: number;
  requestId: string;
  userAgent: string | null;
  durationMs: number;
  metadata: Prisma.JsonValue | null;
  createdAt: Date;
}): AuditEventView {
  return {
    id: row.id.toString(),
    action: row.action,
    method: row.method,
    route: row.route,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    outcome: row.outcome,
    statusCode: row.statusCode,
    requestId: row.requestId,
    userAgent: row.userAgent,
    durationMs: row.durationMs,
    metadata: row.metadata,
    createdAt: row.createdAt.toISOString(),
  };
}

function optionalTruncate(value: string | undefined, max: number): string | null {
  if (!value?.trim()) return null;
  return truncate(value.trim(), max);
}

function truncate(value: string, max: number): string {
  return value.slice(0, max);
}

function clampInteger(value: number, min: number, max: number): number {
  const integer = Number.isFinite(value) ? Math.round(value) : min;
  return Math.min(max, Math.max(min, integer));
}
