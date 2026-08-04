CREATE TYPE "AfterSaleCaseStatus" AS ENUM (
  'open',
  'handling',
  'waiting_external',
  'verifying',
  'closed'
);

CREATE TYPE "AfterSaleWaitingOn" AS ENUM (
  'merchant',
  'sales_platform',
  'supplier',
  'system',
  'none'
);

CREATE TYPE "AfterSaleResolutionCode" AS ENUM (
  'sales_rejected_or_withdrawn',
  'partial_refund_handled',
  'full_refund_handled',
  'price_protection_reconciled',
  'order_closed_handled'
);

CREATE TYPE "AfterSalePurchaseLinkStatus" AS ENUM (
  'not_required',
  'action_required',
  'waiting_external',
  'confirmed',
  'failed'
);

CREATE TYPE "AfterSalePurchaseAction" AS ENUM (
  'none',
  'cancel',
  'refund',
  'return_refund',
  'intercept',
  'accept_loss',
  'manual_review'
);

CREATE TYPE "AfterSalePurchaseResult" AS ENUM (
  'confirmed',
  'failed'
);

CREATE TYPE "AfterSaleRemoteReferenceType" AS ENUM (
  'purchase_order',
  'refund',
  'return_order',
  'logistics',
  'other'
);

CREATE TYPE "AfterSaleCaseEventType" AS ENUM (
  'opened',
  'source_updated',
  'reopened',
  'claimed',
  'action_started',
  'action_confirmed',
  'verification_failed',
  'closed'
);

-- Composite keys make every child relation prove it belongs to the same
-- sales order instead of relying only on service-layer tenant checks.
CREATE UNIQUE INDEX "uk_order_item_id_order" ON "order_items"("id", "order_id");
CREATE UNIQUE INDEX "uk_purchase_order_id_order" ON "purchase_orders"("id", "order_id");

