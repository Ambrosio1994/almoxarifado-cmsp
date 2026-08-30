import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createPoolConfig } from "../src/db/postgres.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const MIGRATIONS_DIR = join(ROOT, "db", "migrations");

export async function runMigrations(options = {}) {
  const resolvedDatabaseUrl = options.databaseUrl
    ? { databaseUrl: options.databaseUrl, source: "options.databaseUrl" }
    : resolveMigrationDatabaseUrl();
  const {
    databaseUrl = resolvedDatabaseUrl.databaseUrl,
    databaseUrlSource = resolvedDatabaseUrl.source,
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

  logger.log(formatDatabaseTarget(databaseUrl, databaseUrlSource));
  const client = createClient(databaseUrl);
  await client.connect();
  let migrationLockHeld = false;
  try {
    await client.query("SET search_path TO public");
    await client.query("SELECT pg_advisory_lock(hashtext('almoxarifado_schema_migrations'))");
    migrationLockHeld = true;
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
      await client.query("BEGIN");
      try {
        const migrationSql = withoutOuterTransaction(readFileSync(fullPath, "utf8"), migration);
        await client.query(migrationSql);
        await recordAppliedMigration(client, migrationVersion);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => null);
        throw new Error(`Falha ao aplicar ${migration}: ${error.message}`);
      }
      appliedMigrations.add(migrationVersion);
      result.applied.push(migrationVersion);
    }

    logger.log("Migracoes aplicadas com sucesso.");
    return result;
  } finally {
    if (migrationLockHeld) {
      await client.query("SELECT pg_advisory_unlock(hashtext('almoxarifado_schema_migrations'))").catch(() => null);
    }
    await client.end();
  }
}

function withoutOuterTransaction(sql, migrationName) {
  const lines = String(sql).split(/\r?\n/);
  const meaningful = lines
    .map((line, index) => ({ line: line.trim(), index }))
    .filter(({ line }) => line && !line.startsWith("--"));
  const first = meaningful[0];
  const last = meaningful.at(-1);
  const startsTransaction = /^BEGIN(?:\s+TRANSACTION)?;$/i.test(first?.line || "");
  const endsTransaction = /^COMMIT;$/i.test(last?.line || "");

  if (startsTransaction !== endsTransaction) {
    throw new Error(`${migrationName} possui controle de transacao incompleto.`);
  }
  if (startsTransaction) {
    lines[first.index] = "";
    lines[last.index] = "";
  }
  return lines.join("\n");
}

async function loadAppliedMigrations(client) {
  try {
    const result = await client.query("SELECT version FROM public.app_schema_migrations");
    return new Set(result.rows.map((row) => row.version));
  } catch (error) {
    if (error.code === "42P01") return new Set();
    throw error;
  }
}

async function recordAppliedMigration(client, version) {
  await client.query(
    "INSERT INTO public.app_schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING",
    [version]
  );
}

function defaultCreateClient(databaseUrl) {
  return new pg.Client(createPoolConfig(databaseUrl));
}

export function resolveMigrationDatabaseUrl(environment = process.env) {
  if (environment.DATABASE_URL_MIGRATION) {
    return {
      databaseUrl: environment.DATABASE_URL_MIGRATION,
      source: "DATABASE_URL_MIGRATION"
    };
  }

  if (isNeonPooledUrl(environment.DATABASE_URL)) {
    throw new Error("DATABASE_URL usa endpoint Neon pooled; DATABASE_URL_MIGRATION com a URL direta da mesma branch e database e obrigatoria para migrations, pois o advisory lock exige uma sessao dedicada.");
  }

  return {
    databaseUrl: environment.DATABASE_URL,
    source: "DATABASE_URL"
  };
}

function isNeonPooledUrl(databaseUrl) {
  try {
    const hostname = new URL(databaseUrl).hostname.toLowerCase();
    return hostname.endsWith(".neon.tech")
      && (hostname.includes("-pooler.") || hostname.includes(".pooler."));
  } catch {
    return false;
  }
}

function formatDatabaseTarget(databaseUrl, source) {
  try {
    const url = new URL(databaseUrl);
    const database = url.pathname.replace(/^\//, "") || "<sem database>";
    const sslmode = url.searchParams.get("sslmode") || "<nao informado>";
    return [
      `Banco alvo da migracao: source=${source}`,
      `NODE_ENV=${process.env.NODE_ENV || "<nao definido>"}`,
      `host=${url.host}`,
      `database=${database}`,
      `sslmode=${sslmode}`
    ].join(" ");
  } catch {
    return [
      `Banco alvo da migracao: source=${source}`,
      `NODE_ENV=${process.env.NODE_ENV || "<nao definido>"}`,
      "host=<url invalida>"
    ].join(" ");
  }
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
