import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { closePool, query } from "../../src/db/postgres.js";
import { detectStoreBackend, readStore, writeStore } from "../../src/storage.js";
import { createAuditEntry } from "../../src/domain/processos.js";
import { createSession, resolveSessionUser } from "../../src/repositories/sessions.js";

const integration = process.env.RUN_DB_INTEGRATION === "true" ? describe : describe.skip;

integration("integracao PostgreSQL", () => {
  after(() => closePool());

  it("reconhece todas as migracoes exigidas pela aplicacao", async () => {
    assert.equal(await detectStoreBackend(), "postgres");
    const required = [
      "app_users", "user_sessions", "app_settings",
      "app_processes", "app_process_audit", "app_state_revision",
      "app_email_dispatch_claims", "auth_rate_limits", "app_security_audit"
    ];
    const result = await query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY($1::text[])", [required]);
    assert.deepEqual(result.rows.map((row) => row.tablename).sort(), required.sort());
    const authColumns = await query(`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = ANY($1::text[])
        AND column_name = 'auth_version'
      ORDER BY table_name
    `, [["app_users", "user_sessions"]]);
    assert.deepEqual(authColumns.rows, [
      { table_name: "app_users", column_name: "auth_version" },
      { table_name: "user_sessions", column_name: "auth_version" }
    ]);
    const migration = await query("SELECT version FROM app_schema_migrations WHERE version = '010_auth_session_version'");
    assert.equal(migration.rowCount, 1);
  });

  it("rejeita uma gravacao baseada em snapshot obsoleto", async () => {
    const first = await readStore();
    const stale = await readStore();
    const correlationId = crypto.randomUUID();
    first.fornecedores.push({ id: crypto.randomUUID(), razaoSocial: "Fornecedor concorrente A", criadoEm: new Date().toISOString() });
    await writeStore(first);
    stale.fornecedores.push({ id: crypto.randomUUID(), razaoSocial: "Fornecedor concorrente B", criadoEm: new Date().toISOString() });
    await assert.rejects(() => writeStore(stale, {
      securityEvents: [{
        eventType: "stale_write_must_not_be_audited",
        metadata: { correlationId }
      }]
    }), (error) => error.statusCode === 409);
    const events = await query("SELECT id FROM app_security_audit WHERE metadata ->> 'correlationId' = $1", [correlationId]);
    assert.equal(events.rowCount, 0);
  });

  it("confirma usuario e eventos de seguranca no mesmo commit", async () => {
    const store = await readStore();
    const userId = crypto.randomUUID();
    const correlationId = crypto.randomUUID();
    store.usuarios.push({
      id: userId,
      nome: "Usuario auditado",
      email: `${userId}@example.test`,
      senhaHash: "hash-de-integracao",
      authVersion: 1,
      ativo: true,
      role: "auditor",
      criadoEm: new Date().toISOString()
    });
    await writeStore(store, {
      securityEvents: [
        {
          eventType: "integration_user_created",
          actorEmail: "admin@example.test",
          targetUserId: userId,
          metadata: { correlationId, order: 1 }
        },
        {
          eventType: "integration_user_permissions_set",
          actorEmail: "admin@example.test",
          targetUserId: userId,
          metadata: { correlationId, order: 2 }
        }
      ]
    });

    const result = await query(`
      SELECT event_type, target_user_id, metadata
      FROM app_security_audit
      WHERE metadata ->> 'correlationId' = $1
      ORDER BY (metadata ->> 'order')::integer
    `, [correlationId]);
    assert.deepEqual(result.rows, [
      {
        event_type: "integration_user_created",
        target_user_id: userId,
        metadata: { correlationId, order: 1 }
      },
      {
        event_type: "integration_user_permissions_set",
        target_user_id: userId,
        metadata: { correlationId, order: 2 }
      }
    ]);
    assert.equal((await query("SELECT id FROM app_users WHERE id = $1", [userId])).rowCount, 1);
  });

  it("reverte estado, revisao e primeiro evento se outro evento falhar", async () => {
    const store = await readStore();
    const revisionBefore = store.__revision;
    const supplierId = crypto.randomUUID();
    const correlationId = crypto.randomUUID();
    store.fornecedores.push({
      id: supplierId,
      razaoSocial: "Fornecedor que deve sofrer rollback",
      criadoEm: new Date().toISOString()
    });

    await assert.rejects(() => writeStore(store, {
      securityEvents: [
        {
          eventType: "integration_event_before_failure",
          metadata: { correlationId, order: 1 }
        },
        {
          eventType: "integration_event_invalid_target",
          targetUserId: crypto.randomUUID(),
          metadata: { correlationId, order: 2 }
        }
      ]
    }), (error) => error.code === "23503");

    const persisted = await readStore();
    assert.equal(persisted.__revision, revisionBefore);
    assert.equal(persisted.fornecedores.some((supplier) => supplier.id === supplierId), false);
    assert.equal(store.__revision, revisionBefore);
    const events = await query("SELECT id FROM app_security_audit WHERE metadata ->> 'correlationId' = $1", [correlationId]);
    assert.equal(events.rowCount, 0);
  });

  it("resolve sessao por usuario direcionado e invalida pela versao persistida", async () => {
    const store = await readStore();
    const userId = crypto.randomUUID();
    store.usuarios.push({
      id: userId,
      nome: "Usuario de integracao",
      email: `${userId}@example.test`,
      senhaHash: "hash-nao-deve-ser-carregado-na-sessao",
      authVersion: 1,
      ativo: true,
      role: "auditor",
      criadoEm: new Date().toISOString()
    });
    await writeStore(store);

    const token = await createSession(userId, 30 * 60 * 1000, 1);
    const resolved = await resolveSessionUser(token, 30 * 60 * 1000);
    assert.equal(resolved?.id, userId);
    assert.equal(resolved?.senhaHash, "");

    const updatedStore = await readStore();
    updatedStore.usuarios.find((user) => user.id === userId).authVersion = 2;
    await writeStore(updatedStore);
    assert.equal(await resolveSessionUser(token, 30 * 60 * 1000), null);
  });

  it("persiste registros legados sem timestamps sem alterar a criacao depois", async () => {
    const store = await readStore();
    const supplierId = crypto.randomUUID();
    store.fornecedores.push({ id: supplierId, razaoSocial: "Fornecedor legado sem timestamp" });
    await writeStore(store);

    const inserted = await query("SELECT created_at FROM app_suppliers WHERE id = $1", [supplierId]);
    assert.ok(inserted.rows[0]?.created_at);

    const updatedStore = await readStore();
    const supplier = updatedStore.fornecedores.find((item) => item.id === supplierId);
    supplier.razaoSocial = "Fornecedor legado atualizado";
    await writeStore(updatedStore);

    const updated = await query("SELECT created_at FROM app_suppliers WHERE id = $1", [supplierId]);
    assert.equal(updated.rows[0].created_at.toISOString(), inserted.rows[0].created_at.toISOString());
  });

  it("impede update e delete de auditoria no banco", async () => {
    const store = await readStore();
    const processId = crypto.randomUUID();
    const correlationId = crypto.randomUUID();
    const audit = createAuditEntry({ processoId: processId, usuario: "Integracao", acao: "Teste", detalhes: "Append-only" });
    store.processos.push({ id: processId, status: "Enviado para SALC", materiais: [], criadoEm: new Date().toISOString(), atualizadoEm: new Date().toISOString() });
    store.auditoria.push(audit);
    await writeStore(store, {
      securityEvents: [{ eventType: "integration_immutable", metadata: { correlationId } }]
    });
    await assert.rejects(() => query("UPDATE app_process_audit SET data = '{}'::jsonb WHERE id = $1", [audit.id]), /append-only/);
    await assert.rejects(() => query("DELETE FROM app_process_audit WHERE id = $1", [audit.id]), /append-only/);
    const securityEvent = await query("SELECT id FROM app_security_audit WHERE metadata ->> 'correlationId' = $1", [correlationId]);
    assert.equal(securityEvent.rowCount, 1);
    await assert.rejects(() => query("UPDATE app_security_audit SET metadata = '{}'::jsonb WHERE id = $1", [securityEvent.rows[0].id]), /append-only/);
    await assert.rejects(() => query("DELETE FROM app_security_audit WHERE id = $1", [securityEvent.rows[0].id]), /append-only/);
    assert.equal((await query("SELECT id FROM app_security_audit WHERE id = $1", [securityEvent.rows[0].id])).rowCount, 1);
  });
});
