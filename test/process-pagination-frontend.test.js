import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

describe("paginação de empenhos no DOM", () => {
  it("consulta filtros no servidor, redefine para a primeira página e navega entre páginas", async () => {
    const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
    const dom = new JSDOM(html, { url: "http://localhost/", pretendToBeVisual: true });
    installDialogPolyfill(dom.window);
    const restoreGlobals = installDomGlobals(dom.window);
    const requests = [];

    globalThis.fetch = async (input) => {
      const path = String(input);
      if (path === "/auth/session") return jsonResponse({ id: "paginacao", email: "paginacao@example.com", nome: "Paginação", role: "almoxarifado" });
      if (path === "/api/meta") return jsonResponse({ status: ["Pago"], filtrosRapidos: ["Pago"] });
      if (path.startsWith("/api/dashboard")) return jsonResponse(dashboardPayload());
      if (path.startsWith("/api/processes?")) {
        requests.push(path);
        const params = new URL(`http://localhost${path}`).searchParams;
        const page = Number(params.get("page"));
        const query = params.get("q") || "";
        const paid = params.getAll("filtroRapido").includes("Pago");
        const data = paid ? [{ id: "paid", numeroProcesso: "PAGO", status: "Pago", materiais: [] }] : [{ id: `p${page}`, numeroProcesso: query || `PROC-${page}`, status: "Enviado para SALC", materiais: [] }];
        return jsonResponse({ data, total: paid ? 1 : 51, page, limit: 25, totalPages: paid ? 1 : 3 });
      }
      if (path === "/api/processes") return jsonResponse([]);
      if (path === "/api/suppliers") return jsonResponse([]);
      throw new Error(`Requisição inesperada no teste: ${path}`);
    };

    try {
      await import(`${new URL("../public/app.js", import.meta.url).href}?process-pagination=${Date.now()}`);
      dom.window.document.querySelector('[data-section="processes"]').click();
      await waitFor(() => requests.length === 1);
      await waitFor(() => dom.window.document.querySelector("#processPaginationSummary").textContent.includes("Página 1 de 3"));

      assert.match(requests[0], /page=1/);
      assert.match(requests[0], /limit=25/);
      assert.match(dom.window.document.querySelector("#processPaginationSummary").textContent, /Página 1 de 3.*51 empenhos/);
      assert.equal(dom.window.document.querySelector("#processPreviousPage").disabled, true);

      dom.window.document.querySelector("#processNextPage").click();
      await waitFor(() => requests.length === 2);
      await waitFor(() => dom.window.document.querySelector("#processPaginationSummary").textContent.includes("Página 2 de 3"));
      assert.match(requests[1], /page=2/);

      const search = dom.window.document.querySelector("#searchInput");
      search.value = "material";
      search.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      await waitFor(() => requests.length === 3);
      await waitFor(() => dom.window.document.querySelector("#processPaginationSummary").textContent.includes("Página 1 de 3"));
      assert.match(requests[2], /page=1/);
      assert.match(requests[2], /q=material/);

      dom.window.document.querySelector("#processNextPage").click();
      await waitFor(() => requests.length === 4);
      await waitFor(() => dom.window.document.querySelector("#processPaginationSummary").textContent.includes("Página 2 de 3"));
      assert.match(requests[3], /page=2/);
      assert.match(requests[3], /q=material/);

      dom.window.document.querySelector('[data-filter="Pago"]').click();
      await waitFor(() => requests.length === 5);
      await waitFor(() => dom.window.document.querySelector("#processPaginationSummary").textContent.includes("Página 1 de 1"));
      assert.match(requests[4], /page=1/);
      assert.match(requests[4], /q=material/);
      assert.match(requests[4], /filtroRapido=Pago/);
      assert.match(dom.window.document.querySelector("#processPaginationSummary").textContent, /Página 1 de 1.*1 empenho/);
      assert.equal(dom.window.document.querySelector("#processNextPage").disabled, true);
    } finally {
      restoreGlobals();
      dom.window.close();
    }
  });

  it("mantém as cargas da lista e do quadro independentes e recarrega o quadro após uma mutação", async () => {
    const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
    const dom = new JSDOM(html, { url: "http://localhost/", pretendToBeVisual: true });
    installDialogPolyfill(dom.window);
    const restoreGlobals = installDomGlobals(dom.window);
    dom.window.sessionStorage.setItem("almoxActiveSection:admin@example.com", "processes");
    const statuses = ["Enviado para SALC", "Empenho enviado ao fornecedor"];
    const transitions = { "Enviado para SALC": "Empenho enviado ao fornecedor", "Empenho enviado ao fornecedor": "" };
    let processes = [processFixture()];
    let pageSignal;
    let resolveDeferredPage;
    let pageRequests = 0;
    let fullRequests = 0;

    globalThis.fetch = async (input, options = {}) => {
      const path = String(input);
      if (path === "/auth/session") return jsonResponse({ id: "admin-1", email: "admin@example.com", nome: "Admin", role: "admin" });
      if (path === "/api/meta") return jsonResponse({ status: statuses, filtrosRapidos: [], transicoes: transitions });
      if (path.startsWith("/api/dashboard")) return jsonResponse(dashboardPayload());
      if (path.startsWith("/api/processes?")) {
        pageRequests += 1;
        if (pageRequests === 2) {
          pageSignal = options.signal;
          return new Promise((resolve) => { resolveDeferredPage = resolve; });
        }
        return jsonResponse(pagePayload(processes));
      }
      if (path === "/api/processes") {
        fullRequests += 1;
        return jsonResponse(processes);
      }
      if (/\/api\/processes\/[^/]+\/(observations|audit)$/.test(path)) return jsonResponse([]);
      const updateMatch = path.match(/^\/api\/processes\/([^/]+)$/);
      if (updateMatch && options.method === "PUT") {
        const body = JSON.parse(options.body);
        const current = processes.find((process) => process.id === updateMatch[1]);
        const updated = { ...current, ...body, versao: current.versao + 1 };
        processes = processes.map((process) => process.id === updated.id ? updated : process);
        return jsonResponse(updated);
      }
      if (path === "/api/suppliers") return jsonResponse([]);
      throw new Error(`Requisição inesperada no teste: ${path}`);
    };

    try {
      await import(`${new URL("../public/app.js", import.meta.url).href}?process-load-separation=${Date.now()}`);
      await waitFor(() => dom.window.document.querySelector("#processPaginationSummary").textContent.includes("Página 1 de 2"));
      dom.window.document.querySelector("#processNextPage").click();
      await waitFor(() => pageSignal);

      dom.window.document.querySelector('[data-section="board"]').click();
      await waitFor(() => fullRequests === 1);
      assert.equal(pageSignal.aborted, false, "a carga completa não deve cancelar a paginação em curso");
      resolveDeferredPage(jsonResponse(pagePayload(processes)));
      await waitFor(() => dom.window.document.querySelector('[data-process-id="p1"]'));

      const move = dom.window.document.querySelector('[data-process-id="p1"] [data-board-move]');
      move.value = "Empenho enviado ao fornecedor";
      move.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      await waitFor(() => dom.window.document.querySelector("#processStepDialog").open);
      dom.window.document.querySelector('#processStepForm input[name="data"]').value = "01-09-2026";
      submit(dom.window, dom.window.document.querySelector("#processStepForm"));

      await waitFor(() => fullRequests === 2);
      await waitFor(() => dom.window.document.querySelector('[data-board-status="Empenho enviado ao fornecedor"] [data-process-id="p1"]'));

      dom.window.document.querySelector('[data-section="processes"]').click();
      await waitFor(() => dom.window.document.querySelector("#processPaginationSummary").textContent.includes("Página 1 de 2"));
      dom.window.document.querySelector('[data-section="board"]').click();
      await waitFor(() => dom.window.document.querySelector('[data-board-status="Empenho enviado ao fornecedor"] [data-process-id="p1"]'));
      assert.equal(pageSignal.aborted, false, "a mutação e o retorno ao quadro não devem invalidar a requisição paginada já concluída");
    } finally {
      restoreGlobals();
      dom.window.close();
    }
  });

  it("absorve o cancelamento de uma busca substituída sem rejeição não tratada", async () => {
    const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
    const dom = new JSDOM(html, { url: "http://localhost/", pretendToBeVisual: true });
    installDialogPolyfill(dom.window);
    const restoreGlobals = installDomGlobals(dom.window);
    dom.window.sessionStorage.setItem("almoxActiveSection:cancelamento@example.com", "processes");
    const unhandled = [];
    const captureUnhandled = (reason) => unhandled.push(reason);
    process.on("unhandledRejection", captureUnhandled);

    globalThis.fetch = (input, options = {}) => {
      const path = String(input);
      if (path === "/auth/session") return Promise.resolve(jsonResponse({ id: "cancelamento", email: "cancelamento@example.com", nome: "Cancelamento", role: "almoxarifado" }));
      if (path === "/api/meta") return Promise.resolve(jsonResponse({ status: [], filtrosRapidos: [] }));
      if (path.startsWith("/api/dashboard")) return Promise.resolve(jsonResponse(dashboardPayload()));
      if (path.startsWith("/api/processes?")) {
        const query = new URL(`http://localhost${path}`).searchParams.get("q");
        if (query === "primeira") {
          return new Promise((resolve, reject) => {
            options.signal.addEventListener("abort", () => reject(abortError()), { once: true });
          });
        }
        return Promise.resolve(jsonResponse(pagePayload([processFixture({ numeroProcesso: query === "segunda" ? "SEGUNDA" : "INICIAL" })])));
      }
      if (path === "/api/suppliers") return Promise.resolve(jsonResponse([]));
      throw new Error(`Requisição inesperada no teste: ${path}`);
    };

    try {
      await import(`${new URL("../public/app.js", import.meta.url).href}?process-pagination-cancel=${Date.now()}`);
      await waitFor(() => dom.window.document.querySelector("#processTable").textContent.includes("INICIAL"));

      const search = dom.window.document.querySelector("#searchInput");
      search.value = "primeira";
      search.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      await waitFor(() => dom.window.document.querySelector("#processPaginationSummary").textContent.includes("Atualizando"));

      search.value = "segunda";
      search.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      await waitFor(() => dom.window.document.querySelector("#processTable").textContent.includes("SEGUNDA"));
      await new Promise((resolve) => setTimeout(resolve, 25));

      assert.deepEqual(unhandled, []);
      assert.equal(dom.window.document.querySelector("#appStatus").classList.contains("hidden"), true);
    } finally {
      process.off("unhandledRejection", captureUnhandled);
      restoreGlobals();
      dom.window.close();
    }
  });

  it("mostra falha de paginação, permite tentar novamente e não mantém resultados antigos sob o filtro novo", async () => {
    const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
    const dom = new JSDOM(html, { url: "http://localhost/", pretendToBeVisual: true });
    installDialogPolyfill(dom.window);
    const restoreGlobals = installDomGlobals(dom.window);
    dom.window.sessionStorage.setItem("almoxActiveSection:falha@example.com", "processes");
    let paidRequests = 0;

    globalThis.fetch = async (input) => {
      const path = String(input);
      if (path === "/auth/session") return jsonResponse({ id: "falha", email: "falha@example.com", nome: "Falha", role: "almoxarifado" });
      if (path === "/api/meta") return jsonResponse({ status: ["Pago"], filtrosRapidos: [] });
      if (path.startsWith("/api/dashboard")) return jsonResponse(dashboardPayload());
      if (path.startsWith("/api/processes?")) {
        const status = new URL(`http://localhost${path}`).searchParams.get("status");
        if (status === "Pago") {
          paidRequests += 1;
          if (paidRequests === 1) return jsonResponse({ error: "Servidor indisponível para esta consulta." }, 503);
          return jsonResponse(pagePayload([processFixture({ numeroProcesso: "PAGO", status: "Pago" })]));
        }
        return jsonResponse(pagePayload([processFixture({ numeroProcesso: "ANTERIOR" })]));
      }
      if (path === "/api/suppliers") return jsonResponse([]);
      throw new Error(`Requisição inesperada no teste: ${path}`);
    };

    try {
      await import(`${new URL("../public/app.js", import.meta.url).href}?process-pagination-retry=${Date.now()}`);
      await waitFor(() => dom.window.document.querySelector("#processTable").textContent.includes("ANTERIOR"));

      const status = dom.window.document.querySelector("#statusFilter");
      status.value = "Pago";
      status.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      await waitFor(() => dom.window.document.querySelector("#appStatus").textContent.includes("Servidor indisponível"));

      assert.match(dom.window.document.querySelector("#processTable").textContent, /Nao foi possivel atualizar a lista de empenhos/);
      assert.doesNotMatch(dom.window.document.querySelector("#processTable").textContent, /ANTERIOR/);
      const retry = dom.window.document.querySelector("#appStatus button");
      assert.equal(retry.textContent, "Tentar novamente");
      retry.click();
      await waitFor(() => dom.window.document.querySelector("#processTable").textContent.includes("PAGO"));

      assert.equal(paidRequests, 2);
      assert.equal(dom.window.document.querySelector("#appStatus").classList.contains("hidden"), true);
    } finally {
      restoreGlobals();
      dom.window.close();
    }
  });

  it("apresenta uma falha de rede da paginação sem rejeição não tratada", async () => {
    const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
    const dom = new JSDOM(html, { url: "http://localhost/", pretendToBeVisual: true });
    installDialogPolyfill(dom.window);
    const restoreGlobals = installDomGlobals(dom.window);
    dom.window.sessionStorage.setItem("almoxActiveSection:rede@example.com", "processes");

    globalThis.fetch = async (input) => {
      const path = String(input);
      if (path === "/auth/session") return jsonResponse({ id: "rede", email: "rede@example.com", nome: "Rede", role: "almoxarifado" });
      if (path === "/api/meta") return jsonResponse({ status: ["Pago"], filtrosRapidos: [] });
      if (path.startsWith("/api/dashboard")) return jsonResponse(dashboardPayload());
      if (path.startsWith("/api/processes?")) {
        const status = new URL(`http://localhost${path}`).searchParams.get("status");
        if (status === "Pago") throw new Error("socket encerrado");
        return jsonResponse(pagePayload([processFixture({ numeroProcesso: "ANTERIOR" })]));
      }
      if (path === "/api/suppliers") return jsonResponse([]);
      throw new Error(`Requisição inesperada no teste: ${path}`);
    };

    try {
      await import(`${new URL("../public/app.js", import.meta.url).href}?process-pagination-network=${Date.now()}`);
      await waitFor(() => dom.window.document.querySelector("#processTable").textContent.includes("ANTERIOR"));

      const status = dom.window.document.querySelector("#statusFilter");
      status.value = "Pago";
      status.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      await waitFor(() => dom.window.document.querySelector("#appStatus").textContent.includes("Nao foi possivel conectar ao servidor"));

      assert.match(dom.window.document.querySelector("#processTable").textContent, /Nao foi possivel atualizar a lista de empenhos/);
      assert.doesNotMatch(dom.window.document.querySelector("#processTable").textContent, /ANTERIOR/);
      assert.equal(dom.window.document.querySelector("#appStatus button").textContent, "Tentar novamente");
    } finally {
      restoreGlobals();
      dom.window.close();
    }
  });

  it("ignora uma resposta antiga quando uma busca mais nova já foi concluída", async () => {
    const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
    const dom = new JSDOM(html, { url: "http://localhost/", pretendToBeVisual: true });
    installDialogPolyfill(dom.window);
    const restoreGlobals = installDomGlobals(dom.window);
    dom.window.sessionStorage.setItem("almoxActiveSection:sequencia@example.com", "processes");
    let resolveOldResponse;

    globalThis.fetch = (input) => {
      const path = String(input);
      if (path === "/auth/session") return Promise.resolve(jsonResponse({ id: "sequencia", email: "sequencia@example.com", nome: "Sequência", role: "almoxarifado" }));
      if (path === "/api/meta") return Promise.resolve(jsonResponse({ status: [], filtrosRapidos: [] }));
      if (path.startsWith("/api/dashboard")) return Promise.resolve(jsonResponse(dashboardPayload()));
      if (path.startsWith("/api/processes?")) {
        const query = new URL(`http://localhost${path}`).searchParams.get("q");
        if (query === "antiga") return new Promise((resolve) => { resolveOldResponse = resolve; });
        return Promise.resolve(jsonResponse(pagePayload([processFixture({ numeroProcesso: query === "nova" ? "NOVA" : "INICIAL" })])));
      }
      if (path === "/api/suppliers") return Promise.resolve(jsonResponse([]));
      throw new Error(`Requisição inesperada no teste: ${path}`);
    };

    try {
      await import(`${new URL("../public/app.js", import.meta.url).href}?process-pagination-sequence=${Date.now()}`);
      await waitFor(() => dom.window.document.querySelector("#processTable").textContent.includes("INICIAL"));

      const search = dom.window.document.querySelector("#searchInput");
      search.value = "antiga";
      search.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      await waitFor(() => resolveOldResponse);

      search.value = "nova";
      search.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      await waitFor(() => dom.window.document.querySelector("#processTable").textContent.includes("NOVA"));
      resolveOldResponse(jsonResponse(pagePayload([processFixture({ numeroProcesso: "ANTIGA" })])));
      await new Promise((resolve) => setTimeout(resolve, 25));

      assert.match(dom.window.document.querySelector("#processTable").textContent, /NOVA/);
      assert.doesNotMatch(dom.window.document.querySelector("#processTable").textContent, /ANTIGA/);
    } finally {
      restoreGlobals();
      dom.window.close();
    }
  });
});