CREATE TABLE "after_sale_cases" (
  "id" BIGSERIAL NOT NULL,
  "user_id" BIGINT NOT NULL,
  "order_id" BIGINT NOT NULL,
  "status" "AfterSaleCaseStatus" NOT NULL DEFAULT 'open',
  "waiting_on" "AfterSaleWaitingOn" NOT NULL DEFAULT 'merchant',
  "priority" "ExceptionPriority" NOT NULL DEFAULT 'high',
  "source_active" BOOLEAN NOT NULL DEFAULT true,
  "source_fingerprint" VARCHAR(64) NOT NULL,
  "source_revision" INTEGER NOT NULL DEFAULT 1,
  "state_revision" INTEGER NOT NULL DEFAULT 1,
  "occurrences" INTEGER NOT NULL DEFAULT 1,
  "assignee_user_id" BIGINT,
  "first_detected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_observed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "next_action_due_at" TIMESTAMP(3) NOT NULL,
  "platform_deadline_at" TIMESTAMP(3),
  "resolution_code" "AfterSaleResolutionCode",
  "resolution_note" TEXT,
  "closed_at" TIMESTAMP(3),
  "closed_by_user_id" BIGINT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "after_sale_cases_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "after_sale_cases_revisions_check"
    CHECK ("source_revision" > 0 AND "state_revision" > 0 AND "occurrences" > 0),
  CONSTRAINT "after_sale_cases_source_fingerprint_check"
    CHECK ("source_fingerprint" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "after_sale_cases_assignee_tenant_check"
    CHECK ("assignee_user_id" IS NULL OR "assignee_user_id" = "user_id"),
  CONSTRAINT "after_sale_cases_closed_by_tenant_check"
    CHECK ("closed_by_user_id" IS NULL OR "closed_by_user_id" = "user_id"),
  CONSTRAINT "after_sale_cases_deadline_check"
    CHECK ("platform_deadline_at" IS NULL OR "platform_deadline_at" >= "first_detected_at"),
  CONSTRAINT "after_sale_cases_lifecycle_check"
    CHECK (
      (
        "status" = 'closed'
        AND "waiting_on" = 'none'
        AND "source_active" = false
        AND "resolution_code" IS NOT NULL
        AND "resolution_note" IS NOT NULL
        AND btrim("resolution_note") <> ''
        AND "closed_at" IS NOT NULL
        AND "closed_by_user_id" IS NOT NULL
      )
      OR (
        "status" <> 'closed'
        AND "waiting_on" <> 'none'
        AND "resolution_code" IS NULL
        AND "resolution_note" IS NULL
        AND "closed_at" IS NULL
        AND "closed_by_user_id" IS NULL
      )
    )
);

CREATE TABLE "after_sale_case_items" (
  "id" BIGSERIAL NOT NULL,
  "user_id" BIGINT NOT NULL,
  "case_id" BIGINT NOT NULL,
  "order_id" BIGINT NOT NULL,
  "order_item_id" BIGINT NOT NULL,
  "source_revision" INTEGER NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "platform_after_sale_id" VARCHAR(128),
  "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "after_sale_case_items_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "after_sale_case_items_source_revision_check" CHECK ("source_revision" > 0),
  CONSTRAINT "after_sale_case_items_seen_interval_check" CHECK ("last_seen_at" >= "first_seen_at"),
  CONSTRAINT "after_sale_case_items_platform_id_check"
    CHECK ("platform_after_sale_id" IS NULL OR btrim("platform_after_sale_id") <> '')
);

CREATE TABLE "after_sale_purchase_links" (
  "id" BIGSERIAL NOT NULL,
  "user_id" BIGINT NOT NULL,
  "case_id" BIGINT NOT NULL,
  "order_id" BIGINT NOT NULL,
  "purchase_order_id" BIGINT NOT NULL,
  "status" "AfterSalePurchaseLinkStatus" NOT NULL DEFAULT 'action_required',
  "action" "AfterSalePurchaseAction" NOT NULL DEFAULT 'none',
  "result" "AfterSalePurchaseResult",
  "remote_reference_type" "AfterSaleRemoteReferenceType",
  "remote_reference_id" VARCHAR(128),
  "purchase_fingerprint" VARCHAR(64) NOT NULL,
  "bound_source_revision" INTEGER NOT NULL,
  "expected_purchase_exception_revision" INTEGER NOT NULL,
  "expected_purchase_sync_revision" INTEGER NOT NULL,
  "started_at" TIMESTAMP(3),
  "confirmed_at" TIMESTAMP(3),
  "confirmed_by_user_id" BIGINT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "after_sale_purchase_links_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "after_sale_purchase_links_revisions_check"
    CHECK (
      "bound_source_revision" > 0
      AND "expected_purchase_exception_revision" >= 0
      AND "expected_purchase_sync_revision" >= 0
    ),
  CONSTRAINT "after_sale_purchase_links_fingerprint_check"
    CHECK ("purchase_fingerprint" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "after_sale_purchase_links_reference_check"
    CHECK (("remote_reference_type" IS NULL) = ("remote_reference_id" IS NULL)),
  CONSTRAINT "after_sale_purchase_links_reference_text_check"
    CHECK ("remote_reference_id" IS NULL OR btrim("remote_reference_id") <> ''),
  CONSTRAINT "after_sale_purchase_links_confirmer_check"
    CHECK ("confirmed_by_user_id" IS NULL OR "confirmed_by_user_id" = "user_id"),
  CONSTRAINT "after_sale_purchase_links_lifecycle_check"
    CHECK (
      (
        "status" IN ('not_required', 'action_required')
        AND "action" = 'none'
        AND "result" IS NULL
        AND "started_at" IS NULL
        AND "confirmed_at" IS NULL
        AND "confirmed_by_user_id" IS NULL
      )
      OR (
        "status" = 'waiting_external'
        AND "action" <> 'none'
        AND "result" IS NULL
        AND "remote_reference_type" IS NOT NULL
        AND "remote_reference_id" IS NOT NULL
        AND "started_at" IS NOT NULL
        AND "confirmed_at" IS NULL
        AND "confirmed_by_user_id" IS NULL
      )
      OR (
        "status" = 'confirmed'
        AND "action" <> 'none'
        AND "result" = 'confirmed'
        AND "started_at" IS NOT NULL
        AND "confirmed_at" IS NOT NULL
        AND "confirmed_by_user_id" IS NOT NULL
      )
      OR (
        "status" = 'failed'
        AND "action" <> 'none'
        AND "result" = 'failed'
        AND "started_at" IS NOT NULL
        AND "confirmed_at" IS NOT NULL
        AND "confirmed_by_user_id" IS NOT NULL
      )
    )
);

CREATE TABLE "after_sale_case_events" (
  "id" BIGSERIAL NOT NULL,
  "user_id" BIGINT NOT NULL,
  "case_id" BIGINT NOT NULL,
  "case_revision" INTEGER NOT NULL,
  "type" "AfterSaleCaseEventType" NOT NULL,
  "client_request_id" UUID,
  "request_fingerprint" VARCHAR(64),
  "actor_user_id" BIGINT,
  "note" TEXT,
  "evidence" JSONB,
  "from_status" "AfterSaleCaseStatus",
  "to_status" "AfterSaleCaseStatus",
  "source_revision" INTEGER NOT NULL,
  "source_fingerprint" VARCHAR(64) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "after_sale_case_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "after_sale_case_events_revisions_check"
    CHECK ("case_revision" > 0 AND "source_revision" > 0),
  CONSTRAINT "after_sale_case_events_fingerprint_check"
    CHECK (
      "source_fingerprint" ~ '^[0-9a-f]{64}$'
      AND (
        "request_fingerprint" IS NULL
        OR "request_fingerprint" ~ '^[0-9a-f]{64}$'
      )
    ),
  CONSTRAINT "after_sale_case_events_command_key_check"
    CHECK (("client_request_id" IS NULL) = ("request_fingerprint" IS NULL)),
  CONSTRAINT "after_sale_case_events_actor_check"
    CHECK ("actor_user_id" IS NULL OR "actor_user_id" = "user_id"),
  CONSTRAINT "after_sale_case_events_evidence_check"
    CHECK ("evidence" IS NULL OR jsonb_typeof("evidence") = 'object'),
  CONSTRAINT "after_sale_case_events_transition_check"
    CHECK (
      ("type" = 'opened' AND "from_status" IS NULL AND "to_status" = 'open')
      OR (
        "type" = 'source_updated'
        AND "from_status" IS NOT NULL
        AND "to_status" IS NOT NULL
      )
      OR (
        "type" = 'reopened'
        AND "from_status" = 'closed'
        AND "to_status" IN ('open', 'handling')
      )
      OR (
        "type" = 'claimed'
        AND "from_status" <> 'closed'
        AND "to_status" = 'handling'
        AND "client_request_id" IS NOT NULL
      )
      OR (
        "type" = 'action_started'
        AND "from_status" <> 'closed'
        AND "to_status" = 'waiting_external'
        AND "client_request_id" IS NOT NULL
      )
      OR (
        "type" = 'action_confirmed'
        AND "from_status" <> 'closed'
        AND "to_status" IN ('handling', 'verifying')
        AND "client_request_id" IS NOT NULL
      )
      OR (
        "type" = 'verification_failed'
        AND "from_status" = "to_status"
        AND "from_status" <> 'closed'
        AND "client_request_id" IS NOT NULL
        AND "evidence" IS NOT NULL
      )
      OR (
        "type" = 'closed'
        AND "from_status" <> 'closed'
        AND "to_status" = 'closed'
        AND "client_request_id" IS NOT NULL
        AND "evidence" IS NOT NULL
      )
    )
);

CREATE UNIQUE INDEX "after_sale_cases_order_id_key" ON "after_sale_cases"("order_id");
CREATE UNIQUE INDEX "uk_after_sale_case_id_user"
  ON "after_sale_cases"("id", "user_id");
CREATE UNIQUE INDEX "uk_after_sale_case_id_user_order"
  ON "after_sale_cases"("id", "user_id", "order_id");
CREATE INDEX "after_sale_cases_user_status_priority_updated_idx"
  ON "after_sale_cases"("user_id", "status", "priority", "updated_at" DESC, "id" DESC);
CREATE INDEX "after_sale_cases_user_due_status_idx"
  ON "after_sale_cases"("user_id", "next_action_due_at", "status");
CREATE INDEX "after_sale_cases_user_assignee_status_idx"
  ON "after_sale_cases"("user_id", "assignee_user_id", "status", "updated_at" DESC);

CREATE UNIQUE INDEX "uk_after_sale_case_item"
  ON "after_sale_case_items"("case_id", "order_item_id");
CREATE INDEX "after_sale_case_items_user_case_active_idx"
  ON "after_sale_case_items"("user_id", "case_id", "active");
CREATE INDEX "after_sale_case_items_order_item_idx"
  ON "after_sale_case_items"("order_item_id");

CREATE UNIQUE INDEX "uk_after_sale_case_purchase"
  ON "after_sale_purchase_links"("case_id", "purchase_order_id");
CREATE INDEX "after_sale_purchase_links_user_status_idx"
  ON "after_sale_purchase_links"("user_id", "status", "updated_at" DESC);
CREATE INDEX "after_sale_purchase_links_purchase_idx"
  ON "after_sale_purchase_links"("purchase_order_id");

CREATE UNIQUE INDEX "after_sale_case_events_client_request_key"
  ON "after_sale_case_events"("client_request_id");
CREATE UNIQUE INDEX "uk_after_sale_case_event_revision"
  ON "after_sale_case_events"("case_id", "case_revision");
CREATE INDEX "after_sale_case_events_user_case_revision_idx"
  ON "after_sale_case_events"("user_id", "case_id", "case_revision");

ALTER TABLE "after_sale_cases"
  ADD CONSTRAINT "after_sale_cases_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "after_sale_cases"
  ADD CONSTRAINT "after_sale_cases_assignee_user_id_fkey"
  FOREIGN KEY ("assignee_user_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "after_sale_cases"
  ADD CONSTRAINT "after_sale_cases_closed_by_user_id_fkey"
  FOREIGN KEY ("closed_by_user_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "after_sale_cases"
  ADD CONSTRAINT "after_sale_cases_order_id_fkey"
  FOREIGN KEY ("order_id") REFERENCES "orders"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "after_sale_case_items"
  ADD CONSTRAINT "after_sale_case_items_case_user_order_fkey"
  FOREIGN KEY ("case_id", "user_id", "order_id")
  REFERENCES "after_sale_cases"("id", "user_id", "order_id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "after_sale_case_items"
  ADD CONSTRAINT "after_sale_case_items_order_item_order_fkey"
  FOREIGN KEY ("order_item_id", "order_id")
  REFERENCES "order_items"("id", "order_id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "after_sale_purchase_links"
  ADD CONSTRAINT "after_sale_purchase_links_case_user_order_fkey"
  FOREIGN KEY ("case_id", "user_id", "order_id")
  REFERENCES "after_sale_cases"("id", "user_id", "order_id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "after_sale_purchase_links"
  ADD CONSTRAINT "after_sale_purchase_links_purchase_order_fkey"
  FOREIGN KEY ("purchase_order_id", "order_id")
  REFERENCES "purchase_orders"("id", "order_id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "after_sale_purchase_links"
  ADD CONSTRAINT "after_sale_purchase_links_confirmed_by_user_id_fkey"
  FOREIGN KEY ("confirmed_by_user_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "after_sale_case_events"
  ADD CONSTRAINT "after_sale_case_events_case_user_fkey"
  FOREIGN KEY ("case_id", "user_id") REFERENCES "after_sale_cases"("id", "user_id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "after_sale_case_events"
  ADD CONSTRAINT "after_sale_case_events_actor_user_id_fkey"
  FOREIGN KEY ("actor_user_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Supabase clients never access Prisma tables directly; the authenticated BFF
-- remains the only business-data boundary.
ALTER TABLE "after_sale_cases" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "after_sale_case_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "after_sale_purchase_links" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "after_sale_case_events" ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE
  "after_sale_cases",
  "after_sale_case_items",
  "after_sale_purchase_links",
  "after_sale_case_events"
FROM "anon", "authenticated";

REVOKE ALL PRIVILEGES ON SEQUENCE
  "after_sale_cases_id_seq",
  "after_sale_case_items_id_seq",
  "after_sale_purchase_links_id_seq",
  "after_sale_case_events_id_seq"
FROM "anon", "authenticated";
