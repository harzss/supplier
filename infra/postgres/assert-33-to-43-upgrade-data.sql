\set ON_ERROR_STOP on

-- Reusable post-upgrade assertion for a database restored from the 33-migration
-- staging baseline and upgraded to the current 43-migration schema. Every query
-- runs in one read-only transaction; empty business tables pass naturally.
BEGIN TRANSACTION READ ONLY;

DO $post_upgrade_assertions$
DECLARE
  expected_migrations CONSTANT jsonb := $migration_manifest$[
    {"name":"20260612032804_init","checksum":"c58b26d591ce8602d1d4bdab4db2a567792c206704d1c4031e48c52aad6027cf"},
    {"name":"20260716185000_add_product_category_mappings","checksum":"6c2c2be34c349b4de8788fb07d1f9e774fbe60211620f068002e0d035d063e48"},
    {"name":"20260716191000_add_publish_job_queue","checksum":"7d5496a17f3983bea76cf6016b5c42ae73ab648aeef875f91a3579d797671a43"},
    {"name":"20260716194000_add_product_sku_mappings","checksum":"14356173bfc83823de45145a789a9e5ae2170ede26158b8ff6d1ef2eed637d5a"},
    {"name":"20260716203000_add_purchase_order_cost","checksum":"e064cec9b8debbcfef66c04e049be373b25dda5974bb7ad51bd21af4501d670d"},
    {"name":"20260717150000_add_user_auth_subject","checksum":"56dadcc7dcc4bfdb3720a5ffcf76c9f6b263fec60d77a7e0eecf6a8470fcddcb"},
    {"name":"20260717180000_add_audit_and_operational_alerts","checksum":"71ba586cdeeacdff6abba9f11a0d6676652f1f7ea5016d870482a23b2dfc3269"},
    {"name":"20260717183000_backfill_llm_credentials_schema","checksum":"b7217dde9672adbbfdaae93143d11c15f66640e334da8fd8c7873b8ff4bcd63a"},
    {"name":"20260717190000_add_structured_order_address","checksum":"a08d2dca74d63d20b4fc689ff39c04f39ed34633bc2f959dbd7e3c6f033ba1cf"},
    {"name":"20260718100000_add_order_items","checksum":"0b3adacae3390648f33bcc03c8828c86f63bf926aac3f46371b53caa64e64f63"},
    {"name":"20260718110000_add_multi_purchase_orders","checksum":"ae179f1a4b700a4552bccab7caf43239980b89869f9de4abab859dc849da3363"},
    {"name":"20260718120000_add_supplier_and_shipment_item_mapping","checksum":"3a57a62f29d0beed7b1dd085855ac8f50061cb5e676ce00a93adfb9e55a32ec9"},
    {"name":"20260718130000_encrypt_receiver_name","checksum":"14bfb74ef9ec3c2516048f15abeddd8cc6e46a5de3df737e0dc3a03baa83818e"},
    {"name":"20260718213000_add_shop_order_sync_state","checksum":"f166daa65e85db35a67feb8d6c1f1626e695c50492043549310275c2190d17c1"},
    {"name":"20260720120000_add_inventory_sync","checksum":"92866a7d795ff15c6a98760c2154a275c9b79b8782647bf8f789e4ee362b8a73"},
    {"name":"20260720160000_add_shop_category_catalog","checksum":"4981adddedc316afa71b038f52165bcbb237f55482aa06de5d1a3318a86ebc6f"},
    {"name":"20260720170000_add_category_property_mappings","checksum":"7de2ec692ef40b9a6d5fc1fa43358e23380d843c5256e62e7f663a22c34cbc10"},
    {"name":"20260720180000_add_category_qualification_mappings","checksum":"8c1b32d7595ee74ef3ae14ba0348a6e4a11bbcc921e32809129ac96c26452277"},
    {"name":"20260720190000_add_published_product_edit_tracking","checksum":"669c633f81bcde7eda32acc29c0b81cd98cff01d7a5ee9f5b3fdeff22e156abc"},
    {"name":"20260720200000_add_published_product_status_sync","checksum":"d8ab230af47e1d3ee2ee1b81e900799e76641539b1706e9c74f04a700a4259fd"},
    {"name":"20260720210000_add_purchase_exception_tracking","checksum":"48bbe6c16adc5a673b4d87b227f2c84d68a3da71ac69167385db650ae8156275"},
    {"name":"20260720220000_add_partial_refund_disposition","checksum":"1464c63974daa1cbcd73279f48f7d20d1bae6a5fa454d87930c6b87b36a44ec6"},
    {"name":"20260720230000_add_refund_amount_reconciliation","checksum":"bf1b96ec9a7bbffaf456df9a04c99f371f82a088bc2c34a251f7d76d24939ba1"},
    {"name":"20260720234000_add_purchase_cost_reconciliation","checksum":"6e4f7c904a8b83504c058aa4ee9ab5385ebf3f84b5e9f8adbf199e9d929c16d3"},
    {"name":"20260720235000_add_publish_recovery_keys","checksum":"5f00819ecde615788040facf6f3a8208cfda46322dab5602003b20bb5ab0b4fb"},
    {"name":"20260720235500_add_purchase_sync_revision","checksum":"419f76b567e4740c3e89b7674f0750a04e5b1277e1c0dc62c69ec64df8cdd091"},
    {"name":"20260720235600_expand_purchase_carrier","checksum":"de4d75570a59247a58be243deabeabb76cedaa79482b41aef79ad2c5bc1ce0cc"},
    {"name":"20260720235700_add_purchase_exception_revision","checksum":"c3bfb63eee5c17b196fc05cb4b4357aaad2b1d229453a4e044cd7daaefdf53f9"},
    {"name":"20260720235800_add_purchase_retry_history","checksum":"eb74e73dca016c78712d1d0a2315ebd4cf2b3cb541289797db411f87a94e459f"},
    {"name":"20260720235900_add_purchase_logistics_recovery","checksum":"39bee67763e0f522af20c6d5ec9cbe0163c4687b33a2cf02d1c732a168d55100"},
    {"name":"20260722090000_add_settled_purchase_audit_schedule","checksum":"e72472dfb8b211a8e7954443149b169049cc7ab57926a05930f507bfb1a3eb3d"},
    {"name":"20260722091000_add_order_logistics_repairs","checksum":"7b06ca88c1774f6299e96d3bf185cc80a9239918fb538e3d83654a2d846221e7"},
    {"name":"20260803173000_secure_supabase_public_schema","checksum":"a160e5f2dd2cef04012f8690e73850699c4e24f7bef3c2347bf9c0ebd8a75b74"},
    {"name":"20260803200000_add_publish_request_idempotency","checksum":"854a382ce26982fbbec2a73a5b331dc039f2c1698f99711dedadbe81b422f5f3"},
    {"name":"20260804023000_add_publish_drafts","checksum":"87274fcfde1750e365d7bd628f84b03495ce06151a7cfdd92b0f64e875713723"},
    {"name":"20260804050000_add_product_batch_operations","checksum":"815ef7a73c0a34932e21c64eee0588ba8102f3a650d6366c87db5f9b720e3dc2"},
    {"name":"20260804120000_add_published_product_price_snapshot","checksum":"f55a7d95d4aadf80f56523ca2f57ea24d71de154aa77e759734aee380710130f"},
    {"name":"20260804183000_add_published_product_inventory_snapshot","checksum":"da121314146a5a1f30e0f1b5f21a5d26851d25e59b0d53cbe583ab43d19e355a"},
    {"name":"20260804210000_add_source_imports","checksum":"a0ab59e2127ecd5a9c787b27bf3991ca1b1b857d2e47c3d38d15e5f3877982ca"},
    {"name":"20260805010000_add_published_source_bindings","checksum":"1e14dc95cc181f909d21e3d2f8c3f7906db56e3cecc8ee6cdc342b62b0653f5d"},
    {"name":"20260805020000_add_exception_center","checksum":"845ce78692a4f3f7d605104704048d5eeda6b53c9a843dca2ecb396f3225e7e7"},
    {"name":"20260805030000_add_after_sale_cases","checksum":"dfb762ba6a7a90c01e512a9d6cef018fa22cf39a2a208ddecac003a1e1d77165"},
    {"name":"20260805040000_harden_workflow_check_null_semantics","checksum":"55eeb15f2dd2eb9a44e6768c5ef97a3ee72cec30333f94c07a559023356a6d9c"}
  ]$migration_manifest$::jsonb;
  required_tables CONSTANT text[] := ARRAY[
    '_prisma_migrations',
    'published_products',
    'source_products',
    'published_product_source_bindings',
    'order_items',
    'purchase_orders',
    'product_batch_tasks',
    'product_batch_items',
    'source_import_tasks',
    'source_import_items',
    'user_source_products',
    'exception_cases',
    'exception_case_events',
    'after_sale_cases',
    'after_sale_case_items',
    'after_sale_purchase_links',
    'after_sale_case_events'
  ];
  rls_tables CONSTANT text[] := ARRAY[
    'product_batch_tasks',
    'product_batch_items',
    'source_import_tasks',
    'source_import_items',
    'user_source_products',
    'published_product_source_bindings',
    'exception_cases',
    'exception_case_events',
    'after_sale_cases',
    'after_sale_case_items',
    'after_sale_purchase_links',
    'after_sale_case_events'
  ];
  missing_tables text[];
  missing_migrations text[];
  unexpected_migrations text[];
  migration_history_mismatches text[];
  invalid_migration_rows text[];
  applied_migration_count integer;
  duplicate_platform_products text[];
  invalid_current_bindings text[];
  invalid_order_item_snapshots text[];
  missing_exception_codes text[];
  missing_or_unvalidated_checks text[];
  tables_without_rls text[];
