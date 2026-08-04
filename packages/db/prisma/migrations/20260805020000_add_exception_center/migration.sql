ALTER TABLE "purchase_orders"
  ADD COLUMN "exception_code" VARCHAR(64);

-- Existing unresolved rows predate structured codes. Classify only from
-- persisted state (never free-text reasons) so the new exception center can
-- route them without inventing semantics.
UPDATE "purchase_orders" AS purchase
SET "exception_code" = CASE
  WHEN orders."after_sale_status" IN ('pending', 'partial_refund', 'refunded')
    OR orders."status" IN ('refunded', 'closed')
    THEN 'sales_order_after_sale_hold'
  WHEN purchase."retry_eligible" = true
    THEN 'purchase_remote_cancelled_retryable'
  WHEN purchase."ever_shipped" = true
    THEN 'logistics_manual_review'
  ELSE 'purchase_manual_review'
END
FROM "orders"
WHERE purchase."order_id" = orders."id"
  AND purchase."exception_code" IS NULL
  AND purchase."exception_status" IN ('stopped', 'action_required');

CREATE TYPE "ExceptionDomain" AS ENUM (
  'publish',
  'order',
  'purchase',
  'logistics',
  'after_sale',
  'entitlement'
);

CREATE TYPE "ExceptionPriority" AS ENUM (
  'critical',
  'high',
  'medium'
);

CREATE TYPE "ExceptionCaseStatus" AS ENUM (
  'open',
  'acknowledged',
  'resolved'
);

CREATE TYPE "ExceptionSourceKind" AS ENUM (
  'scanner',
  'producer'
);

CREATE TYPE "ExceptionResponsibleParty" AS ENUM (
  'merchant',
  'system',
  'platform',
  'supplier'
);

CREATE TYPE "ExceptionCaseEventType" AS ENUM (
  'opened',
  'updated',
  'reopened',
  'acknowledged',
  'resolved'
);

