-- CreateTable
CREATE TABLE "product_category_mappings" (
    "id" BIGSERIAL NOT NULL,
    "user_id" BIGINT NOT NULL,
    "source_product_id" BIGINT NOT NULL,
    "platform" "Platform" NOT NULL,
    "category_id" VARCHAR(64) NOT NULL,
    "category_name" VARCHAR(128),
    "confirmed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_category_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uk_user_product_platform_category" ON "product_category_mappings"("user_id", "source_product_id", "platform");

-- CreateIndex
CREATE INDEX "product_category_mappings_user_id_platform_idx" ON "product_category_mappings"("user_id", "platform");

-- CreateIndex
CREATE INDEX "product_category_mappings_source_product_id_idx" ON "product_category_mappings"("source_product_id");

-- AddForeignKey
ALTER TABLE "product_category_mappings" ADD CONSTRAINT "product_category_mappings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_category_mappings" ADD CONSTRAINT "product_category_mappings_source_product_id_fkey" FOREIGN KEY ("source_product_id") REFERENCES "source_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
