BEGIN;

CREATE TABLE "runtime_states" (
  "key" VARCHAR(255) NOT NULL,
  "value" JSONB,
  "owner_token" UUID,
  "counter_value" INTEGER,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "runtime_states_pkey" PRIMARY KEY ("key"),
  CONSTRAINT "runtime_states_mode_check" CHECK (
    (
      ("value" IS NOT NULL)::INTEGER
      + ("owner_token" IS NOT NULL)::INTEGER
      + ("counter_value" IS NOT NULL)::INTEGER
    ) = 1
  ),
  CONSTRAINT "runtime_states_counter_check" CHECK (
    ("counter_value" IS NULL OR "counter_value" > 0) IS TRUE
  )
);

CREATE INDEX "runtime_states_expires_at_idx" ON "runtime_states"("expires_at");

ALTER TABLE "runtime_states" ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE "runtime_states" FROM "anon", "authenticated";

COMMIT;
