// PostgreSQL schema contract used by the read-only operational verifier.
// Keep this declarative and update it together with a new migration. Parsing
// migrations is unsafe here because they can contain data changes and
// conditional DDL that do not describe the final catalog state.

export const SCHEMA_CONTRACT_VERSION = 2;

const column = (type, options = {}) => ({ type, nullable: options.nullable === true, default: options.default ?? null });
const text = (options) => column("text", options);
const jsonb = (options) => column("jsonb", options);
const timestamp = (options) => column("timestamp with time zone", options);
const check = (definition) => ({ definition });

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
    app_schema_migrations: { columns: { version: text(), applied_at: timestamp({ default: "now()" }) }, primaryKeys: [["version"]] },
    app_users: {
      columns: {
        id: text({ default: "(gen_random_uuid())::text" }), nome: text(), email: column("citext"), foto_url: text({ default: "''::text" }),
        google_sub: text({ nullable: true }), origem_cadastro: text({ default: "'local'::text" }), senha_hash: text({ default: "''::text" }),
        precisa_definir_senha: column("boolean", { default: "false" }), role: text({ default: "'almoxarifado'::text" }), ativo: column("boolean", { default: "true" }),
        criado_em: timestamp({ default: "now()" }), atualizado_em: timestamp({ default: "now()" }), access_justification: text({ default: "''::text" }),
        access_requested_at: timestamp({ nullable: true }), auth_version: column("bigint", { default: "1" })
      },
      primaryKeys: [["id"]], unique: [["email"], ["google_sub"]], checks: [check("CHECK (role = ANY (ARRAY['admin'::text, 'almoxarifado'::text, 'auditor'::text]))"), check("CHECK (auth_version > 0)")]
    },
    user_sessions: {
      columns: { token_hash: text(), user_id: text(), created_at: timestamp({ default: "now()" }), last_activity_at: timestamp({ default: "now()" }), expires_at: timestamp(), revoked_at: timestamp({ nullable: true }), auth_version: column("bigint", { default: "1" }) },
      primaryKeys: [["token_hash"]], foreignKeys: [{ columns: ["user_id"], referencesTable: "app_users", referencesColumns: ["id"], onDelete: "c" }], checks: [check("CHECK (auth_version > 0)")]
    },
    email_templates: { columns: { template_key: text(), assunto: text(), corpo: text(), atualizado_em: timestamp({ default: "now()" }) }, primaryKeys: [["template_key"]] },
    email_template_attachments: {
      columns: {
        id: text({ default: "(gen_random_uuid())::text" }), template_key: text(), file_name: text(), storage_key: text(), public_path: text({ default: "''::text" }),
        mime_type: text({ default: "''::text" }), size_bytes: column("bigint", { default: "0" }), uploaded_by_name: text({ default: "''::text" }),
        uploaded_by_user_id: text({ nullable: true }), uploaded_at: timestamp({ default: "now()" })
      },
      primaryKeys: [["id"]], unique: [["storage_key"]], foreignKeys: [{ columns: ["template_key"], referencesTable: "email_templates", referencesColumns: ["template_key"], onDelete: "c" }, { columns: ["uploaded_by_user_id"], referencesTable: "app_users", referencesColumns: ["id"], onDelete: "n" }], checks: [check("CHECK (size_bytes >= 0)")]
    },
    notification_rules: {
      columns: { id: column("bool", { default: "true" }), dias_aviso_interno: column("_int4", { default: "ARRAY[14, 21, 28]" }), dia_oficio_fornecedor: column("integer", { default: "31" }), atualizado_em: timestamp({ default: "now()" }) },
      primaryKeys: [["id"]], checks: [check("CHECK (id = true)"), check("CHECK (dia_oficio_fornecedor > 0)")]
    },
    notification_recipients: {
      columns: { id: text({ default: "(gen_random_uuid())::text" }), nome: text(), email: column("citext"), funcao: text({ default: "''::text" }), ativo: column("boolean", { default: "true" }), criado_em: timestamp({ default: "now()" }), atualizado_em: timestamp({ default: "now()" }) },
      primaryKeys: [["id"]]
    },
    app_settings: { columns: { key: text(), value: jsonb(), updated_at: timestamp({ default: "now()" }) }, primaryKeys: [["key"]] },
    app_processes: { columns: { id: text(), data: jsonb(), created_at: timestamp({ default: "now()" }), updated_at: timestamp({ default: "now()" }) }, primaryKeys: [["id"]] },
    app_suppliers: { columns: { id: text(), data: jsonb(), created_at: timestamp({ default: "now()" }), updated_at: timestamp({ default: "now()" }) }, primaryKeys: [["id"]] },
    app_process_observations: { columns: { id: text(), processo_id: text(), data: jsonb(), created_at: timestamp({ default: "now()" }), updated_at: timestamp({ default: "now()" }) }, primaryKeys: [["id"]], foreignKeys: [{ columns: ["processo_id"], referencesTable: "app_processes", referencesColumns: ["id"], onDelete: "c" }] },
    app_process_audit: { columns: { id: text(), processo_id: text(), data: jsonb(), created_at: timestamp({ default: "now()" }) }, primaryKeys: [["id"]], foreignKeys: [{ columns: ["processo_id"], referencesTable: "app_processes", referencesColumns: ["id"], onDelete: "c" }] },
    app_email_history: { columns: { id: text(), dedupe_key: text({ nullable: true }), processo_id: text({ nullable: true }), data: jsonb(), created_at: timestamp({ default: "now()" }), updated_at: timestamp({ default: "now()" }) }, primaryKeys: [["id"]], unique: [["dedupe_key"]] },
    app_state_revision: { columns: { id: column("bool", { default: "true" }), revision: column("bigint", { default: "0" }) }, primaryKeys: [["id"]], checks: [check("CHECK (id = true)"), check("CHECK (revision >= 0)")] },
    app_email_dispatch_claims: {
      columns: { dedupe_key: text(), status: text(), metadata: jsonb({ default: "'{}'::jsonb" }), result: jsonb({ default: "'{}'::jsonb" }), claimed_at: timestamp({ default: "now()" }), sent_at: timestamp({ nullable: true }), updated_at: timestamp({ default: "now()" }), last_error: text({ default: "''::text" }) },
      primaryKeys: [["dedupe_key"]], checks: [check("CHECK (status = ANY (ARRAY['processing'::text, 'sent'::text, 'failed'::text]))")]
    },
    auth_rate_limits: { columns: { rate_key: text(), attempts: column("integer", { default: "0" }), window_started_at: timestamp({ default: "now()" }), updated_at: timestamp({ default: "now()" }) }, primaryKeys: [["rate_key"]], checks: [check("CHECK (attempts >= 0)")] },
    app_security_audit: {
      columns: { id: text({ default: "(gen_random_uuid())::text" }), event_type: text(), actor_user_id: text({ nullable: true }), actor_email: column("citext", { default: "''::citext" }), target_user_id: text({ nullable: true }), metadata: jsonb({ default: "'{}'::jsonb" }), created_at: timestamp({ default: "now()" }) },
      primaryKeys: [["id"]], foreignKeys: [{ columns: ["actor_user_id"], referencesTable: "app_users", referencesColumns: ["id"], onDelete: "n" }, { columns: ["target_user_id"], referencesTable: "app_users", referencesColumns: ["id"], onDelete: "n" }]
    }
  },
  indexes: [
    { table: "user_sessions", name: "user_sessions_user_idx", unique: false, keys: ["user_id"] },
    { table: "user_sessions", name: "user_sessions_active_idx", unique: false, keys: ["expires_at"], predicate: "revoked_at IS NULL" },
    { table: "user_sessions", name: "user_sessions_auth_version_idx", unique: false, keys: ["user_id", "auth_version"], predicate: "revoked_at IS NULL" },
    { table: "email_template_attachments", name: "email_template_attachments_template_idx", unique: false, keys: ["template_key"] },
    { table: "notification_recipients", name: "notification_recipients_email_uidx", unique: true, keys: ["email"] },
    { table: "app_processes", name: "app_processes_updated_idx", unique: false, keys: ["updated_at"] },
    { table: "app_processes", name: "app_processes_numero_processo_idx", unique: false, keys: ["regexp_replace(lower(data ->> 'numeroProcesso'::text), '[^a-z0-9]'::text, ''::text, 'g'::text)"], predicate: "COALESCE(data ->> 'numeroProcesso'::text, ''::text) <> ''::text AND COALESCE((data ->> 'inativo'::text)::boolean, false) = false" },
    { table: "app_processes", name: "app_processes_numero_empenho_uidx", unique: true, keys: ["regexp_replace(lower(data ->> 'numeroEmpenho'::text), '[^a-z0-9]'::text, ''::text, 'g'::text)"], predicate: "COALESCE(data ->> 'numeroEmpenho'::text, ''::text) <> ''::text AND COALESCE((data ->> 'inativo'::text)::boolean, false) = false" },
    { table: "app_processes", name: "app_processes_status_idx", unique: false, keys: ["(data ->> 'status'::text)"] },
    { table: "app_processes", name: "app_processes_fornecedor_idx", unique: false, keys: ["lower(data ->> 'fornecedor'::text)"] },
    { table: "app_suppliers", name: "app_suppliers_updated_idx", unique: false, keys: ["updated_at"] },
    { table: "app_process_observations", name: "app_process_observations_process_idx", unique: false, keys: ["processo_id", "created_at"] },
    { table: "app_process_audit", name: "app_process_audit_process_idx", unique: false, keys: ["processo_id", "created_at"] },
    { table: "app_email_history", name: "app_email_history_process_idx", unique: false, keys: ["processo_id", "created_at"] },
    { table: "app_email_dispatch_claims", name: "app_email_dispatch_claims_status_idx", unique: false, keys: ["status", "updated_at"] },
    { table: "auth_rate_limits", name: "auth_rate_limits_updated_idx", unique: false, keys: ["updated_at"] },
    { table: "app_security_audit", name: "app_security_audit_created_idx", unique: false, keys: ["created_at"] },
    { table: "app_security_audit", name: "app_security_audit_actor_idx", unique: false, keys: ["actor_user_id", "created_at"] }
  ].map((index) => ({ accessMethod: "btree", ...index })),
  forbiddenIndexes: [{ table: "app_processes", name: "app_processes_numero_processo_uidx" }],
  functions: [{
    schema: "public",
    name: "prevent_process_audit_mutation",
    identityArguments: "",
    returns: "trigger",
    language: "plpgsql",
    // pg_get_functiondef() is normalized before comparison so PostgreSQL's
    // generated dollar-quote tag and whitespace do not create false drift.
    // Keep the complete executable definition here: fragments would accept an
    // inert IF false branch that merely contains the expected words.
    canonicalDefinition: "CREATE OR REPLACE FUNCTION public.prevent_process_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'app_process_audit is append-only'; END; $$"
  }],
  triggers: [
    { table: "app_process_audit", name: "app_process_audit_immutable", functionSchema: "public", function: "prevent_process_audit_mutation", functionIdentityArguments: "", timing: "BEFORE", events: ["UPDATE", "DELETE"], updateColumns: [], level: "ROW", whenCondition: null, enabled: "O" },
    { table: "app_security_audit", name: "app_security_audit_immutable", functionSchema: "public", function: "prevent_process_audit_mutation", functionIdentityArguments: "", timing: "BEFORE", events: ["UPDATE", "DELETE"], updateColumns: [], level: "ROW", whenCondition: null, enabled: "O" }
  ],
  // UUID defaults are functions; this schema has no serial/identity sequences.
  sequences: []
});

