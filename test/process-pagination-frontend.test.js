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
});

function dashboardPayload() {
  return { ano: 2026, anos: [2026], metrics: {}, charts: { execucaoMensal: [], distribuicaoStatus: [] } };
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
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

async function waitFor(predicate, timeoutMs = 1_500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("A interface não completou a paginação no prazo.");
}
