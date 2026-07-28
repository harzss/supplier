ALTER TABLE "purchase_orders"
ADD COLUMN "settled_audit_next_at" TIMESTAMP(3);

CREATE INDEX "purchase_orders_settled_audit_next_at_idx"
ON "purchase_orders"("settled_audit_next_at");
