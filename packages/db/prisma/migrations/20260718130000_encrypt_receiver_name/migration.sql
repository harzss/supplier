ALTER TABLE "orders"
ADD COLUMN "receiver_name_enc" VARCHAR(256);

UPDATE "orders"
SET "receiver_name" = CASE
    WHEN BTRIM("receiver_name") = '' THEN '**'
    ELSE LEFT(BTRIM("receiver_name"), 1)
      || REPEAT('*', LEAST(2, GREATEST(1, CHAR_LENGTH(BTRIM("receiver_name")) - 1)))
END
WHERE "receiver_name" IS NOT NULL;
