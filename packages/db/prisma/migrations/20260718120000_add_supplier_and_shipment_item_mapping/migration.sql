ALTER TABLE "order_items"
ADD COLUMN "source_supplier_id" VARCHAR(32);

UPDATE "order_items" AS "oi"
SET "source_supplier_id" = "sp"."supplier_id"
FROM "published_products" AS "pp"
JOIN "source_products" AS "sp" ON "sp"."id" = "pp"."source_product_id"
WHERE "oi"."published_product_id" = "pp"."id"
  AND "oi"."source_supplier_id" IS NULL;

CREATE INDEX "order_items_source_supplier_id_idx"
ON "order_items"("source_supplier_id");

CREATE TABLE "purchase_shipment_items" (
    "id" BIGSERIAL NOT NULL,
    "purchase_shipment_id" BIGINT NOT NULL,
    "order_item_id" BIGINT NOT NULL,
    "quantity" INTEGER NOT NULL,

    CONSTRAINT "purchase_shipment_items_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "purchase_shipment_items_purchase_shipment_id_order_item_id_key"
ON "purchase_shipment_items"("purchase_shipment_id", "order_item_id");

CREATE INDEX "purchase_shipment_items_order_item_id_idx"
ON "purchase_shipment_items"("order_item_id");

ALTER TABLE "purchase_shipment_items"
ADD CONSTRAINT "purchase_shipment_items_purchase_shipment_id_fkey"
FOREIGN KEY ("purchase_shipment_id") REFERENCES "purchase_shipments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "purchase_shipment_items"
ADD CONSTRAINT "purchase_shipment_items_order_item_id_fkey"
FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
