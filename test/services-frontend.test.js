import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

describe("Servicos no DOM", () => {
  it("mostra acompanhamento por execucao e registra uma competencia sem pedir entrega", async () => {
    const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
    const dom = new JSDOM(html, { url: "http://localhost/empenhos/s1/entregas", pretendToBeVisual: true });
    installDialogPolyfill(dom.window);
    const restoreGlobals = installDomGlobals(dom.window);
    const today = new Date().toISOString().slice(0, 10);
    let process = serviceFixture(today);
    let executionRequest = null;

    globalThis.fetch = async (input, options = {}) => {
      const path = String(input);
      if (path === "/auth/session") return jsonResponse({ id: "u1", email: "estoque@example.com", nome: "Estoque", role: "almoxarifado" });
      if (path === "/api/meta") return jsonResponse({
        status: ["Enviado para SALC", "Empenho enviado ao fornecedor", "Em execução", "Serviço concluído", "Enviado para liquidacao", "Liquidado", "Pago", "Anulado"],
        filtrosRapidos: [],
        transicoes: {},
        transicoesServico: {
          "Empenho enviado ao fornecedor": "Em execução",
          "Em execução": "Serviço concluído",
          "Serviço concluído": "Enviado para liquidacao"
        }
      });
      if (path.startsWith("/api/dashboard")) return jsonResponse({ ano: 2026, anos: [2026], metrics: {}, charts: { execucaoMensal: [], distribuicaoStatus: [] } });
      if (path === "/api/processes/s1") return jsonResponse(process);
      if (path === "/api/processes") return jsonResponse([process]);
      if (path === "/api/suppliers") return jsonResponse([]);
      if (path === "/api/processes/s1/observations" || path === "/api/processes/s1/audit") return jsonResponse([]);
      if (path === "/api/processes/s1/service-executions" && options.method === "POST") {
        executionRequest = JSON.parse(options.body);
        process = {
          ...process,
          status: "Em execução",
          percentualConcluido: 40,
          versao: 2,
          execucoesServico: [{
            id: "e1",
            ...executionRequest,
            registradoPor: "Estoque"
          }]
        };
        return jsonResponse(process, 201);
      }
      throw new Error(`Requisicao inesperada no teste: ${path}`);
    };

    try {
      await import(`${new URL("../public/app.js", import.meta.url).href}?services-test=${Date.now()}`);
      await waitFor(() => dom.window.document.querySelector('[data-detail-tab="deliveries"]')?.textContent === "Execução");

      assert.match(dom.window.document.querySelector("#detailPanel").textContent, /0% concluído/i);
      assert.doesNotMatch(dom.window.document.querySelector("#detailPanel").textContent, /data da entrega/i);
      dom.window.document.querySelector('[data-register-service-execution="true"]').click();
      const dialog = dom.window.document.querySelector("#serviceExecutionDialog");
      assert.equal(dialog.open, true);

      const form = dom.window.document.querySelector("#serviceExecutionForm");
      form.elements.percentualExecutado.value = "40";
      form.elements.valorExecutado.value = "1.000,00";
      form.elements.descricao.value = "Competência executada";
      form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));

      await waitFor(() => executionRequest !== null);
      assert.equal(executionRequest.percentualExecutado, 40);
      assert.equal(executionRequest.valorExecutado, 1000);
      assert.equal(executionRequest.competencia, today.slice(0, 7));
      await waitFor(() => dom.window.document.querySelector("#detailPanel").textContent.includes("40% concluído"));
      assert.equal(dialog.open, false);
    } finally {
      restoreGlobals();
      dom.window.close();
    }
  });

  it("adiciona itens em lote, replica a descricao e importa uma planilha CSV", async () => {
    const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
    const dom = new JSDOM(html, { url: "http://localhost/empenhos", pretendToBeVisual: true });
    installDialogPolyfill(dom.window);
    const restoreGlobals = installDomGlobals(dom.window);

    globalThis.fetch = async (input) => {
      const path = String(input);
      if (path === "/auth/session") return jsonResponse({ id: "u1", email: "estoque@example.com", nome: "Estoque", role: "almoxarifado" });
      if (path === "/api/meta") return jsonResponse({ status: [], filtrosRapidos: [], transicoes: {} });
      if (path.startsWith("/api/dashboard")) return jsonResponse({ ano: 2026, anos: [2026], metrics: {}, charts: { execucaoMensal: [], distribuicaoStatus: [] } });
      if (path === "/api/processes") return jsonResponse([]);
      if (path === "/api/suppliers") return jsonResponse([]);
      throw new Error(`Requisicao inesperada no teste: ${path}`);
    };

    try {
      await import(`${new URL("../public/app.js", import.meta.url).href}?materials-test=${Date.now()}`);
      dom.window.document.querySelector("#newProcessButton").click();
      const materialsList = dom.window.document.querySelector("#materialsList");
      const firstDescription = materialsList.querySelector('[data-material-field="descricao"]');
      firstDescription.value = "Papel A4";
      firstDescription.dispatchEvent(new dom.window.Event("input", { bubbles: true }));

      dom.window.document.querySelector("#materialRowsCount").value = "2";
      dom.window.document.querySelector("#addMaterialRowsButton").click();
      assert.equal(materialsList.children.length, 3);
      dom.window.document.querySelector("#copyMaterialDescriptionButton").click();
      assert.deepEqual(
        [...materialsList.querySelectorAll('[data-material-field="descricao"]')].map((input) => input.value),
        ["Papel A4", "Papel A4", "Papel A4"]
      );

      const spreadsheetInput = dom.window.document.querySelector("#materialsSpreadsheetInput");
      Object.defineProperty(spreadsheetInput, "files", {
        configurable: true,
        value: [{
          name: "itens.csv",
          text: async () => "descricao;quantidade;valor unitario\nCaneta;2;0,7326\nEtiqueta;1;47,4750\n"
        }]
      });
      spreadsheetInput.dispatchEvent(new dom.window.Event("change", { bubbles: true }));

      await waitFor(() => materialsList.children.length === 5);
      assert.deepEqual(
        [...materialsList.querySelectorAll('[data-material-field="descricao"]')].slice(-2).map((input) => input.value),
        ["Caneta", "Etiqueta"]
      );
      assert.deepEqual(
        [...materialsList.querySelectorAll('[data-material-field="valorUnitario"]')].slice(-2).map((input) => input.value),
        ["0,7326", "47,4750"]
      );
      assert.match(dom.window.document.querySelector("#materialsImportHelp").textContent, /2 itens importados de itens\.csv/);
    } finally {
      restoreGlobals();
      dom.window.close();
    }
  });
});

