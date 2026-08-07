BEGIN;

ALTER TYPE "ProductBatchAction" ADD VALUE 'edit_sku';

ALTER TABLE "published_products"
  ADD COLUMN "sku_spec_snapshot" JSONB,
  ADD COLUMN "sku_spec_fingerprint" VARCHAR(64),
  ADD COLUMN "sku_spec_synced_at" TIMESTAMP(3),
  ADD CONSTRAINT "published_products_sku_spec_snapshot_check"
    CHECK (
      (
        (
          "sku_spec_snapshot" IS NULL
          AND "sku_spec_fingerprint" IS NULL
          AND "sku_spec_synced_at" IS NULL
        )
        OR (
          jsonb_typeof("sku_spec_snapshot") = 'object'
          AND "sku_spec_fingerprint" ~ '^[0-9a-f]{64}$'
          AND "sku_spec_synced_at" IS NOT NULL
        )
      ) IS TRUE
    );

-- Historical publish task snapshots do not contain the complete platform SKU
-- identity and property metadata required by the current adapter contract.
-- Keep all three fields NULL until a successful platform readback persists an
-- authoritative snapshot, its SHA-256 fingerprint, and the readback time.

COMMIT;
