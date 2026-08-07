import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from './prisma.module';

interface LeaseRow {
  ownerToken: string;
}

interface ValueRow {
  value: unknown;
}

interface FixedWindowRow {
  count: number;
  retryAfterMs: number;
}

export interface FixedWindowResult {
  allowed: boolean;
  retryAfterMs: number;
}

/**
 * Short-lived, cross-instance state backed by Supabase PostgreSQL.
 *
 * Every ownership or one-time-consume transition is a single SQL statement so
 * it remains safe behind Supabase's transaction pooler.
 */
@Injectable()
export class RuntimeStateService {
  private readonly logger = new Logger(RuntimeStateService.name);

  constructor(private readonly prisma: PrismaService) {}

  async ping(): Promise<void> {
    await this.prisma.$queryRaw`SELECT 1 FROM "runtime_states" LIMIT 0`;
  }

  async storeIfAbsent(key: string, value: unknown, ttlMs: number): Promise<boolean> {
    this.assertInput(key, ttlMs);
    const rows = await this.prisma.$queryRaw<Array<{ key: string }>>`
      INSERT INTO "runtime_states" (
        "key", "value", "owner_token", "counter_value", "expires_at", "updated_at"
      )
      VALUES (
        ${key}, CAST(${serialize(value)} AS jsonb), NULL, NULL,
        clock_timestamp() + ${ttlMs} * INTERVAL '1 millisecond', clock_timestamp()
      )
      ON CONFLICT ("key") DO UPDATE SET
        "value" = EXCLUDED."value",
        "owner_token" = NULL,
        "counter_value" = NULL,
        "expires_at" = clock_timestamp() + ${ttlMs} * INTERVAL '1 millisecond',
        "updated_at" = clock_timestamp()
      WHERE "runtime_states"."expires_at" <= clock_timestamp()
      RETURNING "key"
    `;
    await this.cleanupExpired();
    return rows.length === 1;
  }

  async store(key: string, value: unknown, ttlMs: number): Promise<void> {
    this.assertInput(key, ttlMs);
    await this.prisma.$executeRaw`
      INSERT INTO "runtime_states" (
        "key", "value", "owner_token", "counter_value", "expires_at", "updated_at"
      )
      VALUES (
        ${key}, CAST(${serialize(value)} AS jsonb), NULL, NULL,
        clock_timestamp() + ${ttlMs} * INTERVAL '1 millisecond', clock_timestamp()
      )
      ON CONFLICT ("key") DO UPDATE SET
        "value" = EXCLUDED."value",
        "owner_token" = NULL,
        "counter_value" = NULL,
        "expires_at" = clock_timestamp() + ${ttlMs} * INTERVAL '1 millisecond',
        "updated_at" = clock_timestamp()
    `;
    await this.cleanupExpired();
  }

  async read<T>(key: string): Promise<T | null> {
    this.assertKey(key);
    const rows = await this.prisma.$queryRaw<ValueRow[]>`
      SELECT "value"
      FROM "runtime_states"
      WHERE "key" = ${key}
        AND "value" IS NOT NULL
        AND "expires_at" > clock_timestamp()
      LIMIT 1
    `;
    return rows.length === 1 ? (rows[0]!.value as T) : null;
  }

  async consume<T>(key: string): Promise<T | null> {
    this.assertKey(key);
    const rows = await this.prisma.$queryRaw<ValueRow[]>`
      DELETE FROM "runtime_states"
      WHERE "key" = ${key}
        AND "value" IS NOT NULL
        AND "expires_at" > clock_timestamp()
      RETURNING "value"
    `;
    return rows.length === 1 ? (rows[0]!.value as T) : null;
  }

  async remove(key: string): Promise<void> {
    this.assertKey(key);
    await this.prisma.$executeRaw`
      DELETE FROM "runtime_states" WHERE "key" = ${key}
    `;
  }

