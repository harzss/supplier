BEGIN;

CREATE TYPE "EntitlementSource" AS ENUM ('internal_beta', 'marketplace');
CREATE TYPE "EntitlementAccessStatus" AS ENUM ('active', 'suspended');
CREATE TYPE "MarketplaceProvider" AS ENUM ('alibaba_1688');
CREATE TYPE "MarketplaceAccountBindingStatus" AS ENUM ('active', 'revoked');
CREATE TYPE "MarketplaceProjectionOrigin" AS ENUM ('legacy', 'marketplace');
CREATE TYPE "MarketplaceLifecycleState" AS ENUM (
  'trialing',
  'active',
  'cancelling',
  'refunded',
  'expired',
  'cancelled',
  'uninstalled'
);
CREATE TYPE "MarketplaceProjectionAccessStatus" AS ENUM (
  'active',
  'suspended',
  'unverified'
);
CREATE TYPE "MarketplaceEventSource" AS ENUM (
  'callback',
  'reconciliation',
  'manual_repair'
);
CREATE TYPE "MarketplaceEventKind" AS ENUM (
  'trial_started',
  'subscribed',
  'renewed',
  'cancelling',
  'refunded',
  'expired',
  'cancelled',
  'uninstalled',
  'reconciled'
);
CREATE TYPE "MarketplaceEventStatus" AS ENUM (
  'received',
  'processing',
  'retry_wait',
  'applied',
  'ignored_stale',
  'blocked',
  'dead'
);

ALTER TABLE "users"
  ADD COLUMN "entitlement_source" "EntitlementSource" NOT NULL DEFAULT 'internal_beta',
  ADD COLUMN "entitlement_access_status" "EntitlementAccessStatus" NOT NULL DEFAULT 'active',
  ADD COLUMN "entitlement_revision" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "entitlement_updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD CONSTRAINT "users_entitlement_revision_check" CHECK (
    "entitlement_revision" > 0
  );

CREATE INDEX "users_entitlement_source_entitlement_access_status_idx"
  ON "users"("entitlement_source", "entitlement_access_status");

CREATE TABLE "marketplace_account_bindings" (
  "id" BIGSERIAL NOT NULL,
  "provider" "MarketplaceProvider" NOT NULL,
  "integration_key" VARCHAR(64) NOT NULL,
  "external_account_key" VARCHAR(255) NOT NULL,
  "user_id" BIGINT NOT NULL,
  "status" "MarketplaceAccountBindingStatus" NOT NULL DEFAULT 'active',
  "state_revision" INTEGER NOT NULL DEFAULT 1,
  "evidence_digest" CHAR(64) NOT NULL,
  "verified_at" TIMESTAMPTZ(3) NOT NULL,
  "revoked_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "marketplace_account_bindings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "marketplace_account_binding_user_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "marketplace_account_binding_keys_check" CHECK (
    char_length(btrim("integration_key")) > 0
    AND char_length(btrim("external_account_key")) > 0
    AND "integration_key" !~ '[[:cntrl:]]'
    AND "external_account_key" !~ '[[:cntrl:]]'
  ),
  CONSTRAINT "marketplace_account_binding_revision_check" CHECK (
    "state_revision" > 0
  ),
  CONSTRAINT "marketplace_account_binding_digest_check" CHECK (
    "evidence_digest" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "marketplace_account_binding_status_check" CHECK (
    (
      "status" = 'active'
      AND "revoked_at" IS NULL
    )
    OR (
      "status" = 'revoked'
      AND "revoked_at" IS NOT NULL
    )
  )
);

CREATE UNIQUE INDEX "marketplace_account_bindings_external_key"
  ON "marketplace_account_bindings"("provider", "integration_key", "external_account_key");
CREATE INDEX "marketplace_account_bindings_user_id_status_idx"
  ON "marketplace_account_bindings"("user_id", "status");

