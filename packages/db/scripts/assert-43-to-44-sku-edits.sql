-- Forward-prefix assertion for M87. The historical 33-to-43 assertion runs
-- before migration 44 and remains unchanged; later migrations may follow 44.
BEGIN TRANSACTION READ ONLY;

DO $sku_edit_forward_assertions$
DECLARE
  migration_43_position integer;
  migration_44_position integer;
  applied_migration_count integer;
  invalid_columns text[];
  invalid_constraints text[];
  backfilled_products bigint;
  published_products_rls boolean;
  client_table_privileges text[];
  client_column_privileges text[];
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
      WHERE migration_name = '20260805040000_harden_workflow_check_null_semantics'
    ),
    max(position) FILTER (
      WHERE migration_name = '20260807110000_add_published_product_sku_edits'
    ),
    count(*)::integer
  INTO migration_43_position, migration_44_position, applied_migration_count
  FROM applied;

  IF migration_43_position <> 43
    OR migration_44_position <> 44
    OR applied_migration_count < 44 THEN
    RAISE EXCEPTION
      'expected completed migrations 43 and 44 as the exact prefix, found old=% new=% count=%',
      migration_43_position,
      migration_44_position,
      applied_migration_count;
  END IF;

  SELECT array_agg(expected.column_name ORDER BY expected.column_name)
  INTO invalid_columns
  FROM (
    VALUES
      ('sku_spec_snapshot', 'jsonb', NULL::integer),
      ('sku_spec_fingerprint', 'character varying', 64),
      ('sku_spec_synced_at', 'timestamp without time zone', NULL::integer)
  ) AS expected(column_name, data_type, character_maximum_length)
  LEFT JOIN information_schema.columns AS actual
    ON actual.table_schema = 'public'
    AND actual.table_name = 'published_products'
    AND actual.column_name = expected.column_name
  WHERE actual.column_name IS NULL
    OR actual.data_type <> expected.data_type
    OR actual.is_nullable <> 'YES'
    OR actual.character_maximum_length IS DISTINCT FROM expected.character_maximum_length;

  IF invalid_columns IS NOT NULL THEN
    RAISE EXCEPTION 'published_products SKU spec columns are missing or invalid: %', invalid_columns;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_enum
    JOIN pg_type ON pg_type.oid = pg_enum.enumtypid
    JOIN pg_namespace ON pg_namespace.oid = pg_type.typnamespace
    WHERE pg_namespace.nspname = 'public'
      AND pg_type.typname = 'ProductBatchAction'
      AND pg_enum.enumlabel = 'edit_sku'
  ) THEN
    RAISE EXCEPTION 'ProductBatchAction.edit_sku is missing';
  END IF;

  SELECT array_agg(expected.constraint_name ORDER BY expected.constraint_name)
  INTO invalid_constraints
  FROM (
    VALUES ('published_products_sku_spec_snapshot_check')
  ) AS expected(constraint_name)
  LEFT JOIN pg_constraint AS actual
    ON actual.conname = expected.constraint_name
    AND actual.conrelid = 'public.published_products'::regclass
    AND actual.contype = 'c'
    AND actual.convalidated
  WHERE actual.oid IS NULL;

  IF invalid_constraints IS NOT NULL THEN
    RAISE EXCEPTION 'published_products SKU spec constraints are missing or invalid: %',
      invalid_constraints;
  END IF;

  SELECT count(*)
  INTO backfilled_products
  FROM public.published_products
  WHERE sku_spec_snapshot IS NOT NULL
    OR sku_spec_fingerprint IS NOT NULL
    OR sku_spec_synced_at IS NOT NULL;

  IF backfilled_products <> 0 THEN
    RAISE EXCEPTION
      'migration 44 must not backfill non-authoritative platform SKU snapshots: % rows changed',
      backfilled_products;
  END IF;

  SELECT rowsecurity
  INTO published_products_rls
  FROM pg_tables
  WHERE schemaname = 'public'
    AND tablename = 'published_products';

  IF published_products_rls IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'published_products must keep RLS enabled';
  END IF;

  SELECT array_agg(client_role ORDER BY client_role)
  INTO client_table_privileges
  FROM unnest(ARRAY['anon', 'authenticated']) AS client_role
  WHERE has_table_privilege(
    client_role,
    'public.published_products',
    'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
  );

  IF client_table_privileges IS NOT NULL THEN
    RAISE EXCEPTION 'client roles retain published_products privileges: %',
      client_table_privileges;
  END IF;

  SELECT array_agg(
    format('%s:%s', client_role, column_name)
    ORDER BY client_role, column_name
  )
  INTO client_column_privileges
  FROM unnest(ARRAY['anon', 'authenticated']) AS client_role
  CROSS JOIN unnest(
    ARRAY['sku_spec_snapshot', 'sku_spec_fingerprint', 'sku_spec_synced_at']
  ) AS column_name
  WHERE has_column_privilege(
    client_role,
    'public.published_products',
    column_name,
    'SELECT,INSERT,UPDATE,REFERENCES'
  );

  IF client_column_privileges IS NOT NULL THEN
    RAISE EXCEPTION 'client roles retain published_products SKU column privileges: %',
      client_column_privileges;
  END IF;
END
$sku_edit_forward_assertions$;

COMMIT;
