-- Generic PostgreSQL release assertion. Unlike the staging audit, this file
-- intentionally works on a clean non-Supabase database used by CI or restore
-- rehearsals. The application owner may access the schema; PostgREST client
-- roles must not.
DO $public_schema_isolation$
DECLARE
  tables_without_rls text[];
  client_table_privileges text[];
  client_sequence_privileges text[];
  unsafe_default_privileges text[];
BEGIN
  SELECT array_agg(tablename ORDER BY tablename)
  INTO tables_without_rls
  FROM pg_tables
  WHERE schemaname = 'public'
    AND NOT rowsecurity;

  SELECT array_agg(format('%s:%s', client_role, tablename) ORDER BY client_role, tablename)
  INTO client_table_privileges
  FROM unnest(ARRAY['anon', 'authenticated']) AS client_role
  CROSS JOIN pg_tables
  WHERE schemaname = 'public'
    AND has_table_privilege(
      client_role,
      format('%I.%I', schemaname, tablename),
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
    );

  SELECT array_agg(
    format('%s:%s', client_role, sequence_name)
    ORDER BY client_role, sequence_name
  )
  INTO client_sequence_privileges
  FROM unnest(ARRAY['anon', 'authenticated']) AS client_role
  CROSS JOIN information_schema.sequences
  WHERE sequence_schema = 'public'
    AND has_sequence_privilege(
      client_role,
      format('%I.%I', sequence_schema, sequence_name),
      'USAGE,SELECT,UPDATE'
    );

  WITH owner_role AS (
    SELECT oid
    FROM pg_roles
    WHERE rolname = current_user
  ),
  client_roles AS (
    SELECT oid, rolname
    FROM pg_roles
    WHERE rolname IN ('anon', 'authenticated')
  ),
  object_types AS (
    SELECT *
    FROM (
      VALUES ('r'::"char", 'tables'), ('S'::"char", 'sequences')
    ) AS values_table(object_type, object_label)
  )
  SELECT array_agg(
    format('%s:%s', client_roles.rolname, object_types.object_label)
    ORDER BY client_roles.rolname, object_types.object_label
  )
  INTO unsafe_default_privileges
  FROM owner_role
  CROSS JOIN client_roles
  CROSS JOIN object_types
  WHERE EXISTS (
    SELECT 1
    FROM pg_default_acl
    CROSS JOIN LATERAL aclexplode(pg_default_acl.defaclacl) AS default_acl
    WHERE pg_default_acl.defaclrole = owner_role.oid
      AND pg_default_acl.defaclobjtype = object_types.object_type
      AND (
        pg_default_acl.defaclnamespace = 0
        OR pg_default_acl.defaclnamespace = 'public'::regnamespace
      )
      AND CASE
        WHEN default_acl.grantee = 0 THEN true
        ELSE pg_has_role(client_roles.oid, default_acl.grantee, 'USAGE')
      END
  );

  IF tables_without_rls IS NOT NULL THEN
    RAISE EXCEPTION 'public tables without RLS: %', tables_without_rls;
  END IF;
  IF client_table_privileges IS NOT NULL THEN
    RAISE EXCEPTION 'client roles retain public table privileges: %', client_table_privileges;
  END IF;
  IF client_sequence_privileges IS NOT NULL THEN
    RAISE EXCEPTION 'client roles retain public sequence privileges: %', client_sequence_privileges;
  END IF;
  IF unsafe_default_privileges IS NOT NULL THEN
    RAISE EXCEPTION 'client roles inherit unsafe public default privileges: %', unsafe_default_privileges;
  END IF;
END
$public_schema_isolation$;
