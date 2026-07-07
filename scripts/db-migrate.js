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
    env: process.env
  });

  if (result.error) {
    console.error(`Falha ao executar psql: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status || 1);
}

console.log("Migracoes aplicadas com sucesso.");

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
