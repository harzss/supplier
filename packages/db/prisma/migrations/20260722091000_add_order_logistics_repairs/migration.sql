CREATE TYPE "OrderLogisticsRepairStatus" AS ENUM ('pending', 'running', 'completed');

CREATE TABLE "order_logistics_repairs" (
  "id" BIGSERIAL PRIMARY KEY,
  "repair_key" VARCHAR(64) NOT NULL,
  "order_id" BIGINT NOT NULL,
  "purchase_order_id" BIGINT NOT NULL,
  "operator_user_id" BIGINT NOT NULL,
  "exception_revision" INTEGER NOT NULL,
  "purchase_sync_revision" INTEGER NOT NULL,
  "target_fingerprint" VARCHAR(64) NOT NULL,
  "previous_platform_packages" JSONB NOT NULL,
  "target_platform_packages" JSONB NOT NULL,
  "target_purchase_shipments" JSONB NOT NULL,
  "target_purchase_status" "PurchaseOrderStatus" NOT NULL,
  "target_purchase_cost" DECIMAL(10, 2) NOT NULL,
  "reconciled_cost" DECIMAL(10, 2) NOT NULL,
  "resolution_note" TEXT NOT NULL,
  "status" "OrderLogisticsRepairStatus" NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "locked_at" TIMESTAMP(3),
  "locked_by" VARCHAR(128),
  "last_error" VARCHAR(500),
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "order_logistics_repairs_order_id_fkey"
    FOREIGN KEY ("order_id") REFERENCES "orders"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "order_logistics_repairs_purchase_order_id_fkey"
    FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "order_logistics_repairs_operator_user_id_fkey"
    FOREIGN KEY ("operator_user_id") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "order_logistics_repairs_repair_key_key"
ON "order_logistics_repairs"("repair_key");
CREATE UNIQUE INDEX "uk_order_logistics_repair_exception"
ON "order_logistics_repairs"("purchase_order_id", "exception_revision");
CREATE INDEX "order_logistics_repairs_order_id_idx"
ON "order_logistics_repairs"("order_id");
CREATE INDEX "order_logistics_repairs_purchase_order_id_idx"
ON "order_logistics_repairs"("purchase_order_id");
CREATE INDEX "order_logistics_repairs_operator_user_id_idx"
ON "order_logistics_repairs"("operator_user_id");
CREATE INDEX "order_logistics_repairs_status_locked_at_idx"
ON "order_logistics_repairs"("status", "locked_at");
