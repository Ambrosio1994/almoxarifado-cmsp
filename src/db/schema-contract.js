// PostgreSQL schema contract used by the read-only operational verifier.
// Keep this declarative and update it together with a new migration. Parsing
// migrations is unsafe here because they can contain data changes and
// conditional DDL that do not describe the final catalog state.

export const SCHEMA_CONTRACT_VERSION = 1;

const column = (type, options = {}) => ({ type, nullable: options.nullable === true, ...(options.defaultIncludes ? { defaultIncludes: options.defaultIncludes } : {}) });
const text = (options) => column("text", options);
const jsonb = (options) => column("jsonb", options);
const timestamp = (options) => column("timestamp with time zone", options);
const check = (...parts) => ({ parts });

export const REQUIRED_SCHEMA_MIGRATIONS = Object.freeze([
  "001_initial_schema", "002_process_data", "003_state_revision", "004_integrity_and_audit",
  "005_notification_deadlines", "006_email_dispatch_claims", "007_auth_rate_limits",
  "008_access_request_metadata", "009_security_audit", "010_auth_session_version",
  "011_process_multiple_commitments"
]);

// This includes legacy relations too. They remain part of the contract while
// retained by migrations; their removal requires a separate migration.
export const RUNTIME_SCHEMA_CONTRACT = Object.freeze({
  version: SCHEMA_CONTRACT_VERSION,
  schema: "public",
  migrations: REQUIRED_SCHEMA_MIGRATIONS,
  tables: {
    app_schema_migrations: { columns: { version: text(), applied_at: timestamp({ defaultIncludes: "now" }) }, primaryKeys: [["version"]] },
    app_users: {
      columns: {
        id: text({ defaultIncludes: "gen_random_uuid" }), nome: text(), email: column("citext"), foto_url: text({ defaultIncludes: "''" }),
        google_sub: text({ nullable: true }), origem_cadastro: text({ defaultIncludes: "local" }), senha_hash: text({ defaultIncludes: "''" }),
        precisa_definir_senha: column("boolean", { defaultIncludes: "false" }), role: text({ defaultIncludes: "almoxarifado" }), ativo: column("boolean", { defaultIncludes: "true" }),
        criado_em: timestamp({ defaultIncludes: "now" }), atualizado_em: timestamp({ defaultIncludes: "now" }), access_justification: text({ defaultIncludes: "''" }),
        access_requested_at: timestamp({ nullable: true }), auth_version: column("bigint", { defaultIncludes: "1" })
      },
      primaryKeys: [["id"]], unique: [["email"], ["google_sub"]], checks: [check("role", "admin", "almoxarifado", "auditor"), check("auth_version", "> 0")]
    },
    user_sessions: {
      columns: { token_hash: text(), user_id: text(), created_at: timestamp({ defaultIncludes: "now" }), last_activity_at: timestamp({ defaultIncludes: "now" }), expires_at: timestamp(), revoked_at: timestamp({ nullable: true }), auth_version: column("bigint", { defaultIncludes: "1" }) },
      primaryKeys: [["token_hash"]], foreignKeys: [{ columns: ["user_id"], referencesTable: "app_users", onDelete: "c" }], checks: [check("auth_version", "> 0")]
    },
    email_templates: { columns: { template_key: text(), assunto: text(), corpo: text(), atualizado_em: timestamp({ defaultIncludes: "now" }) }, primaryKeys: [["template_key"]] },
    email_template_attachments: {
      columns: {
        id: text({ defaultIncludes: "gen_random_uuid" }), template_key: text(), file_name: text(), storage_key: text(), public_path: text({ defaultIncludes: "''" }),
        mime_type: text({ defaultIncludes: "''" }), size_bytes: column("bigint", { defaultIncludes: "0" }), uploaded_by_name: text({ defaultIncludes: "''" }),
        uploaded_by_user_id: text({ nullable: true }), uploaded_at: timestamp({ defaultIncludes: "now" })
      },
      primaryKeys: [["id"]], unique: [["storage_key"]], foreignKeys: [{ columns: ["template_key"], referencesTable: "email_templates", onDelete: "c" }, { columns: ["uploaded_by_user_id"], referencesTable: "app_users", onDelete: "n" }], checks: [check("size_bytes", ">= 0")]
    },
    notification_rules: {
      columns: { id: column("bool", { defaultIncludes: "true" }), dias_aviso_interno: column("_int4", { defaultIncludes: "array" }), dia_oficio_fornecedor: column("integer", { defaultIncludes: "31" }), atualizado_em: timestamp({ defaultIncludes: "now" }) },
      primaryKeys: [["id"]], checks: [check("id", "= true"), check("dia_oficio_fornecedor", "> 0")]
    },
    notification_recipients: {
      columns: { id: text({ defaultIncludes: "gen_random_uuid" }), nome: text(), email: column("citext"), funcao: text({ defaultIncludes: "''" }), ativo: column("boolean", { defaultIncludes: "true" }), criado_em: timestamp({ defaultIncludes: "now" }), atualizado_em: timestamp({ defaultIncludes: "now" }) },
      primaryKeys: [["id"]]
    },
    app_settings: { columns: { key: text(), value: jsonb(), updated_at: timestamp({ defaultIncludes: "now" }) }, primaryKeys: [["key"]] },
    app_processes: { columns: { id: text(), data: jsonb(), created_at: timestamp({ defaultIncludes: "now" }), updated_at: timestamp({ defaultIncludes: "now" }) }, primaryKeys: [["id"]] },
    app_suppliers: { columns: { id: text(), data: jsonb(), created_at: timestamp({ defaultIncludes: "now" }), updated_at: timestamp({ defaultIncludes: "now" }) }, primaryKeys: [["id"]] },
    app_process_observations: { columns: { id: text(), processo_id: text(), data: jsonb(), created_at: timestamp({ defaultIncludes: "now" }), updated_at: timestamp({ defaultIncludes: "now" }) }, primaryKeys: [["id"]], foreignKeys: [{ columns: ["processo_id"], referencesTable: "app_processes", onDelete: "c" }] },
    app_process_audit: { columns: { id: text(), processo_id: text(), data: jsonb(), created_at: timestamp({ defaultIncludes: "now" }) }, primaryKeys: [["id"]], foreignKeys: [{ columns: ["processo_id"], referencesTable: "app_processes", onDelete: "c" }] },
    app_email_history: { columns: { id: text(), dedupe_key: text({ nullable: true }), processo_id: text({ nullable: true }), data: jsonb(), created_at: timestamp({ defaultIncludes: "now" }), updated_at: timestamp({ defaultIncludes: "now" }) }, primaryKeys: [["id"]], unique: [["dedupe_key"]] },
    app_state_revision: { columns: { id: column("bool", { defaultIncludes: "true" }), revision: column("bigint", { defaultIncludes: "0" }) }, primaryKeys: [["id"]], checks: [check("id", "= true"), check("revision", ">= 0")] },
    app_email_dispatch_claims: {
      columns: { dedupe_key: text(), status: text(), metadata: jsonb({ defaultIncludes: "{}" }), result: jsonb({ defaultIncludes: "{}" }), claimed_at: timestamp({ defaultIncludes: "now" }), sent_at: timestamp({ nullable: true }), updated_at: timestamp({ defaultIncludes: "now" }), last_error: text({ defaultIncludes: "''" }) },
      primaryKeys: [["dedupe_key"]], checks: [check("status", "processing", "sent", "failed")]
    },
    auth_rate_limits: { columns: { rate_key: text(), attempts: column("integer", { defaultIncludes: "0" }), window_started_at: timestamp({ defaultIncludes: "now" }), updated_at: timestamp({ defaultIncludes: "now" }) }, primaryKeys: [["rate_key"]], checks: [check("attempts", ">= 0")] },
    app_security_audit: {
      columns: { id: text({ defaultIncludes: "gen_random_uuid" }), event_type: text(), actor_user_id: text({ nullable: true }), actor_email: column("citext", { defaultIncludes: "''" }), target_user_id: text({ nullable: true }), metadata: jsonb({ defaultIncludes: "{}" }), created_at: timestamp({ defaultIncludes: "now" }) },
      primaryKeys: [["id"]], foreignKeys: [{ columns: ["actor_user_id"], referencesTable: "app_users", onDelete: "n" }, { columns: ["target_user_id"], referencesTable: "app_users", onDelete: "n" }]
    }
  },
  indexes: [
    { table: "user_sessions", name: "user_sessions_user_idx", unique: false, parts: ["user_id"] },
    { table: "user_sessions", name: "user_sessions_active_idx", unique: false, parts: ["expires_at"], predicateParts: ["revoked_at is null"] },
    { table: "user_sessions", name: "user_sessions_auth_version_idx", unique: false, parts: ["user_id", "auth_version"], predicateParts: ["revoked_at is null"] },
    { table: "email_template_attachments", name: "email_template_attachments_template_idx", unique: false, parts: ["template_key"] },
    { table: "notification_recipients", name: "notification_recipients_email_uidx", unique: true, parts: ["email"] },
    { table: "app_processes", name: "app_processes_updated_idx", unique: false, parts: ["updated_at desc"] },
    { table: "app_processes", name: "app_processes_numero_processo_idx", unique: false, parts: ["regexp_replace", "numeroprocesso"], predicateParts: ["numeroprocesso", "inativo"] },
    { table: "app_processes", name: "app_processes_numero_empenho_uidx", unique: true, parts: ["regexp_replace", "numeroempenho"], predicateParts: ["numeroempenho", "inativo"] },
    { table: "app_processes", name: "app_processes_status_idx", unique: false, parts: ["status"] },
    { table: "app_processes", name: "app_processes_fornecedor_idx", unique: false, parts: ["lower", "fornecedor"] },
    { table: "app_suppliers", name: "app_suppliers_updated_idx", unique: false, parts: ["updated_at desc"] },
    { table: "app_process_observations", name: "app_process_observations_process_idx", unique: false, parts: ["processo_id", "created_at desc"] },
    { table: "app_process_audit", name: "app_process_audit_process_idx", unique: false, parts: ["processo_id", "created_at desc"] },
    { table: "app_email_history", name: "app_email_history_process_idx", unique: false, parts: ["processo_id", "created_at desc"] },
    { table: "app_email_dispatch_claims", name: "app_email_dispatch_claims_status_idx", unique: false, parts: ["status", "updated_at"] },
    { table: "auth_rate_limits", name: "auth_rate_limits_updated_idx", unique: false, parts: ["updated_at"] },
    { table: "app_security_audit", name: "app_security_audit_created_idx", unique: false, parts: ["created_at desc"] },
    { table: "app_security_audit", name: "app_security_audit_actor_idx", unique: false, parts: ["actor_user_id", "created_at desc"] }
  ],
  functions: [{ name: "prevent_process_audit_mutation", identityArguments: "", returns: "trigger", language: "plpgsql", sourceParts: ["raise exception", "app_process_audit is append-only"] }],
  triggers: [
    { table: "app_process_audit", name: "app_process_audit_immutable", function: "prevent_process_audit_mutation", definitionParts: ["before", "update", "delete", "for each row"] },
    { table: "app_security_audit", name: "app_security_audit_immutable", function: "prevent_process_audit_mutation", definitionParts: ["before", "update", "delete", "for each row"] }
  ],
  // UUID defaults are functions; this schema has no serial/identity sequences.
  sequences: []
});

