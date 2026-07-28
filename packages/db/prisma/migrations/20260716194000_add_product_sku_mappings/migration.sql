-- User-scoped, confirmed SKU mappings. A source fingerprint invalidates stale confirmations.
CREATE TABLE "product_sku_mappings" (
    "id" BIGSERIAL NOT NULL,
    "user_id" BIGINT NOT NULL,
    "source_product_id" BIGINT NOT NULL,
    "platform" "Platform" NOT NULL,
    "dimensions" JSONB NOT NULL,
    "skus" JSONB NOT NULL,
    "source_fingerprint" VARCHAR(64) NOT NULL,
    "confirmed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_sku_mappings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "product_sku_mappings_user_id_source_product_id_platform_key"
ON "product_sku_mappings"("user_id", "source_product_id", "platform");

CREATE INDEX "product_sku_mappings_user_id_platform_idx"
ON "product_sku_mappings"("user_id", "platform");

CREATE INDEX "product_sku_mappings_source_product_id_idx"
ON "product_sku_mappings"("source_product_id");

ALTER TABLE "product_sku_mappings"
ADD CONSTRAINT "product_sku_mappings_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "product_sku_mappings"
ADD CONSTRAINT "product_sku_mappings_source_product_id_fkey"
FOREIGN KEY ("source_product_id") REFERENCES "source_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "publish_tasks" ADD COLUMN "sku_snapshot" JSONB;
