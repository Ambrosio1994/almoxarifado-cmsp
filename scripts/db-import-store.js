import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { closePool, databaseConfigured } from "../src/db/postgres.js";
import { writeStore } from "../src/storage.js";

const storePath = fileURLToPath(new URL("../data/store.json", import.meta.url));

if (!databaseConfigured()) {
  console.error("DATABASE_URL nao configurada.");
  process.exit(1);
}

try {
  console.log(formatDatabaseTarget(process.env.DATABASE_URL));
  const raw = await readFile(storePath, "utf8");
  const store = JSON.parse(raw);
  await importStore(store);
  console.log("data/store.json importado para o PostgreSQL com sucesso.");
} catch (error) {
  console.error(`Falha ao importar store.json: ${error.message}`);
  process.exitCode = 1;
} finally {
  await closePool().catch(() => null);
}

async function importStore(store) {
  await writeStore(store);
}

function formatDatabaseTarget(databaseUrl) {
  try {
    const url = new URL(databaseUrl);
    const database = url.pathname.replace(/^\//, "") || "<sem database>";
    const sslmode = url.searchParams.get("sslmode") || "<nao informado>";
    return [
      "Banco alvo do import:",
      `NODE_ENV=${process.env.NODE_ENV || "<nao definido>"}`,
      "source=DATABASE_URL",
      `user=${decodeURIComponent(url.username || "<sem usuario>")}`,
      `host=${url.host}`,
      `database=${database}`,
      `sslmode=${sslmode}`
    ].join(" ");
  } catch {
    return [
      "Banco alvo do import:",
      `NODE_ENV=${process.env.NODE_ENV || "<nao definido>"}`,
      "source=DATABASE_URL",
      "host=<url invalida>"
    ].join(" ");
  }
}
