import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const MIGRATIONS_DIR = join(ROOT, "db", "migrations");

export function runMigrations(options = {}) {
  const {
    databaseUrl = process.env.DATABASE_URL,
    migrationsDir = MIGRATIONS_DIR,
    env = process.env,
    cwd = ROOT,
    executePsql = defaultExecutePsql,
    logger = console
  } = options;

  validateDatabaseEnv(databaseUrl, env);

  const migrations = readdirSync(migrationsDir)
    .filter((fileName) => /^\d+_.+\.sql$/.test(fileName))
    .sort();

  if (!migrations.length) {
    logger.log("Nenhuma migracao encontrada.");
    return { applied: [], skipped: [] };
  }

  const context = { databaseUrl, env, cwd, executePsql };
  const appliedMigrations = loadAppliedMigrations(context);
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
    const migrationResult = runPsql([
      databaseUrl,
      "-v",
      "ON_ERROR_STOP=1",
      "-f",
      fullPath
    ], "inherit", context);

    ensurePsqlSuccess(migrationResult, "Falha ao executar psql");
    recordAppliedMigration(migrationVersion, context);
    appliedMigrations.add(migrationVersion);
    result.applied.push(migrationVersion);
  }

  logger.log("Migracoes aplicadas com sucesso.");
  return result;
}

function validateDatabaseEnv(databaseUrl, env) {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL nao configurada.");
  }
  if (env.NODE_ENV === "production" && env.DB_SSL !== "true") {
    throw new Error("DB_SSL=true e obrigatorio em producao.");
  }
  if (env.DB_SSL === "true" && !env.DB_CA_CERT_PATH) {
    throw new Error("DB_CA_CERT_PATH e obrigatorio quando DB_SSL=true.");
  }
}

function loadAppliedMigrations(context) {
  const result = runPsql([
    context.databaseUrl,
    "-t",
    "-A",
    "-c",
    "SELECT version FROM app_schema_migrations"
  ], "pipe", context);

  if (result.error) {
    throw new Error(`Falha ao executar psql: ${result.error.message}`);
  }

  if (result.status === 0) {
    return new Set(result.stdout.split(/\r?\n/).filter(Boolean));
  }

  const errorOutput = `${result.stderr || ""}${result.stdout || ""}`;
  if (/app_schema_migrations.*does not exist|relation .*app_schema_migrations.* does not exist/i.test(errorOutput)) {
    return new Set();
  }

  throw new Error(errorOutput || "Falha ao consultar migracoes aplicadas.");
}

function recordAppliedMigration(version, context) {
  const sql = "INSERT INTO app_schema_migrations (version) VALUES (:'migration_version') ON CONFLICT (version) DO NOTHING";
  const result = runPsql([
    context.databaseUrl,
    "-v",
    "ON_ERROR_STOP=1",
    "-v",
    `migration_version=${version}`,
    "-c",
    sql
  ], "inherit", context);

  ensurePsqlSuccess(result, "Falha ao registrar migracao");
}

function ensurePsqlSuccess(result, message) {
  if (result.error) {
    throw new Error(`${message}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${message}: psql encerrou com status ${result.status || 1}`);
  }
}

function runPsql(args, stdio, context) {
  return context.executePsql(args, {
    cwd: context.cwd,
    stdio,
    encoding: stdio === "pipe" ? "utf8" : undefined,
    env: buildPsqlEnv(context.env)
  });
}

function defaultExecutePsql(args, options) {
  return spawnSync("psql", args, options);
}

function buildPsqlEnv(env) {
  if (env.DB_SSL !== "true") return env;
  return {
    ...env,
    PGSSLMODE: "verify-full",
    PGSSLROOTCERT: env.DB_CA_CERT_PATH
  };
}

function loadLocalEnv() {
  const envPath = join(ROOT, ".env");
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
    runMigrations();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
