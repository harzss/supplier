CREATE TABLE "order_items" (
    "id" BIGSERIAL NOT NULL,
    "order_id" BIGINT NOT NULL,
    "published_product_id" BIGINT,
    "platform_order_item_id" VARCHAR(64) NOT NULL,
    "platform_product_id" VARCHAR(64),
    "platform_sku_id" VARCHAR(64) NOT NULL,
    "source_offer_id" VARCHAR(32),
    "source_spec_id" VARCHAR(128),
    "source_spec_required" BOOLEAN NOT NULL DEFAULT false,
    "title" VARCHAR(255) NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unit_price" DECIMAL(10,2) NOT NULL,
    "specs" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "order_items_order_id_platform_order_item_id_key"
ON "order_items"("order_id", "platform_order_item_id");

CREATE INDEX "order_items_source_offer_id_source_spec_id_idx"
ON "order_items"("source_offer_id", "source_spec_id");

CREATE INDEX "order_items_published_product_id_idx"
ON "order_items"("published_product_id");

ALTER TABLE "order_items"
ADD CONSTRAINT "order_items_order_id_fkey"
FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "order_items"
ADD CONSTRAINT "order_items_published_product_id_fkey"
FOREIGN KEY ("published_product_id") REFERENCES "published_products"("id") ON DELETE SET NULL ON UPDATE CASCADE;