CREATE TABLE "marketplace_plan_mappings" (
  "id" BIGSERIAL NOT NULL,
  "provider" "MarketplaceProvider" NOT NULL,
  "integration_key" VARCHAR(64) NOT NULL,
  "provider_plan_key" VARCHAR(255) NOT NULL,
  "internal_plan" "SubscriptionPlan" NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "mapping_revision" INTEGER NOT NULL DEFAULT 1,
  "evidence_digest" CHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "marketplace_plan_mappings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "marketplace_plan_mapping_keys_check" CHECK (
    char_length(btrim("integration_key")) > 0
    AND char_length(btrim("provider_plan_key")) > 0
    AND "integration_key" !~ '[[:cntrl:]]'
    AND "provider_plan_key" !~ '[[:cntrl:]]'
  ),
  CONSTRAINT "marketplace_plan_mapping_revision_check" CHECK (
    "mapping_revision" > 0
  ),
  CONSTRAINT "marketplace_plan_mapping_digest_check" CHECK (
    "evidence_digest" ~ '^[0-9a-f]{64}$'
  )
);

CREATE UNIQUE INDEX "marketplace_plan_mappings_provider_key"
  ON "marketplace_plan_mappings"("provider", "integration_key", "provider_plan_key");
CREATE INDEX "marketplace_plan_mappings_internal_plan_enabled_idx"
  ON "marketplace_plan_mappings"("internal_plan", "enabled");

CREATE TABLE "marketplace_subscription_projections" (
  "id" BIGSERIAL NOT NULL,
  "projection_key" VARCHAR(320) NOT NULL,
  "origin" "MarketplaceProjectionOrigin" NOT NULL,
  "legacy_subscription_id" BIGINT,
  "provider" "MarketplaceProvider",
  "integration_key" VARCHAR(64),
  "external_subscription_key" VARCHAR(255),
  "account_binding_id" BIGINT,
  "plan_mapping_id" BIGINT,
  "user_id" BIGINT NOT NULL,
  "internal_plan" "SubscriptionPlan" NOT NULL,
  "lifecycle_state" "MarketplaceLifecycleState" NOT NULL,
  "access_status" "MarketplaceProjectionAccessStatus" NOT NULL,
  "provider_revision" DECIMAL(39,0),
  "projection_revision" INTEGER NOT NULL DEFAULT 1,
  "effective_start_at" TIMESTAMPTZ(3),
  "effective_end_at" TIMESTAMPTZ(3),
  "amount_cny" DECIMAL(10,2),
  "currency" CHAR(3),
  "last_event_occurred_at" TIMESTAMPTZ(3),
  "last_reconciled_at" TIMESTAMPTZ(3),
  "superseded_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "marketplace_subscription_projections_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "marketplace_projection_legacy_fkey"
    FOREIGN KEY ("legacy_subscription_id") REFERENCES "subscriptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "marketplace_projection_binding_fkey"
    FOREIGN KEY ("account_binding_id") REFERENCES "marketplace_account_bindings"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "marketplace_projection_mapping_fkey"
    FOREIGN KEY ("plan_mapping_id") REFERENCES "marketplace_plan_mappings"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "marketplace_projection_user_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "marketplace_projection_key_check" CHECK (
    char_length(btrim("projection_key")) > 0
    AND "projection_key" !~ '[[:cntrl:]]'
  ),
  CONSTRAINT "marketplace_projection_origin_check" CHECK (
    (
      (
        "origin" = 'legacy'
        AND "legacy_subscription_id" IS NOT NULL
        AND "provider" IS NULL
        AND "integration_key" IS NULL
        AND "external_subscription_key" IS NULL
        AND "account_binding_id" IS NULL
        AND "plan_mapping_id" IS NULL
        AND "provider_revision" IS NULL
        AND "access_status" IN ('unverified', 'suspended')
      )
      OR (
        "origin" = 'marketplace'
        AND "legacy_subscription_id" IS NULL
        AND "provider" IS NOT NULL
        AND "integration_key" IS NOT NULL
        AND "external_subscription_key" IS NOT NULL
        AND char_length(btrim("integration_key")) > 0
        AND char_length(btrim("external_subscription_key")) > 0
        AND "integration_key" !~ '[[:cntrl:]]'
        AND "external_subscription_key" !~ '[[:cntrl:]]'
        AND "account_binding_id" IS NOT NULL
        AND "plan_mapping_id" IS NOT NULL
        AND "provider_revision" IS NOT NULL
        AND "access_status" IN ('active', 'suspended')
      )
    ) IS TRUE
  ),
  CONSTRAINT "marketplace_projection_access_check" CHECK (
    "origin" = 'legacy'
    OR (
      "access_status" = 'active'
      AND "lifecycle_state" IN ('trialing', 'active', 'cancelling')
    )
    OR (
      "access_status" = 'suspended'
      AND "lifecycle_state" IN ('refunded', 'expired', 'cancelled', 'uninstalled')
    )
  ),
  CONSTRAINT "marketplace_projection_revision_check" CHECK (
    "projection_revision" > 0
    AND ("provider_revision" IS NULL OR "provider_revision" > 0)
  ),
  CONSTRAINT "marketplace_projection_effective_check" CHECK (
    (
      "effective_start_at" IS NULL
      OR "effective_end_at" IS NULL
      OR "effective_end_at" > "effective_start_at"
    ) IS TRUE
  ),
  CONSTRAINT "marketplace_projection_amount_check" CHECK (
    ("amount_cny" IS NULL OR "amount_cny" >= 0) IS TRUE
  ),
  CONSTRAINT "marketplace_projection_currency_check" CHECK (
    (
      "amount_cny" IS NULL
      AND "currency" IS NULL
    )
    OR (
      "amount_cny" IS NOT NULL
      AND "currency" IS NOT NULL
      AND "currency" ~ '^[A-Z]{3}$'
    )
  )
);

