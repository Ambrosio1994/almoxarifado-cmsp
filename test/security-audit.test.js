import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { recordSecurityEvent, listSecurityEvents } from "../src/repositories/security-audit.js";
import { prepareSecurityEvents, readStore, writeStore } from "../src/storage.js";

describe("auditoria de seguranca", { concurrency: false }, () => {
  it("usa o client explicito e propaga falhas para a transacao chamadora", async () => {
    const calls = [];
    const client = {
      async query(sql, params) {
        calls.push({ sql, params });
        return { rowCount: 1, rows: [] };
      }
    };
    const eventType = `transactional_test_${crypto.randomUUID()}`;
    const entry = await recordSecurityEvent(eventType, {
      actorUserId: "actor-1",
      actorEmail: "Actor@Example.TEST",
      targetUserId: "target-1",
      metadata: { correlationId: "correlation-1", nested: { ok: true } }
    }, { client });

    assert.equal(calls.length, 1);
    assert.match(calls[0].sql, /INSERT INTO app_security_audit/i);
    assert.equal(calls[0].params[0], entry.id);
    assert.equal(calls[0].params[1], eventType);
    assert.equal(calls[0].params[2], "actor-1");
    assert.equal(calls[0].params[3], "actor@example.test");
    assert.equal(calls[0].params[4], "target-1");
    assert.deepEqual(JSON.parse(calls[0].params[5]), {
      correlationId: "correlation-1",
      nested: { ok: true }
    });
    assert.equal(new Date(calls[0].params[6]).toISOString(), calls[0].params[6]);
    assert.equal((await listSecurityEvents(1000)).some((event) => event.eventType === eventType), false);

    const failure = new Error("falha de auditoria transacional");
    await assert.rejects(
      recordSecurityEvent("transactional_failure", {}, {
        client: { query: async () => { throw failure; } }
      }),
      (error) => error === failure
    );
  });

  it("registra e lista eventos no fallback em memoria", async () => {
    const eventType = `memory_test_${crypto.randomUUID()}`;
    const entry = await recordSecurityEvent(eventType, {
      actorEmail: "MEMORY@EXAMPLE.TEST",
      metadata: { source: "fallback" }
    });
    entry.actorEmail = "changed@example.test";
    entry.metadata.source = "changed-through-record-result";
    const events = await listSecurityEvents(1000);
    const persisted = events.find((event) => event.id === entry.id);

    assert.ok(persisted);
    assert.equal(persisted.eventType, eventType);
    assert.equal(persisted.actorEmail, "memory@example.test");
    assert.deepEqual(persisted.metadata, { source: "fallback" });

    persisted.actorEmail = "changed-again@example.test";
    persisted.metadata.source = "changed-through-list-result";
    const listedAgain = (await listSecurityEvents(1000)).find((event) => event.id === entry.id);
    assert.equal(listedAgain.actorEmail, "memory@example.test");
    assert.deepEqual(listedAgain.metadata, { source: "fallback" });
    assert.equal((await listSecurityEvents(1)).length, 1);
  });

  it("persiste o store e publica seus eventos no fallback JSON", async () => {
    const store = await readStore();
    const supplierId = crypto.randomUUID();
    const eventType = `json_store_test_${crypto.randomUUID()}`;
    const metadata = { supplierId, correlationId: "before-queue" };
    store.fornecedores.push({
      id: supplierId,
      razaoSocial: "Fornecedor auditado",
      criadoEm: new Date().toISOString()
    });

    const pendingWrite = writeStore(store, {
      securityEvents: [{
        eventType,
        actorEmail: " ADMIN@EXAMPLE.TEST ",
        targetUserId: " target-user ",
        metadata
      }]
    });
    metadata.correlationId = "changed-after-enqueue";
    await pendingWrite;

    const persistedStore = await readStore();
    assert.ok(persistedStore.fornecedores.some((supplier) => supplier.id === supplierId));

    const event = (await listSecurityEvents(1000)).find((item) => item.eventType === eventType);
    assert.ok(event);
    assert.equal(event.actorEmail, "admin@example.test");
    assert.equal(event.targetUserId, "target-user");
    assert.deepEqual(event.metadata, { supplierId, correlationId: "before-queue" });
  });

  it("normaliza, limita e copia defensivamente os eventos antes da gravacao", () => {
    const metadata = { nested: { value: 1 } };
    const longType = ` ${"x".repeat(120)} `;
    const [event] = prepareSecurityEvents({
      securityEvents: [{
        eventType: longType,
        actorUserId: " actor ",
        actorEmail: " USER@EXAMPLE.TEST ",
        targetUserId: " target ",
        metadata
      }]
    });

    metadata.nested.value = 2;
    assert.equal(event.eventType.length, 100);
    assert.equal(event.actorUserId, "actor");
    assert.equal(event.actorEmail, "user@example.test");
    assert.equal(event.targetUserId, "target");
    assert.deepEqual(event.metadata, { nested: { value: 1 } });
    assert.notEqual(event.metadata, metadata);

    assert.deepEqual(prepareSecurityEvents(), []);
    assert.throws(() => prepareSecurityEvents({ securityEvents: "invalid" }), /deve ser uma lista/);
    assert.throws(() => prepareSecurityEvents({ securityEvents: [null] }), /Evento de seguranca invalido/);
    assert.throws(() => prepareSecurityEvents({ securityEvents: [{ eventType: "   " }] }), /eventType e obrigatorio/);
    assert.throws(
      () => prepareSecurityEvents({
        securityEvents: Array.from({ length: 51 }, (_, index) => ({ eventType: `event_${index}` }))
      }),
      /no maximo 50 eventos/
    );

    const circular = {};
    circular.self = circular;
    assert.throws(
      () => prepareSecurityEvents({ securityEvents: [{ eventType: "circular", metadata: circular }] }),
      /circular/i
    );
  });

  it("rejeita eventos invalidos antes de substituir o arquivo JSON", async () => {
    const before = await readStore();
    const supplierId = crypto.randomUUID();
    const attempted = {
      ...before,
      fornecedores: [
        ...before.fornecedores,
        { id: supplierId, razaoSocial: "Nao deve persistir" }
      ]
    };

    await assert.rejects(
      writeStore(attempted, { securityEvents: "invalid" }),
      /securityEvents deve ser uma lista/
    );
    const after = await readStore();
    assert.equal(after.fornecedores.some((supplier) => supplier.id === supplierId), false);
  });
});
