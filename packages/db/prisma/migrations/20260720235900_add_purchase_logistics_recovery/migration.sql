ALTER TABLE "purchase_orders"
ADD COLUMN "ever_shipped" BOOLEAN NOT NULL DEFAULT false;

UPDATE "purchase_orders" AS "po"
SET "ever_shipped" = true
WHERE "po"."status" IN ('shipped', 'received')
   OR EXISTS (
     SELECT 1
     FROM "purchase_shipments" AS "ps"
     WHERE "ps"."purchase_order_id" = "po"."id"
   );

CREATE TABLE "purchase_order_recoveries" (
  "id" BIGSERIAL PRIMARY KEY,
  "purchase_order_id" BIGINT NOT NULL,
  "operator_user_id" BIGINT NOT NULL,
  "exception_revision" INTEGER NOT NULL,
  "out_order_id" VARCHAR(128) NOT NULL,
  "order_id_1688" VARCHAR(64) NOT NULL,
  "previous_status" "PurchaseOrderStatus" NOT NULL,
  "previous_shipments" JSONB NOT NULL,
  "note" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "purchase_order_recoveries_purchase_order_id_fkey"
    FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "purchase_order_recoveries_operator_user_id_fkey"
    FOREIGN KEY ("operator_user_id") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "purchase_order_recoveries_purchase_order_id_idx"
ON "purchase_order_recoveries"("purchase_order_id");
CREATE INDEX "purchase_order_recoveries_operator_user_id_idx"
ON "purchase_order_recoveries"("operator_user_id");
