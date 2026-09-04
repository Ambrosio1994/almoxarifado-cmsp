import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closePool, query } from "../../src/db/postgres.js";
import {
  EXPECTED_SCHEMA_MIGRATION,
  REQUIRED_DATABASE_TABLES,
  detectStoreBackend,
  readProcessesPage,
  readStore,
  writeStore
} from "../../src/storage.js";
import { createAuditEntry } from "../../src/domain/processos.js";
import { createSession, resolveSessionUser } from "../../src/repositories/sessions.js";
import { runMigrations } from "../../scripts/db-migrate.js";

const integration = process.env.RUN_DB_INTEGRATION === "true" ? describe : describe.skip;

integration("integracao PostgreSQL", () => {
  after(() => closePool());

  it("reconhece todas as migracoes exigidas pela aplicacao", async () => {
    assert.equal(await detectStoreBackend(), "postgres");
    const result = await query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY($1::text[])", [REQUIRED_DATABASE_TABLES]);
    assert.deepEqual(result.rows.map((row) => row.tablename).sort(), REQUIRED_DATABASE_TABLES.slice().sort());
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
    const migration = await query("SELECT version FROM public.app_schema_migrations WHERE version = $1", [EXPECTED_SCHEMA_MIGRATION]);
    assert.equal(migration.rowCount, 1);
  });

  it("pagina processos no PostgreSQL com filtros equivalentes ao armazenamento local", async () => {
    const store = await readStore();
    const marker = `PAGINACAO-DB-${crypto.randomUUID()}`;
    const processIds = ["material", "pago", "inativo"].map((suffix) => `${marker}-${suffix}`);
    store.processos.push(
      {
        id: processIds[0],
        numeroProcesso: `${marker}-MATERIAL`,
        numeroEmpenho: `${marker}-NE-1`,
        fornecedor: "Fornecedor Café",
        status: "Enviado para SALC",
        materiais: [{ descricao: "Café em grãos", quantidade: 1, valorUnitario: 1 }],
        inativo: false
      },
      {
        id: processIds[1],
        numeroProcesso: `${marker}-PAGO`,
        numeroEmpenho: `${marker}-NE-2`,
        fornecedor: "Outro fornecedor",
        status: "Pago",
        materiais: [{ descricao: "Material comum", quantidade: 1, valorUnitario: 1 }],
        inativo: false
      },
      {
        id: processIds[2],
        numeroProcesso: `${marker}-INATIVO`,
        numeroEmpenho: `${marker}-NE-3`,
        fornecedor: "Fornecedor inativo",
        status: "Pago",
        materiais: [],
        inativo: true
      }
    );
    await writeStore(store);

    const firstPage = await readProcessesPage({
      page: 1,
      limit: 1,
      filters: { q: marker },
      quickFilters: []
    });
    assert.equal(firstPage.total, 2);
    assert.equal(firstPage.data.length, 1);
    assert.equal(firstPage.page, 1);
    assert.equal(firstPage.limit, 1);
    assert.equal(firstPage.totalPages, 2);

    const paid = await readProcessesPage({
      page: 8,
      limit: 25,
      filters: { q: marker },
      quickFilters: ["Pago"]
    });
    assert.equal(paid.total, 1);
    assert.equal(paid.page, 1);
    assert.deepEqual(paid.data.map((processo) => processo.id), [processIds[1]]);

    const accentInsensitive = await readProcessesPage({
      page: 1,
      limit: 25,
      filters: { q: "cafe" },
      quickFilters: []
    });
    assert.ok(accentInsensitive.data.some((processo) => processo.id === processIds[0]));
  });

  it("mantém o filtro SQL de prazo equivalente ao fallback enriquecido", async () => {
    const store = await readStore();
    const marker = `PRAZO-PAGINACAO-DB-${crypto.randomUUID()}`;
    const processIds = ["atrasado", "trinta", "entregue", "anulado"].map((suffix) => `${marker}-${suffix}`);
    store.processos.push(
      { id: processIds[0], numeroProcesso: processIds[0], numeroEmpenho: `${marker}-NE-1`, status: "Aguardando entrega", dataEnvioFornecedor: brazilianDateDaysAgo(31), materiais: [] },
      { id: processIds[1], numeroProcesso: processIds[1], numeroEmpenho: `${marker}-NE-2`, status: "Aguardando entrega", dataEnvioFornecedor: brazilianDateDaysAgo(30), materiais: [] },
      { id: processIds[2], numeroProcesso: processIds[2], numeroEmpenho: `${marker}-NE-3`, status: "Entregue", dataEnvioFornecedor: brazilianDateDaysAgo(31), materiais: [] },
      { id: processIds[3], numeroProcesso: processIds[3], numeroEmpenho: `${marker}-NE-4`, status: "Anulado", dataEnvioFornecedor: brazilianDateDaysAgo(31), materiais: [] }
    );
    await writeStore(store);

    for (const quickFilter of ["Em atraso", "Mais de 30 dias"]) {
      const page = await readProcessesPage({
        page: 1,
        limit: 25,
        filters: { q: marker },
        quickFilters: [quickFilter]
      });
      assert.equal(page.total, 1);
      assert.deepEqual(page.data.map((processo) => processo.id), [processIds[0]]);
    }
  });

  it("serializa runners concorrentes: uma migracao e aplicada uma unica vez", async () => {
    const migration = createTemporaryMigration("concurrent", "SELECT pg_sleep(0.15);");
    try {
      const [first, second] = await Promise.all([
        runMigrations({ databaseUrl: process.env.TEST_DATABASE_URL, databaseUrlSource: "TEST_DATABASE_URL", migrationsDir: migration.directory, logger: silentLogger }),
        runMigrations({ databaseUrl: process.env.TEST_DATABASE_URL, databaseUrlSource: "TEST_DATABASE_URL", migrationsDir: migration.directory, logger: silentLogger })
      ]);
      assert.equal(first.applied.length + second.applied.length, 1);
      assert.equal(first.skipped.length + second.skipped.length, 1);
      assert.equal((await query("SELECT count(*)::integer AS count FROM public.app_schema_migrations WHERE version = $1", [migration.version])).rows[0].count, 1);
      assert.equal((await query("SELECT to_regclass($1) AS relation", [`public.${migration.table}`])).rows[0].relation, migration.table);
    } finally {
      rmSync(migration.directory, { recursive: true, force: true });
    }
  });

  it("fixa migrations e historico no public apesar de search_path alternativo", async () => {
    const migration = createTemporaryMigration("search_path", "");
    const alternateSchema = `migration_alternate_${migration.suffix}`;
    await query(`CREATE SCHEMA ${alternateSchema}`);
    const target = new URL(process.env.TEST_DATABASE_URL);
    target.searchParams.set("options", `-c search_path=${alternateSchema}`);

    try {
      const first = await runMigrations({ databaseUrl: target.toString(), databaseUrlSource: "TEST_DATABASE_URL", migrationsDir: migration.directory, logger: silentLogger });
      const second = await runMigrations({ databaseUrl: target.toString(), databaseUrlSource: "TEST_DATABASE_URL", migrationsDir: migration.directory, logger: silentLogger });
      assert.deepEqual(first.applied, [migration.version]);
      assert.deepEqual(second.skipped, [migration.version]);
      assert.equal((await query("SELECT to_regclass($1) AS relation", [`public.${migration.table}`])).rows[0].relation, migration.table);
      assert.equal((await query("SELECT to_regclass($1) AS relation", [`${alternateSchema}.${migration.table}`])).rows[0].relation, null);
      assert.equal((await query("SELECT count(*)::integer AS count FROM public.app_schema_migrations WHERE version = $1", [migration.version])).rows[0].count, 1);
    } finally {
      rmSync(migration.directory, { recursive: true, force: true });
    }
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

const silentLogger = { log() {} };

function brazilianDateDaysAgo(days) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  const date = new Date(`${values.year}-${values.month}-${values.day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function createTemporaryMigration(label, prefixSql) {
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const version = `999_${label}_${suffix}`;
  const table = `migration_${label}_${suffix}`;
  const directory = mkdtempSync(join(tmpdir(), "almoxarifado-db-migration-"));
  writeFileSync(join(directory, `${version}.sql`), `${prefixSql}\nCREATE TABLE ${table} (id text PRIMARY KEY);`);
  return { directory, suffix, table, version };
}
