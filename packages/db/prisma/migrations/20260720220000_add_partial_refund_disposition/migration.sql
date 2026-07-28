CREATE TYPE "OrderPartialRefundDisposition" AS ENUM ('none', 'continue_remaining', 'stop_all');

ALTER TABLE "orders"
ADD COLUMN "partial_refund_disposition" "OrderPartialRefundDisposition" NOT NULL DEFAULT 'none',
ADD COLUMN "partial_refund_fingerprint" VARCHAR(64),
ADD COLUMN "partial_refund_disposition_at" TIMESTAMP(3),
ADD COLUMN "partial_refund_disposition_note" TEXT;

ALTER TABLE "order_items"
ADD COLUMN "after_sale_type_raw" INTEGER;