CREATE UNIQUE INDEX "marketplace_projection_key"
  ON "marketplace_subscription_projections"("projection_key");
CREATE UNIQUE INDEX "marketplace_projection_legacy_key"
  ON "marketplace_subscription_projections"("legacy_subscription_id");
CREATE UNIQUE INDEX "marketplace_projection_external_key"
  ON "marketplace_subscription_projections"(
    "provider",
    "integration_key",
    "external_subscription_key"
  )
  WHERE "origin" = 'marketplace';
CREATE UNIQUE INDEX "marketplace_projection_user_active_key"
  ON "marketplace_subscription_projections"("user_id")
  WHERE "origin" = 'marketplace' AND "access_status" = 'active';
CREATE INDEX "marketplace_subscription_projections_user_id_access_status_idx"
  ON "marketplace_subscription_projections"("user_id", "access_status");
CREATE INDEX "marketplace_subscription_projections_account_binding_id_idx"
  ON "marketplace_subscription_projections"("account_binding_id");
CREATE INDEX "marketplace_subscription_projections_plan_mapping_id_idx"
  ON "marketplace_subscription_projections"("plan_mapping_id");

CREATE TABLE "marketplace_event_inbox" (
  "id" BIGSERIAL NOT NULL,
  "provider" "MarketplaceProvider" NOT NULL,
  "integration_key" VARCHAR(64) NOT NULL,
  "dedupe_key" VARCHAR(255) NOT NULL,
  "external_event_id" VARCHAR(255),
  "payload_digest" CHAR(64) NOT NULL,
  "verifier_version" VARCHAR(64),
  "source" "MarketplaceEventSource" NOT NULL,
  "external_event_type" VARCHAR(128),
  "normalized_kind" "MarketplaceEventKind",
  "authoritative_state" "MarketplaceLifecycleState",
  "external_account_key" VARCHAR(255),
  "external_subscription_key" VARCHAR(255),
  "provider_plan_key" VARCHAR(255),
  "provider_revision" DECIMAL(39,0),
  "occurred_at" TIMESTAMPTZ(3),
  "normalized_payload" JSONB,
  "account_binding_id" BIGINT,
  "plan_mapping_id" BIGINT,
  "projection_id" BIGINT,
  "status" "MarketplaceEventStatus" NOT NULL DEFAULT 'received',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "max_attempts" INTEGER NOT NULL DEFAULT 5,
  "next_attempt_at" TIMESTAMPTZ(3),
  "locked_at" TIMESTAMPTZ(3),
  "locked_by" VARCHAR(128),
  "processed_at" TIMESTAMPTZ(3),
  "last_error_code" VARCHAR(64),
  "delivery_count" INTEGER NOT NULL DEFAULT 1,
  "last_received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "conflict_count" INTEGER NOT NULL DEFAULT 0,
  "last_conflict_digest" CHAR(64),
  "signature_verified_at" TIMESTAMPTZ(3),
  "request_id" VARCHAR(64),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "marketplace_event_inbox_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "marketplace_event_binding_fkey"
    FOREIGN KEY ("account_binding_id") REFERENCES "marketplace_account_bindings"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "marketplace_event_mapping_fkey"
    FOREIGN KEY ("plan_mapping_id") REFERENCES "marketplace_plan_mappings"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "marketplace_event_projection_fkey"
    FOREIGN KEY ("projection_id") REFERENCES "marketplace_subscription_projections"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "marketplace_event_keys_check" CHECK (
    char_length(btrim("integration_key")) > 0
    AND char_length(btrim("dedupe_key")) > 0
    AND "integration_key" !~ '[[:cntrl:]]'
    AND "dedupe_key" !~ '[[:cntrl:]]'
    AND ("external_event_id" IS NULL OR char_length(btrim("external_event_id")) > 0)
    AND (
      "external_event_id" IS NULL
      OR "external_event_id" !~ '[[:cntrl:]]'
    )
    AND (
      "external_account_key" IS NULL
      OR (
        char_length(btrim("external_account_key")) > 0
        AND "external_account_key" !~ '[[:cntrl:]]'
      )
    )
    AND (
      "external_subscription_key" IS NULL
      OR (
        char_length(btrim("external_subscription_key")) > 0
        AND "external_subscription_key" !~ '[[:cntrl:]]'
      )
    )
    AND (
      "provider_plan_key" IS NULL
      OR (
        char_length(btrim("provider_plan_key")) > 0
        AND "provider_plan_key" !~ '[[:cntrl:]]'
      )
    )
  ),
  CONSTRAINT "marketplace_event_digest_check" CHECK (
    "payload_digest" ~ '^[0-9a-f]{64}$'
    AND (
      "last_conflict_digest" IS NULL
      OR "last_conflict_digest" ~ '^[0-9a-f]{64}$'
    )
  ),
  CONSTRAINT "marketplace_event_callback_check" CHECK (
    "source" <> 'callback'
    OR (
      "signature_verified_at" IS NOT NULL
      AND "verifier_version" IS NOT NULL
      AND char_length(btrim("verifier_version")) > 0
    )
  ),
  CONSTRAINT "marketplace_event_authoritative_state_check" CHECK (
    (
      (
        "normalized_kind" = 'reconciled'
        AND "authoritative_state" IS NOT NULL
        AND "source" IN ('reconciliation', 'manual_repair')
      )
      OR (
        "normalized_kind" IS DISTINCT FROM 'reconciled'
        AND "authoritative_state" IS NULL
      )
    ) IS TRUE
  ),
  CONSTRAINT "marketplace_event_attempts_check" CHECK (
    "attempts" >= 0
    AND "max_attempts" BETWEEN 1 AND 10
    AND "attempts" <= "max_attempts"
    AND "delivery_count" > 0
    AND "conflict_count" >= 0
    AND (
      ("conflict_count" = 0 AND "last_conflict_digest" IS NULL)
      OR ("conflict_count" > 0 AND "last_conflict_digest" IS NOT NULL)
    )
    AND ("provider_revision" IS NULL OR "provider_revision" > 0)
  ),
  CONSTRAINT "marketplace_event_processing_check" CHECK (
    (
      "status" = 'received'
      AND "next_attempt_at" IS NULL
      AND "locked_at" IS NULL
      AND "locked_by" IS NULL
      AND "processed_at" IS NULL
    )
    OR (
      "status" = 'processing'
      AND "next_attempt_at" IS NULL
      AND "locked_at" IS NOT NULL
      AND "locked_by" IS NOT NULL
      AND char_length(btrim("locked_by")) > 0
      AND "processed_at" IS NULL
    )
    OR (
      "status" = 'retry_wait'
      AND "next_attempt_at" IS NOT NULL
      AND "locked_at" IS NULL
      AND "locked_by" IS NULL
      AND "processed_at" IS NULL
    )
    OR (
      "status" IN ('applied', 'ignored_stale', 'blocked', 'dead')
      AND "next_attempt_at" IS NULL
      AND "locked_at" IS NULL
      AND "locked_by" IS NULL
      AND "processed_at" IS NOT NULL
    )
  ),
  CONSTRAINT "marketplace_event_applied_check" CHECK (
    "status" <> 'applied'
    OR (
      "normalized_kind" IS NOT NULL
      AND "provider_revision" IS NOT NULL
      AND "account_binding_id" IS NOT NULL
      AND "plan_mapping_id" IS NOT NULL
      AND "projection_id" IS NOT NULL
    )
  ),
  CONSTRAINT "marketplace_event_timestamps_check" CHECK (
    "last_received_at" >= "created_at"
    AND ("processed_at" IS NULL OR "processed_at" >= "created_at")
  )
);

