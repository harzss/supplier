CREATE TABLE "published_product_source_bindings" (
    "id" BIGSERIAL NOT NULL,
    "published_product_id" BIGINT NOT NULL,
    "source_product_id" BIGINT NOT NULL,
    "revision" INTEGER NOT NULL,
    "current_slot" INTEGER,
    "effective_from" TIMESTAMP(3) NOT NULL,
    "effective_to" TIMESTAMP(3),
    "source_offer_id" VARCHAR(32) NOT NULL,
    "source_supplier_id" VARCHAR(32),
    "source_one_piece_drop" BOOLEAN NOT NULL,
    "source_fingerprint" VARCHAR(64) NOT NULL,
    "inventory_fingerprint" VARCHAR(64) NOT NULL,
    "inventory_version" INTEGER NOT NULL,
    "sku_routes" JSONB NOT NULL,
    "binding_fingerprint" VARCHAR(64) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "published_product_source_bindings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "published_product_source_bindings_current_slot_check"
      CHECK ("current_slot" IS NULL OR "current_slot" = 1),
    CONSTRAINT "published_product_source_bindings_revision_check"
      CHECK ("revision" > 0),
    CONSTRAINT "published_product_source_bindings_inventory_version_check"
      CHECK ("inventory_version" >= 0),
    CONSTRAINT "published_product_source_bindings_effective_interval_check"
      CHECK ("effective_to" IS NULL OR "effective_to" > "effective_from")
);

CREATE UNIQUE INDEX "uk_published_product_source_binding_revision"
ON "published_product_source_bindings"("published_product_id", "revision");

CREATE UNIQUE INDEX "uk_published_product_current_source_binding"
ON "published_product_source_bindings"("published_product_id", "current_slot");

CREATE INDEX "published_product_source_bindings_effective_interval_idx"
ON "published_product_source_bindings"("published_product_id", "effective_from", "effective_to");

CREATE INDEX "published_product_source_bindings_source_product_id_idx"
ON "published_product_source_bindings"("source_product_id");

ALTER TABLE "published_product_source_bindings"
ADD CONSTRAINT "published_product_source_bindings_published_product_id_fkey"
FOREIGN KEY ("published_product_id") REFERENCES "published_products"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "published_product_source_bindings"
ADD CONSTRAINT "published_product_source_bindings_source_product_id_fkey"
FOREIGN KEY ("source_product_id") REFERENCES "source_products"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "order_items"
ADD COLUMN "source_binding_id" BIGINT,
ADD COLUMN "source_unit_cost" DECIMAL(10,2),
ADD COLUMN "source_one_piece_drop" BOOLEAN;

CREATE INDEX "order_items_source_binding_id_idx"
ON "order_items"("source_binding_id");

ALTER TABLE "order_items"
ADD CONSTRAINT "order_items_source_binding_id_fkey"
FOREIGN KEY ("source_binding_id") REFERENCES "published_product_source_bindings"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

