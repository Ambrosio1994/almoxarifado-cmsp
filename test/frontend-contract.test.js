import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  isValidPasswordInput,
  PASSWORD_POLICY_MESSAGE
} from "../public/password-fields.js";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
const passwordComponent = readFileSync(new URL("../public/password-fields.js", import.meta.url), "utf8");

describe("contrato visual e de navegacao", () => {
  it("exibe e-mail e senha juntos no formulario inicial", () => {
    const loginForm = html.match(/<form id="loginForm"[\s\S]*?<\/form>/)?.[0] || "";
    assert.match(loginForm, /name="email"[^>]*type="email"/);
    assert.match(loginForm, /name="senha"[^>]*type="password"/);
    assert.match(loginForm, />Entrar<\/button>/);
    assert.doesNotMatch(loginForm, /consultar empenhos/i);
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

  it("mantem Usuarios e permissoes separado de Templates", () => {
    assert.match(html, /data-section="users"[^>]*>[^<]*<span[^>]*>[\s\S]*?Usuarios e permissoes<\/a>/);
    assert.match(html, /data-section="settings"[^>]*>[^<]*<span[^>]*>[\s\S]*?Templates<\/a>/);
    assert.match(html, /id="usersView"/);
    assert.match(html, /id="settingsView"/);
  });

  it("preserva os campos, limites e rotulos de aceite", () => {
    assert.match(html, /id="newProcessButton">\+ Novo<\/button>/);
    assert.doesNotMatch(html, /id="newProcessButton">\+ Novo processo<\/button>/);
    assert.match(html, /name="numeroProcesso" maxlength="20"/);
    assert.match(html, /name="numeroEmpenho" maxlength="20"/);
    assert.match(html, /name="fornecedor" maxlength="100"/);
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

  it("oferece atualizacao explicita e anulacao motivada", () => {
    assert.doesNotMatch(html, /id="publicConsultButton"/);
    assert.doesNotMatch(app, /\bpublico\b/);
    assert.match(html, /id="refreshProcessesButton"/);
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
