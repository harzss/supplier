ALTER TYPE "PurchaseOrderStatus" ADD VALUE IF NOT EXISTS 'awaiting_payment';
ALTER TYPE "PurchaseOrderStatus" ADD VALUE IF NOT EXISTS 'paid';

ALTER TABLE "purchase_orders"
ADD COLUMN "buyer_shop_id" BIGINT,
ADD COLUMN "supplier_key" VARCHAR(64),
ADD COLUMN "out_order_id" VARCHAR(128),
ADD COLUMN "payment_mode" VARCHAR(16) NOT NULL DEFAULT 'manual';

UPDATE "purchase_orders"
SET "supplier_key" = 'legacy',
    "out_order_id" = 'legacy-' || "id"::text
WHERE "supplier_key" IS NULL OR "out_order_id" IS NULL;

ALTER TABLE "purchase_orders"
ALTER COLUMN "supplier_key" SET NOT NULL,
ALTER COLUMN "out_order_id" SET NOT NULL;

DROP INDEX "purchase_orders_order_id_key";

CREATE UNIQUE INDEX "purchase_orders_order_id_supplier_key_key"
ON "purchase_orders"("order_id", "supplier_key");

CREATE UNIQUE INDEX "purchase_orders_out_order_id_key"
ON "purchase_orders"("out_order_id");

CREATE UNIQUE INDEX "purchase_orders_order_id_1688_key"
ON "purchase_orders"("order_id_1688");

CREATE INDEX "purchase_orders_order_id_idx" ON "purchase_orders"("order_id");
CREATE INDEX "purchase_orders_buyer_shop_id_idx" ON "purchase_orders"("buyer_shop_id");

ALTER TABLE "purchase_orders"
ADD CONSTRAINT "purchase_orders_buyer_shop_id_fkey"
FOREIGN KEY ("buyer_shop_id") REFERENCES "shops"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "purchase_order_items" (
    "id" BIGSERIAL NOT NULL,
    "purchase_order_id" BIGINT NOT NULL,
    "order_item_id" BIGINT NOT NULL,
    "offer_id" VARCHAR(32) NOT NULL,
    "spec_id" VARCHAR(128),
    "quantity" INTEGER NOT NULL,
    "unit_cost" DECIMAL(10,2),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_order_items_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "purchase_order_items_order_item_id_key"
ON "purchase_order_items"("order_item_id");

CREATE INDEX "purchase_order_items_purchase_order_id_idx"
ON "purchase_order_items"("purchase_order_id");

ALTER TABLE "purchase_order_items"
ADD CONSTRAINT "purchase_order_items_purchase_order_id_fkey"
FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "purchase_order_items"
ADD CONSTRAINT "purchase_order_items_order_item_id_fkey"
FOREIGN KEY ("order_item_id") REFERENCES "order_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "purchase_shipments" (
    "id" BIGSERIAL NOT NULL,
    "purchase_order_id" BIGINT NOT NULL,
    "tracking_no" VARCHAR(64) NOT NULL,
    "carrier" VARCHAR(64),
    "status" VARCHAR(32),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "purchase_shipments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "purchase_shipments_purchase_order_id_tracking_no_key"
ON "purchase_shipments"("purchase_order_id", "tracking_no");

CREATE INDEX "purchase_shipments_tracking_no_idx"
ON "purchase_shipments"("tracking_no");

ALTER TABLE "purchase_shipments"
ADD CONSTRAINT "purchase_shipments_purchase_order_id_fkey"
FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "purchase_shipments" (
    "purchase_order_id", "tracking_no", "carrier", "status", "updated_at"
)
SELECT "id", "tracking_no", "carrier", "status"::text, CURRENT_TIMESTAMP
FROM "purchase_orders"
WHERE "tracking_no" IS NOT NULL;
