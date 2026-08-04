\set ON_ERROR_STOP on

-- Exercise the final CHECK definitions without touching business rows or
-- requiring parent records. LIKE ... INCLUDING CONSTRAINTS copies CHECK/NOT
-- NULL rules but intentionally does not copy foreign keys.
BEGIN;

CREATE TEMP TABLE check_exception_case_events
  (LIKE public.exception_case_events INCLUDING CONSTRAINTS)
  ON COMMIT DROP;
CREATE TEMP TABLE check_after_sale_purchase_links
  (LIKE public.after_sale_purchase_links INCLUDING CONSTRAINTS)
  ON COMMIT DROP;
CREATE TEMP TABLE check_after_sale_case_events
  (LIKE public.after_sale_case_events INCLUDING CONSTRAINTS)
  ON COMMIT DROP;

DO $$
DECLARE
  violated_constraint text;
BEGIN
  BEGIN
    INSERT INTO check_exception_case_events (
      id,
      user_id,
      case_id,
      case_revision,
      type,
      from_status,
      to_status,
      created_at
    ) VALUES (
      1,
      1,
      1,
      1,
      'acknowledged',
      NULL,
      'acknowledged',
      CURRENT_TIMESTAMP
    );
    RAISE EXCEPTION 'exception event transition accepted a NULL from_status';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS violated_constraint = CONSTRAINT_NAME;
      IF violated_constraint <> 'exception_case_events_transition_check' THEN
        RAISE EXCEPTION 'unexpected exception event constraint: %', violated_constraint;
      END IF;
  END;

  INSERT INTO check_exception_case_events (
    id,
    user_id,
    case_id,
    case_revision,
    type,
    from_status,
    to_status,
    created_at
  ) VALUES (
    2,
    1,
    1,
    1,
    'acknowledged',
    'open',
    'acknowledged',
    CURRENT_TIMESTAMP
  );

  BEGIN
    INSERT INTO check_after_sale_purchase_links (
      id,
      user_id,
      case_id,
      order_id,
      purchase_order_id,
      status,
      action,
      result,
      purchase_fingerprint,
      bound_source_revision,
      expected_purchase_exception_revision,
      expected_purchase_sync_revision,
      started_at,
      confirmed_at,
      confirmed_by_user_id,
      created_at,
      updated_at
    ) VALUES (
      1,
      1,
      1,
      1,
      1,
      'confirmed',
      'refund',
      NULL,
      repeat('a', 64),
      1,
      0,
      0,
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP,
      1,
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    );
    RAISE EXCEPTION 'confirmed purchase link accepted a NULL result';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS violated_constraint = CONSTRAINT_NAME;
      IF violated_constraint <> 'after_sale_purchase_links_lifecycle_check' THEN
        RAISE EXCEPTION 'unexpected purchase-link constraint: %', violated_constraint;
      END IF;
  END;

  INSERT INTO check_after_sale_purchase_links (
    id,
    user_id,
    case_id,
    order_id,
    purchase_order_id,
    status,
    action,
    result,
    purchase_fingerprint,
    bound_source_revision,
    expected_purchase_exception_revision,
    expected_purchase_sync_revision,
    started_at,
    confirmed_at,
    confirmed_by_user_id,
    created_at,
    updated_at
  ) VALUES (
    2,
    1,
    1,
    1,
    1,
    'confirmed',
    'refund',
    'confirmed',
    repeat('a', 64),
    1,
    0,
    0,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP,
    1,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  );

  BEGIN
    INSERT INTO check_after_sale_case_events (
      id,
      user_id,
      case_id,
      case_revision,
      type,
      client_request_id,
      request_fingerprint,
      from_status,
      to_status,
      source_revision,
      source_fingerprint,
      created_at
    ) VALUES (
      1,
      1,
      1,
      1,
      'claimed',
      '00000000-0000-4000-8000-000000000001',
      repeat('b', 64),
      NULL,
      'handling',
      1,
      repeat('c', 64),
      CURRENT_TIMESTAMP
    );
    RAISE EXCEPTION 'after-sale event transition accepted a NULL from_status';
  EXCEPTION
    WHEN check_violation THEN
      GET STACKED DIAGNOSTICS violated_constraint = CONSTRAINT_NAME;
      IF violated_constraint <> 'after_sale_case_events_transition_check' THEN
        RAISE EXCEPTION 'unexpected after-sale event constraint: %', violated_constraint;
      END IF;
  END;

  INSERT INTO check_after_sale_case_events (
    id,
    user_id,
    case_id,
    case_revision,
    type,
    client_request_id,
    request_fingerprint,
    from_status,
    to_status,
    source_revision,
    source_fingerprint,
    created_at
  ) VALUES (
    2,
    1,
    1,
    1,
    'claimed',
    '00000000-0000-4000-8000-000000000002',
    repeat('b', 64),
    'open',
    'handling',
    1,
    repeat('c', 64),
    CURRENT_TIMESTAMP
  );
END $$;

ROLLBACK;
