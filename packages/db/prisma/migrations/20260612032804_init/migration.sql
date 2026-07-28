-- CreateEnum
CREATE TYPE "UserPlan" AS ENUM ('free', 'basic', 'pro', 'flagship', 'enterprise');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('active', 'disabled');

-- CreateEnum
CREATE TYPE "Platform" AS ENUM ('alibaba_1688', 'taobao', 'tmall', 'douyin', 'pdd', 'kuaishou', 'wechat_shop');

-- CreateEnum
CREATE TYPE "ShopRole" AS ENUM ('seller', 'buyer');

-- CreateEnum
CREATE TYPE "ShopStatus" AS ENUM ('active', 'expired', 'revoked');

-- CreateEnum
CREATE TYPE "PublishTaskStatus" AS ENUM ('pending', 'optimizing', 'publishing', 'partial', 'success', 'failed');

-- CreateEnum
CREATE TYPE "PublishedProductStatus" AS ENUM ('online', 'offline', 'draft', 'rejected');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('paid', 'purchasing', 'shipped', 'received', 'refunded', 'closed');

-- CreateEnum
CREATE TYPE "PurchaseOrderStatus" AS ENUM ('pending', 'placed', 'shipped', 'received', 'failed');

-- CreateEnum
CREATE TYPE "AiModule" AS ENUM ('title', 'detail', 'image_remove_watermark', 'image_relight', 'image_compose', 'category_mapping', 'compliance_check', 'customer_service', 'recommendation_reason');

-- CreateEnum
CREATE TYPE "SubscriptionPlan" AS ENUM ('basic', 'pro', 'flagship', 'enterprise');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('active', 'expired', 'cancelled');

-- CreateTable
CREATE TABLE "users" (
    "id" BIGSERIAL NOT NULL,
    "phone" VARCHAR(20),
    "wechat_unionid" VARCHAR(64),
    "nickname" VARCHAR(64),
    "avatar_url" VARCHAR(512),
    "plan" "UserPlan" NOT NULL DEFAULT 'free',
    "status" "UserStatus" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shops" (
    "id" BIGSERIAL NOT NULL,
    "user_id" BIGINT NOT NULL,
    "platform" "Platform" NOT NULL,
    "platform_shop_id" VARCHAR(64) NOT NULL,
    "shop_name" VARCHAR(128),
    "role" "ShopRole" NOT NULL DEFAULT 'seller',
    "access_token_enc" VARCHAR(1024),
    "refresh_token_enc" VARCHAR(1024),
    "token_expire_at" TIMESTAMP(3),
    "status" "ShopStatus" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shops_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_products" (
    "id" BIGSERIAL NOT NULL,
    "product_id_1688" VARCHAR(32) NOT NULL,
    "supplier_id" VARCHAR(32),
    "title" VARCHAR(255) NOT NULL,
    "price" DECIMAL(10,2) NOT NULL,
    "price_min" DECIMAL(10,2),
    "price_max" DECIMAL(10,2),
    "main_image" VARCHAR(512),
    "detail_images" JSONB,
    "category_path" VARCHAR(255),
    "category_l1" VARCHAR(64),
    "category_l2" VARCHAR(64),
    "sku_list" JSONB,
    "attributes" JSONB,
    "monthly_sold" INTEGER NOT NULL DEFAULT 0,
    "is_cross_border" BOOLEAN NOT NULL DEFAULT false,
    "is_one_piece_drop" BOOLEAN NOT NULL DEFAULT false,
    "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "source_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_scores" (
    "product_id" BIGINT NOT NULL,
    "demand_score" DOUBLE PRECISION NOT NULL,
    "competition_score" DOUBLE PRECISION NOT NULL,
    "profit_score" DOUBLE PRECISION NOT NULL,
    "compliance_score" DOUBLE PRECISION NOT NULL,
    "trend_score" DOUBLE PRECISION NOT NULL,
    "overall_score" DOUBLE PRECISION NOT NULL,
    "reason" JSONB NOT NULL,
    "features" JSONB NOT NULL,
    "scored_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_scores_pkey" PRIMARY KEY ("product_id")
);