function dashboardPayload() {
  return { ano: 2026, anos: [2026], metrics: {}, charts: { execucaoMensal: [], distribuicaoStatus: [] } };
}

function processFixture(overrides = {}) {
  return {
    id: "p1",
    numeroProcesso: "PROC-1",
    numeroEmpenho: "2026NE000001",
    fornecedor: "Fornecedor",
    criadoPor: "Responsável",
    criadoPorEmail: "responsavel@example.com",
    status: "Enviado para SALC",
    materiais: [],
    documentos: {},
    entregas: [],
    versao: 1,
    ...overrides
  };
}

function pagePayload(processes) {
  return { data: processes, total: 2, page: 1, limit: 25, totalPages: 2 };
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function abortError() {
  const error = new Error("A requisição foi cancelada.");
  error.name = "AbortError";
  return error;
}

function installDialogPolyfill(window) {
  for (const dialog of window.document.querySelectorAll("dialog")) {
    dialog.showModal = function showModal() { this.open = true; };
    dialog.close = function close() { this.open = false; this.dispatchEvent(new window.Event("close")); };
  }
}

function installDomGlobals(window) {
  const values = { window, document: window.document, FormData: window.FormData, localStorage: window.localStorage, location: window.location, alert: () => {}, confirm: () => true };
  const previous = new Map();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, Object.hasOwn(globalThis, key) ? globalThis[key] : undefined);
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

function submit(window, form) {
  form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
}

async function waitFor(predicate, timeoutMs = 1_500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("A interface não completou a paginação no prazo.");
}
