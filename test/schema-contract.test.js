import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RUNTIME_SCHEMA_CONTRACT, compareSchemaCatalog } from "../src/db/schema-contract.js";

const OWNER = "neondb_owner";

describe("contrato de schema PostgreSQL", () => {
  it("aceita o catalogo completo esperado, inclusive migration 011", () => {
    const result = compareSchemaCatalog(completeCatalog(), { expectedOwner: OWNER });
    assert.deepEqual(result, { valid: true, differences: [] });
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
      "app_users:p:id", "app_users:u:email", "user_sessions:f:user_id", "auth_rate_limits:c:attempts"
    ].includes(row.marker));
    const categories = compareSchemaCatalog(catalog, { expectedOwner: OWNER }).differences.map((item) => item.category);
    assert.ok(categories.includes("primary-key"));
    assert.ok(categories.includes("unique"));
    assert.ok(categories.includes("foreign-key"));
    assert.ok(categories.includes("check"));
  });

  it("detecta indice, unicidade, predicado parcial e ownership divergentes", () => {
    const catalog = completeCatalog();
    const index = catalog.indexes.find((row) => row.name === "app_processes_numero_empenho_uidx");
    index.unique = false;
    index.partial = false;
    index.predicate = "";
    index.owner = "runtime_role";
    catalog.indexes = catalog.indexes.filter((row) => row.name !== "app_processes_status_idx");
    const categories = compareSchemaCatalog(catalog, { expectedOwner: OWNER }).differences.map((item) => item.category);
    assert.ok(categories.includes("index"));
    assert.ok(categories.includes("index-unique"));
    assert.ok(categories.includes("index-partial"));
    assert.ok(categories.includes("index-predicate"));
    assert.ok(categories.includes("ownership"));
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
    column_default: expected.defaultIncludes || null
  })));
  const constraints = Object.entries(contract.tables).flatMap(([table_name, table]) => [
    ...(table.primaryKeys || []).map((columns) => ({ table_name, type: "p", columns, marker: `${table_name}:p:${columns.join(",")}` })),
    ...(table.unique || []).map((columns) => ({ table_name, type: "u", columns, marker: `${table_name}:u:${columns.join(",")}` })),
    ...(table.foreignKeys || []).map((foreignKey) => ({ table_name, type: "f", columns: foreignKey.columns, references_table: foreignKey.referencesTable, on_delete: foreignKey.onDelete, marker: `${table_name}:f:${foreignKey.columns.join(",")}` })),
    ...(table.checks || []).map((expectedCheck) => ({ table_name, type: "c", columns: [], definition: `CHECK (${expectedCheck.parts.join(" AND ")})`, marker: `${table_name}:c:${expectedCheck.parts[0]}` }))
  ]);
  const indexes = contract.indexes.map((expected) => ({
    table_name: expected.table, name: expected.name, unique: expected.unique, partial: Boolean(expected.predicateParts?.length),
    definition: expected.parts.join(" "), predicate: (expected.predicateParts || []).join(" "), owner: OWNER
  }));
  const functions = contract.functions.map((expected) => ({ name: expected.name, identity_arguments: expected.identityArguments, returns: expected.returns, language: expected.language, source: expected.sourceParts.join(" "), owner: OWNER }));
  const triggers = contract.triggers.map((expected) => ({ table_name: expected.table, name: expected.name, function_name: expected.function, definition: expected.definitionParts.join(" ") }));
  return { schema: { schema: contract.schema, owner: OWNER }, tables, columns, constraints, indexes, functions, triggers, sequences: contract.sequences.map((item) => ({ name: item.name, owner: OWNER })), migrations: contract.migrations.map((version) => ({ version })) };
}
