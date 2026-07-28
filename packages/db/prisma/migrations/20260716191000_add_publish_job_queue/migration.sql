-- CreateEnum
CREATE TYPE "PublishJobStatus" AS ENUM ('queued', 'running', 'retry_wait', 'completed', 'dead');

-- AlterTable
ALTER TABLE "publish_tasks" ADD COLUMN "ai_options" JSONB;

-- CreateTable
CREATE TABLE "publish_jobs" (
    "id" BIGSERIAL NOT NULL,
    "task_id" BIGINT NOT NULL,
    "status" "PublishJobStatus" NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 3,
    "next_run_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_at" TIMESTAMP(3),
    "locked_by" VARCHAR(128),
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "publish_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "publish_jobs_task_id_key" ON "publish_jobs"("task_id");

-- CreateIndex
CREATE INDEX "publish_jobs_status_next_run_at_idx" ON "publish_jobs"("status", "next_run_at");

-- CreateIndex
CREATE INDEX "publish_jobs_locked_at_idx" ON "publish_jobs"("locked_at");

-- AddForeignKey
ALTER TABLE "publish_jobs" ADD CONSTRAINT "publish_jobs_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "publish_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
