import { readdir, rm } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { closePool } from "../src/db/postgres.js";
import { readStore } from "../src/storage.js";

const root = resolve(process.env.UPLOAD_STORAGE_ROOT || fileURLToPath(new URL("../uploads/", import.meta.url)));
const apply = process.argv.includes("--apply");

try {
  const store = await readStore();
  const referenced = referencedUploadPaths(store);
  const files = await walk(root);
  const orphans = files.filter((file) => !referenced.has(normalize(file)));

  for (const file of orphans) {
    if (apply) await rm(file, { force: true });
    console.log(`${apply ? "removido" : "orphan"}: ${relative(root, file)}`);
  }
  console.log(JSON.stringify({ root, referenced: referenced.size, scanned: files.length, orphans: orphans.length, applied: apply }));
} finally {
  await closePool();
}

function referencedUploadPaths(store) {
  const paths = new Set();
  const add = (value) => {
    const publicPath = String(value?.path || "");
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
    return entry.isDirectory() ? walk(path) : [path];
  }));
  return nested.flat();
}
