import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RUNTIME_SCHEMA_CONTRACT, compareSchemaCatalog } from "../src/db/schema-contract.js";

const OWNER = "neondb_owner";

describe("contrato de schema PostgreSQL", () => {
  it("aceita o catalogo completo esperado, inclusive migration 011", () => {
    const result = compareSchemaCatalog(completeCatalog(), { expectedOwner: OWNER });
    assert.deepEqual(result, { valid: true, differences: [] });
  });

  it("aceita o delimitador dollar-quote canonico gerado pelo PostgreSQL", () => {
    const catalog = completeCatalog();
    catalog.functions.find((row) => row.name === "prevent_process_audit_mutation").source = "CREATE OR REPLACE FUNCTION public.prevent_process_audit_mutation()\n RETURNS trigger\n LANGUAGE plpgsql\nAS $function$\nBEGIN\n  RAISE EXCEPTION 'app_process_audit is append-only';\nEND;\n$function$\n";
    assert.deepEqual(compareSchemaCatalog(catalog, { expectedOwner: OWNER }), { valid: true, differences: [] });
  });

  it("detecta tabela, coluna, tipo, nullability e default divergentes", () => {
    const catalog = completeCatalog();
    catalog.tables = catalog.tables.filter((row) => row.table_name !== "app_suppliers");
    const email = catalog.columns.find((row) => row.table_name === "app_users" && row.column_name === "email");
    email.udt_name = "text";
    email.data_type = "text";
    const nome = catalog.columns.find((row) => row.table_name === "app_users" && row.column_name === "nome");
    nome.nullable = true;
    const active = catalog.columns.find((row) => row.table_name === "app_users" && row.column_name === "ativo");
    active.column_default = null;
    const categories = compareSchemaCatalog(catalog, { expectedOwner: OWNER }).differences.map((item) => item.category);
    assert.ok(categories.includes("table"));
    assert.ok(categories.includes("column-type"));
    assert.ok(categories.includes("column-nullability"));
    assert.ok(categories.includes("column-default"));
  });

  it("detecta primary key, unique, foreign key e check ausentes", () => {
    const catalog = completeCatalog();
    catalog.constraints = catalog.constraints.filter((row) => ![
      "app_users:p:id", "app_users:u:email", "user_sessions:f:user_id", "auth_rate_limits:c:CHECK (attempts >= 0)"
    ].includes(row.marker));
    const categories = compareSchemaCatalog(catalog, { expectedOwner: OWNER }).differences.map((item) => item.category);
    assert.ok(categories.includes("primary-key"));
    assert.ok(categories.includes("unique"));
    assert.ok(categories.includes("foreign-key"));
    assert.ok(categories.includes("check"));
  });

  it("detecta indice, validade, prontidao, metodo, unicidade, predicado parcial e ownership divergentes", () => {
    const catalog = completeCatalog();
    const index = catalog.indexes.find((row) => row.name === "app_processes_numero_empenho_uidx");
    index.unique = false;
    index.valid = false;
    index.ready = false;
    index.access_method = "hash";
    index.partial = false;
    index.predicate = "";
    index.owner = "runtime_role";
    catalog.indexes = catalog.indexes.filter((row) => row.name !== "app_processes_status_idx");
    const categories = compareSchemaCatalog(catalog, { expectedOwner: OWNER }).differences.map((item) => item.category);
    assert.ok(categories.includes("index"));
    assert.ok(categories.includes("index-unique"));
    assert.ok(categories.includes("index-validity"));
    assert.ok(categories.includes("index-readiness"));
    assert.ok(categories.includes("index-access-method"));
    assert.ok(categories.includes("index-partial"));
    assert.ok(categories.includes("index-predicate"));
    assert.ok(categories.includes("ownership"));
  });

  it("rejeita indice legado proibido, expressao incompleta e predicado invertido", () => {
    const catalog = completeCatalog();
    catalog.indexes.push({ table_name: "app_processes", name: "app_processes_numero_processo_uidx", unique: true, partial: true, key_definitions: ["regexp_replace(lower(data ->> 'numeroProcesso'::text), '[^a-z0-9]'::text, ''::text, 'g'::text)"], predicate: "COALESCE(data ->> 'numeroProcesso'::text, ''::text) <> ''::text AND COALESCE((data ->> 'inativo'::text)::boolean, false) = false", owner: OWNER });
    const index = catalog.indexes.find((row) => row.name === "app_processes_numero_processo_idx");
    index.key_definitions = ["regexp_replace(lower(data ->> 'numeroProcesso'::text), '[^a-z0-9]'::text, ''::text, 'g'::text) || 'alterado'"];
    index.predicate = "COALESCE(data ->> 'numeroProcesso'::text, ''::text) <> ''::text AND COALESCE((data ->> 'inativo'::text)::boolean, false) = true";
    const categories = compareSchemaCatalog(catalog, { expectedOwner: OWNER }).differences.map((item) => item.category);
    assert.ok(categories.includes("forbidden-index"));
    assert.ok(categories.includes("index-definition"));
    assert.ok(categories.includes("index-predicate"));
  });

  it("rejeita indice exigido que nao esta valido", () => {
    const catalog = completeCatalog();
    catalog.indexes.find((row) => row.name === "app_processes_updated_idx").valid = false;
    const difference = compareSchemaCatalog(catalog, { expectedOwner: OWNER }).differences.find((item) => item.category === "index-validity");
    assert.equal(difference?.critical, true);
  });

  it("rejeita indice exigido que nao esta pronto", () => {
    const catalog = completeCatalog();
    catalog.indexes.find((row) => row.name === "app_processes_updated_idx").ready = false;
    const difference = compareSchemaCatalog(catalog, { expectedOwner: OWNER }).differences.find((item) => item.category === "index-readiness");
    assert.equal(difference?.critical, true);
  });

  it("rejeita FK em coluna referenciada errada, CHECK invertido e default inesperado", () => {
    const catalog = completeCatalog();
    const foreignKey = catalog.constraints.find((row) => row.marker === "user_sessions:f:user_id");
    foreignKey.references_columns = ["email"];
    const check = catalog.constraints.find((row) => row.marker === "auth_rate_limits:c:CHECK (attempts >= 0)");
    check.definition = "CHECK (attempts <= 0)";
    const active = catalog.columns.find((row) => row.table_name === "app_users" && row.column_name === "ativo");
    active.column_default = "false";
    const categories = compareSchemaCatalog(catalog, { expectedOwner: OWNER }).differences.map((item) => item.category);
    assert.ok(categories.includes("foreign-key"));
    assert.ok(categories.includes("check"));
    assert.ok(categories.includes("column-default"));
  });

  it("rejeita funcao homonima em outro schema e corpo inerte mesmo contendo os fragmentos esperados", () => {
    const catalog = completeCatalog();
    const trigger = catalog.triggers.find((row) => row.name === "app_process_audit_immutable");
    trigger.function_schema = "other_schema";
    const functionRow = catalog.functions.find((row) => row.name === "prevent_process_audit_mutation");
    functionRow.source = "CREATE OR REPLACE FUNCTION public.prevent_process_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF false THEN RAISE EXCEPTION 'app_process_audit is append-only'; END IF; RETURN OLD; END; $$";
    const categories = compareSchemaCatalog(catalog, { expectedOwner: OWNER }).differences.map((item) => item.category);
    assert.ok(categories.includes("trigger-function"));
    assert.ok(categories.includes("function-definition"));
  });

  it("rejeita trigger condicionado que nunca executa", () => {
    const catalog = completeCatalog();
    const trigger = catalog.triggers.find((row) => row.name === "app_process_audit_immutable");
    trigger.when_condition = "false";
    const difference = compareSchemaCatalog(catalog, { expectedOwner: OWNER }).differences.find((item) => item.category === "trigger-when");
    assert.equal(difference?.critical, true);
  });

  it("rejeita trigger UPDATE OF coluna que deixa outras mutacoes sem protecao", () => {
    const catalog = completeCatalog();
    const trigger = catalog.triggers.find((row) => row.name === "app_process_audit_immutable");
    trigger.update_columns = "{data}";
    const result = compareSchemaCatalog(catalog, { expectedOwner: OWNER });
    const difference = result.differences.find((item) => item.category === "trigger-update-columns");
    assert.equal(result.valid, false);
    assert.deepEqual(difference, {
      category: "trigger-update-columns",
      object: "trigger:app_process_audit.app_process_audit_immutable",
      expected: "no UPDATE OF columns",
      actual: "data",
      critical: true
    });
  });

  it("aceita o array textual vazio retornado pelo catalogo PostgreSQL", () => {
    const catalog = completeCatalog();
    for (const trigger of catalog.triggers) trigger.update_columns = "{}";
    assert.deepEqual(compareSchemaCatalog(catalog, { expectedOwner: OWNER }), { valid: true, differences: [] });
  });

  it("detecta funcao, trigger, sequence e migration ausentes", () => {
    const catalog = completeCatalog();
    catalog.functions = [];
    catalog.triggers = [];
    catalog.migrations = catalog.migrations.filter((row) => row.version !== "011_process_multiple_commitments");
    const sequenceContract = { ...RUNTIME_SCHEMA_CONTRACT, sequences: [{ name: "future_sequence" }] };
    const categories = compareSchemaCatalog(catalog, { contract: sequenceContract, expectedOwner: OWNER }).differences.map((item) => item.category);
    assert.ok(categories.includes("function"));
    assert.ok(categories.includes("trigger"));
    assert.ok(categories.includes("sequence"));
    assert.ok(categories.includes("migration"));
  });



});

