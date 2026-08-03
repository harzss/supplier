ALTER TABLE "published_products"
  ADD COLUMN "mutation_revision" INTEGER NOT NULL DEFAULT 1;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "published_products"
    WHERE "platform_product_id" IS NOT NULL
    GROUP BY "shop_id", "platform_product_id"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'duplicate published product ids exist within a shop';
  END IF;
END $$;

CREATE UNIQUE INDEX "published_products_shop_platform_product_key"
  ON "published_products"("shop_id", "platform_product_id");

CREATE TYPE "ProductBatchAction" AS ENUM (
  'edit_title',
  'edit_price',
  'sync_inventory',
  'online',
  'offline',
  'change_source',
  'cleanup'
);

CREATE TYPE "ProductBatchTaskStatus" AS ENUM (
  'preview',
  'queued',
  'running',
  'cancelling',
  'cancelled',
  'partial',
  'succeeded',
  'failed'
);

CREATE TYPE "ProductBatchItemStatus" AS ENUM (
  'pending',
  'running',
  'retry_wait',
  'succeeded',
  'failed',
  'skipped',
  'cancelled'
);

CREATE TABLE "product_batch_tasks" (
  "id" BIGSERIAL NOT NULL,
  "user_id" BIGINT NOT NULL,
  "client_request_id" UUID NOT NULL,
  "request_fingerprint" VARCHAR(64) NOT NULL,
  "action" "ProductBatchAction" NOT NULL,
  "status" "ProductBatchTaskStatus" NOT NULL DEFAULT 'preview',
  "state_revision" INTEGER NOT NULL DEFAULT 1,
  "preview_revision" INTEGER NOT NULL DEFAULT 1,
  "cancel_requested_at" TIMESTAMP(3),
  "confirmed_at" TIMESTAMP(3),
  "started_at" TIMESTAMP(3),
  "finished_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "product_batch_tasks_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "product_batch_items" (
  "id" BIGSERIAL NOT NULL,
  "task_id" BIGINT NOT NULL,
  "published_product_id" BIGINT NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "status" "ProductBatchItemStatus" NOT NULL DEFAULT 'pending',
  "expected_mutation_revision" INTEGER NOT NULL,
  "before_snapshot" JSONB NOT NULL,
  "desired_snapshot" JSONB NOT NULL,
  "result" JSONB,
  "error_code" VARCHAR(64),
  "error_message" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "max_attempts" INTEGER NOT NULL DEFAULT 3,
  "next_run_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "locked_at" TIMESTAMP(3),
  "locked_by" VARCHAR(128),
  "started_at" TIMESTAMP(3),
  "finished_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "product_batch_items_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "product_batch_tasks_user_client_request_key"
  ON "product_batch_tasks"("user_id", "client_request_id");
CREATE INDEX "product_batch_tasks_user_id_created_at_idx"
  ON "product_batch_tasks"("user_id", "created_at" DESC);
CREATE INDEX "product_batch_tasks_status_created_at_idx"
  ON "product_batch_tasks"("status", "created_at");

CREATE UNIQUE INDEX "product_batch_items_task_product_key"
  ON "product_batch_items"("task_id", "published_product_id");
CREATE INDEX "product_batch_items_task_id_status_idx"
  ON "product_batch_items"("task_id", "status");
CREATE INDEX "product_batch_items_status_next_run_at_idx"
  ON "product_batch_items"("status", "next_run_at");
CREATE INDEX "product_batch_items_locked_at_idx"
  ON "product_batch_items"("locked_at");

ALTER TABLE "product_batch_tasks"
  ADD CONSTRAINT "product_batch_tasks_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "product_batch_items"
  ADD CONSTRAINT "product_batch_items_task_id_fkey"
  FOREIGN KEY ("task_id") REFERENCES "product_batch_tasks"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "product_batch_items"
  ADD CONSTRAINT "product_batch_items_published_product_id_fkey"
  FOREIGN KEY ("published_product_id") REFERENCES "published_products"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "product_batch_tasks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "product_batch_items" ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE "product_batch_tasks", "product_batch_items"
  FROM "anon", "authenticated";
REVOKE ALL PRIVILEGES ON SEQUENCE "product_batch_tasks_id_seq", "product_batch_items_id_seq"
  FROM "anon", "authenticated";
