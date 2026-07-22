import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

describe("Navegacao principal no DOM", () => {
  it("restaura a secao do usuario ao recarregar e salva a proxima navegacao", async () => {
    const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
    const dom = new JSDOM(html, { url: "http://localhost/", pretendToBeVisual: true });
    const restoreGlobals = installDomGlobals(dom.window);
    const storageKey = "almoxActiveSection:teste@example.com";
    dom.window.sessionStorage.setItem(storageKey, "suppliers");

    globalThis.fetch = async (input) => {
      const path = String(input);
      if (path === "/auth/session") return jsonResponse({ email: "teste@example.com", nome: "Teste", role: "almoxarifado" });
      if (path === "/api/meta") return jsonResponse({ status: [], filtrosRapidos: [] });
      if (path === "/api/dashboard") return jsonResponse(dashboardPayload());
      if (path === "/api/suppliers" || path === "/api/processes") return jsonResponse([]);
      throw new Error(`Requisicao inesperada no teste: ${path}`);
    };

    try {
      await import(`${new URL("../public/app.js", import.meta.url).href}?navigation-test=${Date.now()}`);
      await waitFor(() => dom.window.document.querySelector('[data-section="suppliers"]')?.getAttribute("aria-current") === "page");

      assert.equal(dom.window.document.querySelector("#sectionTitle").textContent, "Fornecedores");
      assert.equal(dom.window.document.querySelector("#suppliersView").classList.contains("hidden"), false);
      assert.equal(dom.window.sessionStorage.getItem(storageKey), "suppliers");

      dom.window.document.querySelector('[data-section="processes"]').click();
      await waitFor(() => dom.window.document.querySelector('[data-section="processes"]')?.getAttribute("aria-current") === "page");

      assert.equal(dom.window.document.querySelector("#sectionTitle").textContent, "Empenhos");
      assert.equal(dom.window.sessionStorage.getItem(storageKey), "processes");
    } finally {
      restoreGlobals();
      dom.window.close();
    }
  });
});

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
  assert.fail("A interface nao restaurou a secao esperada dentro do prazo.");
}

function installDomGlobals(window) {
  const values = {
    window,
    document: window.document,
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
