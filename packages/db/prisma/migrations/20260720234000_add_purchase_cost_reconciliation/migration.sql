ALTER TABLE "purchase_orders"
ADD COLUMN "reconciled_cost" DECIMAL(10,2),
ADD CONSTRAINT "ck_purchase_orders_reconciled_cost_non_negative"
CHECK ("reconciled_cost" IS NULL OR "reconciled_cost" >= 0);
