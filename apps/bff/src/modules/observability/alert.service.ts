import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  OperationalAlert,
  OperationalAlertSeverity,
  OperationalAlertStatus,
  Prisma,
} from '@supplier/db';
import { createHash, createHmac } from 'node:crypto';
import { PrismaService } from '../../common/prisma.module';

export interface RaiseAlertInput {
  key: string;
  type: string;
  severity: OperationalAlertSeverity;
  summary: string;
  details?: unknown;
}

export interface OperationalAlertView {
  id: string;
  key: string;
  type: string;
  severity: OperationalAlertSeverity;
  status: OperationalAlertStatus;
  summary: string;
  details: unknown;
  occurrences: number;
  firstSeenAt: string;
  lastSeenAt: string;
  lastNotifiedAt: string | null;
  resolvedAt: string | null;
}

/** 告警去重、持久化和签名 Webhook 投递；任一告警故障都不会阻断业务请求。 */
@Injectable()
export class AlertService {
  private readonly logger = new Logger('OperationalAlert');
  private readonly webhookUrl?: string;
  private readonly webhookSecret?: string;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly retryBaseMs: number;
  private readonly renotifyMs: number;
  private readonly fallbackNotifiedAt = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.webhookUrl = config.get<string>('ALERT_WEBHOOK_URL')?.trim() || undefined;
    this.webhookSecret = config.get<string>('ALERT_WEBHOOK_SECRET')?.trim() || undefined;
    this.timeoutMs = config.get<number>('ALERT_WEBHOOK_TIMEOUT_MS') ?? 3_000;
    this.maxAttempts = config.get<number>('ALERT_WEBHOOK_MAX_ATTEMPTS') ?? 3;
    this.retryBaseMs = config.get<number>('ALERT_WEBHOOK_RETRY_BASE_MS') ?? 500;
    this.renotifyMs = (config.get<number>('ALERT_RENOTIFY_SECONDS') ?? 900) * 1_000;
  }

  async raise(input: RaiseAlertInput): Promise<void> {
    const normalized = normalizeInput(input);
    const now = new Date();
    let shouldNotify = true;
    let persisted = false;
    try {
      const existing = await this.prisma.operationalAlert.findUnique({
        where: { key: normalized.key },
      });
      if (!existing) {
        await this.prisma.operationalAlert.create({
          data: {
            ...normalized,
            status: 'active',
            firstSeenAt: now,
            lastSeenAt: now,
          },
        });
      } else {
        shouldNotify = shouldRenotify(existing, normalized.severity, now, this.renotifyMs);
        await this.prisma.operationalAlert.update({
          where: { key: normalized.key },
          data: {
            type: normalized.type,
            severity: maxSeverity(existing.severity, normalized.severity),
            status: 'active',
            summary: normalized.summary,
            ...(normalized.details === undefined ? {} : { details: normalized.details }),
            occurrences: { increment: 1 },
            ...(existing.status === 'resolved' ? { firstSeenAt: now } : {}),
            lastSeenAt: now,
            resolvedAt: null,
          },
        });
      }
      persisted = true;
    } catch (error) {
      this.logger.error(
        JSON.stringify({
          event: 'alert_persistence_failed',
          key: normalized.key,
          severity: normalized.severity,
          error: error instanceof Error ? error.name : 'unknown',
        }),
      );
      shouldNotify = this.shouldFallbackNotify(normalized.key, now.getTime());
    }

    if (!shouldNotify) return;
    if (await this.deliver('firing', normalized, now)) {
      this.fallbackNotifiedAt.set(normalized.key, now.getTime());
      if (persisted) {
        await this.prisma.operationalAlert
          .update({ where: { key: normalized.key }, data: { lastNotifiedAt: now } })
          .catch(() => undefined);
      }
    }
  }

  async resolve(key: string, details?: unknown): Promise<void> {
    const normalizedKey = truncate(key, 160);
    const now = new Date();
    try {
      const existing = await this.prisma.operationalAlert.findUnique({
        where: { key: normalizedKey },
      });
      if (!existing || existing.status === 'resolved') return;
      await this.prisma.operationalAlert.update({
        where: { key: normalizedKey },
        data: {
          status: 'resolved',
          resolvedAt: now,
          lastSeenAt: now,
          ...(details === undefined ? {} : { details: sanitizeDetails(details) }),
        },
      });
      await this.deliver(
        'resolved',
        {
          key: existing.key,
          type: existing.type,
          severity: existing.severity,
          summary: existing.summary,
          details: details === undefined ? existing.details : sanitizeDetails(details),
        },
        now,
      );
    } catch (error) {
      this.logger.error(
        JSON.stringify({
          event: 'alert_resolution_failed',
          key: normalizedKey,
          error: error instanceof Error ? error.name : 'unknown',
        }),
      );
    }
  }

  async list(status: OperationalAlertStatus | 'all' = 'active', limit = 50) {
    const rows = await this.prisma.operationalAlert.findMany({
      where: status === 'all' ? undefined : { status },
      orderBy: [{ status: 'asc' }, { severity: 'desc' }, { lastSeenAt: 'desc' }],
      take: Math.min(Math.max(limit, 1), 200),
    });
    return rows.map(toView);
  }

  private shouldFallbackNotify(key: string, now: number): boolean {
    const last = this.fallbackNotifiedAt.get(key) ?? 0;
    return now - last >= this.renotifyMs;
  }

  private async deliver(
    state: 'firing' | 'resolved',
    alert: RaiseAlertInput,
    now: Date,
  ): Promise<boolean> {
    const timestamp = now.getTime().toString();
    const deliveryId = createHash('sha256')
      .update(`${timestamp}.${state}.${alert.key}`)
      .digest('hex');
    const payload = JSON.stringify({
      version: 1,
      deliveryId,
      state,
      service: 'supplier-bff',
      occurredAt: now.toISOString(),
      alert,
    });
    if (!this.webhookUrl || !this.webhookSecret) {
      this.logger.warn(JSON.stringify({ event: 'operational_alert', state, alert }));
      return true;
    }

    const signature = createHmac('sha256', this.webhookSecret)
      .update(`${timestamp}.${payload}`)
      .digest('hex');

    let attempts = 0;
    let lastError = 'unknown';
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      attempts = attempt;
      let retryable = true;
      try {
        const response = await fetch(this.webhookUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-supplier-alert-delivery-id': deliveryId,
            'x-supplier-alert-timestamp': timestamp,
            'x-supplier-alert-signature': `sha256=${signature}`,
          },
          body: payload,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (response.ok) return true;
        lastError = `webhook returned ${response.status}`;
        retryable = isRetryableWebhookStatus(response.status);
      } catch (error) {
        lastError = error instanceof Error ? error.message.slice(0, 200) : 'unknown';
      }

      if (!retryable || attempt === this.maxAttempts) break;
      const delayMs = webhookRetryDelayMs(this.retryBaseMs, attempt);
      this.logger.warn(
        JSON.stringify({
          event: 'alert_delivery_retry',
          key: alert.key,
          state,
          attempt,
          nextAttempt: attempt + 1,
          delayMs,
          error: lastError,
        }),
      );
      await delay(delayMs);
    }

    this.logger.error(
      JSON.stringify({
        event: 'alert_delivery_failed',
        key: alert.key,
        state,
        attempts,
        error: lastError,
      }),
    );
    return false;
  }
}

function isRetryableWebhookStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function webhookRetryDelayMs(baseMs: number, failedAttempt: number): number {
  return Math.min(baseMs * 2 ** (failedAttempt - 1), 10_000);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function normalizeInput(
  input: RaiseAlertInput,
): RaiseAlertInput & { details?: Prisma.InputJsonValue } {
  return {
    key: truncate(input.key, 160),
    type: truncate(input.type, 64),
    severity: input.severity,
    summary: truncate(input.summary, 255),
    details: sanitizeDetails(input.details),
  };
}

function shouldRenotify(
  existing: OperationalAlert,
  severity: OperationalAlertSeverity,
  now: Date,
  renotifyMs: number,
): boolean {
  if (existing.status === 'resolved') return true;
  if (severityRank(severity) > severityRank(existing.severity)) return true;
  return (
    !existing.lastNotifiedAt || now.getTime() - existing.lastNotifiedAt.getTime() >= renotifyMs
  );
}

function maxSeverity(
  left: OperationalAlertSeverity,
  right: OperationalAlertSeverity,
): OperationalAlertSeverity {
  return severityRank(right) > severityRank(left) ? right : left;
}

function severityRank(value: OperationalAlertSeverity): number {
  return value === 'critical' ? 2 : 1;
}

function sanitizeDetails(value: unknown, depth = 0): Prisma.InputJsonValue | undefined {
  if (value === undefined || depth > 5) return undefined;
  if (value === null) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') return truncate(value, 500);
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitizeDetails(item, depth + 1) ?? null);
  }
  if (typeof value === 'object') {
    const result: Record<string, Prisma.InputJsonValue> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 50)) {
      const safeKey = truncate(key, 100);
      if (/authorization|cookie|password|secret|token|api.?key|credential|code/i.test(safeKey)) {
        result[safeKey] = '[redacted]';
        continue;
      }
      const sanitized = sanitizeDetails(item, depth + 1);
      if (sanitized !== undefined) result[safeKey] = sanitized;
    }
    return result;
  }
  return truncate(String(value), 500);
}

function toView(row: OperationalAlert): OperationalAlertView {
  return {
    id: row.id.toString(),
    key: row.key,
    type: row.type,
    severity: row.severity,
    status: row.status,
    summary: row.summary,
    details: row.details,
    occurrences: row.occurrences,
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    lastNotifiedAt: row.lastNotifiedAt?.toISOString() ?? null,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
  };
}

function truncate(value: string, max: number): string {
  return value.slice(0, max);
}