CREATE UNIQUE INDEX "marketplace_event_inbox_dedupe_key"
  ON "marketplace_event_inbox"("provider", "integration_key", "dedupe_key");
CREATE INDEX "marketplace_event_inbox_account_binding_id_idx"
  ON "marketplace_event_inbox"("account_binding_id");
CREATE INDEX "marketplace_event_inbox_plan_mapping_id_idx"
  ON "marketplace_event_inbox"("plan_mapping_id");
CREATE INDEX "marketplace_event_inbox_projection_id_idx"
  ON "marketplace_event_inbox"("projection_id");
CREATE INDEX "marketplace_event_inbox_subscription_revision_idx"
  ON "marketplace_event_inbox"(
    "provider",
    "integration_key",
    "external_subscription_key",
    "provider_revision" DESC
  );
CREATE INDEX "marketplace_event_inbox_ready_idx"
  ON "marketplace_event_inbox"("status", "next_attempt_at", "created_at")
  WHERE "status" IN ('received', 'retry_wait');
CREATE INDEX "marketplace_event_inbox_processing_lease_idx"
  ON "marketplace_event_inbox"("locked_at")
  WHERE "status" = 'processing';

INSERT INTO "marketplace_subscription_projections" (
  "projection_key",
  "origin",
  "legacy_subscription_id",
  "user_id",
  "internal_plan",
  "lifecycle_state",
  "access_status",
  "projection_revision",
  "amount_cny",
  "currency",
  "created_at",
  "updated_at"
)
SELECT
  'legacy:' || subscription."id"::text,
  'legacy',
  subscription."id",
  subscription."user_id",
  subscription."plan",
  CASE subscription."status"
    WHEN 'active' THEN 'active'::"MarketplaceLifecycleState"
    WHEN 'expired' THEN 'expired'::"MarketplaceLifecycleState"
    WHEN 'cancelled' THEN 'cancelled'::"MarketplaceLifecycleState"
  END,
  'unverified',
  1,
  subscription."amount_cny",
  'CNY',
  subscription."created_at" AT TIME ZONE 'UTC',
  CURRENT_TIMESTAMP
