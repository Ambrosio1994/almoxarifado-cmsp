import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

const STATUSES = [
  "Criado",
  "Enviado para SALC",
  "Empenho enviado ao fornecedor",
  "Entrega parcial",
  "Entregue",
  "Enviado para liquidacao",
  "Liquidado",
  "Pago",
  "Anulado"
];

const TRANSITIONS = {
  Criado: "Enviado para SALC",
  "Enviado para SALC": "Empenho enviado ao fornecedor",
  "Empenho enviado ao fornecedor": "Entrega parcial",
  "Aguardando entrega": "Entrega parcial",
  "Entrega parcial": "Entregue",
  Entregue: "Enviado para liquidacao",
  "Enviado para liquidacao": "Liquidado",
  Liquidado: "Pago",
  Pago: "",
  Anulado: ""
};

describe("Quadro kanban no DOM", () => {
  it("renderiza, filtra, abre detalhes e executa somente transicoes validas com reversao e confirmacao dupla", async () => {
    const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
    const dom = new JSDOM(html, { url: "http://localhost/", pretendToBeVisual: true });
    installDialogPolyfill(dom.window);
    const confirmAnswers = [];
    const confirmMessages = [];
    const restoreGlobals = installDomGlobals(dom.window, (message) => {
      confirmMessages.push(message);
      return confirmAnswers.length ? confirmAnswers.shift() : true;
    });
    dom.window.sessionStorage.setItem("almoxActiveSection:admin@example.com", "board");
    let processes = processFixtures();
    const putRequests = [];
    let resolveFailedUpdate;

    globalThis.fetch = async (input, options = {}) => {
      const path = String(input);
      if (path === "/auth/session") return jsonResponse({ id: "admin-1", email: "admin@example.com", nome: "Admin", role: "admin" });
      if (path === "/api/meta") return jsonResponse({ status: STATUSES, filtrosRapidos: [], transicoes: TRANSITIONS });
      if (path.startsWith("/api/dashboard")) return jsonResponse(dashboardPayload());
      if (path === "/api/processes" && !options.method) return jsonResponse(processes);
      if (path === "/api/suppliers") return jsonResponse([]);
      if (/\/api\/processes\/[^/]+\/(observations|audit)$/.test(path)) return jsonResponse([]);
      const updateMatch = path.match(/^\/api\/processes\/([^/]+)$/);
      if (updateMatch && options.method === "PUT") {
        const body = JSON.parse(options.body);
        putRequests.push({ id: updateMatch[1], body });
        if (updateMatch[1] === "p5") {
          return new Promise((resolve) => {
            resolveFailedUpdate = () => resolve(jsonResponse({ error: "O processo foi alterado por outro usuário." }, 409));
          });
        }
        const current = processes.find((process) => process.id === updateMatch[1]);
        const updated = { ...current, ...body, versao: current.versao + 1 };
        processes = processes.map((process) => process.id === updated.id ? updated : process);
        return jsonResponse(updated);
      }
      throw new Error(`Requisição inesperada no teste: ${path}`);
    };

    try {
      await import(`${new URL("../public/app.js", import.meta.url).href}?board-test=${Date.now()}`);
      await waitFor(() => !dom.window.document.querySelector("#boardView").classList.contains("hidden"));
      await waitFor(() => dom.window.document.querySelectorAll(".kanban-card").length === processes.length);

      const board = dom.window.document.querySelector("#kanbanBoard");
      assert.equal(dom.window.document.querySelector('[data-section="board"]').getAttribute("aria-current"), "page");
      assert.equal(dom.window.document.querySelector("#sectionTitle").textContent, "Quadro de processos");
      assert.equal(board.querySelectorAll(".kanban-column").length, STATUSES.length);
      assert.ok([...dom.window.document.querySelector("#boardResponsibleFilter").options].some((option) => option.value === "Carla"));
      assert.ok([...dom.window.document.querySelector("#boardSupplierFilter").options].some((option) => option.value === "Beta"));
      assert.match(columnFor(board, "Entregue").textContent, /Nenhum processo neste status/);
      const supplierColumn = columnFor(board, "Empenho enviado ao fornecedor");
      assert.equal(supplierColumn.querySelector(".kanban-column-header > strong").textContent, "1");
      assert.match(supplierColumn.querySelector(".kanban-column-header span").textContent, /200,00/);
      assert.doesNotMatch(board.textContent, /undefined|null|NaN/);

      const hideEmpty = dom.window.document.querySelector("#boardHideEmptyColumns");
      hideEmpty.checked = true;
      hideEmpty.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      assert.equal(board.querySelectorAll(".kanban-column").length, 5);
      assert.equal(JSON.parse(dom.window.localStorage.getItem("almoxBoardPreferences:admin-1")).hideEmptyColumns, true);
      hideEmpty.checked = false;
      hideEmpty.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      assert.equal(board.querySelectorAll(".kanban-column").length, STATUSES.length);

      const firstCard = board.querySelector('[data-process-id="p1"]');
      assert.equal(firstCard.getAttribute("role"), "button");
      assert.equal(firstCard.getAttribute("tabindex"), "0");
      assert.equal(firstCard.draggable, true);
      assert.deepEqual([...firstCard.querySelectorAll("[data-board-move] option")].slice(1).map((item) => item.value), ["Enviado para SALC"]);

      firstCard.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await waitFor(() => !dom.window.document.querySelector("#processDetailView").classList.contains("hidden"));
      dom.window.document.querySelector("#backToProcesses").click();
      await waitFor(() => !dom.window.document.querySelector("#boardView").classList.contains("hidden"));
      assert.equal(dom.window.document.querySelector("#sectionTitle").textContent, "Quadro de processos");

      const search = dom.window.document.querySelector("#boardSearchInput");
      search.value = "Beta";
      search.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      await waitFor(() => board.querySelectorAll(".kanban-card").length === 1);
      assert.ok(board.querySelector('[data-process-id="p2"]'));
      dom.window.document.querySelector("#clearBoardFilters").click();
      await waitFor(() => board.querySelectorAll(".kanban-card").length === processes.length);

      const responsible = dom.window.document.querySelector("#boardResponsibleFilter");
      responsible.value = "Carla";
      responsible.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      assert.deepEqual([...board.querySelectorAll(".kanban-card")].map((item) => item.dataset.processId), ["p4"]);
      dom.window.document.querySelector("#clearBoardFilters").click();
      const deadline = dom.window.document.querySelector("#boardDeadlineFilter");
      deadline.value = "overdue";
      deadline.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      assert.deepEqual([...board.querySelectorAll(".kanban-card")].map((item) => item.dataset.processId), ["p2"]);
      dom.window.document.querySelector("#clearBoardFilters").click();

      const requestCountBeforeInvalid = putRequests.length;
      const draggable = board.querySelector('[data-process-id="p1"]');
      const transfer = dataTransfer();
      draggable.dispatchEvent(dragEvent(dom.window, "dragstart", transfer));
      columnFor(board, "Pago").dispatchEvent(dragEvent(dom.window, "drop", transfer));
      await waitFor(() => dom.window.document.querySelector("#boardMessage").textContent.includes("Não é possível mover"));
      assert.equal(putRequests.length, requestCountBeforeInvalid);

      const p1Move = board.querySelector('[data-process-id="p1"] [data-board-move]');
      p1Move.value = "Enviado para SALC";
      p1Move.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      await waitFor(() => dom.window.document.querySelector("#processStepDialog").open);
      assert.equal(dom.window.document.querySelector("#processStepDateLabel").textContent, "Data do envio para SALC");
      assert.equal(putRequests.length, requestCountBeforeInvalid);
      dom.window.document.querySelector("#cancelProcessStep").click();
      await waitFor(() => !dom.window.document.querySelector("#processStepDialog").open);

      const p2Move = board.querySelector('[data-process-id="p2"] [data-board-move]');
      p2Move.value = "Entrega parcial";
      p2Move.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      await waitFor(() => dom.window.document.querySelector("#deliveryDialog").open);
      assert.equal(putRequests.length, requestCountBeforeInvalid);
      dom.window.document.querySelector("#cancelDelivery").click();
      await waitFor(() => !dom.window.document.querySelector("#deliveryDialog").open);

      const p4Card = board.querySelector('[data-process-id="p4"]');
      const p4Transfer = dataTransfer();
      p4Card.dispatchEvent(dragEvent(dom.window, "dragstart", p4Transfer));
      const supplierTargetColumn = columnFor(board, "Empenho enviado ao fornecedor");
      supplierTargetColumn.dispatchEvent(dragEvent(dom.window, "dragover", p4Transfer));
      assert.equal(supplierTargetColumn.classList.contains("is-drag-over"), true);
      supplierTargetColumn.dispatchEvent(dragEvent(dom.window, "drop", p4Transfer));
      await waitFor(() => dom.window.document.querySelector("#processStepDialog").open);
      dom.window.document.querySelector('#processStepForm input[name="data"]').value = "01-06-2026";
      submit(dom.window, dom.window.document.querySelector("#processStepForm"));
      await waitFor(() => columnFor(board, "Empenho enviado ao fornecedor").querySelector('[data-process-id="p4"]'));
      assert.equal(putRequests.filter((request) => request.id === "p4").length, 1);

      const p5Move = board.querySelector('[data-process-id="p5"] [data-board-move]');
      p5Move.value = "Empenho enviado ao fornecedor";
      p5Move.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      await waitFor(() => dom.window.document.querySelector("#processStepDialog").open);
      dom.window.document.querySelector('#processStepForm input[name="data"]').value = "01-06-2026";
      submit(dom.window, dom.window.document.querySelector("#processStepForm"));
      await waitFor(() => board.querySelector('[data-process-id="p5"]')?.getAttribute("aria-busy") === "true");
      assert.equal(board.querySelector('[data-process-id="p5"] [data-board-move]'), null);
      assert.equal(putRequests.filter((request) => request.id === "p5").length, 1);
      resolveFailedUpdate();
      await waitFor(() => dom.window.document.querySelector("#processStepMessage").textContent.includes("alterado por outro usuário"));
      dom.window.document.querySelector("#cancelProcessStep").click();
      await waitFor(() => !dom.window.document.querySelector("#processStepDialog").open);
      assert.ok(columnFor(board, "Enviado para SALC").querySelector('[data-process-id="p5"]'));

      const paidMove = board.querySelector('[data-process-id="p6"] [data-board-move]');
      paidMove.value = "Pago";
      paidMove.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      await waitFor(() => dom.window.document.querySelector("#processStepDialog").open);
      const paymentDate = dom.window.document.querySelector('#processStepForm input[name="data"]');
      paymentDate.value = "01-07-2026";

      confirmAnswers.push(false);
      submit(dom.window, dom.window.document.querySelector("#processStepForm"));
      await waitFor(() => dom.window.document.querySelector("#processStepMessage").textContent.includes("não foi confirmado"));
      assert.equal(putRequests.filter((request) => request.id === "p6").length, 0);

      confirmAnswers.push(true, false);
      submit(dom.window, dom.window.document.querySelector("#processStepForm"));
      await waitFor(() => dom.window.document.querySelector("#processStepMessage").textContent.includes("adicional"));
      assert.equal(putRequests.filter((request) => request.id === "p6").length, 0);

      confirmAnswers.push(true, true);
      submit(dom.window, dom.window.document.querySelector("#processStepForm"));
      await waitFor(() => columnFor(board, "Pago").querySelector('[data-process-id="p6"]'));
      assert.equal(putRequests.filter((request) => request.id === "p6").length, 1);
      assert.equal(confirmMessages.filter((message) => /realmente alterar/.test(message)).length, 3);
      assert.equal(confirmMessages.filter((message) => /confirmação adicional/.test(message)).length, 2);
      assert.equal(columnFor(board, "Pago").querySelector('[data-process-id="p6"]').draggable, false);
    } finally {
      restoreGlobals();
      dom.window.close();
    }
  });

  it("mantem o quadro somente leitura para auditor", async () => {
    const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
    const dom = new JSDOM(html, { url: "http://localhost/", pretendToBeVisual: true });
    installDialogPolyfill(dom.window);
    const restoreGlobals = installDomGlobals(dom.window, () => true);
    dom.window.sessionStorage.setItem("almoxActiveSection:auditor@example.com", "board");
    globalThis.fetch = async (input) => {
      const path = String(input);
      if (path === "/auth/session") return jsonResponse({ id: "auditor-1", email: "auditor@example.com", nome: "Auditor", role: "auditor" });
      if (path === "/api/meta") return jsonResponse({ status: STATUSES, filtrosRapidos: [], transicoes: TRANSITIONS });
      if (path.startsWith("/api/dashboard")) return jsonResponse(dashboardPayload());
      if (path === "/api/processes") return jsonResponse([processFixtures()[0]]);
      throw new Error(`Requisição inesperada no teste: ${path}`);
    };
    try {
      await import(`${new URL("../public/app.js", import.meta.url).href}?board-auditor-test=${Date.now()}`);
      await waitFor(() => dom.window.document.querySelector(".kanban-card"));
      const card = dom.window.document.querySelector(".kanban-card");
      assert.equal(card.draggable, false);
      assert.equal(card.querySelector("[data-board-move]"), null);
      card.click();
      await waitFor(() => !dom.window.document.querySelector("#processDetailView").classList.contains("hidden"));
    } finally {
      restoreGlobals();
      dom.window.close();
    }
  });

  it("mantem os controles do quadro e permite tentar novamente apos falha de carga", async () => {
    const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
    const dom = new JSDOM(html, { url: "http://localhost/", pretendToBeVisual: true });
    installDialogPolyfill(dom.window);
    const restoreGlobals = installDomGlobals(dom.window, () => true);
    dom.window.sessionStorage.setItem("almoxActiveSection:admin@example.com", "board");
    let processRequests = 0;
    globalThis.fetch = async (input) => {
      const path = String(input);
      if (path === "/auth/session") return jsonResponse({ id: "admin-1", email: "admin@example.com", nome: "Admin", role: "admin" });
      if (path === "/api/meta") return jsonResponse({ status: STATUSES, filtrosRapidos: [], transicoes: TRANSITIONS });
      if (path.startsWith("/api/dashboard")) return jsonResponse(dashboardPayload());
      if (path === "/api/processes") {
        processRequests += 1;
        return processRequests === 1
          ? jsonResponse({ error: "Falha de conexão ao carregar processos." }, 503)
          : jsonResponse([processFixtures()[0]]);
      }
      throw new Error(`Requisição inesperada no teste: ${path}`);
    };
    try {
      await import(`${new URL("../public/app.js", import.meta.url).href}?board-retry-test=${Date.now()}`);
      await waitFor(() => dom.window.document.querySelector("#kanbanBoard .section-error button"));
      assert.ok(dom.window.document.querySelector("#boardSearchInput"));
      assert.match(dom.window.document.querySelector("#boardMessage").textContent, /Falha de conexão/);
      dom.window.document.querySelector("#kanbanBoard .section-error button").click();
      await waitFor(() => dom.window.document.querySelector('[data-process-id="p1"]'));
      assert.equal(processRequests, 2);
    } finally {
      restoreGlobals();
      dom.window.close();
    }
  });
});

