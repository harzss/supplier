CREATE TABLE "shop_categories" (
  "id" BIGSERIAL NOT NULL,
  "shop_id" BIGINT NOT NULL,
  "channel" INTEGER NOT NULL DEFAULT 0,
  "category_id" VARCHAR(64) NOT NULL,
  "name" VARCHAR(128) NOT NULL,
  "parent_id" VARCHAR(64),
  "path" VARCHAR(512) NOT NULL,
  "level" INTEGER NOT NULL,
  "is_leaf" BOOLEAN NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "shop_categories_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "uk_shop_channel_category"
ON "shop_categories"("shop_id", "channel", "category_id");

CREATE INDEX "shop_categories_shop_id_channel_is_leaf_enabled_idx"
ON "shop_categories"("shop_id", "channel", "is_leaf", "enabled");

CREATE INDEX "shop_categories_shop_id_channel_parent_id_idx"
ON "shop_categories"("shop_id", "channel", "parent_id");

ALTER TABLE "shop_categories"
ADD CONSTRAINT "shop_categories_shop_id_fkey"
FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
