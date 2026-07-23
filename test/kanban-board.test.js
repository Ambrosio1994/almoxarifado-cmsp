import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  allowedBoardTransitions,
  boardDeadlineDate,
  boardFilterOptions,
  countProcessDocuments,
  filterBoardProcesses,
  getProcessDeadlineState,
  groupProcessesByStatus,
  safeBoardStatusId
} from "../public/kanban-board.js";

describe("funcoes puras do quadro kanban", () => {
  const processes = [
    processFixture({ id: "p1", status: "Enviado para SALC", fornecedor: "Alpha", criadoPor: "Ana", diasDecorridos: 5 }),
    processFixture({ id: "p2", status: "Aguardando entrega", fornecedor: "Beta", criadoPor: "Bruno", diasDecorridos: 31 }),
    processFixture({ id: "p3", status: "Pago", fornecedor: "Alpha", criadoPor: "Ana", diasDecorridos: 40 })
  ];

  it("agrupa por todos os status, inclusive colunas vazias, e sanitiza identificadores", () => {
    const statuses = ["Enviado para SALC", "Aguardando entrega", "Entregue", "Pago"];
    const groups = groupProcessesByStatus(processes, statuses);
    assert.deepEqual([...groups.keys()], statuses);
    assert.equal(groups.get("Enviado para SALC").length, 1);
    assert.equal(groups.get("Entregue").length, 0);
    assert.equal(safeBoardStatusId("Aguardando entrega"), "aguardando_entrega");
  });

  it("filtra sem alterar a fonte e oferece fornecedores e responsaveis unicos", () => {
    const snapshot = structuredClone(processes);
    assert.deepEqual(filterBoardProcesses(processes, { search: "material p2" }).map((item) => item.id), ["p2"]);
    assert.deepEqual(filterBoardProcesses(processes, { supplier: "Alpha" }).map((item) => item.id), ["p1", "p3"]);
    assert.deepEqual(filterBoardProcesses(processes, { responsible: "Bruno" }).map((item) => item.id), ["p2"]);
    assert.deepEqual(filterBoardProcesses(processes, { status: "Pago" }).map((item) => item.id), ["p3"]);
    assert.deepEqual(filterBoardProcesses(processes, { deadline: "overdue" }).map((item) => item.id), ["p2"]);
    assert.deepEqual(boardFilterOptions(processes), { suppliers: ["Alpha", "Beta"], responsibles: ["Ana", "Bruno"] });
    assert.deepEqual(processes, snapshot);
  });

  it("reutiliza o prazo de 30 dias e lista apenas transicoes ativas permitidas", () => {
    assert.equal(getProcessDeadlineState(processFixture({ diasDecorridos: 31, status: "Aguardando entrega" })), "overdue");
    assert.equal(getProcessDeadlineState(processFixture({ diasDecorridos: 30, status: "Aguardando entrega" })), "today");
    assert.equal(getProcessDeadlineState(processFixture({ diasDecorridos: 25, status: "Aguardando entrega" })), "upcoming");
    assert.equal(getProcessDeadlineState(processFixture({ dataReferenciaPrazo: "", dataEnvioFornecedor: "" })), "none");
    assert.equal(boardDeadlineDate(processFixture({ dataReferenciaPrazo: "2026-06-01" })), "2026-07-01");
    assert.deepEqual(allowedBoardTransitions("Entregue", { Entregue: "Enviado para liquidacao" }, ["Entregue", "Enviado para liquidacao"]), ["Enviado para liquidacao"]);
    assert.deepEqual(allowedBoardTransitions("Entregue", { Entregue: "Status legado" }, ["Entregue"]), []);
  });

  it("conta documentos simples e complementares sem produzir valores invalidos", () => {
    assert.equal(countProcessDocuments({ documentos: {
      processoSped: { path: "/a.pdf" },
      notaEmpenho: null,
      complementares: [{ path: "/b.pdf" }, { path: "/c.pdf" }]
    } }), 3);
  });
});

function processFixture(overrides = {}) {
  return {
    id: "process",
    numeroProcesso: "PROC",
    numeroEmpenho: "NE",
    fornecedor: "Fornecedor",
    criadoPor: "Responsavel",
    status: "Enviado para SALC",
    dataReferenciaPrazo: "2026-06-01",
    dataEnvioFornecedor: "2026-06-01",
    diasDecorridos: 0,
    materiais: [{ descricao: `Material ${overrides.id || "process"}`, valorUnitario: 10, quantidade: 1 }],
    documentos: {},
    valorTotal: 10,
    ...overrides
  };
}
