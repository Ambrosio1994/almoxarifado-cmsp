import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STORE_PATH = new URL("../data/store.json", `file://${__dirname}/`);

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
  await mkdir(dirname(fileURLToPath(STORE_PATH)), { recursive: true });
  await writeFile(STORE_PATH, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

function emptyStore() {
  return {
    processos: [],
    fornecedores: [],
    auditoria: [],
    observacoes: [],
    usuarios: [],
    configuracoes: {}
  };
}
