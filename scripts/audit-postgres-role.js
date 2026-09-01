import pg from "pg";
import { fileURLToPath } from "node:url";
import { createPoolConfig } from "../src/db/postgres.js";

const DEFAULT_ROLE = "almoxarifado_app";

export function aclPrivilegeOrigin(granteeOid, runtimeRoleOid, inheritedRoleOids = []) {
  if (Number(granteeOid) === 0) return "PUBLIC";
  if (Number(granteeOid) === Number(runtimeRoleOid)) return "direct";
  return inheritedRoleOids.map(Number).includes(Number(granteeOid)) ? "inherited" : "other";
}

export function roleAuditQueryCatalog() {
  const roleTree = `WITH RECURSIVE role_tree AS (
    SELECT r.oid, r.rolname, 0 AS depth, ARRAY[r.oid] AS path
    FROM pg_roles AS r WHERE r.rolname = $1
    UNION ALL
    SELECT parent.oid, parent.rolname, tree.depth + 1, tree.path || parent.oid
    FROM role_tree AS tree
    JOIN pg_auth_members AS membership ON membership.member = tree.oid
    JOIN pg_roles AS parent ON parent.oid = membership.roleid
    WHERE NOT parent.oid = ANY(tree.path)
  )`;
  const origin = `CASE
    WHEN privilege.grantee = 0 THEN 'PUBLIC'
    WHEN privilege.grantee = (SELECT oid FROM role_tree WHERE depth = 0) THEN 'direct'
    ELSE 'inherited'
  END`;
  return {
    role: "SELECT oid, rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = $1",
    memberships: `WITH RECURSIVE membership_edges AS (
      SELECT parent.oid AS role_oid, parent.rolname AS "roleName", member.rolname AS "memberName", membership.admin_option AS "adminOption", 1 AS depth, ARRAY[member.oid, parent.oid] AS path
      FROM pg_auth_members AS membership
      JOIN pg_roles AS parent ON parent.oid = membership.roleid
      JOIN pg_roles AS member ON member.oid = membership.member
      WHERE member.rolname = $1
      UNION ALL
      SELECT parent.oid, parent.rolname, edge."roleName", membership.admin_option, edge.depth + 1, edge.path || parent.oid
      FROM membership_edges AS edge
      JOIN pg_auth_members AS membership ON membership.member = edge.role_oid
      JOIN pg_roles AS parent ON parent.oid = membership.roleid
      WHERE NOT parent.oid = ANY(edge.path)
    )
    SELECT "roleName", "memberName", "adminOption", depth,
      CASE WHEN depth = 1 THEN 'direct' ELSE 'inherited' END AS origin
    FROM membership_edges ORDER BY depth, "roleName"`,
    schemas: `${roleTree}, acl_entries AS (
      SELECT n.nspname AS schema, pg_get_userbyid(n.nspowner) AS owner, privilege.*
      FROM pg_namespace AS n
      CROSS JOIN LATERAL aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) AS privilege
      WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema'
    )
    SELECT schema, owner, pg_get_userbyid(privilege.grantor) AS grantor,
      CASE WHEN privilege.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(privilege.grantee) END AS grantee,
      privilege.privilege_type, privilege.is_grantable AS grantable, ${origin} AS origin
    FROM acl_entries AS privilege
    WHERE privilege.grantee = 0 OR privilege.grantee IN (SELECT oid FROM role_tree)
    ORDER BY schema, privilege.privilege_type, grantee`,
    tables: `${roleTree}, acl_entries AS (
      SELECT n.nspname AS schema, c.relname AS name, pg_get_userbyid(c.relowner) AS owner, privilege.*
      FROM pg_class AS c
      JOIN pg_namespace AS n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) AS privilege
      WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND n.nspname = 'public'
    )
    SELECT schema, name, owner, pg_get_userbyid(privilege.grantor) AS grantor,
      CASE WHEN privilege.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(privilege.grantee) END AS grantee,
      privilege.privilege_type, privilege.is_grantable AS grantable, ${origin} AS origin
    FROM acl_entries AS privilege
    WHERE privilege.grantee = 0 OR privilege.grantee IN (SELECT oid FROM role_tree)
    ORDER BY schema, name, privilege.privilege_type, grantee`,
    sequences: `${roleTree}, acl_entries AS (
      SELECT n.nspname AS schema, c.relname AS name, pg_get_userbyid(c.relowner) AS owner, privilege.*
      FROM pg_class AS c
      JOIN pg_namespace AS n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('S', c.relowner))) AS privilege
      WHERE c.relkind = 'S' AND n.nspname = 'public'
    )
    SELECT schema, name, owner, pg_get_userbyid(privilege.grantor) AS grantor,
      CASE WHEN privilege.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(privilege.grantee) END AS grantee,
      privilege.privilege_type, privilege.is_grantable AS grantable, ${origin} AS origin
    FROM acl_entries AS privilege
    WHERE privilege.grantee = 0 OR privilege.grantee IN (SELECT oid FROM role_tree)
    ORDER BY schema, name, privilege.privilege_type, grantee`,
    functions: `${roleTree}, acl_entries AS (
      SELECT n.nspname AS schema, format('%I(%s)', p.proname, pg_get_function_identity_arguments(p.oid)) AS signature, pg_get_userbyid(p.proowner) AS owner, privilege.*
      FROM pg_proc AS p
      JOIN pg_namespace AS n ON n.oid = p.pronamespace
      CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS privilege
      WHERE n.nspname = 'public'
    )
    SELECT schema, signature, owner, pg_get_userbyid(privilege.grantor) AS grantor,
      CASE WHEN privilege.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(privilege.grantee) END AS grantee,
      privilege.privilege_type, privilege.is_grantable AS grantable, ${origin} AS origin
    FROM acl_entries AS privilege
    WHERE privilege.grantee = 0 OR privilege.grantee IN (SELECT oid FROM role_tree)
    ORDER BY schema, signature, privilege.privilege_type, grantee`,
    ownership: "SELECT n.nspname AS schema, c.relkind AS kind, c.relname AS name, pg_get_userbyid(c.relowner) AS owner FROM pg_class AS c JOIN pg_namespace AS n ON n.oid = c.relnamespace WHERE n.nspname = 'public' ORDER BY c.relkind, c.relname",
    defaultPrivileges: `${roleTree}, acl_entries AS (
      SELECT pg_get_userbyid(d.defaclrole) AS owner, n.nspname AS schema, d.defaclobjtype AS object_type, privilege.*
      FROM pg_default_acl AS d
      LEFT JOIN pg_namespace AS n ON n.oid = d.defaclnamespace
      CROSS JOIN LATERAL aclexplode(d.defaclacl) AS privilege
    )
    SELECT owner, schema, object_type, pg_get_userbyid(privilege.grantor) AS grantor,
      CASE WHEN privilege.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(privilege.grantee) END AS grantee,
      privilege.privilege_type, privilege.is_grantable AS grantable, ${origin} AS origin
    FROM acl_entries AS privilege
    WHERE privilege.grantee = 0 OR privilege.grantee IN (SELECT oid FROM role_tree)
    ORDER BY owner, schema NULLS FIRST, object_type, privilege.privilege_type, grantee`
  };
}

