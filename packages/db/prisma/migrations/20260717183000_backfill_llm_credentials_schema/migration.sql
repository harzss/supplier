-- Historical application work introduced BYOK through schema sync without a committed migration.
-- Keep this corrective migration idempotent so environments that already have the objects remain safe.

DO $$
BEGIN
  CREATE TYPE "LlmProviderName" AS ENUM ('openai', 'anthropic', 'deepseek', 'dashscope');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE "LlmCredentialStatus" AS ENUM ('active', 'disabled');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "ai_usage_logs"
  ADD COLUMN IF NOT EXISTS "via_byok" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "llm_credentials" (
  "id" BIGSERIAL NOT NULL,
  "user_id" BIGINT NOT NULL,
  "provider" "LlmProviderName" NOT NULL,
  "api_key_enc" VARCHAR(1024) NOT NULL,
  "label" VARCHAR(64),
  "status" "LlmCredentialStatus" NOT NULL DEFAULT 'active',
  "last_used_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "llm_credentials_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "llm_credentials_user_id_key"
  ON "llm_credentials"("user_id");

DROP INDEX IF EXISTS "ai_usage_logs_user_id_created_at_idx";
CREATE INDEX IF NOT EXISTS "ai_usage_logs_user_id_via_byok_created_at_idx"
  ON "ai_usage_logs"("user_id", "via_byok", "created_at");

DO $$
BEGIN
  ALTER TABLE "llm_credentials"
    ADD CONSTRAINT "llm_credentials_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
