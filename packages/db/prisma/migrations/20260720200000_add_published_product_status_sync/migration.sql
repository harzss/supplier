ALTER TABLE "published_products"
ADD COLUMN "platform_status_raw" INTEGER,
ADD COLUMN "platform_check_status_raw" INTEGER,
ADD COLUMN "platform_status_synced_at" TIMESTAMP(3),
ADD COLUMN "platform_status_error" TEXT;