export const SCHEMA_CATALOG_QUERIES = Object.freeze({
  tables: `/* schema-contract:tables */ SELECT c.relname AS table_name, pg_get_userbyid(c.relowner) AS owner FROM pg_class AS c JOIN pg_namespace AS n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') AND c.relname = ANY($2::text[]) ORDER BY c.relname`,
  columns: `/* schema-contract:columns */ SELECT table_name, column_name, data_type, udt_name, is_nullable = 'YES' AS nullable, column_default FROM information_schema.columns WHERE table_schema = $1 AND table_name = ANY($2::text[]) ORDER BY table_name, ordinal_position`,
  constraints: `/* schema-contract:constraints */ SELECT rel.relname AS table_name, con.conname AS name, con.contype AS type, COALESCE(cols.columns, ARRAY[]::text[]) AS columns, ref.relname AS references_table, con.confdeltype AS on_delete, pg_get_constraintdef(con.oid, true) AS definition FROM pg_constraint AS con JOIN pg_class AS rel ON rel.oid = con.conrelid JOIN pg_namespace AS n ON n.oid = rel.relnamespace LEFT JOIN pg_class AS ref ON ref.oid = con.confrelid LEFT JOIN LATERAL (SELECT array_agg(att.attname ORDER BY key.ordinality) AS columns FROM unnest(con.conkey) WITH ORDINALITY AS key(attnum, ordinality) JOIN pg_attribute AS att ON att.attrelid = con.conrelid AND att.attnum = key.attnum) AS cols ON true WHERE n.nspname = $1 AND rel.relname = ANY($2::text[]) ORDER BY rel.relname, con.conname`,
  indexes: `/* schema-contract:indexes */ SELECT tbl.relname AS table_name, idx.relname AS name, ind.indisunique AS unique, ind.indpred IS NOT NULL AS partial, pg_get_indexdef(ind.indexrelid) AS definition, pg_get_expr(ind.indpred, ind.indrelid, true) AS predicate, pg_get_userbyid(idx.relowner) AS owner FROM pg_index AS ind JOIN pg_class AS idx ON idx.oid = ind.indexrelid JOIN pg_class AS tbl ON tbl.oid = ind.indrelid JOIN pg_namespace AS n ON n.oid = tbl.relnamespace WHERE n.nspname = $1 AND tbl.relname = ANY($2::text[]) ORDER BY tbl.relname, idx.relname`,
  triggers: `/* schema-contract:triggers */ SELECT tbl.relname AS table_name, trg.tgname AS name, proc.proname AS function_name, pg_get_function_identity_arguments(proc.oid) AS function_identity_arguments, pg_get_triggerdef(trg.oid, true) AS definition FROM pg_trigger AS trg JOIN pg_class AS tbl ON tbl.oid = trg.tgrelid JOIN pg_namespace AS n ON n.oid = tbl.relnamespace JOIN pg_proc AS proc ON proc.oid = trg.tgfoid WHERE n.nspname = $1 AND tbl.relname = ANY($2::text[]) AND NOT trg.tgisinternal ORDER BY tbl.relname, trg.tgname`,
  functions: `/* schema-contract:functions */ SELECT proc.proname AS name, pg_get_function_identity_arguments(proc.oid) AS identity_arguments, pg_get_function_result(proc.oid) AS returns, lang.lanname AS language, pg_get_functiondef(proc.oid) AS source, pg_get_userbyid(proc.proowner) AS owner FROM pg_proc AS proc JOIN pg_namespace AS n ON n.oid = proc.pronamespace JOIN pg_language AS lang ON lang.oid = proc.prolang WHERE n.nspname = $1 AND proc.proname = ANY($2::text[]) ORDER BY proc.proname, identity_arguments`,
  sequences: `/* schema-contract:sequences */ SELECT c.relname AS name, pg_get_userbyid(c.relowner) AS owner FROM pg_class AS c JOIN pg_namespace AS n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind = 'S' AND c.relname = ANY($2::text[]) ORDER BY c.relname`,
  schema: `/* schema-contract:schema */ SELECT n.nspname AS schema, pg_get_userbyid(n.nspowner) AS owner FROM pg_namespace AS n WHERE n.nspname = $1`,
  migrations: `/* schema-contract:migrations */ SELECT version FROM public.app_schema_migrations ORDER BY version`
});