export function roleSecurityAlerts(role = {}, memberships = []) {
  const alerts = [];
  for (const attribute of ["rolsuper", "rolcreaterole", "rolcreatedb", "rolreplication", "rolbypassrls"]) {
    if (role[attribute]) alerts.push(`attribute:${attribute}`);
  }
  for (const membership of memberships) {
    if (/superuser|admin|owner/i.test(membership.roleName || "")) alerts.push(`membership:${membership.roleName}`);
  }
  return alerts;
}

export async function auditRolePrivileges(options = {}) {
  const databaseUrl = options.databaseUrl || process.env.DATABASE_URL_AUDIT || process.env.DATABASE_URL;
  const roleName = options.roleName || process.env.POSTGRES_RUNTIME_ROLE || DEFAULT_ROLE;
  if (!databaseUrl) throw new Error("DATABASE_URL_AUDIT ou DATABASE_URL e obrigatoria.");
  if (!/^[A-Za-z_][A-Za-z0-9_$]{0,62}$/.test(roleName)) throw new Error("POSTGRES_RUNTIME_ROLE invalida.");
  const client = options.client || new pg.Client(createPoolConfig(databaseUrl));
  const ownsClient = !options.client;
  try {
    if (ownsClient) await client.connect();
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    // One pg client executes a transaction. Keep catalog reads sequential so
    // this remains compatible with drivers that do not queue concurrent calls.
    const catalog = roleAuditQueryCatalog();
    const roleResult = await client.query(catalog.role, [roleName]);
    const membershipResult = await client.query(catalog.memberships, [roleName]);
    const schemas = await client.query(catalog.schemas, [roleName]);
    const tables = await client.query(catalog.tables, [roleName]);
    const sequences = await client.query(catalog.sequences, [roleName]);
    const functions = await client.query(catalog.functions, [roleName]);
    const ownership = await client.query(catalog.ownership);
    const defaultPrivileges = await client.query(catalog.defaultPrivileges, [roleName]);
    await client.query("COMMIT");
    const role = roleResult.rows[0] || null;
    return {
      role,
      memberships: membershipResult.rows,
      schemaPrivileges: schemas.rows,
      tablePrivileges: tables.rows,
      sequencePrivileges: sequences.rows,
      functionPrivileges: functions.rows,
      ownership: ownership.rows,
      defaultPrivileges: defaultPrivileges.rows,
      alerts: role ? roleSecurityAlerts(role, membershipResult.rows) : ["role:not-found"]
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => null);
    throw error;
  } finally {
    if (ownsClient) await client.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const report = await auditRolePrivileges();
    console.log(JSON.stringify(report, null, 2));
    if (report.alerts.length) process.exitCode = 2;
  } catch (error) {
    console.error(JSON.stringify({ event: "postgres_role_audit_failed", message: String(error?.message || "Erro de auditoria").replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[database-url-redacted]") }));
    process.exitCode = 1;
  }
}
