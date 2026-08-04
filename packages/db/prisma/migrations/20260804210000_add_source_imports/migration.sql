CREATE TABLE "source_import_tasks" (
  "id" BIGSERIAL NOT NULL,
  "user_id" BIGINT NOT NULL,
  "buyer_shop_id" BIGINT,
  "client_request_id" UUID NOT NULL,
  "request_fingerprint" VARCHAR(64) NOT NULL,
  "status" "ProductBatchTaskStatus" NOT NULL DEFAULT 'preview',
  "state_revision" INTEGER NOT NULL DEFAULT 1,
  "preview_revision" INTEGER NOT NULL DEFAULT 1,
  "cancel_requested_at" TIMESTAMP(3),
  "confirmed_at" TIMESTAMP(3),
  "started_at" TIMESTAMP(3),
  "finished_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "source_import_tasks_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "user_source_products" (
  "id" BIGSERIAL NOT NULL,
  "user_id" BIGINT NOT NULL,
  "source_product_id" BIGINT NOT NULL,
  "first_collected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_collected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "user_source_products_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "source_import_items" (
  "id" BIGSERIAL NOT NULL,
  "task_id" BIGINT NOT NULL,
  "offer_id" VARCHAR(32) NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "source_product_id" BIGINT,
  "user_source_product_id" BIGINT,
  "status" "ProductBatchItemStatus" NOT NULL DEFAULT 'pending',
  "before_snapshot" JSONB NOT NULL,
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

  CONSTRAINT "source_import_items_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "source_import_tasks_user_client_request_key"
  ON "source_import_tasks"("user_id", "client_request_id");
CREATE INDEX "source_import_tasks_user_id_created_at_idx"
  ON "source_import_tasks"("user_id", "created_at" DESC);
CREATE INDEX "source_import_tasks_status_created_at_idx"
  ON "source_import_tasks"("status", "created_at");
CREATE INDEX "source_import_tasks_buyer_shop_id_idx"
  ON "source_import_tasks"("buyer_shop_id");

CREATE UNIQUE INDEX "user_source_products_user_source_product_key"
  ON "user_source_products"("user_id", "source_product_id");
CREATE INDEX "user_source_products_user_id_last_collected_at_idx"
  ON "user_source_products"("user_id", "last_collected_at" DESC);
CREATE INDEX "user_source_products_source_product_id_idx"
  ON "user_source_products"("source_product_id");

CREATE UNIQUE INDEX "source_import_items_task_offer_key"
  ON "source_import_items"("task_id", "offer_id");
CREATE INDEX "source_import_items_task_id_status_idx"
  ON "source_import_items"("task_id", "status");
CREATE INDEX "source_import_items_status_next_run_at_idx"
  ON "source_import_items"("status", "next_run_at");
CREATE INDEX "source_import_items_locked_at_idx"
  ON "source_import_items"("locked_at");
CREATE INDEX "source_import_items_source_product_id_idx"
  ON "source_import_items"("source_product_id");
CREATE INDEX "source_import_items_user_source_product_id_idx"
  ON "source_import_items"("user_source_product_id");

ALTER TABLE "source_import_tasks"
  ADD CONSTRAINT "source_import_tasks_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "source_import_tasks"
  ADD CONSTRAINT "source_import_tasks_buyer_shop_id_fkey"
  FOREIGN KEY ("buyer_shop_id") REFERENCES "shops"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "user_source_products"
  ADD CONSTRAINT "user_source_products_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_source_products"
  ADD CONSTRAINT "user_source_products_source_product_id_fkey"
  FOREIGN KEY ("source_product_id") REFERENCES "source_products"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "source_import_items"
  ADD CONSTRAINT "source_import_items_task_id_fkey"
  FOREIGN KEY ("task_id") REFERENCES "source_import_tasks"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "source_import_items"
  ADD CONSTRAINT "source_import_items_source_product_id_fkey"
  FOREIGN KEY ("source_product_id") REFERENCES "source_products"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "source_import_items"
  ADD CONSTRAINT "source_import_items_user_source_product_id_fkey"
  FOREIGN KEY ("user_source_product_id") REFERENCES "user_source_products"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "source_import_tasks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_import_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_source_products" ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE
  "source_import_tasks",
  "source_import_items",
  "user_source_products"
FROM "anon", "authenticated";

REVOKE ALL PRIVILEGES ON SEQUENCE
  "source_import_tasks_id_seq",
  "source_import_items_id_seq",
  "user_source_products_id_seq"
FROM "anon", "authenticated";