-- CreateTable
CREATE TABLE "user_favorites" (
    "id" BIGSERIAL NOT NULL,
    "user_id" BIGINT NOT NULL,
    "source_product_id" BIGINT NOT NULL,
    "folder_name" VARCHAR(64) NOT NULL DEFAULT 'default',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_favorites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "publish_tasks" (
    "id" BIGSERIAL NOT NULL,
    "user_id" BIGINT NOT NULL,
    "source_product_id" BIGINT NOT NULL,
    "target_shop_ids" JSONB NOT NULL,
    "status" "PublishTaskStatus" NOT NULL DEFAULT 'pending',
    "ai_optimized" JSONB,
    "pricing_strategy" JSONB,
    "error_msg" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "publish_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "published_products" (
    "id" BIGSERIAL NOT NULL,
    "task_id" BIGINT NOT NULL,
    "shop_id" BIGINT NOT NULL,
    "source_product_id" BIGINT NOT NULL,
    "platform_product_id" VARCHAR(64),
    "title" VARCHAR(255) NOT NULL,
    "sale_price" DECIMAL(10,2) NOT NULL,
    "cost_price" DECIMAL(10,2),
    "status" "PublishedProductStatus" NOT NULL DEFAULT 'online',
    "category_id" VARCHAR(64),
    "main_image" VARCHAR(512),
    "published_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "published_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" BIGSERIAL NOT NULL,
    "shop_id" BIGINT NOT NULL,
    "published_product_id" BIGINT,
    "platform_order_id" VARCHAR(64) NOT NULL,
    "buyer_nick" VARCHAR(64),
    "receiver_name" VARCHAR(64),
    "receiver_phone_enc" VARCHAR(256),
    "receiver_address_enc" TEXT,
    "sku_info" JSONB NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "status" "OrderStatus" NOT NULL,
    "paid_at" TIMESTAMP(3),

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_orders" (
    "id" BIGSERIAL NOT NULL,
    "order_id" BIGINT NOT NULL,
    "order_id_1688" VARCHAR(64),
    "status" "PurchaseOrderStatus" NOT NULL DEFAULT 'pending',
    "tracking_no" VARCHAR(64),
    "carrier" VARCHAR(32),
    "failure_reason" TEXT,
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_usage_logs" (
    "id" BIGSERIAL NOT NULL,
    "user_id" BIGINT NOT NULL,
    "module" "AiModule" NOT NULL,
    "model" VARCHAR(64) NOT NULL,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "image_count" INTEGER NOT NULL DEFAULT 0,
    "cost_cny" DECIMAL(10,4) NOT NULL,
    "trace_id" VARCHAR(64),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_usage_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" BIGSERIAL NOT NULL,
    "user_id" BIGINT NOT NULL,
    "plan" "SubscriptionPlan" NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "amount_cny" DECIMAL(10,2) NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_key" ON "users"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "users_wechat_unionid_key" ON "users"("wechat_unionid");

-- CreateIndex
CREATE INDEX "users_plan_idx" ON "users"("plan");

-- CreateIndex
CREATE INDEX "shops_user_id_idx" ON "shops"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "shops_user_id_platform_platform_shop_id_key" ON "shops"("user_id", "platform", "platform_shop_id");

-- CreateIndex
CREATE UNIQUE INDEX "source_products_product_id_1688_key" ON "source_products"("product_id_1688");

-- CreateIndex
CREATE INDEX "source_products_category_l1_idx" ON "source_products"("category_l1");

-- CreateIndex
CREATE INDEX "source_products_synced_at_idx" ON "source_products"("synced_at");

-- CreateIndex
CREATE INDEX "product_scores_overall_score_idx" ON "product_scores"("overall_score" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "user_favorites_user_id_source_product_id_key" ON "user_favorites"("user_id", "source_product_id");

-- CreateIndex
CREATE INDEX "publish_tasks_user_id_status_idx" ON "publish_tasks"("user_id", "status");

-- CreateIndex
CREATE INDEX "published_products_shop_id_idx" ON "published_products"("shop_id");

-- CreateIndex
CREATE INDEX "published_products_platform_product_id_idx" ON "published_products"("platform_product_id");

-- CreateIndex
CREATE INDEX "orders_status_idx" ON "orders"("status");

-- CreateIndex
CREATE UNIQUE INDEX "orders_shop_id_platform_order_id_key" ON "orders"("shop_id", "platform_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_orders_order_id_key" ON "purchase_orders"("order_id");

-- CreateIndex
CREATE INDEX "purchase_orders_status_idx" ON "purchase_orders"("status");

-- CreateIndex
CREATE INDEX "ai_usage_logs_user_id_created_at_idx" ON "ai_usage_logs"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "ai_usage_logs_module_idx" ON "ai_usage_logs"("module");

-- CreateIndex
CREATE INDEX "subscriptions_user_id_idx" ON "subscriptions"("user_id");

-- CreateIndex
CREATE INDEX "subscriptions_end_date_idx" ON "subscriptions"("end_date");

-- AddForeignKey
ALTER TABLE "shops" ADD CONSTRAINT "shops_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_scores" ADD CONSTRAINT "product_scores_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "source_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_favorites" ADD CONSTRAINT "user_favorites_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_favorites" ADD CONSTRAINT "user_favorites_source_product_id_fkey" FOREIGN KEY ("source_product_id") REFERENCES "source_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publish_tasks" ADD CONSTRAINT "publish_tasks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publish_tasks" ADD CONSTRAINT "publish_tasks_source_product_id_fkey" FOREIGN KEY ("source_product_id") REFERENCES "source_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "published_products" ADD CONSTRAINT "published_products_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "publish_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "published_products" ADD CONSTRAINT "published_products_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "published_products" ADD CONSTRAINT "published_products_source_product_id_fkey" FOREIGN KEY ("source_product_id") REFERENCES "source_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_shop_id_fkey" FOREIGN KEY ("shop_id") REFERENCES "shops"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_published_product_id_fkey" FOREIGN KEY ("published_product_id") REFERENCES "published_products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_usage_logs" ADD CONSTRAINT "ai_usage_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
