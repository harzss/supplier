CREATE TABLE "publish_drafts" (
  "user_id" BIGINT NOT NULL,
  "client_request_id" UUID NOT NULL,
  "source_product_id" BIGINT NOT NULL,
  "target_shop_ids" JSONB NOT NULL DEFAULT '[]',
  "pricing_strategy" JSONB,
  "ai_options" JSONB,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "publish_drafts_pkey" PRIMARY KEY ("user_id")
);

CREATE INDEX "publish_drafts_source_product_id_idx"
  ON "publish_drafts"("source_product_id");

ALTER TABLE "publish_drafts"
  ADD CONSTRAINT "publish_drafts_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "publish_drafts"
  ADD CONSTRAINT "publish_drafts_source_product_id_fkey"
  FOREIGN KEY ("source_product_id") REFERENCES "source_products"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Supabase clients never access Prisma tables directly; the authenticated BFF
-- remains the only business-data boundary.
ALTER TABLE "publish_drafts" ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE "publish_drafts" FROM "anon", "authenticated";
