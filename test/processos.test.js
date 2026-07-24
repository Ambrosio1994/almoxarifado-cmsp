import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  canEditProcess,
  canAttachDocument,
  canRemoveDocument,
  calculateMaterialsTotal,
  calculateElapsedDays,
  canCancelProcess,
  dashboardAvailableYears,
  dashboardMetrics,
  dashboardMonthlyExecution,
  dashboardStatusDistribution,
  deadlineBand,
  detectDocumentMime,
  enrichProcess,
  filterProcesses,
  applyQuickFilter,
  isAllowedDocument,
  isPdfDocument,
  isMutationRequest,
  isProcessPendingLiquidation,
  isProcessOverdue,
  isValidStatusRollback,
  isValidStatusTransition,
  PROCESS_TRANSITIONS,
  PROCESS_WORKFLOW,
  normalizeMaterials,
  processHasRequiredDocuments,
  previousProcessStatuses,
  rollbackProcessStatus,
  summarizeMaterials,
  validateDocumentUpload,
  validateProcessDocumentUpload
} from "../src/domain/processos.js";
import { closePool } from "../src/db/postgres.js";
import { createSession, resolveSession, revokeSession } from "../src/repositories/sessions.js";

describe("regras de processo", () => {
  it("considera enviados ainda nao liquidados como pendentes de liquidacao", () => {
    const processos = [
      { id: "entregue", status: "Entregue" },
      { id: "enviado", status: "Enviado para liquidacao", dataEnvioLiquidacao: "2026-07-20" },
      { id: "liquidado", status: "Liquidado", dataLiquidacao: "2026-07-21" }
    ];

    assert.equal(isProcessPendingLiquidation(processos[1]), true);
    assert.deepEqual(applyQuickFilter(processos, "Pendentes de liquidacao").map(({ id }) => id), ["entregue", "enviado"]);
  });

  it("inicia o fluxo em Criado antes do envio para SALC", () => {
    assert.equal(isValidStatusTransition("Criado", "Enviado para SALC"), true);
    assert.equal(isValidStatusTransition("Criado", "Empenho enviado ao fornecedor"), false);
    const rolledBack = rollbackProcessStatus({
      status: "Enviado para SALC",
      dataEnvioSalc: "2026-07-01"
    }, "Criado");
    assert.equal(rolledBack.status, "Criado");
    assert.equal(rolledBack.dataEnvioSalc, "");
  });

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

  it("permite retrocesso somente para status anteriores e limpa marcos desfeitos", () => {
    assert.deepEqual(previousProcessStatuses("Liquidado").slice(-2), ["Entregue", "Enviado para liquidacao"]);
    assert.equal(isValidStatusRollback("Liquidado", "Entregue"), true);
    assert.equal(isValidStatusRollback("Liquidado", "Pago"), false);
    const rolledBack = rollbackProcessStatus({
      status: "Pago", dataEntrega: "2026-01-01", dataEnvioLiquidacao: "2026-01-02",
      dataLiquidacao: "2026-01-03", dataPagamento: "2026-01-04"
    }, "Entregue");
    assert.equal(rolledBack.status, "Entregue");
    assert.equal(rolledBack.dataEntrega, "2026-01-01");
    assert.equal(rolledBack.dataEnvioLiquidacao, "");
    assert.equal(rolledBack.dataLiquidacao, "");
    assert.equal(rolledBack.dataPagamento, "");
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
      id: "legacy-material-0-226ac3f2",
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
      criadoPor: "Maria Almoxarifado",
      materiais: [
        { descricao: "Papel A4", valorUnitario: 20, quantidade: 2 },
        { descricao: "Toner preto", valorUnitario: 300, quantidade: 1 }
      ]
    }];

    assert.equal(filterProcesses(processos, { q: "toner" }).length, 1);
    assert.equal(filterProcesses(processos, { q: "maria" }).length, 1);
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
    assert.equal(isProcessOverdue({ diasDecorridos: 45, status: "Aguardando envio para liquidacao" }), false);
    assert.equal(isProcessOverdue({ diasDecorridos: 45, status: "Enviado para liquidacao" }), false);
    assert.equal(isProcessOverdue({ diasDecorridos: 45, status: "Liquidado" }), false);
    assert.equal(isProcessOverdue({ diasDecorridos: 45, status: "Pago" }), false);
    assert.equal(isProcessOverdue({ diasDecorridos: 45, status: "Anulado" }), false);
  });

  it("mantem indicadores anuais coerentes entre empenho, liquidacao e pagamento", () => {
    const processos = [
      {
        status: "Pago", dataEnvioEmpenho: "2090-12-10", dataLiquidacao: "2091-02-10", dataPagamento: "2091-03-10",
        valorTotal: 100, diasDecorridos: 0
      },
      {
        status: "Liquidado", dataEnvioEmpenho: "2091-01-10", dataLiquidacao: "2091-04-10",
        valorTotal: 50, diasDecorridos: 0
      },
      {
        status: "Aguardando entrega", dataEnvioEmpenho: "2091-01-15",
        valorTotal: 20, diasDecorridos: 31
      },
      {
        status: "Anulado", dataEnvioEmpenho: "2091-01-20",
        valorTotal: 300, diasDecorridos: 0
      }
    ];

    const metrics = dashboardMetrics(processos, 2091);
    assert.equal(metrics.processosAtivos, 2);
    assert.equal(metrics.aguardandoEntrega, 1);
    assert.equal(metrics.atrasados, 1);
    assert.equal(metrics.valorEmpenhado, 70);
    assert.equal(metrics.valorLiquidado, 150);
    assert.equal(metrics.valorPago, 100);

    const monthly = dashboardMonthlyExecution(processos, 2091);
    assert.equal(monthly[0].empenhado, 70);
    assert.equal(monthly[1].liquidado, 100);
    assert.equal(monthly[2].pago, 100);
    assert.equal(monthly[3].liquidado, 50);
    assert.equal(monthly.reduce((total, row) => total + row.liquidado, 0), metrics.valorLiquidado);
    assert.equal(monthly.reduce((total, row) => total + row.pago, 0), metrics.valorPago);
  });

  it("nao trata anulado como empenhado e preserva seu status na distribuicao", () => {
    const processos = [
      { status: "Anulado", dataEnvioEmpenho: "2092-02-10", valorTotal: 500 },
      { status: "Pago", dataEnvioEmpenho: "2092-03-10", dataLiquidacao: "2092-04-10", dataPagamento: "2092-05-10", valorTotal: 80 }
    ];

    const metrics = dashboardMetrics(processos, 2092);
    assert.equal(metrics.processosAtivos, 1);
    assert.equal(metrics.valorEmpenhado, 80);
    assert.equal(metrics.valorLiquidado, 80);
    assert.equal(metrics.valorPago, 80);
    assert.deepEqual(dashboardStatusDistribution(processos, 2092), [
      { status: "Pago", quantidade: 1 },
      { status: "Anulado", quantidade: 1 }
    ]);
  });

  it("oferece anos de liquidacao e pagamento mesmo quando o empenho e anterior", () => {
    const processos = [{
      status: "Pago",
      dataEnvioEmpenho: "2093-12-10",
      dataLiquidacao: "2094-01-15",
      dataPagamento: "2094-02-20",
      valorTotal: 125
    }];

    assert.deepEqual(dashboardAvailableYears(processos), [2094, 2093]);
    assert.equal(dashboardMonthlyExecution(processos, 2094)[0].liquidado, 125);
    assert.equal(dashboardMonthlyExecution(processos, 2094)[1].pago, 125);
  });

  it("permite anulacao pelo criador ou administrador", () => {
    const processo = { status: "Aguardando entrega", criadoPorEmail: "usuario@example.test" };
    assert.equal(canCancelProcess(processo, { email: "usuario@example.test", role: "almoxarifado" }), true);
    assert.equal(canCancelProcess(processo, { email: "outro@example.test", role: "almoxarifado" }), false);
    assert.equal(canCancelProcess(processo, { email: "admin@example.test", role: "admin" }), true);
    assert.equal(canCancelProcess({ ...processo, status: "Pago" }, { email: "admin@example.test", role: "admin" }), false);
    assert.equal(canCancelProcess({ ...processo, status: "Pago" }, { email: "usuario@example.test", role: "almoxarifado" }), false);
    assert.equal(canCancelProcess({ ...processo, criadoPorId: "user-1" }, { id: "user-1", email: "novo@example.test", role: "almoxarifado" }), true);
    assert.equal(canCancelProcess({ ...processo, criadoPorId: "user-1" }, { id: "user-2", email: "usuario@example.test", role: "almoxarifado" }), false);
    assert.equal(canCancelProcess({ ...processo, status: "Liquidado" }, { email: "usuario@example.test", role: "almoxarifado" }), false);
  });

  it("centraliza o fluxo e impede saltos de etapa", () => {
    assert.equal(isValidStatusTransition("Entregue", "Aguardando envio para liquidacao"), false);
    assert.equal(isValidStatusTransition("Entregue", "Enviado para liquidacao"), true);
    assert.equal(isValidStatusTransition("Aguardando envio para liquidacao", "Enviado para liquidacao"), true);
    assert.equal(PROCESS_WORKFLOW.includes("Aguardando entrega"), false);
    assert.equal(PROCESS_TRANSITIONS["Empenho enviado ao fornecedor"], "Entrega parcial");
    assert.equal(PROCESS_TRANSITIONS["Aguardando entrega"], "Entrega parcial");
    assert.equal(isValidStatusTransition("Empenho enviado ao fornecedor", "Aguardando entrega"), false);
  });

  it("calcula totais monetarios sem propagar valores nao finitos", () => {
    assert.equal(calculateMaterialsTotal([{ valorUnitario: 0.1, quantidade: 3 }]), 0.3);
    assert.equal(calculateMaterialsTotal([{ valorUnitario: Infinity, quantidade: 2 }]), 0);
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
    const pdf = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF");
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
    assert.equal(detectDocumentMime(Buffer.from("%PDF-1.4\n")), "application/pdf");
    assert.equal(validateDocumentUpload("nota.pdf", "application/pdf", pdf), true);
    assert.equal(validateDocumentUpload("truncado.pdf", "application/pdf", Buffer.from("%PDF-1.4\n")), false);
    assert.equal(validateDocumentUpload("nota.pdf", "application/pdf", Buffer.from([0x4d, 0x5a, 0x90, 0x00])), false);
    assert.equal(validateDocumentUpload("../../etc/passwd.pdf", "application/pdf", pdf), false);
    assert.equal(validateDocumentUpload("imagem.png", "image/png", png), true);
    assert.equal(validateDocumentUpload("imagem-truncada.png", "image/png", png.subarray(0, 8)), false);
  });

  it("exige Processo SPED ou Nota de Empenho para enviar para liquidacao", () => {
    assert.equal(processHasRequiredDocuments({
      documentos: {
        processoSped: { fileName: "processo.pdf" }
      }
    }), true);

    assert.equal(processHasRequiredDocuments({
      documentos: {
        notaEmpenho: { fileName: "ne.pdf" }
      }
    }), true);

    assert.equal(processHasRequiredDocuments({
      documentos: {
        processoSped: { fileName: "processo.pdf" },
        notaEmpenho: { fileName: "ne.pdf" }
      }
    }), true);

    assert.equal(processHasRequiredDocuments({
      documentos: {
        notaFiscal: { fileName: "nf.pdf" }
      }
    }), false);
  });

  it("restringe nota fiscal ao recebimento e bloqueia documentos apos pagamento", () => {
    assert.equal(canAttachDocument({ status: "Aguardando entrega" }, "notaFiscal"), false);
    assert.equal(canAttachDocument({ status: "Entrega parcial" }, "notaFiscal"), true);
    assert.equal(canAttachDocument({ status: "Entregue" }, "notaFiscal"), true);
    assert.equal(canAttachDocument({ status: "Aguardando entrega" }, "notaEmpenho"), true);
    assert.equal(canAttachDocument({ status: "Pago" }, "processoSped"), false);
    assert.equal(canAttachDocument({ status: "Anulado" }, "processoSped"), false);
    assert.equal(canRemoveDocument({ status: "Enviado para liquidacao" }, "notaFiscal"), false);
    assert.equal(canRemoveDocument({ status: "Enviado para liquidacao" }, "complementares:0"), true);
  });

  it("exige PDF nos documentos obrigatorios e aceita formatos adicionais somente nos complementares", () => {
    const pdf = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF");
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
    assert.equal(validateProcessDocumentUpload("notaEmpenho", "nota.pdf", "application/pdf", pdf), true);
    assert.equal(validateProcessDocumentUpload("notaEmpenho", "nota.png", "image/png", png), false);
    assert.equal(validateProcessDocumentUpload("complementares", "foto.png", "image/png", png), true);
  });

  it("identifica mutacoes HTTP", () => {
    assert.equal(isMutationRequest("GET"), false);
    assert.equal(isMutationRequest("POST"), true);
    assert.equal(isMutationRequest("DELETE"), true);
  });

  it("persiste e invalida sessoes no fallback em memoria", async () => {
    await withEnv({ DATABASE_URL: undefined }, async () => {
      const token = await createSession("user-1", 30 * 60 * 1000);
      assert.equal(await resolveSession(token, 30 * 60 * 1000), "user-1");
      await revokeSession(token);
      assert.equal(await resolveSession(token, 30 * 60 * 1000), null);
    });
  });

  it("renova o TTL da sessao enquanto houver atividade", async () => {
    await withEnv({ DATABASE_URL: undefined }, async () => {
      const originalNow = Date.now;
      let now = 1_700_000_000_000;
      Date.now = () => now;
      try {
        const token = await createSession("user-sliding", 1_000);
        now += 900;
        assert.equal(await resolveSession(token, 1_000), "user-sliding");
        now += 900;
        assert.equal(await resolveSession(token, 1_000), "user-sliding");
        now += 1_001;
        assert.equal(await resolveSession(token, 1_000), null);
      } finally {
        Date.now = originalNow;
      }
    });
  });
});

async function withEnv(values, callback) {
  const previous = {};
  for (const key of Object.keys(values)) {
    previous[key] = process.env[key];
    if (values[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = values[key];
    }
  }

  try {
    return await callback();
  } finally {
    await closePool();
    for (const key of Object.keys(values)) {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key];
      }
    }
  }
}