  async acquireLease(key: string, ttlMs: number): Promise<string | null> {
    this.assertInput(key, ttlMs);
    const token = randomUUID();
    const rows = await this.prisma.$queryRaw<LeaseRow[]>`
      INSERT INTO "runtime_states" (
        "key", "value", "owner_token", "counter_value", "expires_at", "updated_at"
      )
      VALUES (
        ${key}, NULL, CAST(${token} AS uuid), NULL,
        clock_timestamp() + ${ttlMs} * INTERVAL '1 millisecond', clock_timestamp()
      )
      ON CONFLICT ("key") DO UPDATE SET
        "value" = NULL,
        "owner_token" = EXCLUDED."owner_token",
        "counter_value" = NULL,
        "expires_at" = clock_timestamp() + ${ttlMs} * INTERVAL '1 millisecond',
        "updated_at" = clock_timestamp()
      WHERE "runtime_states"."expires_at" <= clock_timestamp()
      RETURNING "owner_token"::text AS "ownerToken"
    `;
    return rows.length === 1 ? rows[0]!.ownerToken : null;
  }

  async renewLease(key: string, token: string, ttlMs: number): Promise<boolean> {
    this.assertInput(key, ttlMs);
    const rows = await this.prisma.$queryRaw<Array<{ key: string }>>`
      UPDATE "runtime_states"
      SET
        "expires_at" = clock_timestamp() + ${ttlMs} * INTERVAL '1 millisecond',
        "updated_at" = clock_timestamp()
      WHERE "key" = ${key}
        AND "owner_token" = CAST(${token} AS uuid)
        AND "expires_at" > clock_timestamp()
      RETURNING "key"
    `;
    return rows.length === 1;
  }

  async releaseLease(key: string, token: string): Promise<void> {
    this.assertKey(key);
    await this.prisma.$executeRaw`
      DELETE FROM "runtime_states"
      WHERE "key" = ${key}
        AND "owner_token" = CAST(${token} AS uuid)
    `;
  }

  async takeFixedWindow(key: string, limit: number, windowMs: number): Promise<FixedWindowResult> {
    this.assertInput(key, windowMs);
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new Error('runtime state limit must be a positive integer');
    }
    const rows = await this.prisma.$queryRaw<FixedWindowRow[]>`
      INSERT INTO "runtime_states" (
        "key", "value", "owner_token", "counter_value", "expires_at", "updated_at"
      )
      VALUES (
        ${key}, NULL, NULL, 1,
        clock_timestamp() + ${windowMs} * INTERVAL '1 millisecond', clock_timestamp()
      )
      ON CONFLICT ("key") DO UPDATE SET
        "value" = NULL,
        "owner_token" = NULL,
        ("counter_value", "expires_at") = (
          SELECT
            CASE
              WHEN "runtime_states"."counter_value" IS NULL
                OR "runtime_states"."expires_at" <= sampled."now"
                THEN 1
              ELSE "runtime_states"."counter_value" + 1
            END,
            CASE
              WHEN "runtime_states"."counter_value" IS NULL
                OR "runtime_states"."expires_at" <= sampled."now"
                THEN sampled."now" + ${windowMs} * INTERVAL '1 millisecond'
              ELSE "runtime_states"."expires_at"
            END
          FROM (SELECT clock_timestamp() AS "now") AS sampled
        ),
        "updated_at" = clock_timestamp()
      RETURNING
        "counter_value" AS "count",
        GREATEST(
          0,
          CEIL(EXTRACT(EPOCH FROM ("expires_at" - clock_timestamp())) * 1000)
        )::integer AS "retryAfterMs"
    `;
    const row = rows[0];
    if (!row || !Number.isSafeInteger(row.count) || !Number.isSafeInteger(row.retryAfterMs)) {
      throw new Error('runtime state fixed-window result is invalid');
    }
    return {
      allowed: row.count <= limit,
      retryAfterMs: row.count <= limit ? 0 : Math.max(row.retryAfterMs, 0),
    };
  }

  private async cleanupExpired(): Promise<void> {
    try {
      await this.prisma.$executeRaw`
        DELETE FROM "runtime_states"
        WHERE "expires_at" <= clock_timestamp()
          AND "key" IN (
            SELECT "key"
            FROM "runtime_states"
            WHERE "expires_at" <= clock_timestamp()
            ORDER BY "expires_at"
            LIMIT 100
          )
      `;
    } catch (error) {
      this.logger.warn(`Runtime state cleanup failed: ${(error as Error).message}`);
    }
  }

  private assertInput(key: string, ttlMs: number): void {
    this.assertKey(key);
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
      throw new Error('runtime state TTL must be a positive integer');
    }
  }

  private assertKey(key: string): void {
    if (!key || key.length > 255) throw new Error('runtime state key is invalid');
  }
}

function serialize(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('runtime state value is not JSON serializable');
  return serialized;
}
