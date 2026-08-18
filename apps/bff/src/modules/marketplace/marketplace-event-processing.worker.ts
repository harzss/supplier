import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AlertService } from '../observability/alert.service';
import {
  MarketplaceEventInboxService,
  type MarketplaceClaim,
  type MarketplaceExpiredClaimRecovery,
} from './marketplace-event-inbox.service';
import { MarketplaceSubscriptionProjectionService } from './marketplace-subscription-projection.service';

const DEFAULT_POLL_MS = 2_000;
const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_LEASE_MS = 60_000;
const RETRY_BASE_MS = 1_000;
const MAX_RETRY_MS = 60_000;

export interface MarketplaceWorkerRunResult {
  recovery: MarketplaceExpiredClaimRecovery;
  claimed: number;
  applied: number;
  ignored: number;
  blocked: number;
  retried: number;
  dead: number;
  ownershipLost: number;
}

@Injectable()
export class MarketplaceEventProcessingWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MarketplaceEventProcessingWorker.name);
  private timer?: NodeJS.Timeout;
  private draining = false;

  constructor(
    private readonly config: ConfigService,
    private readonly inbox: MarketplaceEventInboxService,
    private readonly projections: MarketplaceSubscriptionProjectionService,
    private readonly alerts: AlertService,
  ) {}

  onModuleInit(): void {
    if (this.config.get<string>('MARKETPLACE_EVENT_PROCESSING_ENABLED') !== 'true') return;
    const pollMs = this.pollMs();
    this.timer = setInterval(() => void this.drain(), pollMs);
    this.timer.unref();
    void this.drain();
    this.logger.log(`服务市场事件 worker 已启动，轮询间隔 ${pollMs}ms`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async runOnce(now = new Date()): Promise<MarketplaceWorkerRunResult> {
    const batchSize = this.batchSize();
    const recovery = await this.inbox.recoverExpiredClaims(
      new Date(now.getTime() - this.leaseMs()),
      now,
      batchSize,
    );
    if (recovery.dead > 0) {
      await this.alerts.raise({
        key: 'marketplace.event.dead.recovered',
        type: 'entitlement',
        severity: 'critical',
        summary: '服务市场事件处理租约耗尽并进入死信',
        details: { count: recovery.dead },
      });
    }

    const result: MarketplaceWorkerRunResult = {
      recovery,
      claimed: 0,
      applied: 0,
      ignored: 0,
      blocked: 0,
      retried: 0,
      dead: recovery.dead,
      ownershipLost: 0,
    };

    for (let index = 0; index < batchSize; index++) {
      const claim = await this.inbox.claimNext({ now });
      if (!claim) break;
      result.claimed++;
      try {
        const outcome = await this.projections.processClaim(claim);
        if (outcome.outcome === 'applied') result.applied++;
        else if (outcome.outcome === 'ignored_stale') result.ignored++;
        else result.blocked++;
      } catch (error) {
        const errorCode = processingErrorCode(error);
        const retryAt = new Date(now.getTime() + retryDelayMs(claim.event.attempts));
        const retry = await this.inbox.scheduleRetry(
          claim.event.id,
          claim.ownerToken,
          errorCode,
          retryAt,
          now,
        );
        if (retry === 'retry_wait') {
          result.retried++;
          continue;
        }
        if (retry === 'dead') {
          result.dead++;
          await this.raiseDeadEvent(claim, errorCode);
          continue;
        }
        result.ownershipLost++;
      }
    }
    return result;
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      await this.runOnce();
    } catch (error) {
      this.logger.error(
        `服务市场事件轮询失败：${error instanceof Error ? error.message : 'unknown error'}`,
      );
    } finally {
      this.draining = false;
    }
  }

  private async raiseDeadEvent(claim: MarketplaceClaim, errorCode: string): Promise<void> {
    await this.alerts.raise({
      key: `marketplace.event.dead.${claim.event.id}`,
      type: 'entitlement',
      severity: 'critical',
      summary: '服务市场事件处理重试耗尽',
      details: {
        eventId: claim.event.id,
        attempts: claim.event.attempts,
        maxAttempts: claim.event.maxAttempts,
        errorCode,
      },
    });
  }

  private pollMs(): number {
    return Number(this.config.get<number>('MARKETPLACE_EVENT_POLL_MS') ?? DEFAULT_POLL_MS);
  }

  private batchSize(): number {
    return Number(this.config.get<number>('MARKETPLACE_EVENT_BATCH_SIZE') ?? DEFAULT_BATCH_SIZE);
  }

  private leaseMs(): number {
    return Number(this.config.get<number>('MARKETPLACE_EVENT_LEASE_MS') ?? DEFAULT_LEASE_MS);
  }
}

function retryDelayMs(attempts: number): number {
  const exponent = Math.max(0, Math.min(attempts - 1, 16));
  return Math.min(RETRY_BASE_MS * 2 ** exponent, MAX_RETRY_MS);
}

function processingErrorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'P2002') return 'PROCESS.P2002';
  if (code === 'P2034') return 'PROCESS.P2034';
  if (
    typeof code === 'string' &&
    code.length > 0 &&
    code.length <= 56 &&
    /^[A-Z0-9_.:-]+$/.test(code)
  ) {
    return `PROCESS.${code}`;
  }
  return 'PROCESS.UNEXPECTED';
}
