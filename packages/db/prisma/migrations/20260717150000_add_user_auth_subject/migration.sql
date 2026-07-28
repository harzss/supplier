ALTER TABLE "users"
ADD COLUMN "auth_subject" UUID;

CREATE UNIQUE INDEX "users_auth_subject_key" ON "users"("auth_subject");
