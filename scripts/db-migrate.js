import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const MIGRATIONS_DIR = join(ROOT, "db", "migrations");

loadLocalEnv();

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL nao configurada.");
  process.exit(1);
}
if (process.env.NODE_ENV === "production" && process.env.DB_SSL !== "true") {
  console.error("DB_SSL=true e obrigatorio em producao.");
  process.exit(1);
}
if (process.env.DB_SSL === "true" && !process.env.DB_CA_CERT_PATH) {
  console.error("DB_CA_CERT_PATH e obrigatorio quando DB_SSL=true.");
  process.exit(1);
}

const migrations = readdirSync(MIGRATIONS_DIR)
  .filter((fileName) => /^\d+_.+\.sql$/.test(fileName))
  .sort();

if (!migrations.length) {
  console.log("Nenhuma migracao encontrada.");
  process.exit(0);
}

for (const migration of migrations) {
  const fullPath = join(MIGRATIONS_DIR, migration);
  console.log(`Aplicando ${migration}`);
  const result = spawnSync("psql", [
    databaseUrl,
    "-v",
    "ON_ERROR_STOP=1",
    "-f",
    fullPath
  ], {
    cwd: ROOT,
    stdio: "inherit",
    env: buildPsqlEnv()
  });

  if (result.error) {
    console.error(`Falha ao executar psql: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status || 1);
}

console.log("Migracoes aplicadas com sucesso.");

function buildPsqlEnv() {
  if (process.env.DB_SSL !== "true") return process.env;
  return {
    ...process.env,
    PGSSLMODE: "verify-full",
    PGSSLROOTCERT: process.env.DB_CA_CERT_PATH
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