BEGIN
  SELECT array_agg(table_name ORDER BY table_name)
  INTO missing_tables
  FROM unnest(required_tables) AS required(table_name)
  WHERE to_regclass(format('public.%I', table_name)) IS NULL;

  IF missing_tables IS NOT NULL THEN
    RAISE EXCEPTION 'required post-upgrade tables are missing: %', missing_tables;
  END IF;

  WITH expected_history AS (
    SELECT entry ->> 'name' AS migration_name
    FROM jsonb_array_elements(expected_migrations) AS manifest(entry)
  )
  SELECT array_agg(expected.migration_name ORDER BY expected.migration_name)
  INTO missing_migrations
  FROM expected_history AS expected
  WHERE NOT EXISTS (
    SELECT 1
    FROM public._prisma_migrations AS applied
    WHERE applied.migration_name = expected.migration_name
      AND applied.finished_at IS NOT NULL
      AND applied.rolled_back_at IS NULL
      AND applied.applied_steps_count > 0
  );

  WITH expected_history AS (
    SELECT entry ->> 'name' AS migration_name
    FROM jsonb_array_elements(expected_migrations) AS manifest(entry)
  )
  SELECT array_agg(applied.migration_name ORDER BY applied.migration_name)
  INTO unexpected_migrations
  FROM public._prisma_migrations AS applied
  WHERE applied.finished_at IS NOT NULL
    AND applied.rolled_back_at IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM expected_history AS expected
      WHERE expected.migration_name = applied.migration_name
    );

  WITH expected_history AS (
    SELECT
      ordinality,
      entry ->> 'name' AS migration_name,
      entry ->> 'checksum' AS checksum
    FROM jsonb_array_elements(expected_migrations)
      WITH ORDINALITY AS manifest(entry, ordinality)
  ),
  applied_history AS (
    SELECT
      row_number() OVER (ORDER BY started_at, id) AS ordinality,
      migration_name,
      checksum
    FROM public._prisma_migrations
  )
  SELECT array_agg(
    format(
      'position=%s(expected=%s/%s,actual=%s/%s)',
      ordinality,
      expected_history.migration_name,
      expected_history.checksum,
      applied_history.migration_name,
      applied_history.checksum
    )
    ORDER BY ordinality
  )
  INTO migration_history_mismatches
  FROM expected_history
  FULL JOIN applied_history USING (ordinality)
  WHERE expected_history.migration_name IS DISTINCT FROM applied_history.migration_name
    OR expected_history.checksum IS DISTINCT FROM applied_history.checksum;

  SELECT array_agg(
    format(
      '%s(id=%s,finished=%s,rolled_back=%s,steps=%s)',
      migration_name,
      id,
      finished_at IS NOT NULL,
      rolled_back_at IS NOT NULL,
      applied_steps_count
    )
    ORDER BY started_at, id
  )
  INTO invalid_migration_rows
  FROM public._prisma_migrations
  WHERE finished_at IS NULL
    OR rolled_back_at IS NOT NULL
    OR applied_steps_count <= 0;

  SELECT count(*)
  INTO applied_migration_count
  FROM public._prisma_migrations
  WHERE finished_at IS NOT NULL
    AND rolled_back_at IS NULL
    AND applied_steps_count > 0;

  IF missing_migrations IS NOT NULL THEN
    RAISE EXCEPTION 'required migrations are not fully applied: %', missing_migrations;
  END IF;
  IF unexpected_migrations IS NOT NULL THEN
    RAISE EXCEPTION 'database contains unexpected applied migrations: %', unexpected_migrations;
  END IF;
  IF migration_history_mismatches IS NOT NULL THEN
    RAISE EXCEPTION 'migration order or checksum differs from the local manifest: %',
      migration_history_mismatches;
  END IF;
  IF invalid_migration_rows IS NOT NULL THEN
    RAISE EXCEPTION 'unfinished, rolled-back, or empty migration rows exist: %', invalid_migration_rows;
  END IF;
  IF applied_migration_count <> jsonb_array_length(expected_migrations) THEN
    RAISE EXCEPTION 'expected exactly % completed migrations, found %',
      jsonb_array_length(expected_migrations), applied_migration_count;
  END IF;

  SELECT array_agg(
    format('shop=%s,platform_product_id=%s,count=%s', shop_id, platform_product_id, row_count)
    ORDER BY shop_id, platform_product_id
  )
  INTO duplicate_platform_products
  FROM (
    SELECT shop_id, platform_product_id, count(*) AS row_count
    FROM public.published_products
    WHERE platform_product_id IS NOT NULL
    GROUP BY shop_id, platform_product_id
    HAVING count(*) > 1
    ORDER BY shop_id, platform_product_id
    LIMIT 20
  ) AS duplicates;

  IF duplicate_platform_products IS NOT NULL THEN
    RAISE EXCEPTION 'duplicate platform product ids exist within a shop: %',
      duplicate_platform_products;
  END IF;

  SELECT array_agg(published_product_id::text ORDER BY published_product_id)
  INTO invalid_current_bindings
  FROM (
    SELECT published_product.id AS published_product_id
    FROM public.published_products AS published_product
    JOIN public.source_products AS source_product
      ON source_product.id = published_product.source_product_id
    LEFT JOIN public.published_product_source_bindings AS binding
      ON binding.published_product_id = published_product.id
      AND binding.current_slot = 1
    GROUP BY
      published_product.id,
      published_product.source_product_id,
      source_product.product_id_1688,
      source_product.supplier_id,
      source_product.is_one_piece_drop
    HAVING count(binding.id) <> 1
      OR count(binding.id) FILTER (
        WHERE binding.source_product_id = published_product.source_product_id
          AND binding.source_offer_id = source_product.product_id_1688
          AND binding.source_supplier_id IS NOT DISTINCT FROM source_product.supplier_id
          AND binding.source_one_piece_drop = source_product.is_one_piece_drop
          AND binding.effective_to IS NULL
      ) <> 1
    ORDER BY published_product.id
    LIMIT 20
  ) AS invalid_bindings;

  IF invalid_current_bindings IS NOT NULL THEN
    RAISE EXCEPTION 'published products without exactly one matching current source binding: %',
      invalid_current_bindings;
  END IF;

  -- M40 must freeze binding, cost, and one-piece facts for every historical
  -- order item that still references a published product. Legacy offer and
  -- supplier ids are optional evidence, so compare them only when non-empty.
  SELECT array_agg(order_item_id::text ORDER BY order_item_id)
  INTO invalid_order_item_snapshots
  FROM (
    SELECT order_item.id AS order_item_id
    FROM public.order_items AS order_item
    LEFT JOIN public.published_product_source_bindings AS binding
      ON binding.id = order_item.source_binding_id
    WHERE order_item.published_product_id IS NOT NULL
      AND (
        order_item.source_binding_id IS NULL
        OR order_item.source_unit_cost IS NULL
        OR order_item.source_unit_cost <= 0
        OR order_item.source_one_piece_drop IS NULL
        OR binding.id IS NULL
        OR binding.published_product_id <> order_item.published_product_id
        OR (
          NULLIF(btrim(order_item.source_offer_id), '') IS NOT NULL
          AND binding.source_offer_id IS DISTINCT FROM order_item.source_offer_id
        )
        OR (
          NULLIF(btrim(order_item.source_supplier_id), '') IS NOT NULL
          AND binding.source_supplier_id IS DISTINCT FROM order_item.source_supplier_id
        )
        OR binding.source_one_piece_drop IS DISTINCT FROM order_item.source_one_piece_drop
      )
    ORDER BY order_item.id
    LIMIT 20
  ) AS invalid_snapshots;

  IF invalid_order_item_snapshots IS NOT NULL THEN
    RAISE EXCEPTION 'published order items have missing or mismatched source snapshots: %',
      invalid_order_item_snapshots;
  END IF;

  SELECT array_agg(id::text ORDER BY id)
  INTO missing_exception_codes
  FROM (
    SELECT id
    FROM public.purchase_orders
    WHERE exception_status IN ('stopped', 'action_required')
      AND NULLIF(btrim(exception_code), '') IS NULL
    ORDER BY id
    LIMIT 20
  ) AS unresolved_without_code;

  IF missing_exception_codes IS NOT NULL THEN
    RAISE EXCEPTION 'unresolved purchase exceptions are missing structured codes: %',
      missing_exception_codes;
  END IF;

  WITH expected_checks(table_name, constraint_name) AS (
    VALUES
      ('exception_case_events', 'exception_case_events_transition_check'),
      ('after_sale_purchase_links', 'after_sale_purchase_links_lifecycle_check'),
      ('after_sale_case_events', 'after_sale_case_events_transition_check')
  )
  SELECT array_agg(format('%s.%s', table_name, constraint_name) ORDER BY table_name, constraint_name)
  INTO missing_or_unvalidated_checks
  FROM expected_checks
  WHERE NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_record
    JOIN pg_catalog.pg_class AS relation
      ON relation.oid = constraint_record.conrelid
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relname = expected_checks.table_name
      AND constraint_record.conname = expected_checks.constraint_name
      AND constraint_record.contype = 'c'
      AND constraint_record.convalidated
      AND position('IS TRUE' IN pg_get_constraintdef(constraint_record.oid)) > 0
  );

  IF missing_or_unvalidated_checks IS NOT NULL THEN
    RAISE EXCEPTION 'required strict workflow CHECK constraints are missing or unvalidated: %',
      missing_or_unvalidated_checks;
  END IF;

  SELECT array_agg(table_name ORDER BY table_name)
  INTO tables_without_rls
  FROM unnest(rls_tables) AS required(table_name)
  WHERE NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relname = required.table_name
      AND relation.relkind IN ('r', 'p')
      AND relation.relrowsecurity
  );

  IF tables_without_rls IS NOT NULL THEN
    RAISE EXCEPTION 'required post-upgrade tables without RLS: %', tables_without_rls;
  END IF;
END
$post_upgrade_assertions$;

COMMIT;
