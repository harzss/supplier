-- Supplier exposes business data only through the authenticated BFF. Supabase
-- Auth clients use the public anon key, but must never access Prisma tables
-- directly through PostgREST.
ALTER TABLE "_prisma_migrations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_usage_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "llm_credentials" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "operational_alerts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "order_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "order_logistics_repairs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "orders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "product_category_mappings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "product_category_property_mappings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "product_category_qualification_mappings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "product_scores" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "product_sku_mappings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "publish_jobs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "publish_tasks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "published_products" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "purchase_order_attempts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "purchase_order_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "purchase_order_recoveries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "purchase_orders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "purchase_shipment_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "purchase_shipments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "shop_categories" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "shops" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_products" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "subscriptions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_favorites" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;

-- No RLS policies are intentionally created. The BFF connects with the
-- database owner and continues to work, while anon/authenticated PostgREST
-- roles have neither grants nor policies for these tables.
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA "public" FROM "anon", "authenticated";
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA "public" FROM "anon", "authenticated";

-- Keep future Prisma tables closed by default even before their migration adds
-- an explicit ENABLE ROW LEVEL SECURITY statement.
ALTER DEFAULT PRIVILEGES IN SCHEMA "public"
REVOKE ALL PRIVILEGES ON TABLES FROM "anon", "authenticated";
ALTER DEFAULT PRIVILEGES IN SCHEMA "public"
REVOKE ALL PRIVILEGES ON SEQUENCES FROM "anon", "authenticated";
