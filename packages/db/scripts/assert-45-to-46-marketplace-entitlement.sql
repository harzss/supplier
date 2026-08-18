-- Forward assertion for the marketplace entitlement foundation migration.
-- Migration 46 must remain the exact prefix; later migrations may follow it.
BEGIN TRANSACTION READ ONLY;

DO $marketplace_entitlement_forward_assertions$
DECLARE
  migration_45_position integer;
  migration_46_position integer;
  applied_migration_count integer;
  missing_tables text[];
  invalid_user_columns text[];
  invalid_event_columns text[];
  invalid_constraints text[];
  missing_indexes text[];
  invalid_partial_indexes text[];
  tables_without_rls text[];
  exposed_policies text[];
  client_table_privileges text[];
  client_column_privileges text[];
  client_sequence_privileges text[];
  invalid_user_backfill bigint;
  invalid_legacy_projections bigint;
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
      WHERE migration_name = '20260807150000_add_runtime_state_store'
    ),
    max(position) FILTER (
      WHERE migration_name = '20260818034357_add_marketplace_entitlement_foundation'
    ),
    count(*)::integer
  INTO migration_45_position, migration_46_position, applied_migration_count
  FROM applied;

  IF migration_45_position <> 45
    OR migration_46_position <> 46
    OR applied_migration_count < 46 THEN
    RAISE EXCEPTION
      'expected completed migrations 45 and 46 as the exact prefix, found old=% new=% count=%',
      migration_45_position,
      migration_46_position,
      applied_migration_count;
  END IF;

  SELECT array_agg(expected.table_name ORDER BY expected.table_name)
  INTO missing_tables
  FROM unnest(ARRAY[
    'marketplace_account_bindings',
    'marketplace_plan_mappings',
    'marketplace_subscription_projections',
    'marketplace_event_inbox'
  ]) AS expected(table_name)
  WHERE to_regclass(format('public.%I', expected.table_name)) IS NULL;

  IF missing_tables IS NOT NULL THEN
    RAISE EXCEPTION 'marketplace entitlement tables are missing: %', missing_tables;
  END IF;

  SELECT array_agg(expected.column_name ORDER BY expected.column_name)
  INTO invalid_user_columns
  FROM (
    VALUES
      ('entitlement_source', 'EntitlementSource', 'internal_beta'),
      ('entitlement_access_status', 'EntitlementAccessStatus', 'active'),
      ('entitlement_revision', 'int4', '1'),
      ('entitlement_updated_at', 'timestamptz', NULL::text)
  ) AS expected(column_name, udt_name, default_fragment)
  LEFT JOIN information_schema.columns AS actual
    ON actual.table_schema = 'public'
    AND actual.table_name = 'users'
    AND actual.column_name = expected.column_name
  WHERE actual.column_name IS NULL
    OR actual.udt_name <> expected.udt_name
    OR actual.is_nullable <> 'NO'
    OR actual.column_default IS NULL
    OR (
      expected.default_fragment IS NOT NULL
      AND position(expected.default_fragment IN actual.column_default) = 0
    );

  IF invalid_user_columns IS NOT NULL THEN
    RAISE EXCEPTION 'users entitlement columns are missing or invalid: %', invalid_user_columns;
  END IF;

  SELECT array_agg(expected.column_name ORDER BY expected.column_name)
  INTO invalid_event_columns
  FROM (
    VALUES ('authoritative_state', 'MarketplaceLifecycleState', 'YES')
  ) AS expected(column_name, udt_name, is_nullable)
  LEFT JOIN information_schema.columns AS actual
    ON actual.table_schema = 'public'
    AND actual.table_name = 'marketplace_event_inbox'
    AND actual.column_name = expected.column_name
  WHERE actual.column_name IS NULL
    OR actual.udt_name <> expected.udt_name
    OR actual.is_nullable <> expected.is_nullable;

  IF invalid_event_columns IS NOT NULL THEN
    RAISE EXCEPTION 'marketplace event columns are missing or invalid: %', invalid_event_columns;
  END IF;

  SELECT array_agg(expected.constraint_name ORDER BY expected.constraint_name)
  INTO invalid_constraints
  FROM (
    VALUES
      ('users_entitlement_revision_check', 'users'),
      ('marketplace_account_binding_keys_check', 'marketplace_account_bindings'),
      ('marketplace_account_binding_revision_check', 'marketplace_account_bindings'),
      ('marketplace_account_binding_digest_check', 'marketplace_account_bindings'),
      ('marketplace_account_binding_status_check', 'marketplace_account_bindings'),
      ('marketplace_plan_mapping_keys_check', 'marketplace_plan_mappings'),
      ('marketplace_plan_mapping_revision_check', 'marketplace_plan_mappings'),
      ('marketplace_plan_mapping_digest_check', 'marketplace_plan_mappings'),
      ('marketplace_projection_key_check', 'marketplace_subscription_projections'),
      ('marketplace_projection_origin_check', 'marketplace_subscription_projections'),
      ('marketplace_projection_access_check', 'marketplace_subscription_projections'),
      ('marketplace_projection_revision_check', 'marketplace_subscription_projections'),
      ('marketplace_projection_effective_check', 'marketplace_subscription_projections'),
      ('marketplace_projection_amount_check', 'marketplace_subscription_projections'),
      ('marketplace_projection_currency_check', 'marketplace_subscription_projections'),
      ('marketplace_event_keys_check', 'marketplace_event_inbox'),
      ('marketplace_event_digest_check', 'marketplace_event_inbox'),
      ('marketplace_event_callback_check', 'marketplace_event_inbox'),
      ('marketplace_event_authoritative_state_check', 'marketplace_event_inbox'),
      ('marketplace_event_attempts_check', 'marketplace_event_inbox'),
      ('marketplace_event_processing_check', 'marketplace_event_inbox'),
      ('marketplace_event_applied_check', 'marketplace_event_inbox'),
      ('marketplace_event_timestamps_check', 'marketplace_event_inbox')
  ) AS expected(constraint_name, table_name)
  LEFT JOIN pg_constraint AS actual
    ON actual.conname = expected.constraint_name
    AND actual.conrelid = format('public.%I', expected.table_name)::regclass
    AND actual.convalidated
  WHERE actual.oid IS NULL;

  IF invalid_constraints IS NOT NULL THEN
    RAISE EXCEPTION 'marketplace entitlement constraints are missing or invalid: %',
      invalid_constraints;
  END IF;

  SELECT array_agg(expected.index_name ORDER BY expected.index_name)
  INTO missing_indexes
  FROM unnest(ARRAY[
    'users_entitlement_source_entitlement_access_status_idx',
    'marketplace_account_bindings_external_key',
    'marketplace_account_bindings_user_id_status_idx',
    'marketplace_plan_mappings_provider_key',
    'marketplace_plan_mappings_internal_plan_enabled_idx',
    'marketplace_projection_key',
    'marketplace_projection_legacy_key',
    'marketplace_projection_external_key',
    'marketplace_projection_user_active_key',
    'marketplace_subscription_projections_user_id_access_status_idx',
    'marketplace_subscription_projections_account_binding_id_idx',
    'marketplace_subscription_projections_plan_mapping_id_idx',
    'marketplace_event_inbox_dedupe_key',
    'marketplace_event_inbox_account_binding_id_idx',
    'marketplace_event_inbox_plan_mapping_id_idx',
    'marketplace_event_inbox_projection_id_idx',
    'marketplace_event_inbox_subscription_revision_idx',
    'marketplace_event_inbox_ready_idx',
    'marketplace_event_inbox_processing_lease_idx'
  ]) AS expected(index_name)
  WHERE to_regclass(format('public.%I', expected.index_name)) IS NULL;

  IF missing_indexes IS NOT NULL THEN
    RAISE EXCEPTION 'marketplace entitlement indexes are missing: %', missing_indexes;
  END IF;

  WITH actual_indexes AS (
    SELECT
      index_class.relname AS index_name,
      index_record.indisunique,
      pg_get_expr(index_record.indpred, index_record.indrelid) AS predicate
    FROM pg_index AS index_record
    JOIN pg_class AS index_class ON index_class.oid = index_record.indexrelid
    JOIN pg_namespace AS namespace ON namespace.oid = index_class.relnamespace
    WHERE namespace.nspname = 'public'
  )
  SELECT array_agg(expected.index_name ORDER BY expected.index_name)
  INTO invalid_partial_indexes
  FROM (
    VALUES
      ('marketplace_projection_external_key', true, ARRAY['marketplace']),
      ('marketplace_projection_user_active_key', true, ARRAY['marketplace', 'active']),
      ('marketplace_event_inbox_ready_idx', false, ARRAY['received', 'retry_wait']),
      ('marketplace_event_inbox_processing_lease_idx', false, ARRAY['processing'])
  ) AS expected(index_name, unique_required, predicate_fragments)
  LEFT JOIN actual_indexes AS actual ON actual.index_name = expected.index_name
  WHERE actual.index_name IS NULL
    OR actual.indisunique IS DISTINCT FROM expected.unique_required
    OR actual.predicate IS NULL
    OR EXISTS (
      SELECT 1
      FROM unnest(expected.predicate_fragments) AS fragment
      WHERE position(fragment IN actual.predicate) = 0
    );

  IF invalid_partial_indexes IS NOT NULL THEN
    RAISE EXCEPTION 'marketplace partial indexes are missing or invalid: %',
      invalid_partial_indexes;
  END IF;

  SELECT array_agg(expected.table_name ORDER BY expected.table_name)
  INTO tables_without_rls
  FROM unnest(ARRAY[
    'marketplace_account_bindings',
    'marketplace_plan_mappings',
    'marketplace_subscription_projections',
    'marketplace_event_inbox'
  ]) AS expected(table_name)
  LEFT JOIN pg_tables AS actual
    ON actual.schemaname = 'public'
    AND actual.tablename = expected.table_name
  WHERE actual.rowsecurity IS DISTINCT FROM true;

  IF tables_without_rls IS NOT NULL THEN
    RAISE EXCEPTION 'marketplace entitlement tables must have RLS enabled: %', tables_without_rls;
  END IF;

  SELECT array_agg(format('%s:%s', tablename, policyname) ORDER BY tablename, policyname)
  INTO exposed_policies
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename = ANY (ARRAY[
      'marketplace_account_bindings',
      'marketplace_plan_mappings',
      'marketplace_subscription_projections',
      'marketplace_event_inbox'
    ]);

  IF exposed_policies IS NOT NULL THEN
    RAISE EXCEPTION 'marketplace entitlement tables must not expose client policies: %',
      exposed_policies;
  END IF;

  WITH client_roles AS (
    SELECT rolname
    FROM pg_roles
    WHERE rolname IN ('anon', 'authenticated', 'service_role')
  ), marketplace_tables AS (
    SELECT unnest(ARRAY[
      'marketplace_account_bindings',
      'marketplace_plan_mappings',
      'marketplace_subscription_projections',
      'marketplace_event_inbox'
    ]) AS table_name
  )
  SELECT array_agg(format('%s:%s', rolname, table_name) ORDER BY rolname, table_name)
  INTO client_table_privileges
  FROM client_roles
  CROSS JOIN marketplace_tables
  WHERE has_table_privilege(
    rolname,
    format('public.%I', table_name),
    'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
  );

  IF client_table_privileges IS NOT NULL THEN
    RAISE EXCEPTION 'client roles retain marketplace table privileges: %',
      client_table_privileges;
  END IF;

  WITH client_roles AS (
    SELECT rolname
    FROM pg_roles
    WHERE rolname IN ('anon', 'authenticated', 'service_role')
  ), marketplace_tables AS (
    SELECT unnest(ARRAY[
      'marketplace_account_bindings',
      'marketplace_plan_mappings',
      'marketplace_subscription_projections',
      'marketplace_event_inbox'
    ]) AS table_name
  )
  SELECT array_agg(format('%s:%s', rolname, table_name) ORDER BY rolname, table_name)
  INTO client_column_privileges
  FROM client_roles
  CROSS JOIN marketplace_tables
  WHERE has_any_column_privilege(
    rolname,
    format('public.%I', table_name),
    'SELECT,INSERT,UPDATE,REFERENCES'
  );

  IF client_column_privileges IS NOT NULL THEN
    RAISE EXCEPTION 'client roles retain marketplace column privileges: %',
      client_column_privileges;
  END IF;

  WITH client_roles AS (
    SELECT rolname
    FROM pg_roles
    WHERE rolname IN ('anon', 'authenticated', 'service_role')
  ), marketplace_sequences AS (
    SELECT unnest(ARRAY[
      'marketplace_account_bindings_id_seq',
      'marketplace_plan_mappings_id_seq',
      'marketplace_subscription_projections_id_seq',
      'marketplace_event_inbox_id_seq'
    ]) AS sequence_name
  )
  SELECT array_agg(format('%s:%s', rolname, sequence_name) ORDER BY rolname, sequence_name)
  INTO client_sequence_privileges
  FROM client_roles
  CROSS JOIN marketplace_sequences
  WHERE has_sequence_privilege(
    rolname,
    format('public.%I', sequence_name),
    'USAGE,SELECT,UPDATE'
  );

  IF client_sequence_privileges IS NOT NULL THEN
    RAISE EXCEPTION 'client roles retain marketplace sequence privileges: %',
      client_sequence_privileges;
  END IF;

  SELECT count(*)
  INTO invalid_user_backfill
  FROM public.users
  WHERE entitlement_source <> 'internal_beta'
    OR entitlement_access_status <> 'active'
    OR entitlement_revision <> 1
    OR entitlement_updated_at IS NULL;

  IF invalid_user_backfill <> 0 THEN
    RAISE EXCEPTION 'existing users have invalid entitlement defaults: % rows',
      invalid_user_backfill;
  END IF;

  SELECT count(*)
  INTO invalid_legacy_projections
  FROM public.subscriptions AS subscription
  FULL OUTER JOIN (
    SELECT *
    FROM public.marketplace_subscription_projections
    WHERE origin = 'legacy'
  ) AS projection
    ON projection.legacy_subscription_id = subscription.id
  WHERE subscription.id IS NULL
    OR projection.id IS NULL
    OR projection.projection_key <> 'legacy:' || subscription.id::text
    OR projection.user_id <> subscription.user_id
    OR projection.internal_plan IS DISTINCT FROM subscription.plan
    OR projection.lifecycle_state::text IS DISTINCT FROM subscription.status::text
    OR projection.access_status <> 'unverified'
    OR projection.provider IS NOT NULL
    OR projection.integration_key IS NOT NULL
    OR projection.external_subscription_key IS NOT NULL
    OR projection.account_binding_id IS NOT NULL
    OR projection.plan_mapping_id IS NOT NULL
    OR projection.provider_revision IS NOT NULL
    OR projection.projection_revision <> 1
    OR projection.effective_start_at IS NOT NULL
    OR projection.effective_end_at IS NOT NULL
    OR projection.amount_cny IS DISTINCT FROM subscription.amount_cny
    OR projection.currency <> 'CNY'
    OR projection.last_event_occurred_at IS NOT NULL
    OR projection.last_reconciled_at IS NOT NULL
    OR projection.superseded_at IS NOT NULL
    OR projection.created_at IS DISTINCT FROM subscription.created_at AT TIME ZONE 'UTC';

  IF invalid_legacy_projections <> 0 THEN
    RAISE EXCEPTION 'legacy subscription projection backfill is invalid: % rows',
      invalid_legacy_projections;
  END IF;
END
$marketplace_entitlement_forward_assertions$;

COMMIT;