export async function readSchemaCatalog(client, options = {}) {
  const contract = options.contract || RUNTIME_SCHEMA_CONTRACT;
  const schema = contract.schema || "public";
  const tables = Object.keys(contract.tables);
  const results = {};
  // Keep catalog reads sequential on one repeatable-read transaction/client.
  for (const [name, values] of [
    ["tables", [schema, tables]], ["columns", [schema, tables]], ["constraints", [schema, tables]], ["indexes", [schema, tables]], ["triggers", [schema, tables]],
    ["functions", [schema, contract.functions.map((item) => item.name)]], ["sequences", [schema, contract.sequences.map((item) => item.name)]], ["schema", [schema]], ["migrations", []]
  ]) results[name] = await client.query(SCHEMA_CATALOG_QUERIES[name], values);
  return { schema: results.schema.rows[0] || null, tables: results.tables.rows, columns: results.columns.rows, constraints: results.constraints.rows, indexes: results.indexes.rows, triggers: results.triggers.rows, functions: results.functions.rows, sequences: results.sequences.rows, migrations: results.migrations.rows };
}

export function compareSchemaCatalog(catalog, options = {}) {
  const contract = options.contract || RUNTIME_SCHEMA_CONTRACT;
  const expectedOwner = options.expectedOwner || "";
  const differences = [];
  const tableRows = new Map((catalog.tables || []).map((row) => [row.table_name, row]));
  const columns = groupRows(catalog.columns, "table_name");
  const constraints = groupRows(catalog.constraints, "table_name");
  const indexes = new Map((catalog.indexes || []).map((row) => [`${row.table_name}.${row.name}`, row]));
  const triggers = new Map((catalog.triggers || []).map((row) => [`${row.table_name}.${row.name}`, row]));
  const functions = new Map((catalog.functions || []).map((row) => [`${row.name}(${row.identity_arguments || ""})`, row]));
  const sequences = new Map((catalog.sequences || []).map((row) => [row.name, row]));
  const migrations = new Set((catalog.migrations || []).map((row) => row.version));
  if (!catalog.schema) addDifference(differences, "schema", contract.schema, "present", "missing");
  else if ((options.expectedSchemaOwner || expectedOwner) && catalog.schema.owner !== (options.expectedSchemaOwner || expectedOwner)) addDifference(differences, "ownership", `schema:${contract.schema}`, options.expectedSchemaOwner || expectedOwner, catalog.schema.owner || "missing");
  for (const [tableName, expectation] of Object.entries(contract.tables)) {
    const table = tableRows.get(tableName);
    if (!table) { addDifference(differences, "table", `${contract.schema}.${tableName}`, "present", "missing"); continue; }
    if (expectedOwner && table.owner !== expectedOwner) addDifference(differences, "ownership", `table:${tableName}`, expectedOwner, table.owner || "missing");
    const actualColumns = new Map((columns.get(tableName) || []).map((row) => [row.column_name, row]));
    for (const [columnName, expected] of Object.entries(expectation.columns)) {
      const actual = actualColumns.get(columnName); const subject = `column:${tableName}.${columnName}`;
      if (!actual) { addDifference(differences, "column", subject, describeColumn(expected), "missing"); continue; }
      if (!sameType(actual, expected.type)) addDifference(differences, "column-type", subject, expected.type, actual.udt_name || actual.data_type || "unknown");
      if (Boolean(actual.nullable) !== Boolean(expected.nullable)) addDifference(differences, "column-nullability", subject, expected.nullable ? "nullable" : "not-null", actual.nullable ? "nullable" : "not-null");
      if (expected.defaultIncludes && !normalized(actual.column_default).includes(normalized(expected.defaultIncludes))) addDifference(differences, "column-default", subject, `default contains ${expected.defaultIncludes}`, actual.column_default || "none");
    }
    const tableConstraints = constraints.get(tableName) || [];
    for (const primaryKey of expectation.primaryKeys || []) if (!tableConstraints.some((row) => row.type === "p" && equalColumns(row.columns, primaryKey))) addDifference(differences, "primary-key", `table:${tableName}`, primaryKey.join(","), "missing");
    for (const unique of expectation.unique || []) if (!tableConstraints.some((row) => row.type === "u" && equalColumns(row.columns, unique))) addDifference(differences, "unique", `table:${tableName}`, unique.join(","), "missing");
    for (const foreignKey of expectation.foreignKeys || []) {
      const actual = tableConstraints.find((row) => row.type === "f" && equalColumns(row.columns, foreignKey.columns) && row.references_table === foreignKey.referencesTable);
      if (!actual) addDifference(differences, "foreign-key", `table:${tableName}`, `${foreignKey.columns.join(",")} -> ${foreignKey.referencesTable}`, "missing");
      else if (foreignKey.onDelete && actual.on_delete !== foreignKey.onDelete) addDifference(differences, "foreign-key-delete", `table:${tableName}.${foreignKey.columns.join(",")}`, foreignKey.onDelete, actual.on_delete || "default");
    }
    for (const expectedCheck of expectation.checks || []) if (!tableConstraints.some((row) => row.type === "c" && expectedCheck.parts.every((part) => normalized(row.definition).includes(normalized(part))))) addDifference(differences, "check", `table:${tableName}`, `check contains ${expectedCheck.parts.join("; ")}`, "missing");
  }
  for (const expected of contract.indexes) {
    const actual = indexes.get(`${expected.table}.${expected.name}`);
    if (!actual) { addDifference(differences, "index", `index:${expected.table}.${expected.name}`, "present", "missing"); continue; }
    if (Boolean(actual.unique) !== Boolean(expected.unique)) addDifference(differences, "index-unique", `index:${expected.table}.${expected.name}`, String(expected.unique), String(actual.unique));
    const partialExpected = Boolean(expected.predicateParts?.length);
    if (Boolean(actual.partial) !== partialExpected) addDifference(differences, "index-partial", `index:${expected.table}.${expected.name}`, String(partialExpected), String(Boolean(actual.partial)));
    for (const part of expected.parts || []) if (!normalized(actual.definition).includes(normalized(part))) addDifference(differences, "index-definition", `index:${expected.table}.${expected.name}`, `contains ${part}`, actual.definition || "missing");
    for (const part of expected.predicateParts || []) if (!normalized(actual.predicate).includes(normalized(part))) addDifference(differences, "index-predicate", `index:${expected.table}.${expected.name}`, `predicate contains ${part}`, actual.predicate || "missing");
    if (expectedOwner && actual.owner !== expectedOwner) addDifference(differences, "ownership", `index:${expected.table}.${expected.name}`, expectedOwner, actual.owner || "missing");
  }
  for (const expected of contract.functions) {
    const actual = functions.get(`${expected.name}(${expected.identityArguments || ""})`);
    if (!actual) { addDifference(differences, "function", `function:${expected.name}(${expected.identityArguments || ""})`, "present", "missing"); continue; }
    if (!normalized(actual.returns).includes(normalized(expected.returns))) addDifference(differences, "function-return", `function:${expected.name}`, expected.returns, actual.returns || "missing");
    if (normalized(actual.language) !== normalized(expected.language)) addDifference(differences, "function-language", `function:${expected.name}`, expected.language, actual.language || "missing");
    for (const part of expected.sourceParts || []) if (!normalized(actual.source).includes(normalized(part))) addDifference(differences, "function-source", `function:${expected.name}`, `contains ${part}`, "different");
    if (expectedOwner && actual.owner !== expectedOwner) addDifference(differences, "ownership", `function:${expected.name}`, expectedOwner, actual.owner || "missing");
  }
  for (const expected of contract.triggers) {
    const actual = triggers.get(`${expected.table}.${expected.name}`);
    if (!actual) { addDifference(differences, "trigger", `trigger:${expected.table}.${expected.name}`, "present", "missing"); continue; }
    if (actual.function_name !== expected.function) addDifference(differences, "trigger-function", `trigger:${expected.table}.${expected.name}`, expected.function, actual.function_name || "missing");
    for (const part of expected.definitionParts || []) if (!normalized(actual.definition).includes(normalized(part))) addDifference(differences, "trigger-definition", `trigger:${expected.table}.${expected.name}`, `contains ${part}`, "different");
  }
  for (const expected of contract.sequences) { const actual = sequences.get(expected.name); if (!actual) addDifference(differences, "sequence", `sequence:${expected.name}`, "present", "missing"); else if (expectedOwner && actual.owner !== expectedOwner) addDifference(differences, "ownership", `sequence:${expected.name}`, expectedOwner, actual.owner || "missing"); }
  for (const migration of contract.migrations) if (!migrations.has(migration)) addDifference(differences, "migration", `migration:${migration}`, "applied", "missing");
  return { valid: differences.length === 0, differences };
}

function groupRows(rows = [], key) { const groups = new Map(); for (const row of rows || []) { const name = row[key]; if (!groups.has(name)) groups.set(name, []); groups.get(name).push(row); } return groups; }
function equalColumns(actual = [], expected = []) { const values = Array.isArray(actual) ? actual : String(actual || "").replace(/^\{/, "").replace(/\}$/, "").split(",").filter(Boolean); return values.length === expected.length && values.every((value, index) => value === expected[index]); }
function sameType(actual, expected) { return normalized(actual.udt_name) === normalized(expected) || normalized(actual.data_type) === normalized(expected); }
function describeColumn(expected) { return `${expected.type}${expected.nullable ? " nullable" : " not-null"}`; }
function normalized(value) { return String(value || "").toLowerCase().replace(/\s+/g, ""); }
function addDifference(differences, category, object, expected, actual) { differences.push({ category, object, expected, actual, critical: true }); }
