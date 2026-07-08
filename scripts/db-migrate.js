import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createPoolConfig } from "../src/db/postgres.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const MIGRATIONS_DIR = join(ROOT, "db", "migrations");

export async function runMigrations(options = {}) {
  const {
    databaseUrl = process.env.DATABASE_URL_MIGRATION || process.env.DATABASE_URL,
    migrationsDir = MIGRATIONS_DIR,
    createClient = defaultCreateClient,
    logger = console
  } = options;

  if (!databaseUrl) {
    throw new Error("DATABASE_URL nao configurada.");
  }

  const migrations = readdirSync(migrationsDir)
    .filter((fileName) => /^\d+_.+\.sql$/.test(fileName))
    .sort();

  if (!migrations.length) {
    logger.log("Nenhuma migracao encontrada.");
    return { applied: [], skipped: [] };
  }

  const client = createClient(databaseUrl);
  await client.connect();
  try {
    const appliedMigrations = await loadAppliedMigrations(client);
    const result = { applied: [], skipped: [] };

    for (const migration of migrations) {
      const migrationVersion = migration.replace(/\.sql$/, "");
      if (appliedMigrations.has(migrationVersion)) {
        logger.log(`Ignorando ${migration}: ja aplicada.`);
        result.skipped.push(migrationVersion);
        continue;
      }

      const fullPath = join(migrationsDir, migration);
      logger.log(`Aplicando ${migration}`);
      try {
        await client.query(readFileSync(fullPath, "utf8"));
      } catch (error) {
        throw new Error(`Falha ao aplicar ${migration}: ${error.message}`);
      }
      await recordAppliedMigration(client, migrationVersion);
      appliedMigrations.add(migrationVersion);
      result.applied.push(migrationVersion);
    }

    logger.log("Migracoes aplicadas com sucesso.");
    return result;
  } finally {
    await client.end();
  }
}

async function loadAppliedMigrations(client) {
  try {
    const result = await client.query("SELECT version FROM app_schema_migrations");
    return new Set(result.rows.map((row) => row.version));
  } catch (error) {
    if (error.code === "42P01") return new Set();
    throw error;
  }
}

async function recordAppliedMigration(client, version) {
  await client.query(
    "INSERT INTO app_schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING",
    [version]
  );
}

function defaultCreateClient() {
  return new pg.Client(createPoolConfig());
}

function loadLocalEnv() {
  const envFile = process.env.NODE_ENV === "production" ? ".env.production" : ".env";
  const envPath = join(ROOT, envFile);
  if (!existsSync(envPath)) return;
  const content = readFileSync(envPath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [key, ...valueParts] = trimmed.split("=");
    if (!key || process.env[key]) continue;
    process.env[key] = valueParts.join("=").trim();
  }
}

function isMainModule() {
  return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
}

if (isMainModule()) {
  loadLocalEnv();
  try {
    await runMigrations();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