function processFixtures() {
  return [
    processFixture({ id: "p1", numeroProcesso: "PROC-1", status: "Criado", fornecedor: "Alpha", criadoPor: "Ana", valorTotal: 100, dataEnvioSalc: "", dataEnvioFornecedor: "", dataReferenciaPrazo: "", diasDecorridos: 0 }),
    processFixture({ id: "p2", numeroProcesso: "PROC-2", status: "Empenho enviado ao fornecedor", fornecedor: "Beta", criadoPor: "Bruno", valorTotal: 200, diasDecorridos: 31 }),
    processFixture({ id: "p3", numeroProcesso: "PROC-3", status: "Pago", fornecedor: "Gamma", criadoPor: "Ana", valorTotal: 300, dataEntrega: "2026-06-10", dataEnvioLiquidacao: "2026-06-20", dataLiquidacao: "2026-06-25", dataPagamento: "2026-06-30" }),
    processFixture({ id: "p4", numeroProcesso: "PROC-4", status: "Enviado para SALC", fornecedor: "Delta", criadoPor: "Carla", valorTotal: 150 }),
    processFixture({ id: "p5", numeroProcesso: "PROC-5", status: "Enviado para SALC", fornecedor: "Epsilon", criadoPor: "Diego", valorTotal: 250 }),
    processFixture({ id: "p6", numeroProcesso: "PROC-6", status: "Liquidado", fornecedor: "Zeta", criadoPor: "Eva", valorTotal: 500, dataEntrega: "2026-06-10", dataEnvioLiquidacao: "2026-06-20", dataLiquidacao: "2026-06-30" })
  ];
}

