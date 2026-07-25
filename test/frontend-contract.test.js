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
    assert.match(figmaTheme, /\.auth-screen\s*\{[\s\S]*?login-background\.webp/);
    assert.match(figmaTheme, /body\[data-app-section="dashboard"\][\s\S]*?dashboard-overlay\.png/);
    assert.match(figmaTheme, /body\[data-app-section="processes"\][\s\S]*?processes-background\.png/);
    assert.match(figmaTheme, /body\[data-app-section="board"\][\s\S]*?board-background\.png/);
    assert.match(figmaTheme, /body\[data-app-section="suppliers"\][\s\S]*?suppliers-background\.png/);
    assert.match(figmaTheme, /body\[data-app-section="processes"\] \.table-wrap,[\s\S]*?background:\s*var\(--theme-table-bg\)/);
    assert.match(figmaTheme, /\.board-view\s*\{[\s\S]*?background:\s*var\(--theme-content-glass\)/);
    assert.match(figmaTheme, /\.module-view#suppliersView\s*\{[\s\S]*?background:\s*var\(--theme-content-glass-faint\)/);
    assert.match(figmaTheme, /\.supplier-filters\s*\{[\s\S]*?justify-content:\s*center[\s\S]*?width:\s*100%/);
    assert.match(figmaTheme, /\.supplier-search\s*\{[\s\S]*?margin-inline:\s*auto[\s\S]*?max-width:\s*620px/);
    assert.match(app, /document\.body\.dataset\.appSection = section/);
    assert.match(app, /localStorage\.getItem\("almoxTheme"\) \|\| "dark"/);
    assert.match(html, /id="accountProfileName"[^>]*readonly/);
    assert.match(html, /id="accountThemeToggle"[^>]*role="switch"/);
    for (const asset of [
      "login-background.webp",
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
    assert.match(boot, /loadDashboardData\(\)/);
    assert.match(boot, /openSection\(savedActiveSection\(\)\)/);
    assert.doesNotMatch(boot, /\/api\/processes/);
    assert.match(app, /sessionStorage\.getItem\(activeSectionStorageKey\(\)\)/);
    assert.match(app, /sessionStorage\.setItem\(activeSectionStorageKey\(\), section\)/);
    const processView = html.match(/<section[^>]*id="processListView"[^>]*>/)?.[0] || "";
    assert.match(processView, /class="[^"]*hidden[^"]*"/);
    assert.match(html, /id="dashboardView"/);
    assert.match(html, /id="sectionTitle" class="sr-only"/);
  });

  it("oferece o Quadro como secao persistente, acessivel e responsiva", () => {
    assert.match(html, /data-section="board"[\s\S]*?Quadro<\/a>/);
    assert.match(html, /<section class="module-view hidden board-view" id="boardView"/);
    assert.match(html, /id="boardMessage"[^>]*aria-live="polite"/);
    assert.match(html, /id="kanbanBoard"[^>]*aria-label="Quadro de processos"/);
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
    assert.match(app, /id="settingsPasswordButton"/);
    assert.match(app, /id="settingsThemeToggle"/);
    assert.match(app, /id="settingsProfileImageButton"/);
    assert.match(app, /Configurações administrativas/);
    assert.match(app, /const isAdmin = currentUser\?\.role === "admin"/);
    assert.match(app, /if \(section === "users" && currentUser\?\.role !== "admin"\)/);
    assert.match(html, /<dialog id="profileImageDialog"[^>]*>\s*<img id="profileImagePreview"[^>]*>\s*<\/dialog>/);
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
    assert.match(processList, /id="processExportFormat" type="hidden" value="excel"/);
    assert.doesNotMatch(processList, /<select id="processExportFormat"/);
    assert.doesNotMatch(processList, /id="refreshProcessesButton"/);
    assert.match(processList, /id="downloadProcessesButton">Download<\/button>/);
    assert.match(processList, /id="newProcessButton">\+ Novo<\/button>/);
    assert.match(processList, /class="process-search-row"[\s\S]*?id="searchInput"[\s\S]*?class="process-filter-state"[\s\S]*?id="quickFilter"[\s\S]*?id="quickFilterBar"/);
    assert.match(app, /function placeThemeToggle\(section\)/);
    assert.match(app, /section === "processes" \? processThemeSlot : topbar/);
    assert.match(figmaTheme, /\.process-search-row\s*\{[\s\S]*?margin:[^;]*auto[\s\S]*?max-width:\s*680px/);
    assert.match(figmaTheme, /body\[data-app-section="processes"\] \.process-table th\s*\{[\s\S]*?background:\s*var\(--theme-table-head\)/);
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

  it("mantem os indicadores do Painel densos em tablets e legiveis no celular", () => {
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
