import {
  type CallHandler,
  type ExecutionContext,
  HttpException,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { randomUUID } from 'node:crypto';
import { catchError, from, map, mergeMap, throwError } from 'rxjs';
import type { CurrentUser } from '../entitlement/user-context.service';
import { AUDIT_ACTION, type AuditActionMetadata } from './audit.decorator';
import { AuditService } from './audit.service';
import { RuntimeMetricsService } from './runtime-metrics.service';

interface HttpRequest {
  id?: string | number;
  method: string;
  url: string;
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
  params?: Record<string, unknown>;
  routeOptions?: { url?: string };
  routerPath?: string;
  currentUser?: CurrentUser;
}

interface HttpReply {
  statusCode: number;
  header?(name: string, value: string): void;
}

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
    private readonly metrics: RuntimeMetricsService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler) {
    const http = context.switchToHttp();
    const request = http.getRequest<HttpRequest>();
    const reply = http.getResponse<HttpReply>();
    const startedAt = Date.now();
    const requestId = truncate(
      String(request.id ?? request.headers['x-request-id'] ?? randomUUID()),
      64,
    );
    reply.header?.('x-request-id', requestId);

    const metadata = this.reflector.getAllAndOverride<AuditActionMetadata>(AUDIT_ACTION, [
      context.getHandler(),
      context.getClass(),
    ]);
    const shouldAudit = !!metadata || MUTATING_METHODS.has(request.method.toUpperCase());
    const base = shouldAudit ? auditBase(request, requestId, metadata) : undefined;

    return next.handle().pipe(
      mergeMap((value) => {
        const statusCode = reply.statusCode || 200;
        const durationMs = Date.now() - startedAt;
        this.metrics.record(statusCode, durationMs);
        if (!base) return from(Promise.resolve(value));
        return from(
          this.audit.record({
            ...base,
            outcome: 'success',
            statusCode,
            durationMs,
          }),
        ).pipe(map(() => value));
      }),
      catchError((error: unknown) => {
        const statusCode = error instanceof HttpException ? error.getStatus() : 500;
        const durationMs = Date.now() - startedAt;
        this.metrics.record(statusCode, durationMs);
        if (!base) return throwError(() => error);
        return from(
          this.audit.record({
            ...base,
            outcome: 'failure',
            statusCode,
            durationMs,
            metadata: { errorType: error instanceof Error ? error.name : 'unknown' },
          }),
        ).pipe(mergeMap(() => throwError(() => error)));
      }),
    );
  }
}

function auditBase(
  request: HttpRequest,
  requestId: string,
  metadata: AuditActionMetadata | undefined,
) {
  const method = request.method.toUpperCase();
  const route = request.routeOptions?.url ?? request.routerPath ?? request.url.split('?')[0] ?? '/';
  const params = sanitizeParams(request.params);
  return {
    userId: request.currentUser?.userId,
    action: metadata?.action ?? defaultAction(method, route),
    method,
    route,
    resourceType: metadata?.resourceType ?? resourceType(route),
    resourceId: resourceId(params),
    requestId,
    ip: request.ip,
    userAgent: header(request.headers['user-agent']),
    metadata: Object.keys(params).length ? { params } : undefined,
  };
}

function defaultAction(method: string, route: string): string {
  const normalized = route
    .replace(/^\/api\/?/, '')
    .replace(/[:/]+/g, '.')
    .replace(/[^a-zA-Z0-9_.-]/g, '')
    .replace(/^\.+|\.+$/g, '');
  return truncate(`http.${method.toLowerCase()}.${normalized || 'root'}`, 128);
}

function resourceType(route: string): string | undefined {
  return route
    .replace(/^\/api\/?/, '')
    .split('/')
    .find((part) => !!part && !part.startsWith(':'));
}

function resourceId(params: Record<string, string>): string | undefined {
  const preferred = ['id', 'taskId', 'orderId', 'shopId', 'productId1688'];
  for (const key of preferred) {
    if (params[key]) return params[key];
  }
  return Object.values(params)[0];
}

function sanitizeParams(params: Record<string, unknown> | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(params ?? {}).slice(0, 20)) {
    if (value === undefined || value === null) continue;
    result[truncate(key, 64)] = truncate(String(value), 128);
  }
  return result;
}

function header(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function truncate(value: string, max: number): string {
  return value.slice(0, max);
}