-- Existing published products have never passed through a versioned source switch. Materialize
-- their current source as revision 1. Prefer the immutable SKU snapshot used by the publish task;
-- older rows without that snapshot fall back to the source SKU list, then to one default route.
WITH source_rows AS (
  SELECT
    pp."id" AS published_product_id,
    pp."source_product_id",
    pp."published_at",
    sp."product_id_1688" AS source_offer_id,
    sp."supplier_id" AS source_supplier_id,
    sp."is_one_piece_drop" AS source_one_piece_drop,
    sp."price" AS source_price,
    sp."sku_list" AS source_sku_list,
    sp."inventory_fingerprint",
    sp."inventory_version",
    pt."sku_snapshot" -> shop."platform"::text AS platform_sku_snapshot
  FROM "published_products" pp
  JOIN "source_products" sp ON sp."id" = pp."source_product_id"
  JOIN "publish_tasks" pt ON pt."id" = pp."task_id"
  JOIN "shops" shop ON shop."id" = pp."shop_id"
),
binding_rows AS (
  SELECT
    source_rows.*,
    COALESCE(
      (
        SELECT jsonb_agg(
          jsonb_build_object(
            'platformSkuKey', btrim(published_sku.value ->> 'sourceSkuId'),
            'sourceSpecId', CASE
              WHEN btrim(published_sku.value ->> 'sourceSkuId') = 'default' THEN NULL
              ELSE btrim(published_sku.value ->> 'sourceSkuId')
            END,
            'sourceSpecRequired', btrim(published_sku.value ->> 'sourceSkuId') <> 'default',
            'sourceUnitCost', COALESCE(
              (
                SELECT CASE
                  WHEN source_sku.value ->> 'price' ~ '^[0-9]+([.][0-9]+)?$' THEN
                    CASE
                      WHEN (source_sku.value ->> 'price')::numeric > 0
                        THEN (source_sku.value ->> 'price')::numeric
                      ELSE source_rows.source_price
                    END
                  ELSE source_rows.source_price
                END
                FROM jsonb_array_elements(
                  CASE
                    WHEN jsonb_typeof(source_rows.source_sku_list) = 'array'
                      THEN source_rows.source_sku_list
                    ELSE '[]'::jsonb
                  END
                ) source_sku(value)
                WHERE btrim(source_sku.value ->> 'skuId') =
                  btrim(published_sku.value ->> 'sourceSkuId')
                LIMIT 1
              ),
              source_rows.source_price
            ),
            'values', CASE
              WHEN jsonb_typeof(source_rows.platform_sku_snapshot -> 'dimensions') = 'array' THEN
                CASE
                  WHEN jsonb_array_length(source_rows.platform_sku_snapshot -> 'dimensions') > 0 THEN
                    (
                      SELECT COALESCE(
                        jsonb_agg(
                          to_jsonb(
                            COALESCE(
                              NULLIF(btrim(published_sku.value -> 'attributes' ->> dimension.value), ''),
                              NULLIF(btrim(published_sku.value ->> 'specName'), ''),
                              '规格'
                            )
                          )
                          ORDER BY dimension.ordinality
                        ),
                        '[]'::jsonb
                      )
                      FROM jsonb_array_elements_text(
                        source_rows.platform_sku_snapshot -> 'dimensions'
                      ) WITH ORDINALITY dimension(value, ordinality)
                    )
                  ELSE '[]'::jsonb
                END
              ELSE '[]'::jsonb
            END
          )
          ORDER BY published_sku.ordinality
        )
        FROM jsonb_array_elements(
          CASE
            WHEN jsonb_typeof(source_rows.platform_sku_snapshot -> 'skus') = 'array'
              THEN source_rows.platform_sku_snapshot -> 'skus'
            ELSE '[]'::jsonb
          END
        ) WITH ORDINALITY published_sku(value, ordinality)
        WHERE NULLIF(btrim(published_sku.value ->> 'sourceSkuId'), '') IS NOT NULL
      ),
      (
        SELECT jsonb_agg(
          jsonb_build_object(
            'platformSkuKey', btrim(source_sku.value ->> 'skuId'),
            'sourceSpecId', CASE
              WHEN btrim(source_sku.value ->> 'skuId') = 'default' THEN NULL
              ELSE btrim(source_sku.value ->> 'skuId')
            END,
            'sourceSpecRequired', btrim(source_sku.value ->> 'skuId') <> 'default',
            'sourceUnitCost', CASE
              WHEN source_sku.value ->> 'price' ~ '^[0-9]+([.][0-9]+)?$' THEN
                CASE
                  WHEN (source_sku.value ->> 'price')::numeric > 0
                    THEN (source_sku.value ->> 'price')::numeric
                  ELSE source_rows.source_price
                END
              ELSE source_rows.source_price
            END,
            'values', (
              SELECT COALESCE(
                jsonb_agg(to_jsonb(attribute.value) ORDER BY attribute.key),
                CASE
                  WHEN NULLIF(btrim(source_sku.value ->> 'specName'), '') IS NOT NULL
                    THEN jsonb_build_array(btrim(source_sku.value ->> 'specName'))
                  ELSE '[]'::jsonb
                END
              )
              FROM jsonb_each_text(
                CASE
                  WHEN jsonb_typeof(source_sku.value -> 'attributes') = 'object'
                    THEN source_sku.value -> 'attributes'
                  ELSE '{}'::jsonb
                END
              ) attribute
            )
          )
          ORDER BY source_sku.ordinality
        )
        FROM jsonb_array_elements(
          CASE
            WHEN jsonb_typeof(source_rows.source_sku_list) = 'array'
              THEN source_rows.source_sku_list
            ELSE '[]'::jsonb
          END
        ) WITH ORDINALITY source_sku(value, ordinality)
        WHERE NULLIF(btrim(source_sku.value ->> 'skuId'), '') IS NOT NULL
      ),
      jsonb_build_array(
        jsonb_build_object(
          'platformSkuKey', 'default',
          'sourceSpecId', NULL,
          'sourceSpecRequired', false,
          'sourceUnitCost', source_rows.source_price,
          'values', '[]'::jsonb
        )
      )
    ) AS sku_routes
  FROM source_rows
),
fingerprinted_rows AS (
  SELECT
    binding_rows.*,
    md5(COALESCE(binding_rows.source_sku_list::text, '[]')) ||
      md5('source:' || COALESCE(binding_rows.source_sku_list::text, '[]')) AS source_fingerprint
  FROM binding_rows
)
INSERT INTO "published_product_source_bindings" (
    "published_product_id",
    "source_product_id",
    "revision",
    "current_slot",
    "effective_from",
    "effective_to",
    "source_offer_id",
    "source_supplier_id",
    "source_one_piece_drop",
    "source_fingerprint",
    "inventory_fingerprint",
    "inventory_version",
    "sku_routes",
    "binding_fingerprint",
    "created_at"
)
SELECT
    fingerprinted_rows.published_product_id,
    fingerprinted_rows."source_product_id",
    1,
    1,
    fingerprinted_rows."published_at",
    NULL,
    fingerprinted_rows.source_offer_id,
    fingerprinted_rows.source_supplier_id,
    fingerprinted_rows.source_one_piece_drop,
    fingerprinted_rows.source_fingerprint,
    fingerprinted_rows.inventory_fingerprint,
    fingerprinted_rows.inventory_version,
    fingerprinted_rows.sku_routes,
    md5(
      concat_ws(
        '|',
        fingerprinted_rows.published_product_id::text,
        '1',
        fingerprinted_rows.source_offer_id,
        COALESCE(fingerprinted_rows.source_supplier_id, ''),
        fingerprinted_rows.source_one_piece_drop::text,
        fingerprinted_rows.source_fingerprint,
        fingerprinted_rows.inventory_fingerprint,
        fingerprinted_rows.inventory_version::text,
        fingerprinted_rows.sku_routes::text
      )
    ) || md5(
      'binding:' || concat_ws(
        '|',
        fingerprinted_rows.published_product_id::text,
        '1',
        fingerprinted_rows.source_offer_id,
        COALESCE(fingerprinted_rows.source_supplier_id, ''),
        fingerprinted_rows.source_one_piece_drop::text,
        fingerprinted_rows.source_fingerprint,
        fingerprinted_rows.inventory_fingerprint,
        fingerprinted_rows.inventory_version::text,
        fingerprinted_rows.sku_routes::text
      )
    ),
    fingerprinted_rows."published_at"
