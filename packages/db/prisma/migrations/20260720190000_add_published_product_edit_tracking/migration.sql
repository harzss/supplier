ALTER TABLE "published_products"
ADD COLUMN "edit_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "last_edit_attempt_at" TIMESTAMP(3),
ADD COLUMN "last_edited_at" TIMESTAMP(3),
ADD COLUMN "last_edit_error" TEXT;