CREATE TABLE "exception_cases" (
  "id" BIGSERIAL NOT NULL,
  "user_id" BIGINT NOT NULL,
  "dedupe_key" VARCHAR(160) NOT NULL,
  "domain" "ExceptionDomain" NOT NULL,
  "code" VARCHAR(64) NOT NULL,
  "priority" "ExceptionPriority" NOT NULL,
  "status" "ExceptionCaseStatus" NOT NULL DEFAULT 'open',
  "source_kind" "ExceptionSourceKind" NOT NULL,
  "source_active" BOOLEAN NOT NULL DEFAULT true,
  "source_fingerprint" VARCHAR(64) NOT NULL,
  "subject_type" VARCHAR(64) NOT NULL,
  "subject_id" VARCHAR(128) NOT NULL,
  "subject_label" VARCHAR(255) NOT NULL,
  "responsible_party" "ExceptionResponsibleParty" NOT NULL,
  "reason" TEXT NOT NULL,
  "impact" TEXT NOT NULL,
  "next_action" TEXT NOT NULL,
  "action_label" VARCHAR(80) NOT NULL,
  "action_href" VARCHAR(512) NOT NULL,
  "occurrences" INTEGER NOT NULL DEFAULT 1,
  "state_revision" INTEGER NOT NULL DEFAULT 1,
  "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "acknowledged_at" TIMESTAMP(3),
  "acknowledged_by_user_id" BIGINT,
  "resolved_at" TIMESTAMP(3),
  "resolution_reason" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "exception_cases_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "exception_cases_positive_revisions_check"
    CHECK ("occurrences" > 0 AND "state_revision" > 0),
  CONSTRAINT "exception_cases_source_fingerprint_check"
    CHECK ("source_fingerprint" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "exception_cases_required_text_check"
    CHECK (
      btrim("dedupe_key") <> ''
      AND btrim("code") <> ''
      AND btrim("subject_type") <> ''
      AND btrim("subject_id") <> ''
      AND btrim("subject_label") <> ''
      AND btrim("reason") <> ''
      AND btrim("impact") <> ''
      AND btrim("next_action") <> ''
      AND btrim("action_label") <> ''
    ),
  CONSTRAINT "exception_cases_action_href_check"
    CHECK ("action_href" ~ '^/[^/]'),
  CONSTRAINT "exception_cases_acknowledger_check"
    CHECK (
      ("acknowledged_at" IS NULL) = ("acknowledged_by_user_id" IS NULL)
      AND ("acknowledged_by_user_id" IS NULL OR "acknowledged_by_user_id" = "user_id")
    ),
  CONSTRAINT "exception_cases_lifecycle_check"
    CHECK (
      (
        "status" = 'open'
        AND "acknowledged_at" IS NULL
        AND "acknowledged_by_user_id" IS NULL
        AND "resolved_at" IS NULL
        AND "resolution_reason" IS NULL
      )
      OR (
        "status" = 'acknowledged'
        AND "acknowledged_at" IS NOT NULL
        AND "acknowledged_by_user_id" IS NOT NULL
        AND "resolved_at" IS NULL
        AND "resolution_reason" IS NULL
      )
      OR (
        "status" = 'resolved'
        AND "resolved_at" IS NOT NULL
        AND "resolution_reason" IS NOT NULL
        AND btrim("resolution_reason") <> ''
      )
    ),
  CONSTRAINT "exception_cases_source_active_check"
    CHECK ("source_active" OR "status" = 'resolved')
);

CREATE TABLE "exception_case_events" (
  "id" BIGSERIAL NOT NULL,
  "user_id" BIGINT NOT NULL,
  "case_id" BIGINT NOT NULL,
  "case_revision" INTEGER NOT NULL,
  "type" "ExceptionCaseEventType" NOT NULL,
  "client_request_id" UUID,
  "actor_user_id" BIGINT,
  "note" TEXT,
  "evidence" JSONB,
  "from_status" "ExceptionCaseStatus",
  "to_status" "ExceptionCaseStatus",
  "source_fingerprint" VARCHAR(64),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "exception_case_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "exception_case_events_revision_check"
    CHECK ("case_revision" > 0),
  CONSTRAINT "exception_case_events_actor_check"
    CHECK ("actor_user_id" IS NULL OR "actor_user_id" = "user_id"),
  CONSTRAINT "exception_case_events_source_fingerprint_check"
    CHECK (
      "source_fingerprint" IS NULL
      OR "source_fingerprint" ~ '^[0-9a-f]{64}$'
    ),
  CONSTRAINT "exception_case_events_evidence_check"
    CHECK (
      "evidence" IS NULL
      OR jsonb_typeof("evidence") = 'object'
    ),
  CONSTRAINT "exception_case_events_transition_check"
    CHECK (
      (
        "type" = 'opened'
        AND "from_status" IS NULL
        AND "to_status" = 'open'
      )
      OR (
        "type" = 'updated'
        AND (
          ("from_status" IS NULL AND "to_status" IS NULL)
          OR "from_status" = "to_status"
        )
      )
      OR (
        "type" = 'reopened'
        AND "from_status" IN ('acknowledged', 'resolved')
        AND "to_status" = 'open'
      )
      OR (
        "type" = 'acknowledged'
        AND "from_status" = 'open'
        AND "to_status" = 'acknowledged'
      )
      OR (
        "type" = 'resolved'
        AND "from_status" IN ('open', 'acknowledged')
        AND "to_status" = 'resolved'
        AND "note" IS NOT NULL
        AND btrim("note") <> ''
        AND "evidence" IS NOT NULL
      )
    )
);

CREATE UNIQUE INDEX "uk_exception_case_user_dedupe"
  ON "exception_cases"("user_id", "dedupe_key");
CREATE UNIQUE INDEX "uk_exception_case_id_user"
  ON "exception_cases"("id", "user_id");
CREATE INDEX "exception_cases_user_status_priority_updated_idx"
  ON "exception_cases"("user_id", "status", "priority", "updated_at" DESC, "id" DESC);
CREATE INDEX "exception_cases_user_domain_status_updated_idx"
  ON "exception_cases"("user_id", "domain", "status", "updated_at" DESC, "id" DESC);
CREATE INDEX "exception_cases_user_party_status_updated_idx"
  ON "exception_cases"("user_id", "responsible_party", "status", "updated_at" DESC);
CREATE INDEX "exception_cases_source_active_seen_idx"
  ON "exception_cases"("source_kind", "source_active", "domain", "last_seen_at");

CREATE UNIQUE INDEX "exception_case_events_client_request_key"
  ON "exception_case_events"("client_request_id");
CREATE UNIQUE INDEX "uk_exception_case_event_revision"
  ON "exception_case_events"("case_id", "case_revision");
CREATE INDEX "exception_case_events_user_case_revision_idx"
  ON "exception_case_events"("user_id", "case_id", "case_revision");

ALTER TABLE "exception_cases"
  ADD CONSTRAINT "exception_cases_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "exception_cases"
  ADD CONSTRAINT "exception_cases_acknowledged_by_user_id_fkey"
  FOREIGN KEY ("acknowledged_by_user_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "exception_case_events"
  ADD CONSTRAINT "exception_case_events_case_id_user_id_fkey"
  FOREIGN KEY ("case_id", "user_id") REFERENCES "exception_cases"("id", "user_id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "exception_case_events"
  ADD CONSTRAINT "exception_case_events_actor_user_id_fkey"
  FOREIGN KEY ("actor_user_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Supabase clients never access Prisma tables directly; the authenticated BFF
-- remains the only business-data boundary.
ALTER TABLE "exception_cases" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "exception_case_events" ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE "exception_cases", "exception_case_events"
  FROM "anon", "authenticated";
REVOKE ALL PRIVILEGES ON SEQUENCE "exception_cases_id_seq", "exception_case_events_id_seq"
  FROM "anon", "authenticated";
