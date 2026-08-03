ALTER TABLE "publish_tasks"
  ADD COLUMN "client_request_id" UUID;

CREATE UNIQUE INDEX "uk_publish_tasks_user_client_request"
  ON "publish_tasks"("user_id", "client_request_id");