FROM fingerprinted_rows;

-- Existing order items were routed before binding history existed. Bind them to revision 1 and
-- freeze the SKU-level cost/one-piece facts that the legacy purchase path previously read live.
-- Prefer the matching route cost: PublishedProduct.cost_price is only a product-level minimum and
-- would silently understate older multi-SKU orders when their selected specification costs more.
WITH frozen_order_item_sources AS (
  SELECT
    oi."id" AS order_item_id,
    binding."id" AS source_binding_id,
    COALESCE(
      (
        SELECT (route.value ->> 'sourceUnitCost')::numeric
        FROM jsonb_array_elements(binding."sku_routes") route(value)
        WHERE
          route.value ->> 'sourceUnitCost' ~ '^[0-9]+([.][0-9]+)?$'
          AND (route.value ->> 'sourceUnitCost')::numeric > 0
          AND (
            route.value ->> 'sourceSpecId' IS NOT DISTINCT FROM oi."source_spec_id"
            OR route.value ->> 'platformSkuKey' = oi."source_spec_id"
          )
        ORDER BY CASE
          WHEN route.value ->> 'sourceSpecId' IS NOT DISTINCT FROM oi."source_spec_id" THEN 0
          ELSE 1
        END
        LIMIT 1
      ),
      pp."cost_price",
      sp."price"
    ) AS source_unit_cost,
    binding."source_one_piece_drop" AS source_one_piece_drop
  FROM "order_items" oi
  JOIN "published_products" pp ON pp."id" = oi."published_product_id"
  JOIN "source_products" sp ON sp."id" = pp."source_product_id"
  JOIN "published_product_source_bindings" binding
    ON binding."published_product_id" = pp."id"
   AND binding."current_slot" = 1
)
UPDATE "order_items" oi
SET
    "source_binding_id" = frozen.source_binding_id,
    "source_unit_cost" = frozen.source_unit_cost,
    "source_one_piece_drop" = frozen.source_one_piece_drop
FROM frozen_order_item_sources frozen
WHERE oi."id" = frozen.order_item_id;

ALTER TABLE "published_product_source_bindings" ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE "published_product_source_bindings"
FROM "anon", "authenticated";

REVOKE ALL PRIVILEGES ON SEQUENCE "published_product_source_bindings_id_seq"
FROM "anon", "authenticated";
