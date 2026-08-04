-- PostgreSQL CHECK constraints accept both TRUE and NULL. The original workflow
-- checks used nullable transition/result columns in equality predicates, so a
-- NULL could make the whole predicate UNKNOWN and bypass the intended state
-- machine. Recreate the checks with an explicit IS TRUE boundary.
BEGIN;

ALTER TABLE "exception_case_events"
  DROP CONSTRAINT "exception_case_events_transition_check",
  ADD CONSTRAINT "exception_case_events_transition_check"
    CHECK (
      (
        (
          "type" = 'opened'
          AND "from_status" IS NULL
          AND "to_status" = 'open'
        )
        OR (
          "type" = 'updated'
          AND (
            ("from_status" IS NULL AND "to_status" IS NULL)
            OR "from_status" = "to_status"
          )
        )
        OR (
          "type" = 'reopened'
          AND "from_status" IN ('acknowledged', 'resolved')
          AND "to_status" = 'open'
        )
        OR (
          "type" = 'acknowledged'
          AND "from_status" = 'open'
          AND "to_status" = 'acknowledged'
        )
        OR (
          "type" = 'resolved'
          AND "from_status" IN ('open', 'acknowledged')
          AND "to_status" = 'resolved'
          AND "note" IS NOT NULL
          AND btrim("note") <> ''
          AND "evidence" IS NOT NULL
        )
      ) IS TRUE
    );

ALTER TABLE "after_sale_purchase_links"
  DROP CONSTRAINT "after_sale_purchase_links_lifecycle_check",
  ADD CONSTRAINT "after_sale_purchase_links_lifecycle_check"
    CHECK (
      (
        (
          "status" IN ('not_required', 'action_required')
          AND "action" = 'none'
          AND "result" IS NULL
          AND "started_at" IS NULL
          AND "confirmed_at" IS NULL
          AND "confirmed_by_user_id" IS NULL
        )
        OR (
          "status" = 'waiting_external'
          AND "action" <> 'none'
          AND "result" IS NULL
          AND "remote_reference_type" IS NOT NULL
          AND "remote_reference_id" IS NOT NULL
          AND "started_at" IS NOT NULL
          AND "confirmed_at" IS NULL
          AND "confirmed_by_user_id" IS NULL
        )
        OR (
          "status" = 'confirmed'
          AND "action" <> 'none'
          AND "result" = 'confirmed'
          AND "started_at" IS NOT NULL
          AND "confirmed_at" IS NOT NULL
          AND "confirmed_by_user_id" IS NOT NULL
        )
        OR (
          "status" = 'failed'
          AND "action" <> 'none'
          AND "result" = 'failed'
          AND "started_at" IS NOT NULL
          AND "confirmed_at" IS NOT NULL
          AND "confirmed_by_user_id" IS NOT NULL
        )
      ) IS TRUE
    );

ALTER TABLE "after_sale_case_events"
  DROP CONSTRAINT "after_sale_case_events_transition_check",
  ADD CONSTRAINT "after_sale_case_events_transition_check"
    CHECK (
      (
        ("type" = 'opened' AND "from_status" IS NULL AND "to_status" = 'open')
        OR (
          "type" = 'source_updated'
          AND "from_status" IS NOT NULL
          AND "to_status" IS NOT NULL
        )
        OR (
          "type" = 'reopened'
          AND "from_status" = 'closed'
          AND "to_status" IN ('open', 'handling')
        )
        OR (
          "type" = 'claimed'
          AND "from_status" <> 'closed'
          AND "to_status" = 'handling'
          AND "client_request_id" IS NOT NULL
        )
        OR (
          "type" = 'action_started'
          AND "from_status" <> 'closed'
          AND "to_status" = 'waiting_external'
          AND "client_request_id" IS NOT NULL
        )
        OR (
          "type" = 'action_confirmed'
          AND "from_status" <> 'closed'
          AND "to_status" IN ('handling', 'verifying')
          AND "client_request_id" IS NOT NULL
        )
        OR (
          "type" = 'verification_failed'
          AND "from_status" = "to_status"
          AND "from_status" <> 'closed'
          AND "client_request_id" IS NOT NULL
          AND "evidence" IS NOT NULL
        )
        OR (
          "type" = 'closed'
          AND "from_status" <> 'closed'
          AND "to_status" = 'closed'
          AND "client_request_id" IS NOT NULL
          AND "evidence" IS NOT NULL
        )
      ) IS TRUE
    );

COMMIT;
