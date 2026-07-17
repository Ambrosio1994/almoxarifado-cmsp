import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { databaseConfigured, isTestRuntime } from "../src/db/postgres.js";
import {
  prepareStoreForPersistence,
  readStore,
  resolveStoreFilePath,
  writeStore
} from "../src/storage.js";

const testStorePath = resolveStoreFilePath();

after(async () => {
  await rm(dirname(testStorePath), { recursive: true, force: true });
});

describe("seguranca do armazenamento em testes", () => {
  it("usa arquivo temporario mesmo em node --test direto", () => {
    assert.equal(isTestRuntime(), true);
    assert.equal(databaseConfigured(), Boolean(process.env.TEST_DATABASE_URL));
    assert.doesNotMatch(testStorePath, /\/data\/store\.json$/);
  });

  it("persiste com permissoes restritas e atribui IDs ausentes uma unica vez", async () => {
    const store = {
      processos: [{ numeroProcesso: "TESTE-1" }],
      fornecedores: [],
      auditoria: [],
      observacoes: [],
      emailHistorico: [],
      usuarios: [],
      configuracoes: {}
    };
    await writeStore(store);

    assert.match(store.processos[0].id, /^[0-9a-f-]{36}$/i);
    assert.equal((await stat(testStorePath)).mode & 0o777, 0o600);
    assert.equal((await stat(dirname(testStorePath))).mode & 0o777, 0o700);
    assert.equal(JSON.parse(await readFile(testStorePath, "utf8")).processos[0].id, store.processos[0].id);
    assert.equal((await readStore()).processos[0].id, store.processos[0].id);
  });

  it("rejeita IDs duplicados antes de gravar", () => {
    assert.throws(() => prepareStoreForPersistence({
      processos: [{ id: "duplicado" }, { id: "duplicado" }]
    }), /ID duplicado/);
  });
});
