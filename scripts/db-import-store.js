import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { closePool, databaseConfigured } from "../src/db/postgres.js";
import { prepareStoreForPersistence, readStore, writeStore } from "../src/storage.js";

const defaultStorePath = fileURLToPath(new URL("../data/store.json", import.meta.url));
const apply = process.argv.includes("--apply");
const merge = process.argv.includes("--merge");
const confirmBackup = process.argv.includes("--confirm-backup");
const sourcePath = resolve(optionValue("--source") || defaultStorePath);
const normalizedOutput = optionValue("--output-normalized");

try {
  const raw = await readFile(sourcePath, "utf8");
  const parsed = JSON.parse(raw);
  const providedCollections = providedStoreKeys(parsed);
  const missingIds = countMissingIds(parsed);
  const store = prepareStoreForPersistence(parsed, { allowExternalProcessReferences: true });
  console.log(JSON.stringify({
    mode: apply ? "apply" : "dry-run",
    source: sourcePath,
    operation: "merge-by-id",
    providedCollections,
    missingIdsAssigned: missingIds,
    counts: storeCounts(store)
  }));

  if (normalizedOutput) {
    const output = resolve(normalizedOutput);
    await writeFile(output, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    console.log(`Copia normalizada com IDs persistentes criada em ${output}.`);
  }

  if (!apply) {
    console.log("Dry-run concluido. Use --apply e as confirmacoes exibidas na documentacao para importar.");
  } else {
    if (missingIds > 0) {
      throw new Error("Aplique somente uma fonte com IDs persistentes; gere-a antes com --output-normalized=ARQUIVO.");
    }
    await importStore(store, providedCollections);
  }
} catch (error) {
  console.error(`Falha ao importar store.json: ${error.message}`);
  process.exitCode = 1;
} finally {
  await closePool().catch(() => null);
}

async function importStore(store, providedCollections) {
  if (!databaseConfigured()) throw new Error("DATABASE_URL nao configurada.");
  if (!merge) throw new Error("A importacao segura exige --merge; substituicao integral nao e suportada.");

  const target = databaseTarget(process.env.DATABASE_URL);
  console.log(formatDatabaseTarget(process.env.DATABASE_URL));
  if (optionValue("--confirm-database") !== target.database) {
    throw new Error(`Confirme o database alvo com --confirm-database=${target.database}.`);
  }
  if (process.env.NODE_ENV === "production" && !confirmBackup) {
    throw new Error("Em producao, confirme um backup verificado com --confirm-backup.");
  }

  const current = await readStore();
  const merged = mergeStores(current, store, providedCollections);
  await writeStore(merged);
  console.log("store.json importado para o PostgreSQL com sucesso.");
}

function mergeStores(current, incoming, providedCollections) {
  const result = { ...current };
  for (const key of ["processos", "fornecedores", "auditoria", "observacoes", "emailHistorico", "usuarios"]) {
    if (!providedCollections.includes(key)) continue;
    result[key] = mergeRecordsById(current[key] || [], incoming[key] || [], key === "auditoria");
  }
  if (providedCollections.includes("configuracoes")) {
    result.configuracoes = { ...(current.configuracoes || {}), ...(incoming.configuracoes || {}) };
  }
  return result;
}

function mergeRecordsById(current, incoming, immutable) {
  const records = new Map(current.map((record) => [record.id, record]));
  for (const record of incoming) {
    const existing = records.get(record.id);
    if (immutable && existing && JSON.stringify(existing) !== JSON.stringify(record)) {
      throw new Error(`Auditoria ${record.id} ja existe com conteudo diferente.`);
    }
    records.set(record.id, existing && immutable ? existing : record);
  }
  return [...records.values()];
}

function countMissingIds(store) {
  return ["processos", "fornecedores", "auditoria", "observacoes", "emailHistorico", "usuarios"]
    .reduce((total, key) => total + (Array.isArray(store?.[key])
      ? store[key].filter((record) => !String(record?.id || "").trim()).length
      : 0), 0);
}

function storeCounts(store) {
  return Object.fromEntries(
    ["processos", "fornecedores", "auditoria", "observacoes", "emailHistorico", "usuarios"]
      .map((key) => [key, store[key].length])
  );
}

function providedStoreKeys(store) {
  const keys = ["processos", "fornecedores", "auditoria", "observacoes", "emailHistorico", "usuarios", "configuracoes"];
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(store || {}, key)) continue;
    if (key === "configuracoes") {
      if (!store[key] || typeof store[key] !== "object" || Array.isArray(store[key])) {
        throw new TypeError("configuracoes deve ser um objeto.");
      }
    } else if (!Array.isArray(store[key])) {
      throw new TypeError(`${key} deve ser uma lista.`);
    }
  }
  return keys.filter((key) => Object.prototype.hasOwnProperty.call(store || {}, key));
}

function optionValue(name) {
  const prefix = `${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length) || "";
}

function databaseTarget(databaseUrl) {
  const url = new URL(databaseUrl);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || !database) {
    throw new Error("DATABASE_URL deve ser uma URL PostgreSQL valida.");
  }
  return { url, database };
}

function formatDatabaseTarget(databaseUrl) {
  try {
    const { url, database } = databaseTarget(databaseUrl);
    const sslmode = url.searchParams.get("sslmode") || "<nao informado>";
    return [
      "Banco alvo do import:",
      `NODE_ENV=${process.env.NODE_ENV || "<nao definido>"}`,
      "source=DATABASE_URL",
      `host=${url.host}`,
      `database=${database}`,
      `sslmode=${sslmode}`
    ].join(" ");
  } catch {
    return "Banco alvo do import: host=<url invalida>";
  }
}
