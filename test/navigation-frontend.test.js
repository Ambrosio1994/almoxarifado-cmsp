import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

describe("Navegacao principal no DOM", () => {
  it("restaura a secao do usuario ao recarregar e salva a proxima navegacao", async () => {
    const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
    const [baseStyles, figmaTheme] = await Promise.all([
      readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
      readFile(new URL("../public/figma-theme.css", import.meta.url), "utf8")
    ]);
    const dom = new JSDOM(html, { url: "http://localhost/", pretendToBeVisual: true });
    const style = dom.window.document.createElement("style");
    style.textContent = `${baseStyles}\n${figmaTheme}`;
    dom.window.document.head.append(style);
    installDialogPolyfill(dom.window);
    const restoreGlobals = installDomGlobals(dom.window);
    const storageKey = "almoxActiveSection:teste@example.com";
    dom.window.sessionStorage.setItem(storageKey, "suppliers");
    let finishLogout;
    let profileNameRequest = null;
    let processDownloadPath = "";

    globalThis.fetch = async (input, options = {}) => {
      const path = String(input);
      if (path === "/auth/session") return jsonResponse({ email: "teste@example.com", nome: "Teste", role: "almoxarifado" });
      if (path === "/api/meta") return jsonResponse({ status: [], filtrosRapidos: ["Liquidado", "Pago"] });
      if (path === "/api/dashboard") return jsonResponse(dashboardPayload());
      if (path === "/api/suppliers" || path === "/api/processes") return jsonResponse([]);
      if (path.startsWith("/api/processes/download?")) {
        processDownloadPath = path;
        return new Response("arquivo", { status: 200, headers: { "content-type": "text/csv" } });
      }
      if (path === "/auth/profile") {
        profileNameRequest = JSON.parse(options.body);
        return jsonResponse({ user: { email: "teste@example.com", nome: profileNameRequest.nome, role: "almoxarifado" } });
      }
      if (path === "/auth/logout") return new Promise((resolve) => { finishLogout = () => resolve(jsonResponse({ ok: true })); });
      throw new Error(`Requisicao inesperada no teste: ${path}`);
    };

    try {
      await import(`${new URL("../public/app.js", import.meta.url).href}?navigation-test=${Date.now()}`);
      await waitFor(() => dom.window.document.querySelector('[data-section="suppliers"]')?.getAttribute("aria-current") === "page");

      assert.equal(dom.window.document.querySelector("#sectionTitle").textContent, "Fornecedores");
      assert.equal(dom.window.document.querySelector("#suppliersView").classList.contains("hidden"), false);
      assert.equal(dom.window.sessionStorage.getItem(storageKey), "suppliers");
      assert.equal(dom.window.location.pathname, "/fornecedores");

      dom.window.document.querySelector('[data-section="processes"]').click();
      await waitFor(() => dom.window.document.querySelector('[data-section="processes"]')?.getAttribute("aria-current") === "page");

      assert.equal(dom.window.document.querySelector("#sectionTitle").textContent, "Empenhos");
      assert.equal(dom.window.sessionStorage.getItem(storageKey), "processes");
      assert.equal(dom.window.location.pathname, "/empenhos");
      assert.ok(dom.window.document.querySelector("#processThemeSlot").contains(dom.window.document.querySelector("#themeToggle")));
      assert.equal(dom.window.document.querySelector("#themeToggle").dataset.targetTheme, "light");
      assert.equal(dom.window.document.querySelectorAll("#themeToggle [data-theme-icon]").length, 2);
      const actionButtons = [
        dom.window.document.querySelector("#themeToggle"),
        dom.window.document.querySelector("#downloadProcessesButton"),
        dom.window.document.querySelector("#newProcessButton")
      ];
      const comparableProperties = [
        "height",
        "paddingTop",
        "paddingBottom",
        "lineHeight",
        "alignItems",
        "justifyContent",
        "display",
        "marginTop",
        "marginBottom",
        "position",
        "transform",
        "verticalAlign"
      ];
      for (const property of comparableProperties) {
        const values = actionButtons.map((button) => dom.window.getComputedStyle(button)[property]);
        assert.equal(new Set(values).size, 1, `${property}: ${values.join(", ")}`);
      }
      const themeStyleAcrossScreens = Object.fromEntries([
        "width",
        "minWidth",
        "height",
        "paddingTop",
        "paddingRight",
        "paddingBottom",
        "paddingLeft",
        "lineHeight",
        "backgroundColor",
        "borderTopColor",
        "borderTopWidth",
        "borderRadius"
      ].map((property) => [property, dom.window.getComputedStyle(actionButtons[0])[property]]));
      const themeLabelStyleAcrossScreens = Object.fromEntries([
        "fontSize",
        "fontWeight",
        "lineHeight"
      ].map((property) => [property, dom.window.getComputedStyle(actionButtons[0].querySelector("strong"))[property]]));
      const visibleThemeIcon = dom.window.document.querySelector('#themeToggle [data-theme-icon="light"]');
      assert.equal(dom.window.getComputedStyle(visibleThemeIcon).width, "16px");
      assert.equal(dom.window.getComputedStyle(visibleThemeIcon).height, "16px");
      dom.window.document.querySelector("#newProcessButton").click();
      const processDialog = dom.window.document.querySelector("#processDialog");
      assert.equal(processDialog.open, true);
      const processNumber = processDialog.querySelector("#processNumber");
      const commitmentNumber = processDialog.querySelector(".commitment-number-field");
      assert.equal(dom.window.getComputedStyle(processNumber).height, dom.window.getComputedStyle(commitmentNumber).height);
      assert.equal(
        dom.window
          .getComputedStyle(processDialog.querySelector(".process-primary-group"))
          .getPropertyValue("--process-primary-control-height")
          .trim(),
        "40px",
      );
      assert.deepEqual(
        [...processDialog.querySelectorAll(".process-primary-label")].map((label) => dom.window.getComputedStyle(label).height),
        ["16px", "16px"]
      );
      assert.equal(dom.window.getComputedStyle(processDialog.querySelector("#commitmentNumberPreview")).marginTop, "0px");
      processDialog.close();
      assert.equal(dom.window.document.querySelector("#refreshProcessesButton"), null);
      assert.equal(dom.window.document.querySelector("#processExportFormat"), null);
      const liquidatedFilter = dom.window.document.querySelector('[data-filter="Liquidado"]');
      liquidatedFilter.click();
      dom.window.document.querySelector('[data-filter="Pago"]').click();
      assert.equal(dom.window.document.querySelector('[data-filter=""]').getAttribute("aria-pressed"), "false");
      assert.equal(dom.window.document.querySelector('[data-filter="Liquidado"]').getAttribute("aria-pressed"), "true");
      assert.equal(dom.window.document.querySelector('[data-filter="Pago"]').getAttribute("aria-pressed"), "true");
      assert.equal(dom.window.document.querySelectorAll(".filter-chip.active").length, 2);
      dom.window.document.querySelector("#downloadProcessesButton").click();
      const processExportDialog = dom.window.document.querySelector("#processExportDialog");
      assert.equal(processExportDialog.open, true);
      assert.deepEqual(
        [...processExportDialog.querySelectorAll("[data-process-export-format]")].map((button) => button.dataset.processExportFormat),
        ["excel", "pdf", "csv"]
      );
      const originalAnchorClick = dom.window.HTMLAnchorElement.prototype.click;
      dom.window.HTMLAnchorElement.prototype.click = () => {};
      processExportDialog.querySelector('[data-process-export-format="csv"]').click();
      await waitFor(() => processDownloadPath.includes("format=csv"));
      dom.window.HTMLAnchorElement.prototype.click = originalAnchorClick;
      assert.equal(processExportDialog.open, false);
      const processDownloadUrl = new URL(processDownloadPath, dom.window.location.href);
      assert.deepEqual(processDownloadUrl.searchParams.getAll("filtroRapido"), ["Liquidado", "Pago"]);
      dom.window.document.querySelector('[data-filter=""]').click();
      assert.equal(dom.window.document.querySelector('[data-filter=""]').getAttribute("aria-pressed"), "true");
      assert.equal(dom.window.document.querySelectorAll(".filter-chip.active").length, 1);

      for (const [section, pathname] of [["dashboard", "/graficos"], ["board", "/quadro"], ["suppliers", "/fornecedores"]]) {
        const navigation = dom.window.document.querySelector(`[data-section="${section}"]`);
        navigation.click();
        await waitFor(() => navigation.getAttribute("aria-current") === "page");
        assert.equal(dom.window.location.pathname, pathname);
        assert.ok(dom.window.document.querySelector(".topbar").contains(dom.window.document.querySelector("#themeToggle")));
        assert.equal(dom.window.getComputedStyle(dom.window.document.querySelector("#themeToggle")).position, "absolute");
        for (const [property, expected] of Object.entries(themeStyleAcrossScreens)) {
          assert.equal(
            dom.window.getComputedStyle(dom.window.document.querySelector("#themeToggle"))[property],
            expected,
            `${section}: ${property}`
          );
        }
        for (const [property, expected] of Object.entries(themeLabelStyleAcrossScreens)) {
          assert.equal(
            dom.window.getComputedStyle(dom.window.document.querySelector("#themeToggle strong"))[property],
            expected,
            `${section}: texto ${property}`
          );
        }
      }

      const settingsNavigation = dom.window.document.querySelector('[data-section="settings"]');
      assert.equal(settingsNavigation.classList.contains("hidden"), false);
      settingsNavigation.click();
      await waitFor(() => settingsNavigation.getAttribute("aria-current") === "page");

      assert.equal(dom.window.document.querySelector("#sectionTitle").textContent, "Configurações");
      assert.equal(dom.window.location.pathname, "/configuracoes");
      assert.ok(dom.window.document.querySelector(".topbar").contains(dom.window.document.querySelector("#themeToggle")));
      assert.equal(dom.window.getComputedStyle(dom.window.document.querySelector("#themeToggle")).position, "absolute");
      for (const [property, expected] of Object.entries(themeStyleAcrossScreens)) {
        assert.equal(dom.window.getComputedStyle(dom.window.document.querySelector("#themeToggle"))[property], expected, property);
      }
      for (const [property, expected] of Object.entries(themeLabelStyleAcrossScreens)) {
        assert.equal(dom.window.getComputedStyle(dom.window.document.querySelector("#themeToggle strong"))[property], expected, `texto ${property}`);
      }
      assert.equal(dom.window.document.querySelector("#settingsAccountTitle").textContent, "Configurações");
      assert.equal(dom.window.document.querySelector("#settingsBackButton"), null);
      const profileName = dom.window.document.querySelector('#settingsAccountForm input[name="nome"]');
      assert.equal(profileName.value, "Teste");
      assert.equal(profileName.readOnly, false);
      assert.ok(dom.window.document.querySelector("#settingsDashboardYear"));
      profileName.value = "Nome Atualizado";
      dom.window.document.querySelector("#settingsAccountForm").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
      await waitFor(() => dom.window.document.querySelector("#settingsAccountMessage").textContent === "Nome atualizado.");
      assert.deepEqual(profileNameRequest, { nome: "Nome Atualizado" });
      assert.equal(dom.window.document.querySelector("#sidebarGreeting").textContent, "Olá, Nome");
      assert.equal(dom.window.document.querySelector(".settings-admin-section"), null);
      const profileImageInput = dom.window.document.querySelector("#settingsProfileImageInput");
      let profilePickerOpened = false;
      profileImageInput.addEventListener("click", () => { profilePickerOpened = true; }, { once: true });
      dom.window.document.querySelector("#settingsProfileImageButton").click();
      assert.equal(profilePickerOpened, true);
      assert.equal(profileImageInput.accept, "image/png,image/jpeg,image/webp");
      assert.equal(dom.window.document.querySelector("#settingsThemeToggle"), null);
      dom.window.document.querySelector("#settingsPasswordButton").click();
      const passwordDialog = dom.window.document.querySelector("#changePasswordDialog");
      assert.equal(passwordDialog.open, true);
      assert.equal(passwordDialog.classList.contains("password-settings-dialog"), true);
      assert.ok(passwordDialog.querySelector('[name="senhaAtual"]'));
      assert.ok(passwordDialog.querySelector('[name="novaSenha"]'));
      assert.ok(passwordDialog.querySelector('[name="confirmacao"]'));
      passwordDialog.close();
      dom.window.document.querySelector("#themeToggle").click();
      assert.equal(dom.window.localStorage.getItem("almoxTheme"), "light");
      assert.equal(dom.window.document.documentElement.dataset.theme, "light");
      assert.equal(dom.window.document.querySelector("#themeToggle").getAttribute("aria-label"), "Alternar para modo escuro");
      assert.equal(dom.window.document.querySelector("#themeToggle").dataset.targetTheme, "dark");

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
