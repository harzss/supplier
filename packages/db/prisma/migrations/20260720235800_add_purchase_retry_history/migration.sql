ALTER TABLE "purchase_orders"
ADD COLUMN "attempt_no" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "attempt_started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN "prior_incurred_cost" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN "retry_eligible" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "purchase_order_attempts" (
  "id" BIGSERIAL PRIMARY KEY,
  "purchase_order_id" BIGINT NOT NULL,
  "attempt_no" INTEGER NOT NULL,
  "out_order_id" VARCHAR(128) NOT NULL,
  "order_id_1688" VARCHAR(64) NOT NULL,
  "status" "PurchaseOrderStatus" NOT NULL,
  "purchase_cost" DECIMAL(10,2),
  "actual_cost" DECIMAL(10,2) NOT NULL,
  "failure_reason" TEXT,
  "resolution_note" TEXT NOT NULL,
  "started_at" TIMESTAMP(3) NOT NULL,
  "resolved_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "purchase_order_attempts_purchase_order_id_fkey"
    FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "purchase_order_attempts_out_order_id_key"
ON "purchase_order_attempts"("out_order_id");
CREATE UNIQUE INDEX "uk_purchase_attempt_no"
ON "purchase_order_attempts"("purchase_order_id", "attempt_no");
CREATE INDEX "purchase_order_attempts_purchase_order_id_idx"
ON "purchase_order_attempts"("purchase_order_id");
CREATE INDEX "purchase_order_attempts_order_id_1688_idx"
ON "purchase_order_attempts"("order_id_1688");