export const SCHEMA_CATALOG_QUERIES = Object.freeze({
  tables: `/* schema-contract:tables */ SELECT c.relname AS table_name, pg_get_userbyid(c.relowner) AS owner FROM pg_class AS c JOIN pg_namespace AS n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') AND c.relname = ANY($2::text[]) ORDER BY c.relname`,
  columns: `/* schema-contract:columns */ SELECT table_name, column_name, data_type, udt_name, is_nullable = 'YES' AS nullable, column_default FROM information_schema.columns WHERE table_schema = $1 AND table_name = ANY($2::text[]) ORDER BY table_name, ordinal_position`,
  constraints: `/* schema-contract:constraints */ SELECT rel.relname AS table_name, con.conname AS name, con.contype AS type, COALESCE(cols.columns, ARRAY[]::text[]) AS columns, ref.relname AS references_table, COALESCE(ref_cols.columns, ARRAY[]::text[]) AS references_columns, con.confdeltype AS on_delete, pg_get_constraintdef(con.oid, true) AS definition FROM pg_constraint AS con JOIN pg_class AS rel ON rel.oid = con.conrelid JOIN pg_namespace AS n ON n.oid = rel.relnamespace LEFT JOIN pg_class AS ref ON ref.oid = con.confrelid LEFT JOIN LATERAL (SELECT array_agg(att.attname ORDER BY key.ordinality) AS columns FROM unnest(con.conkey) WITH ORDINALITY AS key(attnum, ordinality) JOIN pg_attribute AS att ON att.attrelid = con.conrelid AND att.attnum = key.attnum) AS cols ON true LEFT JOIN LATERAL (SELECT array_agg(att.attname ORDER BY key.ordinality) AS columns FROM unnest(con.confkey) WITH ORDINALITY AS key(attnum, ordinality) JOIN pg_attribute AS att ON att.attrelid = con.confrelid AND att.attnum = key.attnum) AS ref_cols ON true WHERE n.nspname = $1 AND rel.relname = ANY($2::text[]) ORDER BY rel.relname, con.conname`,
  indexes: `/* schema-contract:indexes */ SELECT tbl.relname AS table_name, idx.relname AS name, ind.indisunique AS unique, ind.indisvalid AS valid, ind.indisready AS ready, access_method.amname AS access_method, ind.indpred IS NOT NULL AS partial, keys.key_definitions, pg_get_expr(ind.indpred, ind.indrelid, true) AS predicate, pg_get_userbyid(idx.relowner) AS owner FROM pg_index AS ind JOIN pg_class AS idx ON idx.oid = ind.indexrelid JOIN pg_am AS access_method ON access_method.oid = idx.relam JOIN pg_class AS tbl ON tbl.oid = ind.indrelid JOIN pg_namespace AS n ON n.oid = tbl.relnamespace LEFT JOIN LATERAL (SELECT array_agg(pg_get_indexdef(ind.indexrelid, key_ordinality, true) ORDER BY key_ordinality) AS key_definitions FROM generate_series(1, ind.indnkeyatts) AS key_ordinality) AS keys ON true WHERE n.nspname = $1 AND tbl.relname = ANY($2::text[]) ORDER BY tbl.relname, idx.relname`,
  triggers: `/* schema-contract:triggers */ SELECT tbl.relname AS table_name, trg.tgname AS name, proc_namespace.nspname AS function_schema, proc.proname AS function_name, pg_get_function_identity_arguments(proc.oid) AS function_identity_arguments, CASE WHEN (trg.tgtype & 2) <> 0 THEN 'BEFORE' WHEN (trg.tgtype & 64) <> 0 THEN 'INSTEAD OF' ELSE 'AFTER' END AS timing, ARRAY_REMOVE(ARRAY[CASE WHEN (trg.tgtype & 4) <> 0 THEN 'INSERT' END, CASE WHEN (trg.tgtype & 16) <> 0 THEN 'UPDATE' END, CASE WHEN (trg.tgtype & 8) <> 0 THEN 'DELETE' END, CASE WHEN (trg.tgtype & 32) <> 0 THEN 'TRUNCATE' END], NULL) AS events, COALESCE(update_columns.columns, ARRAY[]::text[]) AS update_columns, CASE WHEN (trg.tgtype & 1) <> 0 THEN 'ROW' ELSE 'STATEMENT' END AS level, pg_get_expr(trg.tgqual, trg.tgrelid, true) AS when_condition, trg.tgenabled AS enabled FROM pg_trigger AS trg JOIN pg_class AS tbl ON tbl.oid = trg.tgrelid JOIN pg_namespace AS n ON n.oid = tbl.relnamespace JOIN pg_proc AS proc ON proc.oid = trg.tgfoid JOIN pg_namespace AS proc_namespace ON proc_namespace.oid = proc.pronamespace LEFT JOIN LATERAL (SELECT array_agg(att.attname ORDER BY attr.ordinality) AS columns FROM unnest(trg.tgattr::smallint[]) WITH ORDINALITY AS attr(attnum, ordinality) JOIN pg_attribute AS att ON att.attrelid = trg.tgrelid AND att.attnum = attr.attnum) AS update_columns ON true WHERE n.nspname = $1 AND tbl.relname = ANY($2::text[]) AND NOT trg.tgisinternal ORDER BY tbl.relname, trg.tgname`,
  functions: `/* schema-contract:functions */ SELECT n.nspname AS function_schema, proc.proname AS name, pg_get_function_identity_arguments(proc.oid) AS identity_arguments, pg_get_function_result(proc.oid) AS returns, lang.lanname AS language, pg_get_functiondef(proc.oid) AS source, pg_get_userbyid(proc.proowner) AS owner FROM pg_proc AS proc JOIN pg_namespace AS n ON n.oid = proc.pronamespace JOIN pg_language AS lang ON lang.oid = proc.prolang WHERE n.nspname = $1 AND proc.proname = ANY($2::text[]) ORDER BY proc.proname, identity_arguments`,
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
  const functions = new Map((catalog.functions || []).map((row) => [`${row.function_schema || contract.schema}.${row.name}(${row.identity_arguments || ""})`, row]));
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
      if (!sameDefault(actual.column_default, expected.default)) addDifference(differences, "column-default", subject, expected.default || "no default", actual.column_default || "no default");
    }
    const tableConstraints = constraints.get(tableName) || [];
    for (const primaryKey of expectation.primaryKeys || []) if (!tableConstraints.some((row) => row.type === "p" && equalColumns(row.columns, primaryKey))) addDifference(differences, "primary-key", `table:${tableName}`, primaryKey.join(","), "missing");
    for (const unique of expectation.unique || []) if (!tableConstraints.some((row) => row.type === "u" && equalColumns(row.columns, unique))) addDifference(differences, "unique", `table:${tableName}`, unique.join(","), "missing");
    for (const foreignKey of expectation.foreignKeys || []) {
      const actual = tableConstraints.find((row) => row.type === "f" && equalColumns(row.columns, foreignKey.columns) && row.references_table === foreignKey.referencesTable && equalColumns(row.references_columns, foreignKey.referencesColumns));
      if (!actual) addDifference(differences, "foreign-key", `table:${tableName}`, `${foreignKey.columns.join(",")} -> ${foreignKey.referencesTable}`, "missing");
      else if (foreignKey.onDelete && actual.on_delete !== foreignKey.onDelete) addDifference(differences, "foreign-key-delete", `table:${tableName}.${foreignKey.columns.join(",")}`, foreignKey.onDelete, actual.on_delete || "default");
    }
    for (const expectedCheck of expectation.checks || []) if (!tableConstraints.some((row) => row.type === "c" && normalizedSql(row.definition) === normalizedSql(expectedCheck.definition))) addDifference(differences, "check", `table:${tableName}`, expectedCheck.definition, "missing or different");
  }
  for (const expected of contract.indexes) {
    const actual = indexes.get(`${expected.table}.${expected.name}`);
    if (!actual) { addDifference(differences, "index", `index:${expected.table}.${expected.name}`, "present", "missing"); continue; }
    if (Boolean(actual.unique) !== Boolean(expected.unique)) addDifference(differences, "index-unique", `index:${expected.table}.${expected.name}`, String(expected.unique), String(actual.unique));
    if (actual.valid !== true) addDifference(differences, "index-validity", `index:${expected.table}.${expected.name}`, "valid", String(actual.valid));
    if (actual.ready !== true) addDifference(differences, "index-readiness", `index:${expected.table}.${expected.name}`, "ready", String(actual.ready));
    if (expected.accessMethod && normalized(actual.access_method) !== normalized(expected.accessMethod)) addDifference(differences, "index-access-method", `index:${expected.table}.${expected.name}`, expected.accessMethod, actual.access_method || "missing");
    const partialExpected = Boolean(expected.predicate);
    if (Boolean(actual.partial) !== partialExpected) addDifference(differences, "index-partial", `index:${expected.table}.${expected.name}`, String(partialExpected), String(Boolean(actual.partial)));
    if (!equalSqlArrays(actual.key_definitions, expected.keys)) addDifference(differences, "index-definition", `index:${expected.table}.${expected.name}`, (expected.keys || []).join(", "), (actual.key_definitions || []).join(", ") || "missing");
    if (!sameSql(actual.predicate, expected.predicate)) addDifference(differences, "index-predicate", `index:${expected.table}.${expected.name}`, expected.predicate || "no predicate", actual.predicate || "no predicate");
    if (expectedOwner && actual.owner !== expectedOwner) addDifference(differences, "ownership", `index:${expected.table}.${expected.name}`, expectedOwner, actual.owner || "missing");
  }
  for (const forbidden of contract.forbiddenIndexes || []) if (indexes.has(`${forbidden.table}.${forbidden.name}`)) addDifference(differences, "forbidden-index", `index:${forbidden.table}.${forbidden.name}`, "absent", "present");
  for (const expected of contract.functions) {
    const functionSchema = expected.schema || contract.schema;
    const actual = functions.get(`${functionSchema}.${expected.name}(${expected.identityArguments || ""})`);
    if (!actual) { addDifference(differences, "function", `function:${functionSchema}.${expected.name}(${expected.identityArguments || ""})`, "present", "missing"); continue; }
    if (!normalized(actual.returns).includes(normalized(expected.returns))) addDifference(differences, "function-return", `function:${expected.name}`, expected.returns, actual.returns || "missing");
    if (normalized(actual.language) !== normalized(expected.language)) addDifference(differences, "function-language", `function:${expected.name}`, expected.language, actual.language || "missing");
    if (canonicalFunctionDefinition(actual.source) !== canonicalFunctionDefinition(expected.canonicalDefinition)) addDifference(differences, "function-definition", `function:${functionSchema}.${expected.name}(${expected.identityArguments || ""})`, expected.canonicalDefinition, actual.source || "missing or different");
    if (expectedOwner && actual.owner !== expectedOwner) addDifference(differences, "ownership", `function:${expected.name}`, expectedOwner, actual.owner || "missing");
  }
  for (const expected of contract.triggers) {
    const actual = triggers.get(`${expected.table}.${expected.name}`);
    if (!actual) { addDifference(differences, "trigger", `trigger:${expected.table}.${expected.name}`, "present", "missing"); continue; }
    if (actual.function_schema !== (expected.functionSchema || contract.schema) || actual.function_name !== expected.function || (actual.function_identity_arguments || "") !== (expected.functionIdentityArguments || "")) addDifference(differences, "trigger-function", `trigger:${expected.table}.${expected.name}`, `${expected.functionSchema || contract.schema}.${expected.function}(${expected.functionIdentityArguments || ""})`, `${actual.function_schema || "missing"}.${actual.function_name || "missing"}(${actual.function_identity_arguments || ""})`);
    if (normalized(actual.timing) !== normalized(expected.timing)) addDifference(differences, "trigger-timing", `trigger:${expected.table}.${expected.name}`, expected.timing, actual.timing || "missing");
    if (!equalTextArrays(actual.events, expected.events)) addDifference(differences, "trigger-events", `trigger:${expected.table}.${expected.name}`, (expected.events || []).join(", "), (actual.events || []).join(", ") || "missing");
    if (!equalTextArrays(actual.update_columns, expected.updateColumns || [])) addDifference(differences, "trigger-update-columns", `trigger:${expected.table}.${expected.name}`, (expected.updateColumns || []).join(", ") || "no UPDATE OF columns", (actual.update_columns || []).join(", ") || "no UPDATE OF columns");
    if (normalized(actual.level) !== normalized(expected.level)) addDifference(differences, "trigger-level", `trigger:${expected.table}.${expected.name}`, expected.level, actual.level || "missing");
    if (!sameSql(actual.when_condition, expected.whenCondition)) addDifference(differences, "trigger-when", `trigger:${expected.table}.${expected.name}`, expected.whenCondition || "no WHEN clause", actual.when_condition || "no WHEN clause");
    if (actual.enabled !== expected.enabled) addDifference(differences, "trigger-enabled", `trigger:${expected.table}.${expected.name}`, expected.enabled, actual.enabled || "missing");
  }
  for (const expected of contract.sequences) { const actual = sequences.get(expected.name); if (!actual) addDifference(differences, "sequence", `sequence:${expected.name}`, "present", "missing"); else if (expectedOwner && actual.owner !== expectedOwner) addDifference(differences, "ownership", `sequence:${expected.name}`, expectedOwner, actual.owner || "missing"); }
  for (const migration of contract.migrations) if (!migrations.has(migration)) addDifference(differences, "migration", `migration:${migration}`, "applied", "missing");
  return { valid: differences.length === 0, differences };
}

