-- Forward assertion for the Supabase PostgreSQL runtime-state migration.
-- Migration 45 must remain the exact prefix; later migrations may follow it.
BEGIN TRANSACTION READ ONLY;

DO $runtime_state_forward_assertions$
DECLARE
  migration_44_position integer;
  migration_45_position integer;
  applied_migration_count integer;
  invalid_columns text[];
  invalid_constraints text[];
  runtime_state_rls boolean;
  client_table_privileges text[];
BEGIN
  WITH applied AS (
    SELECT
      migration_name,
      row_number() OVER (ORDER BY started_at, id)::integer AS position
    FROM public._prisma_migrations
    WHERE finished_at IS NOT NULL
      AND rolled_back_at IS NULL
      AND applied_steps_count > 0
  )
  SELECT
    max(position) FILTER (
      WHERE migration_name = '20260807110000_add_published_product_sku_edits'
    ),
    max(position) FILTER (
      WHERE migration_name = '20260807150000_add_runtime_state_store'
    ),
    count(*)::integer
  INTO migration_44_position, migration_45_position, applied_migration_count
  FROM applied;

  IF migration_44_position <> 44
    OR migration_45_position <> 45
    OR applied_migration_count < 45 THEN
    RAISE EXCEPTION
      'expected completed migrations 44 and 45 as the exact prefix, found old=% new=% count=%',
      migration_44_position,
      migration_45_position,
      applied_migration_count;
  END IF;

  IF to_regclass('public.runtime_states') IS NULL THEN
    RAISE EXCEPTION 'runtime_states table is missing';
  END IF;

  SELECT array_agg(expected.column_name ORDER BY expected.column_name)
  INTO invalid_columns
  FROM (
    VALUES
      ('key', 'character varying', 255, 'NO'),
      ('value', 'jsonb', NULL::integer, 'YES'),
      ('owner_token', 'uuid', NULL::integer, 'YES'),
      ('counter_value', 'integer', NULL::integer, 'YES'),
      ('expires_at', 'timestamp with time zone', NULL::integer, 'NO'),
      ('created_at', 'timestamp with time zone', NULL::integer, 'NO'),
      ('updated_at', 'timestamp with time zone', NULL::integer, 'NO')
  ) AS expected(column_name, data_type, character_maximum_length, is_nullable)
  LEFT JOIN information_schema.columns AS actual
    ON actual.table_schema = 'public'
    AND actual.table_name = 'runtime_states'
    AND actual.column_name = expected.column_name
  WHERE actual.column_name IS NULL
    OR actual.data_type <> expected.data_type
    OR actual.character_maximum_length IS DISTINCT FROM expected.character_maximum_length
    OR actual.is_nullable <> expected.is_nullable;

  IF invalid_columns IS NOT NULL THEN
    RAISE EXCEPTION 'runtime_states columns are missing or invalid: %', invalid_columns;
  END IF;

  SELECT array_agg(expected.constraint_name ORDER BY expected.constraint_name)
  INTO invalid_constraints
  FROM (
    VALUES
      ('runtime_states_pkey', 'p'),
      ('runtime_states_mode_check', 'c'),
      ('runtime_states_counter_check', 'c')
  ) AS expected(constraint_name, constraint_type)
  LEFT JOIN pg_constraint AS actual
    ON actual.conname = expected.constraint_name
    AND actual.conrelid = 'public.runtime_states'::regclass
    AND actual.contype::text = expected.constraint_type
    AND actual.convalidated
  WHERE actual.oid IS NULL;

  IF invalid_constraints IS NOT NULL THEN
    RAISE EXCEPTION 'runtime_states constraints are missing or invalid: %', invalid_constraints;
  END IF;

  IF to_regclass('public.runtime_states_expires_at_idx') IS NULL THEN
    RAISE EXCEPTION 'runtime_states expiry index is missing';
  END IF;

  SELECT rowsecurity
  INTO runtime_state_rls
  FROM pg_tables
  WHERE schemaname = 'public'
    AND tablename = 'runtime_states';

  IF runtime_state_rls IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'runtime_states must have RLS enabled';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'runtime_states'
  ) THEN
    RAISE EXCEPTION 'runtime_states must not expose client RLS policies';
  END IF;

  SELECT array_agg(client_role ORDER BY client_role)
  INTO client_table_privileges
  FROM unnest(ARRAY['anon', 'authenticated']) AS client_role
  WHERE has_table_privilege(
    client_role,
    'public.runtime_states',
    'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
  );

  IF client_table_privileges IS NOT NULL THEN
    RAISE EXCEPTION 'client roles retain runtime_states privileges: %',
      client_table_privileges;
  END IF;
END
$runtime_state_forward_assertions$;

COMMIT;
