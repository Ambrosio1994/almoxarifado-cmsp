import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import {
  isValidPasswordInput,
  PASSWORD_POLICY_MESSAGE
} from "../public/password-fields.js";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
const figmaTheme = readFileSync(new URL("../public/figma-theme.css", import.meta.url), "utf8");
const passwordComponent = readFileSync(new URL("../public/password-fields.js", import.meta.url), "utf8");

describe("contrato visual e de navegacao", () => {
  it("permite editar o criador do processo e exibe uma barra durante o upload de documentos", () => {
    assert.match(html, /id="processCreatorName"[^>]*name="criadoPor"[^>]*maxlength="100"[^>]*required/);
    assert.doesNotMatch(html, /id="processCreatorName"[^>]*readonly/);
    assert.doesNotMatch(app, /processCreatorName\.value = currentUser\?\.(?:nome|email)/);
    assert.match(app, /if \(!String\(data\.criadoPor \|\| ""\)\.trim\(\)\)[\s\S]*?Informe o requisitante\.[\s\S]*?processCreatorName\?\.focus\(\)/);
    assert.match(app, /detailField\("Requisitante", processo\.criadoPor \|\| processo\.criadoPorEmail\)/);
    assert.match(html, /data-document-upload-progress/);
    assert.match(app, /setDocumentUploadProgress\(true, detailPanel\)/);
    assert.match(styles, /\.document-upload-progress/);
    assert.match(styles, /\.detail-material-table caption\s*\{[\s\S]*?font-family:\s*inherit[\s\S]*?font-size:\s*10px/);
  });

  it("exibe e-mail e senha juntos no formulario inicial", () => {
    const loginForm = html.match(/<form id="loginForm"[\s\S]*?<\/form>/)?.[0] || "";
    assert.match(loginForm, /name="email"[^>]*type="email"/);
    assert.match(loginForm, /name="senha"[^>]*type="password"/);
    assert.match(loginForm, />Entrar<\/button>/);
    assert.doesNotMatch(loginForm, /consultar empenhos/i);
  });

  it("aplica as superficies do Figma com assets locais e sem alterar os fluxos reais", () => {
    assert.match(html, /href="\/figma-theme\.css"/);
    assert.match(html, /class="auth-heading"[\s\S]*?Acesse sua conta[\s\S]*?Insira suas credenciais abaixo/);
    assert.match(figmaTheme, /\.auth-screen,[\s\S]*?:root\[data-theme="dark"\] \.auth-screen\s*\{[\s\S]*?login-background\.png/);
    assert.match(figmaTheme, /body\[data-app-section="dashboard"\][\s\S]*?dashboard-overlay\.png/);
    assert.match(figmaTheme, /body\[data-app-section="processes"\][\s\S]*?processes-background\.png/);
    assert.match(figmaTheme, /body\[data-app-section="board"\][\s\S]*?board-background\.png/);
    assert.match(figmaTheme, /body\[data-app-section="suppliers"\][\s\S]*?suppliers-background\.png/);
    assert.match(figmaTheme, /body\[data-app-section="processes"\] \.table-wrap,[\s\S]*?background:\s*var\(--theme-table-bg\)/);
    assert.match(figmaTheme, /\.board-view\s*\{[\s\S]*?background:\s*var\(--theme-content-glass\)/);
    assert.match(figmaTheme, /\.module-view#suppliersView\s*\{[\s\S]*?background:\s*var\(--theme-suppliers-container\)/);
    assert.match(figmaTheme, /\.module-row\s*\{[\s\S]*?background:\s*var\(--theme-surface-faint\)/);
    assert.match(figmaTheme, /\.supplier-filters\s*\{[\s\S]*?justify-content:\s*center[\s\S]*?width:\s*100%/);
    assert.match(figmaTheme, /\.supplier-search\s*\{[\s\S]*?margin-inline:\s*auto[\s\S]*?max-width:\s*620px/);
    assert.match(app, /document\.body\.dataset\.appSection = section/);
    assert.match(app, /localStorage\.getItem\("almoxTheme"\) \|\| "dark"/);
    assert.doesNotMatch(html, /accountProfileName|accountThemeToggle/);
    for (const asset of [
      "login-background.png",
      "dashboard-overlay.png",
      "processes-background.png",
      "board-background.png",
      "suppliers-background.png",
      "settings-background.png",
      "settings-avatar.png",
      "eye-off.svg",
      "camera.svg"
    ]) {
      assert.equal(existsSync(new URL(`../public/assets/figma/${asset}`, import.meta.url)), true, asset);
    }
  });

  it("mantem a tela de login visualmente fixa em qualquer tema", () => {
    const authTheme = figmaTheme.slice(figmaTheme.indexOf(".auth-screen,"), figmaTheme.indexOf(".sidebar {"));
    assert.match(authTheme, /login-background\.png/);
    assert.match(authTheme, /:root\[data-theme="light"\] \.auth-screen/);
    assert.match(authTheme, /:root\[data-theme="dark"\] \.auth-screen/);
    assert.match(authTheme, /:root\[data-theme="light"\] \.auth-panel/);
    assert.match(authTheme, /:root\[data-theme="dark"\] \.auth-panel/);
    assert.match(authTheme, /color-scheme:\s*dark/);
    assert.match(authTheme, /background:\s*rgb\(6 10 24 \/ 70%\)/);
    assert.match(authTheme, /color:\s*#f8fafc/);
    assert.match(authTheme, /background:\s*rgb\(14 21 40 \/ 90%\)/);
    assert.doesNotMatch(authTheme, /var\(--theme-/);
    assert.doesNotMatch(figmaTheme, /html\[data-theme="light"\] \.auth-form \.password-toggle\s*\{[\s\S]*?filter:/);
  });

  it("define conjuntos completos de tokens claros e escuros para todas as superficies", () => {
    const lightStart = figmaTheme.indexOf(":root,");
    const darkStart = figmaTheme.indexOf('html[data-theme="dark"]');
    const rulesStart = figmaTheme.indexOf("body {", darkStart);
    const lightTheme = figmaTheme.slice(lightStart, darkStart);
    const darkTheme = figmaTheme.slice(darkStart, rulesStart);
    const semanticTokens = [
      "theme-page-overlay",
      "theme-main-overlay",
      "theme-sidebar-bg",
      "theme-topbar-bg",
      "theme-surface",
      "theme-surface-strong",
      "theme-surface-soft",
      "theme-surface-faint",
      "theme-content-glass",
      "theme-content-glass-faint",
      "theme-suppliers-container",
      "theme-control-bg",
      "theme-control-hover",
      "theme-input-bg",
      "theme-border",
      "theme-border-strong",
      "theme-border-soft",
      "theme-border-glass",
      "theme-text",
      "theme-text-muted",
      "theme-text-subtle",
      "theme-link",
      "theme-focus",
      "theme-table-bg",
      "theme-table-head",
      "theme-table-hover",
      "theme-table-line",
      "theme-column-bg",
      "theme-card-bg",
      "theme-dialog-bg",
      "theme-auth-panel",
      "theme-auth-input",
      "theme-settings-overlay",
      "theme-shadow",
      "theme-backdrop",
      "theme-chart-grid",
      "theme-status-info-bg",
      "theme-status-info-text",
      "theme-status-warning-bg",
      "theme-status-warning-text",
      "theme-status-success-bg",
      "theme-status-success-text",
      "theme-status-neutral-bg",
      "theme-status-neutral-text",
      "theme-status-danger-bg",
      "theme-status-danger-text"
    ];

    assert.ok(lightStart >= 0);
    assert.ok(darkStart > lightStart);
    assert.ok(rulesStart > darkStart);
    for (const token of semanticTokens) {
      assert.match(lightTheme, new RegExp(`--${token}:`), `token claro ausente: ${token}`);
      assert.match(darkTheme, new RegExp(`--${token}:`), `token escuro ausente: ${token}`);
    }
    assert.match(lightTheme, /--theme-text:\s*#0f172a/);
    assert.match(lightTheme, /--theme-content-glass:\s*rgb\(246 248 244 \/ 62%\)/);
    assert.match(lightTheme, /color-scheme:\s*light/);
    assert.match(darkTheme, /--theme-text:\s*#f0f4f8/);
    assert.match(darkTheme, /--theme-content-glass:\s*rgb\(13 15 20 \/ 42%\)/);
    assert.match(darkTheme, /color-scheme:\s*dark/);
    assert.match(figmaTheme, /\.dashboard-grid \.metric,[\s\S]*?background:\s*var\(--theme-surface\)/);
    assert.match(figmaTheme, /\.settings-account-screen\s*\{[\s\S]*?background:\s*var\(--theme-content-glass\)/);
    assert.match(figmaTheme, /dialog,[\s\S]*?background:\s*var\(--theme-dialog-bg\)/);
  });

  it("restaura a ultima secao no boot sem carregar processos antecipadamente", () => {
    const boot = app.slice(app.indexOf("async function boot()"), app.indexOf("async function loadDashboardData"));
    assert.match(boot, /api\("\/api\/meta"\)/);
    assert.match(boot, /loadDashboardData\(savedDashboardYear\(\)\)/);
    assert.match(boot, /openSection\(savedActiveSection\(\)\)/);
    assert.doesNotMatch(boot, /\/api\/processes/);
    assert.match(app, /sessionStorage\.getItem\(activeSectionStorageKey\(\)\)/);
    assert.match(app, /sessionStorage\.setItem\(activeSectionStorageKey\(\), section\)/);
    const processView = html.match(/<section[^>]*id="processListView"[^>]*>/)?.[0] || "";
    assert.match(processView, /class="[^"]*hidden[^"]*"/);
    assert.match(html, /id="dashboardView"/);
    assert.match(html, /id="sectionTitle" class="sr-only"/);
  });

  it("apresenta a antiga secao Painel com o nome Graficos", () => {
    assert.match(html, /data-section="dashboard"[\s\S]*?Gráficos<\/a>/);
    assert.match(app, /dashboard:\s*"Gráficos"/);
    assert.match(app, /<h1>Gráficos<\/h1>/);
    assert.doesNotMatch(html, /data-section="dashboard"[^>]*>[\s\S]*?Painel<\/a>/);
    assert.doesNotMatch(app, /<h1>Painel<\/h1>/);
    assert.doesNotMatch(app, /Ano definido em Configurações|Processos pelo ano do empenho|dashboardScope/);
  });

  it("oferece o Quadro como secao persistente, acessivel e responsiva", () => {
    assert.match(html, /data-section="board"[\s\S]*?Quadro<\/a>/);
    assert.match(html, /<section class="module-view hidden board-view" id="boardView"/);
    assert.match(html, /id="boardMessage"[^>]*aria-live="polite"/);
    assert.match(html, /id="kanbanBoard"[^>]*aria-label="Quadro de Empenhos"/);
    assert.match(html, /id="boardHideEmptyColumns"/);
    assert.match(app, /const APP_SECTIONS = new Set\(\[[\s\S]*?"board"/);
    assert.match(app, /board:\s*\(\) => renderBoardView\(\)/);
    assert.match(app, /openProcessDetail\(process, "board"\)/);
    assert.match(app, /state\.detailReturnSection = returnSection/);
    assert.match(styles, /\.kanban-board\s*\{[\s\S]*?overflow-x:\s*auto/);
    assert.match(styles, /\.kanban-column\s*\{[\s\S]*?width:\s*clamp\(280px, 28vw, 360px\)/);
    assert.match(styles, /\[data-theme="dark"\] \.kanban-card/);
    const mobileRules = styles.slice(styles.indexOf("@media (max-width: 640px)"));
    assert.match(mobileRules, /\.kanban-column\s*\{[\s\S]*?width:\s*calc\(100vw - 42px\)/);
  });

  it("mantem Configuracoes acessivel e Templates como subseção administrativa", () => {
    assert.match(html, /data-section="users"[^>]*>[^<]*<span[^>]*>[\s\S]*?Usuarios e permissoes<\/a>/);
    assert.match(html, /data-section="settings"[^>]*>[^<]*<span[^>]*>[\s\S]*?Configurações<\/a>/);
    assert.match(html, /id="usersView"/);
    assert.match(html, /id="settingsView"/);
    assert.match(html, /data-section="suppliers"[\s\S]*?Fornecedores<\/a>[\s\S]*?data-section="settings"[\s\S]*?Configurações<\/a>/);
    assert.match(app, /class="settings-account-screen"/);
    assert.match(app, /id="settingsAccountForm"/);
    assert.match(app, /name="nome"[\s\S]*?maxlength="100"[\s\S]*?required/);
    assert.doesNotMatch(app, /name="nome"[^>]*readonly/);
    assert.doesNotMatch(app, /settingsBackButton|settings-back-button/);
    assert.match(app, /id="settingsPasswordButton"/);
    assert.match(app, /id="settingsDashboardYear"/);
    assert.match(app, /api\("\/auth\/profile"/);
    assert.doesNotMatch(app, /settingsThemeToggle|settingsThemeLabel/);
    assert.match(app, /id="settingsProfileImageButton"/);
    assert.match(app, /id="settingsProfileImageInput" type="file" accept="image\/png,image\/jpeg,image\/webp"/);
    assert.match(app, /api\("\/auth\/profile-photo"/);
    assert.match(app, /function resizeProfileImage\(file\)/);
    assert.match(app, /Configurações administrativas/);
    assert.match(app, /const isAdmin = currentUser\?\.role === "admin"/);
    assert.match(app, /if \(section === "users" && currentUser\?\.role !== "admin"\)/);
    assert.doesNotMatch(html, /profileImageDialog|profileImagePreview/);
    assert.match(html, /<dialog id="changePasswordDialog" class="small-dialog password-settings-dialog"[\s\S]*?name="senhaAtual"[\s\S]*?name="novaSenha"[\s\S]*?name="confirmacao"[\s\S]*?Salvar nova senha/);
    assert.doesNotMatch(html, /id="changePasswordDialog"[\s\S]*?accountThemeToggle/);
    assert.match(figmaTheme, /html\[data-theme\] \.auth-form \.email-submit\s*\{[\s\S]*?background:\s*#fff/);
    assert.match(figmaTheme, /html\[data-theme\] \.auth-form \.password-toggle\s*\{[\s\S]*?eye-off\.svg/);
  });

  it("preserva os campos, limites e rotulos de aceite", () => {
    assert.match(html, /id="newProcessButton">\+ Novo<\/button>/);
    assert.doesNotMatch(html, /id="newProcessButton">\+ Novo processo<\/button>/);
    assert.match(html, /name="numeroProcesso" maxlength="20"/);
    assert.match(html, /id="commitmentYear"[^>]*aria-label="Ano do empenho"[^>]*required/);
    assert.match(html, /class="commitment-number-prefix"[^>]*>NE000<\/span>/);
    assert.match(html, /id="commitmentSequence"[^>]*inputmode="numeric"[^>]*pattern="\[0-9\]\+"[^>]*required/);
    assert.match(html, /type="hidden" name="numeroEmpenho"/);
    assert.match(app, /formatCommitmentNumber\(commitmentYear\?\.value, commitmentSequence\?\.value\)/);
    assert.match(html, /name="fornecedor" maxlength="100"/);
    assert.match(html, /name="cnpj"[^>]*maxlength="18"/);
    assert.match(html, /name="dataProcesso"[\s\S]*?data-date-input[\s\S]*?placeholder="DDMMAAAA"[\s\S]*?maxlength="10"/);
    assert.match(html, /name="conteudo"[^>]*minlength="1"[^>]*maxlength="350"/);
  });

  it("formata datas digitadas somente com numeros", () => {
    assert.match(html, /data-date-input/g);
    assert.match(app, /function formatDateInput\(value = ""\)/);
    assert.match(app, /String\(value\)\.replace\(\/\\D\/g, ""\)\.slice\(0, 8\)/);
    assert.match(app, /parts\.join\("-"\)/);
  });

  it("usa dialog acessivel para entregas e nao usa prompt nativo", () => {
    assert.match(html, /<dialog id="deliveryDialog"[^>]*aria-labelledby="deliveryDialogTitle"[^>]*aria-describedby="deliveryDialogDescription"/);
    assert.match(html, /id="deliveryForm"/);
    assert.doesNotMatch(app, /\bprompt\s*\(/);
  });

  it("pede confirmacao em dialogo para cada etapa registrada nos dados gerais", () => {
    assert.match(html, /<dialog id="processStepDialog"[^>]*aria-labelledby="processStepDialogTitle"[^>]*aria-describedby="processStepDialogDescription"/);
    assert.match(html, /id="processStepForm"/);
    assert.match(html, /id="cancelProcessStep">Cancelar<\/button>/);
    assert.match(app, /openProcessStepDialog\(step\)/);
    assert.match(app, /"Entregue": \{[\s\S]*?button: "Confirmar envio para liquidação"[\s\S]*?status: "Enviado para liquidacao"/);
    assert.doesNotMatch(app, /button: "Confirmar aguardando envio para liquidação"/);
    assert.match(app, /dateLabel: "Data do envio para liquidação"/);
    assert.doesNotMatch(app, /newDataPanel/);
  });

  it("posiciona salvar antes de cancelar nos formularios", () => {
    for (const formId of ["deliveryForm", "processStepForm", "documentMetadataForm", "supplierInfoForm"]) {
      const start = html.indexOf(`<form id="${formId}"`);
      const form = html.slice(start, html.indexOf("</form>", start));
      assert.ok(form.indexOf('type="submit"') < form.indexOf(">Cancelar</button>"), formId);
    }
  });

  it("abre os dados gerais depois de criar um processo ja enviado para SALC", () => {
    assert.match(app, /const isCreating = !id/);
    assert.match(app, /if \(isCreating\)[\s\S]*?openProcessDetail\(createdProcess, "processes"\)/);
    assert.match(app, /status: processo\.status \|\| "Criado"/);
    assert.match(app, /"Enviado para SALC": \["dataEnvioSalc"\]/);
  });

  it("exibe quantidade antes de valor unitario nos materiais", () => {
    const materialRow = app.slice(app.indexOf("function addMaterialRow"), app.indexOf("function ensureOneMaterialRow"));
    assert.ok(materialRow.indexOf(">Quantidade <") < materialRow.indexOf(">Valor unitario <"));
    assert.ok(materialRow.indexOf("data-material-total") < materialRow.indexOf("data-add-material"));
    assert.ok(materialRow.indexOf("data-add-material") < materialRow.indexOf("data-remove-material"));
    assert.match(app, /const row = addMaterialRow\(\)[\s\S]*?data-material-field="descricao"[\s\S]*?\.focus\(\)/);
  });

  it("calcula os totais dos materiais e organiza os dados gerais", () => {
    const materialsSection = html.slice(html.indexOf('<section class="materials-section">'), html.indexOf("</section>", html.indexOf('<section class="materials-section">')));
    const materialsTitle = materialsSection.slice(materialsSection.indexOf('<div class="section-title">'), materialsSection.indexOf("</div>"));
    assert.doesNotMatch(materialsTitle, /Adicionar material/);
    assert.match(materialsSection, /class="process-total-summary"[\s\S]*?id="processMaterialsTotal"[^>]*aria-live="polite"/);
    assert.doesNotMatch(materialsSection, /id="addMaterialButton"/);
    assert.match(app, /data-material-total/);
    assert.match(app, /function updateMaterialTotals\(\)/);
    assert.match(app, /class="general-data-row general-data-identity"[\s\S]*?detailField\("Fornecedor"[\s\S]*?detailField\("CNPJ"/);
    assert.match(app, /class="general-data-row general-data-process"[\s\S]*?detailField\("Processo"[\s\S]*?detailField\("Empenho"[\s\S]*?detailField\("Requisitante"[\s\S]*?detailField\("Data do processo"[\s\S]*?detailField\("Valor total"/);
    assert.match(app, /class="general-data-row general-data-dates"[\s\S]*?Data de envio para fornecedor[\s\S]*?Data de entrega[\s\S]*?Data de envio para liquidação[\s\S]*?Data da liquidação[\s\S]*?Data do pagamento/);
    assert.match(app, /class="detail-material-table"[\s\S]*?<th scope="col">Material[\s\S]*?Unidades[\s\S]*?Valor unitário[\s\S]*?Valor total/);
    assert.doesNotMatch(app, /Valor unitario medio/);
  });

  it("permite redimensionar a tela de criacao do processo", () => {
    assert.match(styles, /#processDialog\s*\{[\s\S]*?max-height:\s*calc\(100vh - 28px\)[\s\S]*?max-width:\s*calc\(100vw - 28px\)[\s\S]*?overflow:\s*hidden[\s\S]*?resize:\s*both/);
    assert.match(styles, /#processDialog \.process-form\s*\{[\s\S]*?height:\s*calc\(100% - 58px\)[\s\S]*?overflow:\s*auto/);
  });

  it("oferece registro de entrega logo apos o envio ao fornecedor", () => {
    assert.match(app, /"Empenho enviado ao fornecedor": \{[\s\S]*?button: "Registrar entrega"[\s\S]*?status: "Entrega parcial"/);
    assert.doesNotMatch(app, /button: "Confirmar aguardando entrega"/);
    assert.match(app, /\["Empenho enviado ao fornecedor", "Aguardando entrega"\]\.includes\(process\.status\)/);
  });

  it("oferece retrocesso de status somente pelo fluxo administrativo dedicado", () => {
    assert.match(html, /id="rollbackStatusDialog"/);
    assert.match(html, /id="rollbackStatusForm"/);
    assert.match(html, /name="motivo"[^>]*maxlength="1000"[^>]*required/);
    assert.match(app, /isCurrentUserAdmin\(\).*previousStatusesInUi/);
    assert.match(app, /\/rollback-status/);
  });

  it("oferece o download completo somente no modulo Documentos", () => {
    assert.doesNotMatch(html, /id="downloadProcessButton"/);
    const documentsModule = app.slice(app.indexOf("function renderDocumentsModule"), app.indexOf("function renderTimelineModule"));
    assert.match(documentsModule, /data-download-process="true"/);
    assert.match(app, /event\.target\.dataset\.downloadProcess/);
  });

  it("organiza os controles de Empenhos sem alterar pesquisa, filtros ou download", () => {
    const processList = html.slice(html.indexOf('id="processListView"'), html.indexOf('id="dashboardView"'));
    assert.match(processList, /<h1>Empenhos<\/h1>/);
    assert.doesNotMatch(processList, /processExportFormat/);
    assert.doesNotMatch(processList, /id="refreshProcessesButton"/);
    assert.match(processList, /class="process-header-actions"[\s\S]*?id="processThemeSlot"[\s\S]*?id="downloadProcessesButton"[\s\S]*?id="newProcessButton"/);
    assert.match(processList, /id="downloadProcessesButton">Download<\/button>/);
    assert.match(processList, /id="newProcessButton">\+ Novo<\/button>/);
    assert.match(processList, /class="process-search-row"[\s\S]*?id="searchInput"[\s\S]*?class="process-filter-state"[\s\S]*?id="quickFilter"[\s\S]*?id="quickFilterBar"/);
    assert.match(html, /id="processExportDialog"[\s\S]*?data-process-export-format="excel"[\s\S]*?data-process-export-format="pdf"[\s\S]*?data-process-export-format="csv"/);
    assert.match(app, /processExportDialog\?\.showModal\(\)/);
    assert.match(app, /downloadProcesses\(format\)/);
    assert.match(app, /function placeThemeToggle\(section\)/);
    assert.match(figmaTheme, /\.process-search-row\s*\{[\s\S]*?margin:[^;]*auto[\s\S]*?max-width:\s*680px/);
    assert.match(figmaTheme, /\.topbar\s*\{[\s\S]*?background:\s*transparent[\s\S]*?height:\s*0[\s\S]*?min-height:\s*0/);
    const themeToggleRules = figmaTheme.slice(
      figmaTheme.indexOf(".theme-toggle,"),
      figmaTheme.indexOf(".topbar > .theme-toggle")
    );
    assert.match(themeToggleRules, /background:\s*transparent/);
    assert.match(themeToggleRules, /border:\s*1px solid #fbbf24/);
    assert.match(themeToggleRules, /border-radius:\s*8px/);
    assert.match(themeToggleRules, /box-shadow:\s*none/);
    assert.match(themeToggleRules, /height:\s*38px/);
    assert.match(themeToggleRules, /padding:\s*8px 14px/);
    assert.match(html, /id="themeToggle"[^>]*data-target-theme="dark"[\s\S]*?class="theme-toggle-icon"[\s\S]*?data-theme-icon="light"[\s\S]*?data-theme-icon="dark"/);
    assert.match(app, /themeToggle\.dataset\.targetTheme = isDark \? "light" : "dark"/);
    assert.match(themeToggleRules, /\.theme-toggle > \.theme-toggle-icon\s*\{[\s\S]*?display:\s*inline-flex[\s\S]*?height:\s*16px[\s\S]*?justify-content:\s*center[\s\S]*?width:\s*16px/);
    assert.match(themeToggleRules, /\.theme-toggle-icon svg\s*\{[\s\S]*?height:\s*16px[\s\S]*?width:\s*16px/);
    assert.match(themeToggleRules, /\.theme-toggle:focus-visible\s*\{[\s\S]*?outline:\s*2px solid var\(--theme-focus\)/);
    const processActionRules = figmaTheme.slice(
      figmaTheme.indexOf('body[data-app-section="processes"] .process-header-actions button,'),
      figmaTheme.indexOf('body[data-app-section="processes"] .process-header-actions .theme-toggle strong')
    );
    assert.match(processActionRules, /align-items:\s*center/);
    assert.match(processActionRules, /background:\s*transparent/);
    assert.match(processActionRules, /border:\s*1px solid #fbbf24/);
    assert.match(processActionRules, /box-shadow:\s*none/);
    assert.match(processActionRules, /display:\s*inline-flex/);
    assert.match(processActionRules, /height:\s*38px/);
    assert.match(processActionRules, /justify-content:\s*center/);
    assert.match(processActionRules, /line-height:\s*1/);
    assert.match(processActionRules, /margin:\s*0/);
    assert.match(processActionRules, /padding:\s*8px 14px/);
    assert.doesNotMatch(processActionRules, /transform|translateY|vertical-align|position:\s*relative|margin-(?:top|bottom)/);
    assert.match(figmaTheme, /\.topbar > \.theme-toggle\s*\{[\s\S]*?position:\s*fixed[\s\S]*?right:\s*18px[\s\S]*?top:\s*12px/);
    assert.match(figmaTheme, /body\[data-app-section="processes"\] \.process-table th\s*\{[\s\S]*?background:\s*var\(--theme-table-head\)/);
    assert.match(html, /<th>Nº Processo<\/th>[\s\S]*?<th>Data Envio fornecedor<\/th>[\s\S]*?<th>Requisitante<\/th>/);
    assert.match(app, /\["Empenhos do ano", data\.processosAtivos\][\s\S]*?\["Atrasados", data\.atrasados[\s\S]*?\["Liquidação Pendente", data\.pendentesLiquidacao\]/);
    assert.match(app, /dashboard-summary-chart/);
    assert.match(figmaTheme, /\.dashboard-summary-chart\s*\{[\s\S]*?min-height:\s*300px/);
    assert.match(app, /class="secondary" data-supplier-history=[\s\S]*?>Histórico de Empenhos<\/button>/);
    assert.match(app, /class="secondary" data-supplier-info=/);
    assert.match(figmaTheme, /@media \(min-width:\s*641px\)\s*\{[\s\S]*?body\[data-app-section="processes"\] \.process-table\s*\{[\s\S]*?border-spacing:\s*0 12px/);
    assert.match(figmaTheme, /body\[data-app-section="processes"\] \.process-table tbody td\s*\{[\s\S]*?background:\s*var\(--theme-surface-faint\)[\s\S]*?border-bottom:\s*1px solid var\(--theme-border-soft\)/);
    const processTableTheme = figmaTheme.slice(
      figmaTheme.indexOf('body[data-app-section="processes"] .table-wrap'),
      figmaTheme.indexOf(".dashboard-grid")
    );
    assert.doesNotMatch(processTableTheme, /\bopacity\s*:/);
    const boardPanelTheme = figmaTheme.slice(
      figmaTheme.indexOf(".board-view {"),
      figmaTheme.indexOf(".board-heading span")
    );
    assert.doesNotMatch(boardPanelTheme, /\bopacity\s*:/);
  });

  it("preserva a anulacao motivada sem o controle visual de atualizacao", () => {
    assert.doesNotMatch(html, /id="publicConsultButton"/);
    assert.doesNotMatch(app, /\bpublico\b/);
    assert.doesNotMatch(html, /id="refreshProcessesButton"/);
    assert.doesNotMatch(app, /refreshProcessesButton/);
    assert.match(html, /id="cancelProcessDialog"/);
    assert.match(html, /name="motivo"[^>]*maxlength="1000"[^>]*required/);
  });

  it("carrega a auditoria do processo para a linha do tempo", () => {
    assert.match(app, /loadDetailAudit\(processo\.id/);
    assert.match(app, /\/api\/processes\/\$\{processId\}\/audit/);
    assert.match(app, /return state\.detailAudit/);
  });

  it("permite ao admin excluir itens da linha do tempo com motivo opcional e sem travar o formulario", () => {
    assert.match(html, /id="deleteTimelineDialog"/);
    assert.match(html, /id="deleteTimelineForm"/);
    const deleteTimelineForm = html.match(/<form id="deleteTimelineForm"[\s\S]*?<\/form>/)?.[0] || "";
    assert.match(deleteTimelineForm, /Motivo \(opcional\)/);
    assert.match(deleteTimelineForm, /name="motivo"[^>]*maxlength="1000"/);
    assert.doesNotMatch(deleteTimelineForm, /name="motivo"[^>]*required/);
    assert.match(app, /isCurrentUserAdmin\(\).*event\.sourceType.*event\.sourceId/s);
    assert.match(app, /\/timeline-items/);
    assert.match(app, /method: "DELETE"/);
    const saveDeletion = app.slice(app.indexOf("async function saveTimelineDeletion"), app.indexOf("function renderDeliveriesModule"));
    assert.match(saveDeletion, /const form = event\.currentTarget/);
    assert.match(saveDeletion, /finally[\s\S]*?setFormBusy\(form, false\)/);
    assert.doesNotMatch(saveDeletion, /setFormBusy\(event\.currentTarget/);
    assert.match(app, /Exclusao de dado da linha do tempo/);
    assert.match(app, /hiddenTimelineKeys\(processo\)/);
  });

  it("mostra previa do documento anexado na linha do tempo e o abre em dialogo", () => {
    assert.match(app, /documentTimelinePreviewContent/);
    assert.match(app, /data-document-preview=/);
    assert.match(app, /hydrateTimelineDocumentPreviews/);
    assert.match(app, /media\.src = `\$\{blobUrl\}#page=1&view=FitH`/);
    assert.match(app, /data-open-document=/);
    assert.match(app, /function openDocument\(path, metadata = \{\}\)/);
    assert.match(app, /URL\.createObjectURL\(resource\.blob\)/);
    assert.match(app, /new AbortController\(\)/);
    assert.match(app, /Math\.min\(3, previews\.length\)/);
    assert.match(app, /window\.IntersectionObserver/);
    assert.match(app, /currentDocumentFromAuditEntry/);
    assert.doesNotMatch(app, /documentInlineUrl/);
  });

  it("preserva erros, nomes e indices originais dos documentos", () => {
    assert.match(app, /async function documentResponseError\(response\)/);
    assert.match(app, /documentFileNameFromDisposition/);
    assert.match(app, /triggerBlobDownload\(blobUrl, resource\.fileName\)/);
    assert.match(app, /sourceIndex/);
    assert.match(app, /complementares:\$\{doc\.sourceIndex \?\? index\}/);
    assert.match(html, /name="titulo" maxlength="150" required/);
    assert.match(html, /name="descricao"[^>]*maxlength="1000"/);
  });

  it("preserva IDs dos materiais e mostra o historico das entregas", () => {
    assert.match(app, /row\.dataset\.materialId = material\.id/);
    assert.match(app, /materialId: balance\.material\.id/);
    assert.match(html, /Se nenhuma quantidade for preenchida, todo o saldo pendente será registrado como entregue/);
    assert.match(app, /if \(!hasEnteredQuantity\)[\s\S]*?quantidade: remaining/);
    assert.match(app, /entrega\.recebidoPor/);
    assert.match(app, /entrega\.observacao/);
  });

  it("mantem os indicadores de Graficos densos em tablets e legiveis no celular", () => {
    const tabletRules = styles.slice(styles.indexOf("@media (max-width: 980px)"), styles.indexOf("@media (prefers-reduced-motion"));
    const mobileRules = styles.slice(styles.indexOf("@media (max-width: 640px)"));
    assert.doesNotMatch(tabletRules, /\.dashboard-grid\s*\{[\s\S]*?grid-template-columns:\s*1fr/);
    assert.match(mobileRules, /\.dashboard-grid\s*\{\s*grid-template-columns:\s*1fr 1fr/);
    assert.match(mobileRules, /\.dashboard-year\s*\{[\s\S]*?width:\s*100%/);
    assert.match(mobileRules, /\.chart-row > \.bar-track\s*\{[\s\S]*?grid-column:\s*1 \/ -1/);
  });
});

describe("componente de senha", () => {
  it("implementa o olho dentro do campo com estados acessiveis", () => {
    assert.match(passwordComponent, /className = "password-input-wrap"/);
    assert.match(passwordComponent, /className = "password-toggle"/);
    assert.match(passwordComponent, /type = passwordVisible \? "text" : "password"/);
    assert.match(passwordComponent, /"aria-label"/);
    assert.match(passwordComponent, /"aria-pressed"/);
    assert.doesNotMatch(html, />\s*Mostrar\s*<\/button>/);
  });

  it("aplica a mesma politica de 8 a 256 caracteres", () => {
    assert.equal(isValidPasswordInput("Senha@12"), true);
    assert.equal(isValidPasswordInput("Álmox@12"), true);
    assert.equal(isValidPasswordInput("Ab@123"), false);
    assert.equal(isValidPasswordInput("senha@12"), false);
    assert.equal(isValidPasswordInput("Senha@xx"), false);
    assert.equal(isValidPasswordInput("Senha 12"), false);
    assert.equal(isValidPasswordInput(`A1@${"a".repeat(253)}`), true);
    assert.equal(isValidPasswordInput(`A1@${"a".repeat(254)}`), false);
    assert.match(PASSWORD_POLICY_MESSAGE, /8 e 256/);
  });
});
