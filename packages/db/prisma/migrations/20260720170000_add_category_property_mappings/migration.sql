ALTER TABLE "shop_categories"
ADD COLUMN "attributes" JSONB,
ADD COLUMN "attributes_fingerprint" VARCHAR(64),
ADD COLUMN "attributes_synced_at" TIMESTAMP(3);

ALTER TABLE "publish_tasks"
ADD COLUMN "category_property_snapshot" JSONB;

CREATE TABLE "product_category_property_mappings" (
  "id" BIGSERIAL NOT NULL,
  "user_id" BIGINT NOT NULL,
  "source_product_id" BIGINT NOT NULL,
  "shop_id" BIGINT NOT NULL,
  "category_id" VARCHAR(64) NOT NULL,
  "schema_fingerprint" VARCHAR(64) NOT NULL,
  "values" JSONB NOT NULL,
  "confirmed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "product_category_property_mappings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "uk_user_product_shop_category_properties"
ON "product_category_property_mappings"("user_id", "source_product_id", "shop_id");

CREATE INDEX "product_category_property_mappings_shop_id_category_id_idx"
ON "product_category_property_mappings"("shop_id", "category_id");

CREATE INDEX "product_category_property_mappings_source_product_id_idx"
ON "product_category_property_mappings"("source_product_id");

ALTER TABLE "product_category_property_mappings"
ADD CONSTRAINT "product_category_property_mappings_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "product_category_property_mappings"
ADD CONSTRAINT "product_category_property_mappings_source_product_id_fkey"
FOREIGN KEY ("source_product_id") REFERENCES "source_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "product_category_property_mappings"
ADD CONSTRAINT "product_category_property_mappings_shop_id_fkey"
FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
