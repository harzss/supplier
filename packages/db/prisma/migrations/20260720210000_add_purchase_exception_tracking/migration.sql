CREATE TYPE "PurchaseExceptionStatus" AS ENUM ('none', 'stopped', 'action_required', 'resolved');
CREATE TYPE "OrderAfterSaleStatus" AS ENUM ('none', 'pending', 'partial_refund', 'refunded', 'failed');

ALTER TABLE "orders"
ADD COLUMN "after_sale_status" "OrderAfterSaleStatus" NOT NULL DEFAULT 'none',
ADD COLUMN "after_sale_synced_at" TIMESTAMP(3);

ALTER TABLE "order_items"
ADD COLUMN "after_sale_status_raw" INTEGER,
ADD COLUMN "refund_status_raw" INTEGER;

ALTER TABLE "purchase_orders"
ADD COLUMN "exception_status" "PurchaseExceptionStatus" NOT NULL DEFAULT 'none',
ADD COLUMN "exception_reason" TEXT,
ADD COLUMN "exception_detected_at" TIMESTAMP(3),
ADD COLUMN "exception_resolved_at" TIMESTAMP(3),
ADD COLUMN "exception_resolution_note" TEXT;

CREATE INDEX "purchase_orders_exception_status_idx" ON "purchase_orders"("exception_status");
CREATE INDEX "orders_after_sale_status_idx" ON "orders"("after_sale_status");

UPDATE "orders"
SET
  "after_sale_status" = 'refunded',
  "after_sale_synced_at" = CURRENT_TIMESTAMP
WHERE "status" = 'refunded';

UPDATE "purchase_orders" AS purchase
SET
  "exception_status" = CASE
    WHEN purchase."order_id_1688" IS NULL AND purchase."status" IN ('pending', 'failed')
      THEN 'stopped'::"PurchaseExceptionStatus"
    ELSE 'action_required'::"PurchaseExceptionStatus"
  END,
  "exception_reason" = CASE
    WHEN purchase."order_id_1688" IS NULL AND purchase."status" IN ('pending', 'failed')
      THEN '销售订单已退款或关闭，采购尚未提交到 1688，系统已自动停止。'
    ELSE '销售订单已退款或关闭，但 1688 采购单已创建或已推进，请人工处理取消、退款或物流拦截。'
  END,
  "exception_detected_at" = CURRENT_TIMESTAMP
FROM "orders" AS sales_order
WHERE purchase."order_id" = sales_order."id"
  AND sales_order."status" IN ('refunded', 'closed')
  AND purchase."exception_status" = 'none';
