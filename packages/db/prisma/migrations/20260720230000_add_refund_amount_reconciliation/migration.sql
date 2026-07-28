ALTER TABLE "orders"
ADD COLUMN "refund_amount" DECIMAL(10,2),
ADD COLUMN "refund_amount_fingerprint" VARCHAR(64),
ADD COLUMN "refund_amount_confirmed_at" TIMESTAMP(3),
ADD COLUMN "refund_amount_note" TEXT,
ADD CONSTRAINT "ck_orders_refund_amount_range"
CHECK ("refund_amount" IS NULL OR ("refund_amount" > 0 AND "refund_amount" < "amount"));