function serviceFixture(today) {
  return {
    id: "s1",
    versao: 1,
    numeroProcesso: "SERV-1",
    numeroEmpenho: "2026NE000001",
    tipoObjeto: "servico",
    acompanhamentoServico: "continuado",
    dataInicioServico: today,
    dataEnvioFornecedor: today,
    status: "Empenho enviado ao fornecedor",
    fornecedor: "Prestadora Teste",
    criadoPor: "Setor requisitante",
    materiais: [{ id: "m1", descricao: "Manutenção mensal", quantidade: 12, valorUnitario: 1000 }],
    valorTotal: 12000,
    percentualConcluido: 0,
    execucoesServico: [],
    documentos: {}
  };
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

async function waitFor(predicate, timeoutMs = 1_500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("A interface de servicos nao atingiu o estado esperado.");
}

function installDomGlobals(window) {
  const values = {
    window,
    document: window.document,
    FormData: window.FormData,
    localStorage: window.localStorage,
    location: window.location,
    alert: () => {},
    confirm: () => true
  };
  const previous = new Map();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, Object.prototype.hasOwnProperty.call(globalThis, key) ? globalThis[key] : undefined);
    globalThis[key] = value;
  }
  previous.set("fetch", globalThis.fetch);
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  };
}

function installDialogPolyfill(window) {
  if (!window.HTMLDialogElement.prototype.showModal) {
    window.HTMLDialogElement.prototype.showModal = function showModal() {
      this.open = true;
    };
  }
  if (!window.HTMLDialogElement.prototype.close) {
    window.HTMLDialogElement.prototype.close = function close() {
      this.open = false;
      this.dispatchEvent(new window.Event("close"));
    };
  }
}
