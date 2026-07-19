import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseReplaceDocumentArgs } from "../scripts/replace-upload-document.js";
import { listFilesByAppProperty, uploadToDrive } from "../src/uploads/drive-storage.js";
import { commitDocumentReplacement, replaceUploadDocument } from "../src/uploads/replace-upload-document.js";

const PDF = Buffer.from("%PDF-1.4\nmock\n%%EOF\n");

describe("substituicao administrativa de uploads", () => {
  it("interpreta o CLI e exige confirmacao exclusiva antes de qualquer escrita", async () => {
    const parsed = parseReplaceDocumentArgs([
      "--process-id", "p1", "--document-key", "notaFiscal", "--file", "/tmp/nf.pdf", "--confirm"
    ]);
    assert.equal(parsed.confirm, true);
    assert.equal(parsed.documentKey, "notaFiscal");
    await assert.rejects(
      replaceUploadDocument({ ...baseOptions(), dryRun: false, confirm: false }, dependencies([])),
      /exatamente uma opcao/
    );
    await assert.rejects(
      replaceUploadDocument({ ...baseOptions(), dryRun: true, confirm: true }, dependencies([])),
      /exatamente uma opcao/
    );
  });

  it("envia e procura a chave idempotente usando um cliente Drive mockado", async () => {
    const requests = [];
    const client = { files: {
      create: async (request) => { requests.push(request); return { data: { id: "drive-id", size: PDF.length } }; },
      list: async (request) => { requests.push(request); return { data: { files: [{ id: "drive-id" }] } }; }
    } };
    await uploadToDrive(PDF, {
      client, folderId: "folder", name: "arquivo.pdf", mimeType: "application/pdf",
      appProperties: { almoxarifadoRepairKey: "repair-hash" }
    });
    const found = await listFilesByAppProperty("almoxarifadoRepairKey", "repair-hash", { client, folderId: "folder" });
    assert.equal(requests[0].requestBody.appProperties.almoxarifadoRepairKey, "repair-hash");
    assert.match(requests[1].q, /appProperties has.*repair-hash/);
    assert.deepEqual(found, [{ id: "drive-id" }]);
  });

  it("faz dry-run sem upload nem escrita no banco", async () => {
    const calls = [];
    const result = await replaceUploadDocument(baseOptions({ dryRun: true, confirm: false }), dependencies(calls));
    assert.equal(result.status, "dry_run");
    assert.equal(result.oldPath, "/uploads/antigo.pdf");
    assert.deepEqual(calls, ["load", "read", "folder", "list"]);
  });

  it("envia, confirma e grava a nova referencia com auditoria do caminho antigo", async () => {
    const calls = [];
    const deps = dependencies(calls);
    deps.commitReplacement = async (change) => {
      calls.push("commit");
      assert.equal(change.expectedDocument.path, "/uploads/antigo.pdf");
      assert.equal(change.newDocument.path, "/uploads/drive/drive-id/Nota%20original.pdf");
      assert.equal(change.newDocument.backend, "drive");
      assert.equal(change.newDocument.fileId, "drive-id");
      assert.equal(change.audit.alteracoes.caminhoAnterior, "/uploads/antigo.pdf");
      assert.equal(change.audit.alteracoes.backendNovo, "drive");
      assert.equal(change.audit.alteracoes.motivo, "Bytes locais perdidos");
      return { status: "replaced" };
    };
    const result = await replaceUploadDocument(baseOptions(), deps);
    assert.equal(result.status, "replaced");
    assert.equal(result.fileId, "drive-id");
    assert.deepEqual(calls, ["load", "read", "folder", "list", "upload", "stat:drive-id", "commit"]);
  });

  it("nao duplica upload quando a referencia Drive atual e valida", async () => {
    const calls = [];
    const deps = dependencies(calls, {
      documentos: { notaEmpenho: { fileName: "ok.pdf", path: "/uploads/drive/existing/ok.pdf", backend: "drive", fileId: "existing" } }
    });
    deps.statDriveFile = async (id) => {
      calls.push(`stat:${id}`);
      return { id, size: PDF.length };
    };
    const result = await replaceUploadDocument(baseOptions(), deps);
    assert.equal(result.status, "already_valid");
    assert.deepEqual(calls, ["load", "stat:existing"]);
  });

  it("normaliza backend e fileId sem duplicar uma referencia Drive existente", async () => {
    const calls = [];
    const deps = dependencies(calls, {
      documentos: { notaEmpenho: { fileName: "ok.pdf", path: "/uploads/drive/existing/ok.pdf" } }
    });
    deps.statDriveFile = async (id) => {
      calls.push(`stat:${id}`);
      return { id, size: PDF.length };
    };
    deps.commitReplacement = async (change) => {
      calls.push("commit");
      assert.equal(change.newDocument.backend, "drive");
      assert.equal(change.newDocument.fileId, "existing");
      assert.equal(change.newDocument.path, "/uploads/drive/existing/ok.pdf");
      return { status: "replaced" };
    };
    const result = await replaceUploadDocument(baseOptions(), deps);
    assert.equal(result.status, "metadata_normalized");
    assert.deepEqual(calls, ["load", "stat:existing", "commit"]);
  });

  it("reutiliza upload identificado apos reinicio antes do commit", async () => {
    const calls = [];
    const deps = dependencies(calls);
    deps.listRepairFiles = async () => {
      calls.push("list");
      return [{ id: "reusable", size: String(PDF.length) }];
    };
    deps.statDriveFile = async (id) => {
      calls.push(`stat:${id}`);
      return { id, size: String(PDF.length) };
    };
    const result = await replaceUploadDocument(baseOptions(), deps);
    assert.equal(result.reusedDriveFile, true);
    assert.equal(result.fileId, "reusable");
    assert.doesNotMatch(calls.join(" "), /upload/);
  });

  it("bloqueia processo Pago sem a autorizacao administrativa", async () => {
    await assert.rejects(
      replaceUploadDocument(baseOptions(), dependencies([], { status: "Pago" })),
      (error) => error.code === "PAID_PROCESS_BLOCKED"
    );
  });

  it("aceita processo Pago somente com --allow-paid", async () => {
    const result = await replaceUploadDocument(baseOptions({ allowPaid: true }), dependencies([], { status: "Pago" }));
    assert.equal(result.status, "replaced");
  });

  it("aborta quando processo ou chave nao existem", async () => {
    const noProcess = dependencies([]);
    noProcess.loadProcess = async () => null;
    await assert.rejects(replaceUploadDocument(baseOptions(), noProcess), (error) => error.code === "PROCESS_NOT_FOUND");
    await assert.rejects(
      replaceUploadDocument(baseOptions({ documentKey: "inexistente" }), dependencies([])),
      (error) => error.code === "DOCUMENT_KEY_NOT_FOUND"
    );
  });

  it("rejeita extensao ou conteudo que nao sejam PDF", async () => {
    const wrongExtension = dependencies([]);
    await assert.rejects(replaceUploadDocument(baseOptions({ filePath: "/tmp/a.txt" }), wrongExtension), /extensao \.pdf/);
    const wrongContent = dependencies([]);
    wrongContent.readPdf = async () => ({ content: Buffer.from("nao pdf"), fileName: "a.pdf" });
    await assert.rejects(replaceUploadDocument(baseOptions(), wrongContent), /conteudo.*nao e PDF/i);
  });

  it("mantem update e auditoria na mesma transacao e detecta concorrencia", async () => {
    const oldDocument = { fileName: "old.pdf", path: "/uploads/old.pdf" };
    const statements = [];
    const client = {
      async query(sql) {
        statements.push(sql.replace(/\s+/g, " ").trim());
        if (sql.includes("SELECT data")) return { rows: [{ data: { documentos: { notaEmpenho: oldDocument }, versao: 3 } }] };
        return { rows: [], rowCount: 1 };
      }
    };
    const result = await commitDocumentReplacement({
      processId: "p1",
      documentKey: "notaEmpenho",
      expectedDocument: oldDocument,
      newDocument: { fileName: "old.pdf", path: "/uploads/drive/id/old.pdf" },
      audit: { id: "audit-1" },
      now: "2026-07-19T10:00:00.000Z"
    }, (callback) => callback(client));
    assert.equal(result.status, "replaced");
    assert.match(statements.join("\n"), /FOR UPDATE/);
    assert.match(statements.join("\n"), /INSERT INTO app_process_audit/);
    assert.match(statements.join("\n"), /UPDATE app_state_revision/);

    client.query = async (sql) => sql.includes("SELECT data")
      ? { rows: [{ data: { documentos: { notaEmpenho: { path: "/changed" } } } }] }
      : { rows: [] };
    await assert.rejects(commitDocumentReplacement({
      processId: "p1", documentKey: "notaEmpenho", expectedDocument: oldDocument,
      newDocument: { path: "/uploads/drive/id/old.pdf" }, audit: { id: "a" }, now: "2026-07-19T10:00:00.000Z"
    }, (callback) => callback(client)), (error) => error.code === "DOCUMENT_REFERENCE_CHANGED");
  });
});

