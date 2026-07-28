CREATE TYPE "SourceProductAvailability" AS ENUM ('available', 'out_of_stock', 'offline', 'unknown');
CREATE TYPE "InventorySyncStatus" AS ENUM ('pending', 'syncing', 'retry_wait', 'synced', 'dead');

ALTER TABLE "source_products"
ADD COLUMN "availability" "SourceProductAvailability" NOT NULL DEFAULT 'unknown',
ADD COLUMN "total_stock" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "inventory_fingerprint" VARCHAR(64) NOT NULL DEFAULT 'legacy',
ADD COLUMN "inventory_version" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "availability_changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "source_products" AS "sp"
SET "total_stock" = CASE
  WHEN jsonb_array_length(
    CASE
      WHEN jsonb_typeof("sp"."sku_list") = 'array' THEN "sp"."sku_list"
      ELSE '[]'::JSONB
    END
  ) > 0 THEN
    LEAST(
      2147483647,
      COALESCE((
        SELECT SUM(
          CASE
            WHEN "sku"->>'stock' ~ '^[0-9]+$' THEN ("sku"->>'stock')::NUMERIC
            ELSE 0
          END
        )
        FROM jsonb_array_elements(
          CASE
            WHEN jsonb_typeof("sp"."sku_list") = 'array' THEN "sp"."sku_list"
            ELSE '[]'::JSONB
          END
        ) AS "sku"
      ), 0)
    )::INTEGER
  ELSE 0
END;

UPDATE "source_products"
SET "availability" = CASE
  WHEN jsonb_typeof("sku_list") IS DISTINCT FROM 'array' THEN 'unknown'::"SourceProductAvailability"
  WHEN jsonb_array_length("sku_list") = 0 THEN 'unknown'::"SourceProductAvailability"
  WHEN "total_stock" > 0 THEN 'available'::"SourceProductAvailability"
  ELSE 'out_of_stock'::"SourceProductAvailability"
END,
"inventory_fingerprint" = md5(
  "product_id_1688" || ':' || COALESCE("sku_list"::TEXT, '[]') || ':' || "total_stock"::TEXT
) || md5(
  'inventory-v2:' || "product_id_1688" || ':' || COALESCE("sku_list"::TEXT, '[]') || ':' || "total_stock"::TEXT
),
"inventory_version" = 1;

ALTER TABLE "published_products"
ADD COLUMN "inventory_sync_status" "InventorySyncStatus" NOT NULL DEFAULT 'synced',
ADD COLUMN "inventory_fingerprint" VARCHAR(64),
ADD COLUMN "inventory_target_fingerprint" VARCHAR(64),
ADD COLUMN "inventory_version" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "inventory_target_version" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "inventory_sync_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "inventory_next_run_at" TIMESTAMP(3),
ADD COLUMN "inventory_locked_at" TIMESTAMP(3),
ADD COLUMN "inventory_locked_by" VARCHAR(128),
ADD COLUMN "inventory_last_synced_at" TIMESTAMP(3),
ADD COLUMN "inventory_sync_reason" VARCHAR(64),
ADD COLUMN "inventory_sync_error" TEXT;

UPDATE "published_products" AS "pp"
SET "inventory_fingerprint" = "sp"."inventory_fingerprint",
    "inventory_target_fingerprint" = "sp"."inventory_fingerprint",
    "inventory_version" = "sp"."inventory_version",
    "inventory_target_version" = "sp"."inventory_version",
    "inventory_sync_status" = CASE
      WHEN "pp"."status" = 'online' AND "sp"."availability" IN ('available', 'out_of_stock')
        THEN 'pending'::"InventorySyncStatus"
      ELSE 'synced'::"InventorySyncStatus"
    END,
    "inventory_next_run_at" = CASE
      WHEN "pp"."status" = 'online' AND "sp"."availability" IN ('available', 'out_of_stock')
        THEN CURRENT_TIMESTAMP
      ELSE NULL
    END,
    "inventory_last_synced_at" = CASE
      WHEN "pp"."status" = 'online' AND "sp"."availability" IN ('available', 'out_of_stock')
        THEN NULL
      ELSE "pp"."published_at"
    END,
    "inventory_sync_reason" = 'migration_backfill'
FROM "source_products" AS "sp"
WHERE "sp"."id" = "pp"."source_product_id";

CREATE INDEX "source_products_availability_idx" ON "source_products"("availability");
CREATE INDEX "published_products_inventory_sync_status_inventory_next_run_at_idx"
ON "published_products"("inventory_sync_status", "inventory_next_run_at");
CREATE INDEX "published_products_inventory_locked_at_idx" ON "published_products"("inventory_locked_at");
