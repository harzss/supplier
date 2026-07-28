ALTER TABLE "purchase_orders"
ADD COLUMN "sync_revision" INTEGER NOT NULL DEFAULT 0;
