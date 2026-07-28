CREATE TYPE "AuditOutcome" AS ENUM ('success', 'failure');

CREATE TYPE "OperationalAlertSeverity" AS ENUM ('warning', 'critical');

CREATE TYPE "OperationalAlertStatus" AS ENUM ('active', 'resolved');

CREATE TABLE "audit_logs" (
  "id" BIGSERIAL NOT NULL,
  "user_id" BIGINT,
  "action" VARCHAR(128) NOT NULL,
  "method" VARCHAR(8),
  "route" VARCHAR(255),
  "resource_type" VARCHAR(64),
  "resource_id" VARCHAR(128),
  "outcome" "AuditOutcome" NOT NULL,
  "status_code" INTEGER NOT NULL,
  "request_id" VARCHAR(64) NOT NULL,
  "ip_hash" VARCHAR(64),
  "user_agent" VARCHAR(256),
  "duration_ms" INTEGER NOT NULL,
  "metadata" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "operational_alerts" (
  "id" BIGSERIAL NOT NULL,
  "key" VARCHAR(160) NOT NULL,
  "type" VARCHAR(64) NOT NULL,
  "severity" "OperationalAlertSeverity" NOT NULL,
  "status" "OperationalAlertStatus" NOT NULL DEFAULT 'active',
  "summary" VARCHAR(255) NOT NULL,
  "details" JSONB,
  "occurrences" INTEGER NOT NULL DEFAULT 1,
  "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_notified_at" TIMESTAMP(3),
  "resolved_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "operational_alerts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "audit_logs_user_id_created_at_idx" ON "audit_logs"("user_id", "created_at" DESC);
CREATE INDEX "audit_logs_action_created_at_idx" ON "audit_logs"("action", "created_at" DESC);
CREATE INDEX "audit_logs_outcome_created_at_idx" ON "audit_logs"("outcome", "created_at" DESC);
CREATE INDEX "audit_logs_request_id_idx" ON "audit_logs"("request_id");

CREATE UNIQUE INDEX "operational_alerts_key_key" ON "operational_alerts"("key");
CREATE INDEX "operational_alerts_status_severity_last_seen_at_idx"
  ON "operational_alerts"("status", "severity", "last_seen_at" DESC);
CREATE INDEX "operational_alerts_type_last_seen_at_idx"
  ON "operational_alerts"("type", "last_seen_at" DESC);

ALTER TABLE "audit_logs"
  ADD CONSTRAINT "audit_logs_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
