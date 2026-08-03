ALTER TABLE "published_products"
  ADD COLUMN "sku_price_snapshot" JSONB,
  ADD COLUMN "price_synced_at" TIMESTAMP(3);
