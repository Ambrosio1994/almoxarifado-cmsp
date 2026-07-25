import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

describe("Navegacao principal no DOM", () => {
  it("restaura a secao do usuario ao recarregar e salva a proxima navegacao", async () => {
    const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
    const dom = new JSDOM(html, { url: "http://localhost/", pretendToBeVisual: true });
    installDialogPolyfill(dom.window);
    const restoreGlobals = installDomGlobals(dom.window);
    const storageKey = "almoxActiveSection:teste@example.com";
    dom.window.sessionStorage.setItem(storageKey, "suppliers");
    let finishLogout;

    globalThis.fetch = async (input) => {
      const path = String(input);
      if (path === "/auth/session") return jsonResponse({ email: "teste@example.com", nome: "Teste", role: "almoxarifado" });
      if (path === "/api/meta") return jsonResponse({ status: [], filtrosRapidos: [] });
      if (path === "/api/dashboard") return jsonResponse(dashboardPayload());
      if (path === "/api/suppliers" || path === "/api/processes") return jsonResponse([]);
      if (path === "/auth/logout") return new Promise((resolve) => { finishLogout = () => resolve(jsonResponse({ ok: true })); });
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
      assert.equal(dom.window.document.querySelector("#themeToggle").parentElement.id, "processThemeSlot");
      assert.equal(dom.window.document.querySelector("#refreshProcessesButton"), null);
      assert.equal(dom.window.document.querySelector("#processExportFormat").type, "hidden");

      const settingsNavigation = dom.window.document.querySelector('[data-section="settings"]');
      assert.equal(settingsNavigation.classList.contains("hidden"), false);
      settingsNavigation.click();
      await waitFor(() => settingsNavigation.getAttribute("aria-current") === "page");

      assert.equal(dom.window.document.querySelector("#sectionTitle").textContent, "Configurações");
      assert.ok(dom.window.document.querySelector(".topbar").contains(dom.window.document.querySelector("#themeToggle")));
      assert.equal(dom.window.document.querySelector("#settingsAccountTitle").textContent, "Configurações");
      assert.equal(dom.window.document.querySelector('#settingsAccountForm input[type="text"]').value, "Teste");
      assert.equal(dom.window.document.querySelector(".settings-admin-section"), null);
      dom.window.document.querySelector("#settingsProfileImageButton").click();
      const profileImageDialog = dom.window.document.querySelector("#profileImageDialog");
      assert.equal(profileImageDialog.open, true);
      assert.equal(profileImageDialog.children.length, 1);
      assert.equal(profileImageDialog.firstElementChild.tagName, "IMG");
      profileImageDialog.click();
      assert.equal(profileImageDialog.open, false);
      const settingsThemeToggle = dom.window.document.querySelector("#settingsThemeToggle");
      settingsThemeToggle.checked = false;
      dom.window.document.querySelector("#settingsAccountForm").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
      assert.equal(dom.window.localStorage.getItem("almoxTheme"), "light");
      assert.equal(dom.window.document.documentElement.dataset.theme, "light");
      assert.equal(dom.window.document.querySelector("#themeToggle").getAttribute("aria-label"), "Alternar para modo escuro");
      assert.match(dom.window.document.querySelector("#settingsAccountMessage").textContent, /sucesso/);

      const logoutButton = dom.window.document.querySelector("#logoutButton");
      logoutButton.click();
      await waitFor(() => logoutButton.textContent === "Saindo...");
      assert.equal(dom.window.document.querySelector("#appShell").classList.contains("hidden"), false);
      assert.equal(dom.window.document.querySelector("#authScreen").classList.contains("hidden"), true);

      finishLogout();
      await waitFor(() => !dom.window.document.querySelector("#authScreen").classList.contains("hidden"));
      assert.equal(dom.window.document.querySelector("#authMessage").textContent, "");
      assert.equal(logoutButton.textContent, "Sair");
    } finally {
      restoreGlobals();
      dom.window.close();
    }
  });

  it("preserva templates e prazos dentro das configuracoes administrativas", async () => {
    const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
    const dom = new JSDOM(html, { url: "http://localhost/", pretendToBeVisual: true });
    installDialogPolyfill(dom.window);
    const restoreGlobals = installDomGlobals(dom.window);
    dom.window.sessionStorage.setItem("almoxActiveSection:admin@example.com", "settings");

    globalThis.fetch = async (input) => {
      const path = String(input);
      if (path === "/auth/session") return jsonResponse({ email: "admin@example.com", nome: "Admin", role: "admin" });
      if (path === "/api/meta") return jsonResponse({ status: [], filtrosRapidos: [] });
      if (path === "/api/dashboard") return jsonResponse(dashboardPayload());
      if (path === "/api/settings") {
        return jsonResponse({
          emailTemplates: {
            avisoPrazos: { assunto: "Aviso", corpo: "Corpo", anexos: [] },
            oficioFornecedor: { assunto: "Ofício", corpo: "Corpo", anexos: [] }
          },
          notificationRules: { diasAvisoInterno: [7, 14], diaOficioFornecedor: 30 },
          responsaveis: [],
          status: [],
          filtrosRapidos: [],
          usuarios: []
        });
      }
      throw new Error(`Requisicao inesperada no teste: ${path}`);
    };

    try {
      await import(`${new URL("../public/app.js", import.meta.url).href}?settings-admin-test=${Date.now()}`);
      await waitFor(() => dom.window.document.querySelector('[data-section="settings"]')?.getAttribute("aria-current") === "page");
      await waitFor(() => Boolean(dom.window.document.querySelector(".settings-admin-section")));

      assert.equal(dom.window.document.querySelector(".settings-admin-section").open, true);
      assert.match(dom.window.document.querySelector(".settings-admin-section").textContent, /Templates de e-mail/);
      assert.match(dom.window.document.querySelector(".settings-admin-section").textContent, /Prazos para notificacoes/);
      assert.ok(dom.window.document.querySelector("#emailTemplatesForm"));
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
