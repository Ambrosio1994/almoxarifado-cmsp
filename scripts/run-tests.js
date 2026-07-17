import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const databaseMode = process.argv.includes("--db");
const forwardedArgs = process.argv.slice(2).filter((argument) => argument !== "--db");
const testRoot = mkdtempSync(join(tmpdir(), "almoxarifado-cmsp-tests-"));
const testDatabaseUrl = databaseMode ? process.env.TEST_DATABASE_URL : "";

if (databaseMode) validateTestDatabaseUrl(testDatabaseUrl);

try {
  const result = spawnSync(process.execPath, ["--test", ...forwardedArgs], {
    stdio: "inherit",
    env: {
      ...process.env,
      NODE_ENV: "test",
      RUN_DB_INTEGRATION: databaseMode ? "true" : "false",
      TEST_DATABASE_URL: testDatabaseUrl,
      TEST_STORAGE_ROOT: testRoot,
      UPLOAD_STORAGE_ROOT: join(testRoot, "uploads"),
      // Runtime database access in tests is exclusively resolved through
      // TEST_DATABASE_URL. Empty these as an additional guard for subprocesses.
      DATABASE_URL: "",
      DATABASE_URL_MIGRATION: ""
    }
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(testRoot, { recursive: true, force: true });
}

function validateTestDatabaseUrl(value) {
  if (!value) throw new Error("TEST_DATABASE_URL e obrigatoria para testes de integracao.");
  const url = new URL(value);
  const database = decodeURIComponent(url.pathname.slice(1));
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || !database) {
    throw new Error("TEST_DATABASE_URL deve ser uma URL PostgreSQL valida.");
  }
  if (!/(?:^|[_-])test(?:$|[_-])|test/i.test(database)) {
    throw new Error("TEST_DATABASE_URL deve apontar para um database identificado como teste.");
  }
}