function groupRows(rows = [], key) { const groups = new Map(); for (const row of rows || []) { const name = row[key]; if (!groups.has(name)) groups.set(name, []); groups.get(name).push(row); } return groups; }
function equalColumns(actual = [], expected = []) { const values = Array.isArray(actual) ? actual : String(actual || "").replace(/^\{/, "").replace(/\}$/, "").split(",").filter(Boolean); return values.length === expected.length && values.every((value, index) => value === expected[index]); }
function sameType(actual, expected) { return normalized(actual.udt_name) === normalized(expected) || normalized(actual.data_type) === normalized(expected); }
function sameDefault(actual, expected) { return sameSql(actual, expected); }
function equalSqlArrays(actual = [], expected = []) { const actualValues = Array.isArray(actual) ? actual : []; return actualValues.length === (expected || []).length && actualValues.every((value, index) => sameSql(value, expected[index])); }
function equalTextArrays(actual = [], expected = []) { const actualValues = Array.isArray(actual) ? actual : []; return actualValues.length === (expected || []).length && actualValues.every((value, index) => normalized(value) === normalized(expected[index])); }
function sameSql(actual, expected) { return normalizedSql(actual) === normalizedSql(expected); }
function canonicalFunctionDefinition(value) { return normalized(String(value || "").replace(/\$[A-Za-z_][A-Za-z0-9_]*\$/g, () => "$$")); }
function describeColumn(expected) { return `${expected.type}${expected.nullable ? " nullable" : " not-null"}`; }
function normalized(value) { return String(value || "").toLowerCase().replace(/\s+/g, ""); }
function normalizedSql(value) { return normalized(value).replace(/\(\(([^()]+)\)\)/g, "($1)"); }
function addDifference(differences, category, object, expected, actual) { differences.push({ category, object, expected, actual, critical: true }); }
