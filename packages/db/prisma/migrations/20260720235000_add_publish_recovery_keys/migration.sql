ALTER TABLE "publish_tasks"
  ADD COLUMN "publish_external_ids" JSONB;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "published_products"
    GROUP BY "task_id", "shop_id"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'cannot add published product task/shop uniqueness: duplicate rows require reconciliation';
  END IF;
END $$;

CREATE UNIQUE INDEX "published_products_task_id_shop_id_key"
  ON "published_products"("task_id", "shop_id");
