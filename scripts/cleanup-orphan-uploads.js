import { readdir, rm, stat } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { closePool } from "../src/db/postgres.js";
import { detectStoreBackend, readStore } from "../src/storage.js";
import { UPLOAD_STORAGE_MARKER_NAME } from "../src/uploads/storage-identity.js";

const root = resolve(process.env.UPLOAD_STORAGE_ROOT || fileURLToPath(new URL("../uploads/", import.meta.url)));
const apply = process.argv.includes("--apply");
const expectedBackend = optionValue("--expect-backend") || (process.env.NODE_ENV === "production" ? "postgres" : "json");
const graceMs = positiveInteger(process.env.ORPHAN_UPLOAD_GRACE_MS || "86400000", "ORPHAN_UPLOAD_GRACE_MS");

if (!["postgres", "json"].includes(expectedBackend)) {
  throw new Error("--expect-backend deve ser postgres ou json.");
}
if (apply && !process.argv.includes("--confirm-delete-orphans")) {
  throw new Error("Use --confirm-delete-orphans para confirmar a exclusao.");
}
if (apply && process.env.NODE_ENV === "production" && !process.argv.includes("--confirm-backup")) {
  throw new Error("Em producao, confirme um backup verificado com --confirm-backup.");
}

try {
  const backend = await detectStoreBackend();
  if (backend !== expectedBackend) {
    throw new Error(`Backend ativo ${backend} difere do esperado ${expectedBackend}.`);
  }
  const store = await readStore();
  const referenced = referencedUploadPaths(store);
  const files = (await walk(root)).filter((file) => normalize(file.path) !== normalize(join(root, UPLOAD_STORAGE_MARKER_NAME)));
  const existing = new Set(files.map((file) => normalize(file.path)));
  const missingReferences = [...referenced].filter((file) => !existing.has(file));
  const now = Date.now();
  const unreferenced = files.filter((file) => !referenced.has(normalize(file.path)));
  const orphans = unreferenced.filter((file) => now - file.mtimeMs >= graceMs);
  const protectedByGrace = unreferenced.filter((file) => now - file.mtimeMs < graceMs);

  for (const file of orphans) {
    if (apply) await rm(file.path, { force: true });
    console.log(`${apply ? "removido" : "orphan"}: ${relative(root, file.path)}`);
  }
  for (const file of missingReferences) {
    console.log(`missing-reference: ${relative(root, file)}`);
  }
  console.log(JSON.stringify({
    root,
    backend,
    referenced: referenced.size,
    scanned: files.length,
    orphans: orphans.length,
    missingReferences: missingReferences.length,
    protectedByGrace: protectedByGrace.length,
    graceMs,
    applied: apply
  }));
} finally {
  await closePool();
}

function referencedUploadPaths(store) {
  const paths = new Set();
  const add = (value) => {
    const publicPath = String(typeof value === "string" ? value : value?.path || "");
    if (!publicPath.startsWith("/uploads/")) return;
    const file = resolve(root, publicPath.replace(/^\/uploads\/+/, ""));
    const relativePath = relative(root, file);
    if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) return;
    paths.add(normalize(file));
  };
  for (const process of store.processos || []) {
    for (const value of Object.values(process.documentos || {})) {
      if (Array.isArray(value)) value.forEach(add);
      else add(value);
    }
  }
  for (const template of Object.values(store.configuracoes?.emailTemplates || {})) {
    (template.anexos || []).forEach(add);
  }
  return paths;
}

async function walk(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const nested = await Promise.all(entries.map((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : stat(path).then((metadata) => [{ path, mtimeMs: metadata.mtimeMs }]);
  }));
  return nested.flat();
}

function optionValue(name) {
  const prefix = `${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length) || "";
}

function positiveInteger(value, name) {
  if (!/^\d+$/.test(value) || Number(value) <= 0 || !Number.isSafeInteger(Number(value))) {
    throw new Error(`${name} deve ser um inteiro positivo.`);
  }
  return Number(value);
}