function completeCatalog(contract = RUNTIME_SCHEMA_CONTRACT) {
  const tables = Object.entries(contract.tables).map(([table_name]) => ({ table_name, owner: OWNER }));
  const columns = Object.entries(contract.tables).flatMap(([table_name, table]) => Object.entries(table.columns).map(([column_name, expected]) => ({
    table_name, column_name, data_type: expected.type, udt_name: expected.type, nullable: expected.nullable,
    column_default: expected.default
  })));
  const constraints = Object.entries(contract.tables).flatMap(([table_name, table]) => [
    ...(table.primaryKeys || []).map((columns) => ({ table_name, type: "p", columns, marker: `${table_name}:p:${columns.join(",")}` })),
    ...(table.unique || []).map((columns) => ({ table_name, type: "u", columns, marker: `${table_name}:u:${columns.join(",")}` })),
    ...(table.foreignKeys || []).map((foreignKey) => ({ table_name, type: "f", columns: foreignKey.columns, references_table: foreignKey.referencesTable, references_columns: foreignKey.referencesColumns, on_delete: foreignKey.onDelete, marker: `${table_name}:f:${foreignKey.columns.join(",")}` })),
    ...(table.checks || []).map((expectedCheck) => ({ table_name, type: "c", columns: [], definition: expectedCheck.definition, marker: `${table_name}:c:${expectedCheck.definition}` }))
  ]);
  const indexes = contract.indexes.map((expected) => ({
    table_name: expected.table, name: expected.name, unique: expected.unique, partial: Boolean(expected.predicate),
    valid: true, ready: true, access_method: expected.accessMethod, key_definitions: expected.keys, predicate: expected.predicate || null, owner: OWNER
  }));
  const functions = contract.functions.map((expected) => ({ function_schema: expected.schema, name: expected.name, identity_arguments: expected.identityArguments, returns: expected.returns, language: expected.language, source: expected.canonicalDefinition, owner: OWNER }));
  const triggers = contract.triggers.map((expected) => ({ table_name: expected.table, name: expected.name, function_schema: expected.functionSchema, function_name: expected.function, function_identity_arguments: expected.functionIdentityArguments, timing: expected.timing, events: expected.events, update_columns: expected.updateColumns, level: expected.level, when_condition: expected.whenCondition, enabled: expected.enabled }));
  return { schema: { schema: contract.schema, owner: OWNER }, tables, columns, constraints, indexes, functions, triggers, sequences: contract.sequences.map((item) => ({ name: item.name, owner: OWNER })), migrations: contract.migrations.map((version) => ({ version })) };
}
