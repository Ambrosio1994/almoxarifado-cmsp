import pg from "pg";
import { fileURLToPath } from "node:url";
import { createPoolConfig } from "../src/db/postgres.js";

const DEFAULT_ROLE = "almoxarifado_app";

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
    const roleResult = await client.query(`SELECT rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = $1`, [roleName]);
    const membershipResult = await client.query(`SELECT parent.rolname AS "roleName", member.rolname AS "memberName", membership.admin_option AS "adminOption" FROM pg_auth_members AS membership JOIN pg_roles AS parent ON parent.oid = membership.roleid JOIN pg_roles AS member ON member.oid = membership.member WHERE member.rolname = $1 ORDER BY parent.rolname`, [roleName]);
    const schemas = await client.query(`SELECT nspname AS schema, has_schema_privilege($1, nspname, 'USAGE') AS usage, has_schema_privilege($1, nspname, 'CREATE') AS create FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' AND nspname <> 'information_schema' ORDER BY nspname`, [roleName]);
    const tables = await client.query(`SELECT n.nspname AS schema, c.relname AS name, pg_get_userbyid(c.relowner) AS owner, has_table_privilege($1, c.oid, 'SELECT') AS "select", has_table_privilege($1, c.oid, 'INSERT') AS "insert", has_table_privilege($1, c.oid, 'UPDATE') AS update, has_table_privilege($1, c.oid, 'DELETE') AS delete, has_table_privilege($1, c.oid, 'TRUNCATE') AS truncate, has_table_privilege($1, c.oid, 'REFERENCES') AS references, has_table_privilege($1, c.oid, 'TRIGGER') AS trigger FROM pg_class AS c JOIN pg_namespace AS n ON n.oid = c.relnamespace WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND n.nspname = 'public' ORDER BY c.relname`, [roleName]);
    const sequences = await client.query(`SELECT n.nspname AS schema, c.relname AS name, pg_get_userbyid(c.relowner) AS owner, has_sequence_privilege($1, c.oid, 'USAGE') AS usage, has_sequence_privilege($1, c.oid, 'SELECT') AS "select", has_sequence_privilege($1, c.oid, 'UPDATE') AS update FROM pg_class AS c JOIN pg_namespace AS n ON n.oid = c.relnamespace WHERE c.relkind = 'S' AND n.nspname = 'public' ORDER BY c.relname`, [roleName]);
    const functions = await client.query(`SELECT n.nspname AS schema, p.proname AS name, pg_get_userbyid(p.proowner) AS owner, has_function_privilege($1, p.oid, 'EXECUTE') AS execute FROM pg_proc AS p JOIN pg_namespace AS n ON n.oid = p.pronamespace WHERE n.nspname = 'public' ORDER BY p.proname, p.oid`, [roleName]);
    const ownership = await client.query(`SELECT n.nspname AS schema, c.relkind AS kind, c.relname AS name, pg_get_userbyid(c.relowner) AS owner FROM pg_class AS c JOIN pg_namespace AS n ON n.oid = c.relnamespace WHERE n.nspname = 'public' ORDER BY c.relkind, c.relname`);
    const defaultPrivileges = await client.query(`SELECT pg_get_userbyid(d.defaclrole) AS owner, n.nspname AS schema, d.defaclobjtype AS object_type, COALESCE(array_to_string(d.defaclacl, ','), '') AS acl FROM pg_default_acl AS d LEFT JOIN pg_namespace AS n ON n.oid = d.defaclnamespace ORDER BY owner, schema NULLS FIRST, object_type`);
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
