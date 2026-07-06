import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STORE_PATH = new URL("../data/store.json", `file://${__dirname}/`);
const STORE_FILE = fileURLToPath(STORE_PATH);
let writeQueue = Promise.resolve();

export async function readStore() {
  try {
    const raw = await readFile(STORE_PATH, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return emptyStore();
  }
}

export async function writeStore(store) {
  writeQueue = writeQueue.then(() => atomicWriteStore(store), () => atomicWriteStore(store));
  return writeQueue;
}

async function atomicWriteStore(store) {
  const dir = dirname(STORE_FILE);
  const tempPath = join(dir, `.store.${process.pid}.${Date.now()}.tmp`);
  await mkdir(dir, { recursive: true });
  await writeFile(tempPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  await rename(tempPath, STORE_FILE);
}

function emptyStore() {
  return {
    processos: [],
    fornecedores: [],
    auditoria: [],
    observacoes: [],
    emailHistorico: [],
    usuarios: [],
    configuracoes: {}
  };
}
