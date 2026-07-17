import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

describe("Painel no DOM", () => {
  it("troca o ano, repete a requisicao com erro e apresenta estados vazios acessiveis", async () => {
    const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
    const dom = new JSDOM(html, { url: "http://localhost/", pretendToBeVisual: true });
    const restoreGlobals = installDomGlobals(dom.window);
    let year2041Attempts = 0;

    globalThis.fetch = async (input) => {
      const path = String(input);
      if (path === "/auth/session") return jsonResponse({ email: "teste@example.com", nome: "Teste", role: "almoxarifado" });
      if (path === "/api/meta") return jsonResponse({ status: [], filtrosRapidos: [] });
      if (path === "/api/dashboard") return jsonResponse(dashboardPayload(2040, { populated: true }));
      if (path === "/api/dashboard?ano=2041") {
        year2041Attempts += 1;
        if (year2041Attempts === 1) return jsonResponse({ error: "Falha temporaria do painel." }, 503);
        return jsonResponse(dashboardPayload(2041));
      }
      throw new Error(`Requisicao inesperada no teste: ${path}`);
    };

    try {
      await import(`${new URL("../public/app.js", import.meta.url).href}?dashboard-test=${Date.now()}`);

      const dashboard = dom.window.document.querySelector("#dashboardView");
      assert.equal(dashboard.querySelector("#dashboardYearSelect").value, "2040");
      assert.deepEqual([...dashboard.querySelectorAll(".metric strong")].map((item) => item.textContent.trim()), ["2", "1", "1", "0"]);
      assert.equal(dashboard.querySelector(".external-pie"), null);
      assert.match(dashboard.textContent, /Aguardando entrega/);
      assert.match(dashboard.textContent, /Anulado/);

      const monthlyBar = dashboard.querySelector("button.group-bar");
      assert.ok(monthlyBar);
      assert.match(monthlyBar.getAttribute("aria-label"), /Empenhado: R\$/);
      monthlyBar.focus();
      assert.equal(dom.window.document.activeElement, monthlyBar);
      const monthlyTable = dashboard.querySelector(".chart-data-details");
      assert.ok(monthlyTable);
      monthlyTable.open = true;
      assert.equal(monthlyTable.querySelectorAll("tbody tr").length, 12);

      const yearSelect = dashboard.querySelector("#dashboardYearSelect");
      yearSelect.value = "2041";
      yearSelect.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      await waitFor(() => dashboard.querySelector(".section-error"));

      assert.equal(year2041Attempts, 1);
      assert.match(dashboard.textContent, /Falha temporaria do painel/);
      dashboard.querySelector(".section-error button").click();
      await waitFor(() => dashboard.querySelector("#dashboardYearSelect")?.value === "2041");

      assert.equal(year2041Attempts, 2);
      assert.equal(dom.window.document.activeElement, dashboard.querySelector("#dashboardYearSelect"));
      assert.equal(dashboard.querySelectorAll(".chart-empty-state").length, 3);
      assert.match(dashboard.textContent, /Nenhuma movimentacao financeira registrada neste ano/);
      assert.equal(dashboard.querySelector(".bar-fill"), null);
    } finally {
      restoreGlobals();
      dom.window.close();
    }
  });
});

function dashboardPayload(year, { populated = false } = {}) {
  const emptyMonths = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"]
    .map((mes) => ({ mes, empenhado: 0, liquidado: 0, pago: 0 }));
  if (populated) {
    emptyMonths[0].empenhado = 120;
    emptyMonths[1].liquidado = 80;
  }
  return {
    ano: year,
    anos: [2041, 2040],
    metrics: populated
      ? { processosAtivos: 2, atrasados: 1, aguardandoEntrega: 1, pendentesLiquidacao: 0, valorEmpenhado: 120, valorLiquidado: 80, valorPago: 0 }
      : { processosAtivos: 0, atrasados: 0, aguardandoEntrega: 0, pendentesLiquidacao: 0, valorEmpenhado: 0, valorLiquidado: 0, valorPago: 0 },
    charts: {
      execucaoMensal: emptyMonths,
      distribuicaoStatus: populated
        ? [{ status: "Aguardando entrega", quantidade: 1 }, { status: "Anulado", quantidade: 1 }]
        : []
    }
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
  assert.fail("A interface nao atingiu o estado esperado dentro do prazo.");
}

function installDomGlobals(window) {
  const values = {
    window,
    document: window.document,
    localStorage: window.localStorage,
    location: window.location,
    alert: () => {}
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
