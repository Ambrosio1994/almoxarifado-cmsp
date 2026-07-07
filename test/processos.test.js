import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  canEditProcess,
  canAttachDocument,
  calculateElapsedDays,
  canCancelProcess,
  deadlineBand,
  detectDocumentMime,
  enrichProcess,
  filterProcesses,
  isAllowedDocument,
  isPdfDocument,
  isPublicConsultation,
  isProcessOverdue,
  mutationRequiresAuthenticatedUser,
  normalizeMaterials,
  processHasRequiredDocuments,
  summarizeMaterials,
  validateDocumentUpload
} from "../src/domain/processos.js";
import { createSession, resolveSession, revokeSession } from "../src/repositories/sessions.js";

describe("regras de processo", () => {
  it("bloqueia processo pago permanentemente para edicao", () => {
    assert.equal(canEditProcess({ status: "Pago" }, "admin"), false);
    assert.equal(canEditProcess({ status: "Pago" }, "almoxarifado"), false);
    assert.equal(canCancelProcess({ status: "Pago" }, { role: "admin" }), false);
  });

  it("restringe processo liquidado ao administrador", () => {
    assert.equal(canEditProcess({ status: "Liquidado" }, "admin"), true);
    assert.equal(canEditProcess({ status: "Liquidado" }, "almoxarifado", "Pago"), false);
  });

  it("restringe outras edicoes em liquidado ao administrador", () => {
    assert.equal(canEditProcess({ status: "Liquidado" }, "almoxarifado", "Liquidado"), false);
  });

  it("calcula dias decorridos desde a emissao do empenho", () => {
    const now = new Date("2026-07-04T12:00:00");
    assert.equal(calculateElapsedDays("2026-06-01", now), 33);
  });

  it("classifica faixas de prazo dos requisitos", () => {
    assert.equal(deadlineBand(7), "low");
    assert.equal(deadlineBand(14), "medium");
    assert.equal(deadlineBand(21), "high");
    assert.equal(deadlineBand(30), "notice");
    assert.equal(deadlineBand(31), "critical");
  });

  it("enriquece processo com total e dias", () => {
    const result = enrichProcess({
      dataEnvioFornecedor: "2026-07-01",
      materiais: [
        { descricao: "Papel A4", valorUnitario: 10, quantidade: 3 },
        { descricao: "Caneta azul", valorUnitario: 2, quantidade: 5 }
      ]
    }, new Date("2026-07-04T12:00:00"));

    assert.equal(result.diasDecorridos, 3);
    assert.equal(result.valorTotal, 40);
  });

  it("mantem data antiga de envio do empenho como fallback do prazo", () => {
    const result = enrichProcess({
      dataEnvioEmpenho: "2026-07-01",
      materiais: [{ descricao: "Papel A4", valorUnitario: 10, quantidade: 1 }]
    }, new Date("2026-07-04T12:00:00"));

    assert.equal(result.dataReferenciaPrazo, "2026-07-01");
    assert.equal(result.diasDecorridos, 3);
  });

  it("mantem compatibilidade com material unico antigo", () => {
    const materiais = normalizeMaterials({
      material: "Material de expediente",
      valorUnitario: 42.5,
      quantidade: 120
    });

    assert.deepEqual(materiais, [{
      descricao: "Material de expediente",
      valorUnitario: 42.5,
      quantidade: 120
    }]);
  });

  it("pesquisa por qualquer material do processo", () => {
    const processos = [{
      numeroProcesso: "64210.001234/2026-11",
      numeroEmpenho: "2026NE000145",
      fornecedor: "Suprimentos Alfa Ltda",
      status: "Aguardando entrega",
      materiais: [
        { descricao: "Papel A4", valorUnitario: 20, quantidade: 2 },
        { descricao: "Toner preto", valorUnitario: 300, quantidade: 1 }
      ]
    }];

    assert.equal(filterProcesses(processos, { q: "toner" }).length, 1);
  });

  it("resume materiais na tabela", () => {
    assert.equal(summarizeMaterials([
      { descricao: "Papel A4", valorUnitario: 20, quantidade: 2 },
      { descricao: "Toner preto", valorUnitario: 300, quantidade: 1 },
      { descricao: "Caneta azul", valorUnitario: 2, quantidade: 10 }
    ]), "Papel A4 + 2 itens");
  });

  it("nao marca como atrasado quando ja foi entregue, liquidado ou pago", () => {
    assert.equal(isProcessOverdue({ diasDecorridos: 31, status: "Aguardando entrega" }), true);
    assert.equal(isProcessOverdue({ diasDecorridos: 45, status: "Entregue" }), false);
    assert.equal(isProcessOverdue({ diasDecorridos: 45, status: "Liquidado" }), false);
    assert.equal(isProcessOverdue({ diasDecorridos: 45, status: "Pago" }), false);
    assert.equal(isProcessOverdue({ diasDecorridos: 45, status: "Anulado" }), false);
  });

  it("permite anulacao pelo criador ou administrador", () => {
    const processo = { status: "Aguardando entrega", criadoPorEmail: "usuario@cmsp.local" };
    assert.equal(canCancelProcess(processo, { email: "usuario@cmsp.local", role: "almoxarifado" }), true);
    assert.equal(canCancelProcess(processo, { email: "outro@cmsp.local", role: "almoxarifado" }), false);
    assert.equal(canCancelProcess(processo, { email: "admin@cmsp.local", role: "admin" }), true);
    assert.equal(canCancelProcess({ ...processo, status: "Pago" }, { email: "admin@cmsp.local", role: "admin" }), false);
    assert.equal(canCancelProcess({ ...processo, status: "Pago" }, { email: "usuario@cmsp.local", role: "almoxarifado" }), false);
  });

  it("identifica documentos PDF para compilacao", () => {
    assert.equal(isPdfDocument("processo.pdf", ""), true);
    assert.equal(isPdfDocument("nota", "application/pdf"), true);
    assert.equal(isPdfDocument("nota.png", "image/png"), false);
  });

  it("aceita formatos comuns nos documentos do processo", () => {
    assert.equal(isAllowedDocument("planilha.xlsx", ""), true);
    assert.equal(isAllowedDocument("dados.csv", ""), true);
    assert.equal(isAllowedDocument("oficio.docx", ""), true);
    assert.equal(isAllowedDocument("imagem.png", ""), true);
    assert.equal(isAllowedDocument("arquivo.exe", ""), false);
  });

  it("valida documentos pelo conteudo e rejeita executavel disfarçado", () => {
    assert.equal(detectDocumentMime(Buffer.from("%PDF-1.4\n")), "application/pdf");
    assert.equal(validateDocumentUpload("nota.pdf", "application/pdf", Buffer.from("%PDF-1.4\n")), true);
    assert.equal(validateDocumentUpload("nota.pdf", "application/pdf", Buffer.from([0x4d, 0x5a, 0x90, 0x00])), false);
    assert.equal(validateDocumentUpload("../../etc/passwd.pdf", "application/pdf", Buffer.from("%PDF-1.4\n")), false);
    assert.equal(validateDocumentUpload("imagem.png", "image/png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), true);
  });

  it("identifica quando todos os documentos obrigatorios estao anexados", () => {
    assert.equal(processHasRequiredDocuments({
      documentos: {
        processoSped: { fileName: "processo.pdf" },
        notaEmpenho: { fileName: "ne.pdf" },
        notaFiscal: { fileName: "nf.pdf" }
      }
    }), true);

    assert.equal(processHasRequiredDocuments({
      documentos: {
        processoSped: { fileName: "processo.pdf" },
        notaEmpenho: { fileName: "ne.pdf" }
      }
    }), false);
  });

  it("permite anexar nota fiscal e demais documentos na aba de documentos", () => {
    assert.equal(canAttachDocument({ dataEntrega: "" }, "notaFiscal"), true);
    assert.equal(canAttachDocument({ dataEntrega: "2026-07-03" }, "notaFiscal"), true);
    assert.equal(canAttachDocument({ dataEntrega: "" }, "notaEmpenho"), true);
    assert.equal(canAttachDocument({ status: "Pago" }, "processoSped"), true);
    assert.equal(canAttachDocument({ status: "Anulado" }, "processoSped"), false);
  });

  it("libera consultas publicas e exige autenticacao em alteracoes", () => {
    assert.equal(isPublicConsultation("GET", "/api/processes"), true);
    assert.equal(isPublicConsultation("GET", "/api/dashboard"), true);
    assert.equal(isPublicConsultation("GET", "/health"), true);
    assert.equal(isPublicConsultation("GET", "/api/settings"), false);
    assert.equal(isPublicConsultation("GET", "/api/audit"), false);
    assert.equal(isPublicConsultation("GET", "/api/processes/abc/download"), false);
    assert.equal(isPublicConsultation("POST", "/api/processes"), false);
    assert.equal(mutationRequiresAuthenticatedUser("GET"), false);
    assert.equal(mutationRequiresAuthenticatedUser("POST"), true);
    assert.equal(mutationRequiresAuthenticatedUser("DELETE"), true);
  });

  it("persiste e invalida sessoes no fallback em memoria", async () => {
    const token = await createSession("user-1", 30 * 60 * 1000);
    assert.equal(await resolveSession(token, 30 * 60 * 1000), "user-1");
    await revokeSession(token);
    assert.equal(await resolveSession(token, 30 * 60 * 1000), null);
  });
});
