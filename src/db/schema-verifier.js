import pg from "pg";
import { createPoolConfig } from "./postgres.js";
import { RUNTIME_SCHEMA_CONTRACT, compareSchemaCatalog, readSchemaCatalog } from "./schema-contract.js";

export async function verifyDatabaseSchema(options = {}) {
  const environment = options.environment || process.env;
  const databaseUrl = options.databaseUrl || environment.DATABASE_URL_SCHEMA_VERIFY || environment.DATABASE_URL;
  const expectedOwner = options.expectedOwner ?? environment.DATABASE_SCHEMA_OWNER ?? "";
  const expectedSchemaOwner = options.expectedSchemaOwner ?? environment.DATABASE_PUBLIC_SCHEMA_OWNER ?? "pg_database_owner";
  if (!databaseUrl) throw new Error("DATABASE_URL_SCHEMA_VERIFY ou DATABASE_URL e obrigatoria.");
  if (!expectedOwner && !options.allowUnverifiedOwnership) throw new Error("DATABASE_SCHEMA_OWNER e obrigatoria para verificar ownership dos objetos.");
  if (expectedOwner && !isRoleName(expectedOwner)) throw new Error("DATABASE_SCHEMA_OWNER invalida.");
  if (expectedSchemaOwner && !isRoleName(expectedSchemaOwner)) throw new Error("DATABASE_PUBLIC_SCHEMA_OWNER invalida.");
  const client = options.client || new pg.Client(createPoolConfig(databaseUrl));
  const ownsClient = !options.client;
  try {
    if (ownsClient) await client.connect();
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const contract = options.contract || RUNTIME_SCHEMA_CONTRACT;
    const catalog = await readSchemaCatalog(client, { contract });
    await client.query("COMMIT");
    const comparison = compareSchemaCatalog(catalog, { contract, expectedOwner, expectedSchemaOwner });
    return { valid: comparison.valid, contractVersion: contract.version, expectedOwner: expectedOwner || null, expectedSchemaOwner: expectedSchemaOwner || null, summary: { tables: catalog.tables.length, columns: catalog.columns.length, constraints: catalog.constraints.length, indexes: catalog.indexes.length, triggers: catalog.triggers.length, functions: catalog.functions.length, sequences: catalog.sequences.length, migrations: catalog.migrations.length }, differences: comparison.differences };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => null);
    throw error;
  } finally {
    if (ownsClient) await client.end();
  }
}

export function safeSchemaVerificationError(error) {
  return String(error?.message || "Erro de verificacao de schema").replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[database-url-redacted]").slice(0, 300);
}

function isRoleName(value) { return /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/.test(value); }
