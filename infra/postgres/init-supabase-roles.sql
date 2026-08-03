-- Supabase provides these PostgREST roles before project migrations run.
-- Keep local clean-database migration behavior aligned with that prerequisite.
DO $$
BEGIN
  CREATE ROLE anon NOLOGIN;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  CREATE ROLE authenticated NOLOGIN;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;
