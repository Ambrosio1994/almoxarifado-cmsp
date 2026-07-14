import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { closePool, query } from "../../src/db/postgres.js";
import { detectStoreBackend, readStore, writeStore } from "../../src/storage.js";
import { createAuditEntry } from "../../src/domain/processos.js";

const integration = process.env.RUN_DB_INTEGRATION === "true" ? describe : describe.skip;

integration("integracao PostgreSQL", () => {
  after(() => closePool());

  it("reconhece todas as migracoes exigidas pela aplicacao", async () => {
    assert.equal(await detectStoreBackend(), "postgres");
    const required = [
      "app_processes", "app_process_audit", "app_state_revision",
      "app_email_dispatch_claims", "auth_rate_limits", "app_security_audit"
    ];
    const result = await query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY($1::text[])", [required]);
    assert.deepEqual(result.rows.map((row) => row.tablename).sort(), required.sort());
  });

  it("rejeita uma gravacao baseada em snapshot obsoleto", async () => {
    const first = await readStore();
    const stale = await readStore();
    first.fornecedores.push({ id: crypto.randomUUID(), razaoSocial: "Fornecedor concorrente A", criadoEm: new Date().toISOString() });
    await writeStore(first);
    stale.fornecedores.push({ id: crypto.randomUUID(), razaoSocial: "Fornecedor concorrente B", criadoEm: new Date().toISOString() });
    await assert.rejects(() => writeStore(stale), (error) => error.statusCode === 409);
  });

  it("impede update e delete de auditoria no banco", async () => {
    const store = await readStore();
    const processId = crypto.randomUUID();
    const audit = createAuditEntry({ processoId: processId, usuario: "Integracao", acao: "Teste", detalhes: "Append-only" });
    store.processos.push({ id: processId, status: "Enviado para SALC", materiais: [], criadoEm: new Date().toISOString(), atualizadoEm: new Date().toISOString() });
    store.auditoria.push(audit);
    await writeStore(store);
    await assert.rejects(() => query("UPDATE app_process_audit SET data = '{}'::jsonb WHERE id = $1", [audit.id]), /append-only/);
    await assert.rejects(() => query("DELETE FROM app_process_audit WHERE id = $1", [audit.id]), /append-only/);
  });
});