function baseOptions(overrides = {}) {
  return {
    processId: "p1",
    documentKey: "notaEmpenho",
    filePath: "/tmp/substituto.pdf",
    dryRun: false,
    confirm: true,
    allowPaid: false,
    technicalUser: "admin-tecnico@local",
    reason: "Bytes locais perdidos",
    ...overrides
  };
}

function dependencies(calls, processOverrides = {}) {
  const process = {
    id: "p1",
    status: "Enviado para liquidacao",
    documentos: { notaEmpenho: { fileName: "Nota original.pdf", path: "/uploads/antigo.pdf", uploadedAt: "2026-01-01" } },
    versao: 1,
    ...processOverrides
  };
  return {
    loadProcess: async () => { calls.push("load"); return process; },
    readPdf: async () => { calls.push("read"); return { content: PDF, fileName: "substituto.pdf" }; },
    verifyDriveFolderAccess: async () => { calls.push("folder"); return { id: "folder" }; },
    listRepairFiles: async () => { calls.push("list"); return []; },
    uploadToDrive: async (content, options) => {
      calls.push("upload");
      assert.equal(options.appProperties.almoxarifadoRepairKey.length, 64);
      return { id: "drive-id", size: content.length };
    },
    statDriveFile: async (id) => { calls.push(`stat:${id}`); return { id, size: String(PDF.length) }; },
    commitReplacement: async () => { calls.push("commit"); return { status: "replaced" }; },
    now: () => new Date("2026-07-19T10:00:00.000Z"),
    randomUUID: () => "audit-id"
  };
}
