ALTER TABLE "shops"
ADD COLUMN "last_order_sync_at" TIMESTAMP(3),
ADD COLUMN "order_sync_attempt_at" TIMESTAMP(3),
ADD COLUMN "order_sync_error" VARCHAR(500);
