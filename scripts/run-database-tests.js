import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

loadEnvironmentFile();

const productionDatabaseUrl = process.env.DATABASE_URL || "";
const productionMigrationUrl = process.env.DATABASE_URL_MIGRATION || "";
process.env.NODE_ENV = "test";

const { assertSafeTestDatabaseUrl } = await import("../src/db/postgres.js");
const { runMigrations } = await import("./db-migrate.js");
const testDatabaseUrl = assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL);

await runMigrations({
  databaseUrl: testDatabaseUrl,
  databaseUrlSource: "TEST_DATABASE_URL"
});

const result = spawnSync(process.execPath, [resolve("scripts/run-tests.js"), "--db", "test/db/integration.test.js"], {
  stdio: "inherit",
  env: {
    ...process.env,
    DATABASE_URL: productionDatabaseUrl,
    DATABASE_URL_MIGRATION: productionMigrationUrl,
    TEST_DATABASE_URL: testDatabaseUrl
  }
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;

function loadEnvironmentFile() {
  const file = resolve(process.env.ENV_FILE || ".env");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [key, ...parts] = trimmed.split("=");
    if (!key || process.env[key]) continue;
    process.env[key] = parts.join("=").trim();
  }
}