function processFixture(overrides = {}) {
  return {
    id: "process",
    numeroProcesso: "PROC",
    numeroEmpenho: "2026NE000001",
    fornecedor: "Fornecedor",
    criadoPor: "Responsável",
    criadoPorEmail: "responsavel@example.com",
    status: "Enviado para SALC",
    materiais: [{ id: "m1", descricao: "Material", valorUnitario: 10, quantidade: 1 }],
    documentos: { processoSped: { path: "/uploads/processo.pdf" } },
    entregas: [],
    dataProcesso: "2026-05-20",
    dataEnvioFornecedor: "2026-06-01",
    dataReferenciaPrazo: "2026-06-01",
    dataEntrega: "",
    dataEnvioLiquidacao: "",
    dataLiquidacao: "",
    dataPagamento: "",
    diasDecorridos: 10,
    valorTotal: 10,
    versao: 1,
    inativo: false,
    ...overrides
  };
}

function columnFor(board, status) {
  return board.querySelector(`[data-board-status="${status}"]`);
}

function dashboardPayload() {
  return { ano: 2026, anos: [2026], metrics: {}, charts: { execucaoMensal: [], distribuicaoStatus: [] } };
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function dataTransfer() {
  const values = new Map();
  return {
    effectAllowed: "none",
    dropEffect: "none",
    setData: (type, value) => values.set(type, value),
    getData: (type) => values.get(type) || ""
  };
}

function dragEvent(window, type, transfer) {
  const event = new window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: transfer });
  return event;
}

function submit(window, form) {
  form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
}

async function waitFor(predicate, timeoutMs = 2_500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("A interface do quadro não atingiu o estado esperado dentro do prazo.");
}

function installDialogPolyfill(window) {
  window.HTMLDialogElement.prototype.showModal = function showModal() { this.setAttribute("open", ""); };
  window.HTMLDialogElement.prototype.close = function close() {
    if (!this.hasAttribute("open")) return;
    this.removeAttribute("open");
    this.dispatchEvent(new window.Event("close"));
  };
}

function installDomGlobals(window, confirm) {
  const values = {
    window,
    document: window.document,
    localStorage: window.localStorage,
    location: window.location,
    File: window.File,
    FileReader: window.FileReader,
    alert: () => {},
    confirm
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