FROM "subscriptions" AS subscription;

ALTER TABLE "marketplace_account_bindings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "marketplace_plan_mappings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "marketplace_subscription_projections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "marketplace_event_inbox" ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE
  "marketplace_account_bindings",
  "marketplace_plan_mappings",
  "marketplace_subscription_projections",
  "marketplace_event_inbox"
FROM "anon", "authenticated";

REVOKE ALL PRIVILEGES ON SEQUENCE
  "marketplace_account_bindings_id_seq",
  "marketplace_plan_mappings_id_seq",
  "marketplace_subscription_projections_id_seq",
  "marketplace_event_inbox_id_seq"
FROM "anon", "authenticated";

-- Supabase projects define service_role, while the clean CI PostgreSQL fixture
-- intentionally creates only anon/authenticated. Revoke it when present without
-- making the migration depend on that optional local role.
DO $revoke_marketplace_service_role$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    REVOKE ALL PRIVILEGES ON TABLE
      "marketplace_account_bindings",
      "marketplace_plan_mappings",
      "marketplace_subscription_projections",
      "marketplace_event_inbox"
    FROM "service_role";

    REVOKE ALL PRIVILEGES ON SEQUENCE
      "marketplace_account_bindings_id_seq",
      "marketplace_plan_mappings_id_seq",
      "marketplace_subscription_projections_id_seq",
      "marketplace_event_inbox_id_seq"
    FROM "service_role";
  END IF;
END
$revoke_marketplace_service_role$;

COMMIT;
