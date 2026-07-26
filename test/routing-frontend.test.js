import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

describe("Roteamento da aplicacao no DOM", () => {
  it("abre um link profundo sem carregar a lista e sincroniza abas, popstate e 404", async () => {
    const dom = await createDom("http://localhost/empenhos/p1/documentos");
    const restoreGlobals = installDomGlobals(dom.window);
    const requests = [];
    const processo = processFixture();

    globalThis.fetch = async (input) => {
      const path = String(input);
      requests.push(path);
      if (path === "/auth/session") return jsonResponse({ email: "admin@example.com", nome: "Admin", role: "admin" });
      if (path === "/api/meta") {
        return jsonResponse({
          status: ["Enviado para SALC", "Empenho enviado ao fornecedor", "Entrega parcial", "Entregue", "Enviado para liquidacao", "Liquidado", "Pago", "Anulado"],
          filtrosRapidos: [],
          transicoes: {}
        });
      }
      if (path === "/api/dashboard") return jsonResponse(dashboardPayload());
      if (path === "/api/processes/p1") return jsonResponse(processo);
      if (path === "/api/processes/inexistente") return jsonResponse({ error: "Processo nao encontrado" }, 404);
      if (path === "/api/processes/p1/observations" || path === "/api/processes/p1/audit") return jsonResponse([]);
      if (path === "/api/suppliers") return jsonResponse([]);
      if (path === "/api/emails/history") return jsonResponse([]);
      if (path === "/api/processes") return jsonResponse([processo]);
      throw new Error(`Requisicao inesperada no teste: ${path}`);
    };

    try {
      await import(`${new URL("../public/app.js", import.meta.url).href}?routing-deep-link=${Date.now()}`);
      await waitFor(() => dom.window.document.querySelector("#detailProcessNumber")?.textContent === "PROC-1");
      await waitFor(() => dom.window.document.querySelector('[data-detail-tab="documents"]')?.getAttribute("aria-selected") === "true");

      assert.equal(dom.window.location.pathname, "/empenhos/p1/documentos");
      assert.equal(requests.filter((path) => path === "/api/processes/p1").length, 1);
      assert.equal(requests.filter((path) => path === "/api/processes").length, 0);

      const historyLength = dom.window.history.length;
      dom.window.document.querySelector('[data-detail-tab="timeline"]').click();
      await waitFor(() => dom.window.location.pathname === "/empenhos/p1/linha-do-tempo");
      assert.equal(dom.window.history.length, historyLength, "trocar de aba deve substituir a entrada atual");

      dom.window.document.querySelector('[data-detail-tab="emails"]').click();
      await waitFor(() => requests.includes("/api/emails/history"));
      assert.equal(dom.window.location.pathname, "/empenhos/p1/emails");

      const boardState = { appRoute: true, kind: "section", section: "board" };
      dom.window.history.pushState(boardState, "", "/quadro");
      dom.window.dispatchEvent(new dom.window.PopStateEvent("popstate", { state: boardState }));
      await waitFor(() => dom.window.document.querySelector('[data-section="board"]')?.getAttribute("aria-current") === "page");
      assert.equal(dom.window.location.pathname, "/quadro");

      const missingState = {
        appRoute: true,
        kind: "process",
        processId: "inexistente",
        tab: "documents",
        returnSection: "processes",
        canReturnBack: false
      };
      dom.window.history.pushState(missingState, "", "/empenhos/inexistente/documentos");
      dom.window.dispatchEvent(new dom.window.PopStateEvent("popstate", { state: missingState }));
      await waitFor(() => dom.window.document.querySelector("#routeNotFoundTitle")?.textContent === "Empenho não encontrado");
      assert.equal(dom.window.document.querySelector("#routeNotFoundView").classList.contains("hidden"), false);
      assert.equal(dom.window.location.pathname, "/empenhos/inexistente/documentos");
    } finally {
      restoreGlobals();
      dom.window.close();
    }
  });

  it("redireciona uma rota sem permissao e mantem URL e tela coerentes", async () => {
    const dom = await createDom("http://localhost/usuarios");
    const restoreGlobals = installDomGlobals(dom.window);
    const requests = [];

    globalThis.fetch = async (input) => {
      const path = String(input);
      requests.push(path);
      if (path === "/auth/session") return jsonResponse({ email: "estoque@example.com", nome: "Estoque", role: "almoxarifado" });
      if (path === "/api/meta") return jsonResponse({ status: [], filtrosRapidos: [], transicoes: {} });
      if (path === "/api/dashboard") return jsonResponse(dashboardPayload());
      throw new Error(`Requisicao inesperada no teste: ${path}`);
    };

    try {
      await import(`${new URL("../public/app.js", import.meta.url).href}?routing-permission=${Date.now()}`);
      await waitFor(() => dom.window.document.querySelector('[data-section="dashboard"]')?.getAttribute("aria-current") === "page");

      assert.equal(dom.window.location.pathname, "/graficos");
      assert.equal(dom.window.document.querySelector("#dashboardView").classList.contains("hidden"), false);
      assert.equal(requests.includes("/api/settings"), false);
    } finally {
      restoreGlobals();
      dom.window.close();
    }
  });

  it("mostra a pagina de nao encontrado ao iniciar por uma URL desconhecida", async () => {
    const dom = await createDom("http://localhost/pagina-inexistente");
    const restoreGlobals = installDomGlobals(dom.window);

    globalThis.fetch = async (input) => {
      const path = String(input);
      if (path === "/auth/session") return jsonResponse({ email: "estoque@example.com", nome: "Estoque", role: "almoxarifado" });
      if (path === "/api/meta") return jsonResponse({ status: [], filtrosRapidos: [], transicoes: {} });
      if (path === "/api/dashboard") return jsonResponse(dashboardPayload());
      throw new Error(`Requisicao inesperada no teste: ${path}`);
    };

    try {
      await import(`${new URL("../public/app.js", import.meta.url).href}?routing-not-found=${Date.now()}`);
      await waitFor(() => dom.window.document.querySelector("#routeNotFoundTitle")?.textContent === "Página não encontrada");

      assert.equal(dom.window.location.pathname, "/pagina-inexistente");
      assert.equal(dom.window.document.querySelector("#routeNotFoundView").classList.contains("hidden"), false);
    } finally {
      restoreGlobals();
      dom.window.close();
    }
  });
});

async function createDom(url) {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const dom = new JSDOM(html, { url, pretendToBeVisual: true });
  installDialogPolyfill(dom.window);
  return dom;
}

function processFixture() {
  return {
    id: "p1",
    versao: 1,
    numeroProcesso: "PROC-1",
    numeroEmpenho: "2026NE000001",
    status: "Enviado para SALC",
    fornecedor: "Fornecedor Teste",
    requisitante: "Requisitante Teste",
    materiais: [{ id: "m1", descricao: "Material", quantidade: 1, valorUnitario: 10 }],
    documentos: {},
    observacoes: []
  };
}

function dashboardPayload() {
  return {
    ano: 2026,
    anos: [2026],
    metrics: {},
    charts: { execucaoMensal: [], distribuicaoStatus: [] }
  };
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}

async function waitFor(predicate, timeoutMs = 1_500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("A rota esperada nao foi renderizada dentro do prazo.");
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
