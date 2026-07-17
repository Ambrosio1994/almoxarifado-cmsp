import {
  enhancePasswordFields,
  isValidPasswordInput,
  PASSWORD_POLICY_MESSAGE,
  resetPasswordVisibility
} from "./password-fields.js";

const state = {
  meta: { status: [], filtrosRapidos: [] },
  processos: [],
  dashboardMetrics: {},
  dashboardCharts: { execucaoMensal: [], distribuicaoStatus: [] },
  dashboardYears: [],
  allProcesses: [],
  processesLoaded: false,
  processesLoading: null,
  fornecedores: [],
  suppliersLoaded: false,
  suppliersLoading: null,
  auditoria: [],
  auditLoaded: false,
  emailHistory: [],
  emailHistoryLoaded: false,
  securityAudit: [],
  detailObservations: [],
  deliveryDraft: null,
  observationProcessId: null,
  selectedProcess: null,
  detailReturnSection: "processes",
  pendingDocumentFile: null,
  detailTab: "general",
  dashboardYear: "",
  supplierSearch: "",
  supplierHistory: "",
  settings: null,
  settingsLoading: null,
  settingsPanel: "templates",
  activeSection: "dashboard",
  detailObservationsError: ""
};

const MAX_DOCUMENT_FILE_BYTES = 15 * 1024 * 1024;

let currentUser = null;
let legacyAuthToken = localStorage.getItem("almoxAuthToken") || "";
let refreshController = null;
let refreshSequence = 0;
let dashboardSequence = 0;
let detailController = null;
let detailSequence = 0;
let handlingUnauthorized = false;
let sessionGeneration = 0;
const authScreen = document.querySelector("#authScreen");
const appShell = document.querySelector("#appShell");
const appStatus = document.querySelector("#appStatus");
const sidebar = document.querySelector("#sidebar");
const sidebarProfile = document.querySelector("#sidebarProfile");
const sidebarAvatar = document.querySelector("#sidebarAvatar");
const sidebarAvatarImage = document.querySelector("#sidebarAvatarImage");
const sidebarAvatarInitials = document.querySelector("#sidebarAvatarInitials");
const sidebarGreeting = document.querySelector("#sidebarGreeting");
const sidebarUserRole = document.querySelector("#sidebarUserRole");
const loginPanel = document.querySelector("#loginPanel");
const loginForm = document.querySelector("#loginForm");
const passwordStep = document.querySelector("#passwordStep");
const emailSubmitButton = document.querySelector("#emailSubmitButton");
const authMessage = document.querySelector("#authMessage");
const logoutButton = document.querySelector("#logoutButton");
const statusFilter = document.querySelector("#statusFilter");
const quickFilter = document.querySelector("#quickFilter");
const quickFilterBar = document.querySelector("#quickFilterBar");
const searchInput = document.querySelector("#searchInput");
const processForm = document.querySelector("#processForm");
const processDialog = document.querySelector("#processDialog");
const processDialogTitle = document.querySelector("#processDialogTitle");
const newProcessButton = document.querySelector("#newProcessButton");
const downloadProcessesButton = document.querySelector("#downloadProcessesButton");
const processExportFormat = document.querySelector("#processExportFormat");
const addMaterialButton = document.querySelector("#addMaterialButton");
const materialsList = document.querySelector("#materialsList");
const formMessage = document.querySelector("#formMessage");
const table = document.querySelector("#processTable");
const dialog = document.querySelector("#observationsDialog");
const observationsList = document.querySelector("#observationsList");
const observationForm = document.querySelector("#observationForm");
const observationMessage = document.querySelector("#observationMessage");
const editObservationDialog = document.querySelector("#editObservationDialog");
const editObservationForm = document.querySelector("#editObservationForm");
const editObservationMessage = document.querySelector("#editObservationMessage");
const deliveryDialog = document.querySelector("#deliveryDialog");
const deliveryForm = document.querySelector("#deliveryForm");
const deliveryDialogTitle = document.querySelector("#deliveryDialogTitle");
const deliveryMaterials = document.querySelector("#deliveryMaterials");
const deliveryMessage = document.querySelector("#deliveryMessage");
const cancelDelivery = document.querySelector("#cancelDelivery");
const processListView = document.querySelector("#processListView");
const processDetailView = document.querySelector("#processDetailView");
const backToProcesses = document.querySelector("#backToProcesses");
const detailProcessNumber = document.querySelector("#detailProcessNumber");
const detailStatusBadges = document.querySelector("#detailStatusBadges");
const detailSubtitle = document.querySelector("#detailSubtitle");
const detailPanel = document.querySelector("#detailPanel");
const detailTabs = document.querySelectorAll(".detail-tab");
const downloadProcessButton = document.querySelector("#downloadProcessButton");
const downloadDialog = document.querySelector("#downloadDialog");
const downloadChoices = document.querySelectorAll("[data-download-format]");
const supplierInfoDialog = document.querySelector("#supplierInfoDialog");
const supplierInfoForm = document.querySelector("#supplierInfoForm");
const supplierInfoMessage = document.querySelector("#supplierInfoMessage");
const cancelSupplierInfo = document.querySelector("#cancelSupplierInfo");
const dashboardView = document.querySelector("#dashboardView");
const suppliersView = document.querySelector("#suppliersView");
const auditView = document.querySelector("#auditView");
const usersView = document.querySelector("#usersView");
const settingsView = document.querySelector("#settingsView");
const navItems = document.querySelectorAll(".nav-item");
const sectionTitle = document.querySelector("#sectionTitle");
const sidebarToggle = document.querySelector("#sidebarToggle");
const sidebarResizer = document.querySelector("#sidebarResizer");
const mobileMenuToggle = document.querySelector("#mobileMenuToggle");
const sidebarBackdrop = document.querySelector("#sidebarBackdrop");
const themeToggle = document.querySelector("#themeToggle");
const documentMetadataDialog = document.querySelector("#documentMetadataDialog");
const documentMetadataForm = document.querySelector("#documentMetadataForm");
const documentSelectedFile = document.querySelector("#documentSelectedFile");
const cancelDocumentMetadata = document.querySelector("#cancelDocumentMetadata");
const changePasswordDialog = document.querySelector("#changePasswordDialog");
const changePasswordForm = document.querySelector("#changePasswordForm");
const changePasswordMessage = document.querySelector("#changePasswordMessage");
const changePasswordCloseButton = document.querySelector("#changePasswordCloseButton");
const adminPasswordDialog = document.querySelector("#adminPasswordDialog");
const adminPasswordForm = document.querySelector("#adminPasswordForm");
const adminPasswordUser = document.querySelector("#adminPasswordUser");
const adminPasswordMessage = document.querySelector("#adminPasswordMessage");

initTheme();
await initAuth();

function initTheme() {
  const savedTheme = localStorage.getItem("almoxTheme") || "light";
  applyTheme(savedTheme === "dark" ? "dark" : "light");
  themeToggle?.addEventListener("click", () => {
    const nextTheme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    applyTheme(nextTheme);
    localStorage.setItem("almoxTheme", nextTheme);
  });
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const isDark = theme === "dark";
  if (!themeToggle) return;
  themeToggle.setAttribute("aria-label", isDark ? "Alternar para modo claro" : "Alternar para modo escuro");
  themeToggle.querySelector("span").textContent = isDark ? "☼" : "◐";
  themeToggle.querySelector("strong").textContent = isDark ? "Claro" : "Escuro";
}

async function initAuth() {
  bindAuthEvents();
  try {
    const user = await api("/auth/session", {
      skipAuthRedirect: true,
      legacyToken: legacyAuthToken
    });
    setCurrentUser(user);
    showApp();
    enforceRequiredPasswordChange();
    await bootSafely();
  } catch (error) {
    if (error.status === 401) {
      clearClientSession();
      showAuth();
    } else {
      showAuth();
      showSessionValidationError();
    }
  } finally {
    legacyAuthToken = "";
    localStorage.removeItem("almoxAuthToken");
  }
}

function bindAuthEvents() {
  enhancePasswordFields(document);
  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    authMessage.textContent = "";
    setFormBusy(loginForm, true, "Entrando...");
    const data = Object.fromEntries(new FormData(loginForm));
    try {
      const response = await api("/auth/login", {
        method: "POST",
        body: JSON.stringify(data),
        skipAuthRedirect: true
      });
      await startSession(response);
    } catch (error) {
      authMessage.textContent = error.message;
      loginForm.elements.senha.value = "";
      resetPasswordVisibility(loginForm);
      loginForm.elements.senha.focus();
    } finally {
      setFormBusy(loginForm, false);
    }
  });

  logoutButton.addEventListener("click", async () => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 8000);
    const logoutRequest = fetch("/auth/logout", {
      method: "POST",
      credentials: "same-origin",
      signal: controller.signal
    });
    clearClientSession();
    showAuth();
    authMessage.textContent = "Encerrando sessao...";
    setFormBusy(loginForm, true, "Encerrando...");
    try {
      const response = await logoutRequest;
      if (!response.ok && response.status !== 401) throw new Error("Nao foi possivel encerrar a sessao.");
      authMessage.textContent = "Sessao encerrada.";
    } catch (error) {
      const message = error.name === "AbortError"
        ? "O servidor demorou para confirmar o encerramento."
        : error.message || "Nao foi possivel confirmar o encerramento no servidor.";
      authMessage.textContent = `${message} A sessao visual foi limpa; tente novamente se ela reaparecer.`;
    } finally {
      window.clearTimeout(timeout);
      setFormBusy(loginForm, false);
    }
  });

  sidebarProfile?.addEventListener("click", () => {
    if (changePasswordDialog && !changePasswordDialog.open) changePasswordDialog.showModal();
  });
  sidebarProfile?.addEventListener("keydown", (event) => {
    if (["Enter", " "].includes(event.key)) {
      event.preventDefault();
      if (changePasswordDialog && !changePasswordDialog.open) changePasswordDialog.showModal();
    }
  });
  changePasswordForm?.addEventListener("submit", changePassword);
  adminPasswordForm?.addEventListener("submit", saveManagedUserPassword);
  changePasswordDialog?.addEventListener("close", () => resetSensitiveForm(changePasswordForm, changePasswordMessage));
  changePasswordDialog?.addEventListener("cancel", (event) => {
    if (currentUser?.precisaDefinirSenha) event.preventDefault();
  });
  adminPasswordDialog?.addEventListener("close", () => resetSensitiveForm(adminPasswordForm, adminPasswordMessage));
}

async function changePassword(event) {
  event.preventDefault();
  changePasswordMessage.textContent = "";
  const passwordData = Object.fromEntries(new FormData(event.currentTarget));
  if (passwordData.novaSenha !== passwordData.confirmacao) {
    changePasswordMessage.textContent = "A confirmacao da nova senha deve ser identica.";
    return;
  }
  if (!isValidPasswordInput(passwordData.novaSenha)) {
    changePasswordMessage.textContent = passwordPolicyMessage();
    return;
  }
  setFormBusy(event.currentTarget, true, "Alterando...");
  try {
    const response = await api("/auth/change-password", {
      method: "POST",
      body: JSON.stringify(passwordData)
    });
    if (response.user) setCurrentUser(response.user);
    if (currentUser) currentUser.precisaDefinirSenha = false;
    enforceRequiredPasswordChange();
    event.currentTarget.reset();
    changePasswordDialog.close();
  } catch (error) {
    changePasswordMessage.textContent = error.message;
  } finally {
    setFormBusy(event.currentTarget, false);
  }
}

async function startSession(response) {
  setCurrentUser(response.user);
  showApp();
  enforceRequiredPasswordChange();
  await bootSafely();
}

async function bootSafely() {
  clearAppStatus();
  try {
    await boot();
  } catch (error) {
    if (error.name === "AbortError") return;
    showAppError(error.message || "Nao foi possivel carregar os dados da aplicacao.");
  }
}

function showAppError(message) {
  if (!appStatus) return;
  appStatus.replaceChildren();
  appStatus.classList.remove("success");
  const text = document.createElement("span");
  text.textContent = message;
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "secondary";
  retry.textContent = "Tentar novamente";
  retry.addEventListener("click", () => bootSafely(), { once: true });
  appStatus.append(text, retry);
  appStatus.classList.remove("hidden");
}

function showAppNotice(message) {
  if (!appStatus) return;
  appStatus.replaceChildren();
  const text = document.createElement("span");
  text.textContent = message;
  appStatus.append(text);
  appStatus.classList.add("success");
  appStatus.classList.remove("hidden");
}

function clearAppStatus() {
  appStatus?.classList.add("hidden");
  appStatus?.classList.remove("success");
  appStatus?.replaceChildren();
}

function clearClientSession() {
  sessionGeneration += 1;
  localStorage.removeItem("almoxAuthToken");
  legacyAuthToken = "";
  currentUser = null;
  refreshController?.abort();
  detailController?.abort();
  refreshSequence += 1;
  dashboardSequence += 1;
  detailSequence += 1;
  state.settings = null;
  state.settingsLoading = null;
  state.auditLoaded = false;
  state.emailHistoryLoaded = false;
  state.suppliersLoaded = false;
  state.suppliersLoading = null;
  if (changePasswordCloseButton) changePasswordCloseButton.disabled = false;
  changePasswordDialog?.classList.remove("password-change-required");
  [
    processDialog,
    dialog,
    editObservationDialog,
    deliveryDialog,
    downloadDialog,
    documentMetadataDialog,
    supplierInfoDialog,
    changePasswordDialog,
    adminPasswordDialog
  ].forEach((modal) => {
    if (modal?.open) modal.close();
  });
  processForm?.reset();
  observationForm?.reset();
  deliveryForm?.reset();
  documentMetadataForm?.reset();
  supplierInfoForm?.reset();
  resetApplicationData();
}

function resetApplicationData() {
  state.meta = { status: [], filtrosRapidos: [] };
  state.processos = [];
  state.dashboardMetrics = {};
  state.dashboardCharts = { execucaoMensal: [], distribuicaoStatus: [] };
  state.dashboardYears = [];
  state.allProcesses = [];
  state.processesLoaded = false;
  state.processesLoading = null;
  state.fornecedores = [];
  state.auditoria = [];
  state.securityAudit = [];
  state.emailHistory = [];
  state.detailObservations = [];
  state.deliveryDraft = null;
  state.observationProcessId = null;
  state.selectedProcess = null;
  state.detailReturnSection = "processes";
  state.pendingDocumentFile = null;
  state.detailTab = "general";
  state.dashboardYear = "";
  state.supplierSearch = "";
  state.supplierHistory = "";
  state.settingsPanel = "templates";
  state.activeSection = "dashboard";
  state.detailObservationsError = "";
  table?.replaceChildren();
  detailPanel?.replaceChildren();
  dashboardView?.replaceChildren();
  suppliersView?.replaceChildren();
  auditView?.replaceChildren();
  usersView?.replaceChildren();
  settingsView?.replaceChildren();
  if (detailProcessNumber) detailProcessNumber.textContent = "Processo";
  if (detailStatusBadges) detailStatusBadges.replaceChildren();
  if (detailSubtitle) detailSubtitle.textContent = "";
  if (searchInput) searchInput.value = "";
  if (statusFilter) statusFilter.value = "";
  if (quickFilter) quickFilter.value = "";
  quickFilterBar?.replaceChildren();
  clearAppStatus();
}

function handleUnauthorized() {
  if (handlingUnauthorized) return;
  handlingUnauthorized = true;
  clearClientSession();
  showAuth();
  authMessage.textContent = "Sua sessao expirou. Entre novamente para continuar.";
  handlingUnauthorized = false;
}

function setCurrentUser(user) {
  currentUser = {
    email: user.email,
    name: user.nome || user.name || user.email,
    role: user.role || "almoxarifado",
    foto: user.foto || "",
    precisaDefinirSenha: Boolean(user.precisaDefinirSenha)
  };
  applyRoleVisibility();
  renderSidebarProfile();
}

function enforceRequiredPasswordChange() {
  const required = Boolean(currentUser?.precisaDefinirSenha);
  if (changePasswordCloseButton) changePasswordCloseButton.disabled = required;
  changePasswordDialog?.classList.toggle("password-change-required", required);
  if (required && changePasswordDialog && !changePasswordDialog.open) {
    changePasswordMessage.textContent = "Defina uma nova senha para continuar usando o sistema.";
    changePasswordDialog.showModal();
    changePasswordForm?.elements.senhaAtual?.focus();
  }
}

function showAuth() {
  document.body.classList.remove("auth-pending");
  authScreen.classList.remove("hidden");
  appShell.classList.add("hidden");
  sidebar.classList.add("hidden");
  closeMobileMenu();
  showAuthPanel("login");
  resetPasswordVisibility(loginForm);
  loginForm?.elements.email?.focus();
}

function showSessionValidationError() {
  authMessage.replaceChildren();
  const text = document.createElement("span");
  text.textContent = "Nao foi possivel confirmar sua sessao. Ela pode continuar valida; tente novamente ou entre com suas credenciais.";
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "secondary auth-retry-button";
  retry.textContent = "Tentar validar novamente";
  retry.addEventListener("click", async () => {
    setButtonBusy(retry, true, "Validando...");
    setFormBusy(loginForm, true, "Validando...");
    try {
      const user = await api("/auth/session", { skipAuthRedirect: true });
      setCurrentUser(user);
      authMessage.textContent = "";
      showApp();
      enforceRequiredPasswordChange();
      await bootSafely();
    } catch (error) {
      if (error.status === 401) {
        clearClientSession();
        showAuth();
        authMessage.textContent = "Sua sessao expirou. Entre novamente para continuar.";
      } else {
        showSessionValidationError();
      }
    } finally {
      setButtonBusy(retry, false);
      setFormBusy(loginForm, false);
    }
  }, { once: true });
  authMessage.append(text, retry);
}

function showApp() {
  document.body.classList.remove("auth-pending");
  authScreen.classList.add("hidden");
  appShell.classList.remove("hidden");
  sidebar.classList.remove("hidden");
  activateSectionShell("dashboard");
  dashboardView.innerHTML = '<p class="empty-state" role="status">Carregando painel...</p>';
  renderSidebarProfile();
}

function renderSidebarProfile() {
  if (!sidebarProfile || !currentUser) return;
  const name = displayFirstName(currentUser.name || currentUser.email || "Usuario");
  sidebarGreeting.textContent = `Olá, ${name}`;
  sidebarUserRole.textContent = currentUser.role || "almoxarifado";
  sidebarAvatarInitials.textContent = userInitials(currentUser.name || currentUser.email);
  if (currentUser.foto) {
    sidebarAvatarImage.src = currentUser.foto;
    sidebarAvatarImage.hidden = false;
  } else {
    sidebarAvatarImage.removeAttribute("src");
    sidebarAvatarImage.hidden = true;
  }
  sidebarAvatar.classList.toggle("has-image", Boolean(currentUser.foto));
}

function applyRoleVisibility() {
  const role = currentUser?.role || "";
  document.querySelector('[data-section="settings"]')?.classList.toggle("hidden", role !== "admin");
  document.querySelector('[data-section="users"]')?.classList.toggle("hidden", role !== "admin");
  document.querySelector('[data-section="audit"]')?.classList.toggle("hidden", !["admin", "auditor"].includes(role));
  document.querySelector('[data-detail-tab="emails"]')?.classList.toggle("hidden", !["admin", "auditor"].includes(role));
  newProcessButton?.classList.toggle("hidden", role === "auditor");
  observationForm?.classList.toggle("hidden", role === "auditor");
}

sidebarAvatarImage?.addEventListener("error", () => {
  sidebarAvatarImage.hidden = true;
  sidebarAvatarImage.removeAttribute("src");
  sidebarAvatar?.classList.remove("has-image");
});

function displayFirstName(name = "") {
  return String(name).trim().split(/\s+/)[0] || "Usuario";
}

function userInitials(name = "") {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? [parts[0][0], parts[parts.length - 1][0]] : [parts[0]?.[0] || "U"];
  return letters.join("").toUpperCase();
}

function showAuthPanel(panel) {
  loginPanel.classList.toggle("hidden", panel !== "login");
  if (panel !== "login") authMessage.textContent = "";
  if (panel === "login") {
    if (passwordStep?.querySelector("input")) {
      passwordStep.querySelector("input").required = true;
      passwordStep.querySelector("input").value = "";
    }
    resetPasswordVisibility(loginForm);
    if (emailSubmitButton) emailSubmitButton.textContent = "Entrar";
  }
}

async function boot() {
  const [meta] = await Promise.all([
    api("/api/meta"),
    loadDashboardData()
  ]);
  state.meta = meta;
  fillSelect(statusFilter, state.meta.status, "Todos os status");
  fillSelect(quickFilter, state.meta.filtrosRapidos, "Filtros rapidos");
  renderQuickFilters();
  await openSection("dashboard");
}

async function loadDashboardData(year = state.dashboardYear) {
  const sequence = ++dashboardSequence;
  const params = new URLSearchParams();
  if (year) params.set("ano", year);
  const query = params.toString();
  const payload = await api(`/api/dashboard${query ? `?${query}` : ""}`);
  if (sequence !== dashboardSequence) return null;
  const normalized = normalizeDashboardPayload(payload, year);
  state.dashboardMetrics = normalized.metrics;
  state.dashboardCharts = normalized.charts;
  state.dashboardYears = normalized.anos;
  state.dashboardYear = String(normalized.ano);
  return normalized;
}

function normalizeDashboardPayload(payload = {}, requestedYear = "") {
  const metricsCandidate = payload.metrics || payload.metricas || payload.dashboardMetrics || payload;
  const metrics = metricsCandidate && typeof metricsCandidate === "object" ? metricsCandidate : {};
  const charts = payload.charts || payload.graficos || {};
  const rawYears = payload.anos || payload.years || [];
  const anos = (Array.isArray(rawYears) ? rawYears : [])
    .map(Number)
    .filter(Number.isInteger)
    .sort((a, b) => b - a);
  const fallbackYear = Number(requestedYear) || new Date().getFullYear();
  return {
    metrics,
    charts: {
      execucaoMensal: Array.isArray(charts.execucaoMensal || payload.execucaoMensal) ? (charts.execucaoMensal || payload.execucaoMensal) : [],
      distribuicaoStatus: Array.isArray(charts.distribuicaoStatus || payload.distribuicaoStatus) ? (charts.distribuicaoStatus || payload.distribuicaoStatus) : []
    },
    anos: anos.length ? anos : [fallbackYear],
    ano: Number(payload.ano || payload.year || requestedYear) || anos[0] || fallbackYear
  };
}

async function ensureProcessesLoaded({ force = false } = {}) {
  if (state.processesLoaded && !force) return state.allProcesses;
  if (state.processesLoading && !force) return state.processesLoading;
  refreshController?.abort();
  const controller = new AbortController();
  refreshController = controller;
  const sequence = ++refreshSequence;
  const request = api("/api/processes", { signal: controller.signal })
    .then((processes) => {
      if (sequence !== refreshSequence) return state.allProcesses;
      state.allProcesses = processes;
      state.processesLoaded = true;
      return processes;
    });
  state.processesLoading = request;
  try {
    return await request;
  } finally {
    if (refreshController === controller) refreshController = null;
    if (state.processesLoading === request) state.processesLoading = null;
  }
}

async function renderProcessesView() {
  if (!state.processesLoaded) {
    table.innerHTML = '<tr class="empty-table-row"><td colspan="10" role="status">Carregando processos...</td></tr>';
  }
  await ensureProcessesLoaded();
  applyProcessFilters();
  renderProcessData();
}

async function refresh({ reload = true, updateDashboard = reload } = {}) {
  if (reload) {
    const [processResult, dashboardResult] = await Promise.allSettled([
      ensureProcessesLoaded({ force: true }),
      updateDashboard ? loadDashboardData(state.dashboardYear) : Promise.resolve(null)
    ]);
    if (processResult.status === "rejected") {
      if (processResult.reason?.name === "AbortError") return;
      throw processResult.reason;
    }
    if (dashboardResult.status === "rejected" && dashboardResult.reason?.name !== "AbortError") {
      showAppError(`A lista foi atualizada, mas o painel nao: ${dashboardResult.reason?.message || "falha ao carregar os indicadores"}`);
    } else if (dashboardResult.value && state.activeSection === "dashboard") {
      renderDashboardView();
    }
  }
  applyProcessFilters();
  renderProcessData();
}

function applyProcessFilters() {
  const query = normalizeText(searchInput?.value || "");
  const status = statusFilter?.value || "";
  const quick = quickFilter?.value || "";
  state.processos = state.allProcesses
    .filter((processo) => !processo.inativo)
    .filter((processo) => !status || processo.status === status)
    .filter((processo) => {
      if (!query) return true;
      return [
        processo.numeroProcesso,
        processo.numeroEmpenho,
        processo.numeroNotaFiscal,
        processo.fornecedor,
        processo.material,
        processo.status,
        ...(processo.materiais || []).map((material) => material.descricao)
      ].some((value) => normalizeText(value).includes(query));
    })
    .filter((processo) => matchesQuickFilter(processo, quick));
}

function matchesQuickFilter(processo, quickFilterValue) {
  if (!quickFilterValue) return true;
  if (["Em atraso", "Mais de 30 dias"].includes(quickFilterValue)) return isOverdue(processo);
  if (quickFilterValue === "Pendentes de liquidacao") return ["Entregue", "Aguardando envio para liquidacao"].includes(processo.status);
  return processo.status === quickFilterValue;
}

function renderProcessData() {
  renderTable();
}

function processFilterParams() {
  const params = new URLSearchParams();
  if (searchInput.value) params.set("q", searchInput.value);
  if (statusFilter.value) params.set("status", statusFilter.value);
  if (quickFilter.value) params.set("filtroRapido", quickFilter.value);
  return params;
}

async function downloadProcesses() {
  const params = processFilterParams();
  const format = processExportFormat?.value || "excel";
  params.set("format", format);
  setButtonBusy(downloadProcessesButton, true, "Gerando...");
  try {
    const response = await fetch(`/api/processes/download?${params}`, { credentials: "same-origin" });
    if (response.status === 401) {
      handleUnauthorized();
      return;
    }
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || "Nao foi possivel gerar o download.");
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    triggerBlobDownload(url, processExportFileName(format));
  } catch (error) {
    if (error.name !== "AbortError") alert(error.message || "Nao foi possivel gerar o download.");
  } finally {
    setButtonBusy(downloadProcessesButton, false);
  }
}

function triggerBlobDownload(url, fileName = "") {
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function processExportFileName(format = "excel") {
  const date = new Date().toISOString().slice(0, 10);
  const extensions = { excel: "xls", pdf: "pdf", csv: "csv" };
  return `empenhos-${date}.${extensions[format] || "xls"}`;
}

function renderTable() {
  table.innerHTML = state.processos.length ? state.processos.map((processo) => `
    <tr data-edit="${escapeAttribute(processo.id)}">
      <td class="strong-cell"><button type="button" class="link-button process-open-button" data-open-process="${escapeAttribute(processo.id)}" aria-label="Abrir ${escapeAttribute(processAccessibleName(processo))}">${empty(processo.numeroProcesso)}</button></td>
      <td class="mono-cell">${documentCell(processo.numeroEmpenho, "Nota de Empenho", processo.documentos?.notaEmpenho)}</td>
      <td>${empty(processo.fornecedor)}</td>
      <td>${materialsCell(processo.materiais)}</td>
      <td class="money-cell">${money(processo.valorTotal)}</td>
      <td>${dateCell(deadlineDate(processo))}</td>
      <td>${daysCell(processo)}</td>
      <td>${dateCell(processo.dataEntrega)}</td>
      <td>${dateCell(processo.dataEnvioLiquidacao)}</td>
      <td>${statusBadges(processo)}</td>
    </tr>
  `).join("") : '<tr class="empty-table-row"><td colspan="10">Nenhum processo encontrado.</td></tr>';
}

function processAccessibleName(processo = {}) {
  if (processo.numeroProcesso) return `processo ${processo.numeroProcesso}`;
  if (processo.numeroEmpenho) return `empenho ${processo.numeroEmpenho}`;
  return "processo sem numero";
}

processForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(processForm));
  data.materiais = readMaterials();
  const id = data.id;
  delete data.id;
  formMessage.textContent = "";
  if (!String(data.numeroProcesso || "").trim() && !String(data.numeroEmpenho || "").trim()) {
    formMessage.textContent = "Informe o numero do processo, o numero do empenho ou ambos.";
    return;
  }
  if (data.dataProcesso && !normalizeDateInput(data.dataProcesso)) {
    formMessage.textContent = "Informe uma data do processo valida no formato DD-MM-AAAA.";
    return;
  }

  setFormBusy(processForm, true, "Salvando...");
  let savedProcess;
  try {
    savedProcess = await api(id ? `/api/processes/${id}` : "/api/processes", {
      method: id ? "PUT" : "POST",
      body: JSON.stringify(data)
    });
  } catch (error) {
    formMessage.textContent = error.message;
    return;
  } finally {
    setFormBusy(processForm, false);
  }

  const wasSelected = state.selectedProcess?.id === savedProcess.id;
  if (wasSelected) state.selectedProcess = savedProcess;
  clearForm();
  processDialog.close();
  try {
    await refresh();
    await refreshAudit();
    if (wasSelected) {
      state.detailObservations = await loadDetailObservations(savedProcess.id);
      renderProcessDetail();
    }
  } catch (error) {
    showAppError(`O processo foi salvo, mas a lista nao foi atualizada: ${error.message}`);
  }
});

document.querySelector("#clearForm").addEventListener("click", clearForm);
newProcessButton.addEventListener("click", () => openProcessDialog());
downloadProcessesButton?.addEventListener("click", downloadProcesses);
addMaterialButton.addEventListener("click", () => addMaterialRow());
searchInput.addEventListener("input", debounce(() => refresh({ reload: false }), 180));
statusFilter.addEventListener("change", () => refresh({ reload: false }));
quickFilter.addEventListener("change", () => refresh({ reload: false }));
documentMetadataForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  await saveComplementaryDocument();
});
cancelDocumentMetadata?.addEventListener("click", () => {
  state.pendingDocumentFile = null;
  documentMetadataDialog.close();
});
materialsList.addEventListener("click", (event) => {
  if (!event.target.dataset.removeMaterial) return;
  event.target.closest(".material-row").remove();
  ensureOneMaterialRow();
});

table.addEventListener("click", async (event) => {
  const editId = event.target.closest("[data-open-process]")?.dataset.openProcess
    || event.target.closest("tr")?.dataset.edit;
  const notesId = event.target.dataset.notes;

  if (editId) {
    const processo = state.processos.find((item) => item.id === editId);
    openProcessDetail(processo, "processes");
  }

  if (notesId) {
    await openObservationsDialog(notesId);
  }
});

backToProcesses.addEventListener("click", closeProcessDetail);

detailTabs.forEach((tab) => {
  tab.addEventListener("click", async () => {
    state.detailTab = tab.dataset.detailTab;
    detailTabs.forEach((item) => setTabActive(item, item === tab));
    detailPanel.setAttribute("aria-busy", "true");
    try {
      if (state.detailTab === "timeline" && !state.auditLoaded && ["admin", "auditor"].includes(currentUser.role)) await loadAuditData();
      if (state.detailTab === "emails" && !state.emailHistoryLoaded && ["admin", "auditor"].includes(currentUser.role)) {
        state.emailHistory = await api("/api/emails/history");
        state.emailHistoryLoaded = true;
      }
      renderDetailPanel();
    } catch (error) {
      renderInlineError(detailPanel, error.message || "Nao foi possivel carregar este modulo.");
    } finally {
      detailPanel.removeAttribute("aria-busy");
    }
  });
  tab.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const available = [...detailTabs].filter((item) => !item.classList.contains("hidden"));
    const currentIndex = available.indexOf(tab);
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? available.length - 1
        : (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + available.length) % available.length;
    event.preventDefault();
    available[nextIndex]?.focus();
    available[nextIndex]?.click();
  });
});

function setTabActive(tab, active) {
  tab.classList.toggle("active", active);
  tab.setAttribute("aria-selected", String(active));
  tab.tabIndex = active ? 0 : -1;
  if (active && tab.id) detailPanel.setAttribute("aria-labelledby", tab.id);
}

downloadProcessButton.addEventListener("click", () => {
  if (!state.selectedProcess) return;
  downloadDialog?.showModal();
});

downloadChoices.forEach((button) => {
  button.addEventListener("click", async () => {
    if (!state.selectedProcess) return;
    downloadDialog?.close();
    try {
      await downloadProcess(state.selectedProcess.id, button.dataset.downloadFormat);
    } catch (error) {
      alert(error.message || "Nao foi possivel baixar o processo.");
    }
  });
});

supplierInfoForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  supplierInfoMessage.textContent = "";
  const data = Object.fromEntries(new FormData(supplierInfoForm));
  const razaoSocial = String(data.razaoSocial || "").trim();
  if (!razaoSocial) return;
  setFormBusy(event.currentTarget, true, "Salvando...");
  try {
    const supplier = await api("/api/suppliers", {
      method: "POST",
      body: JSON.stringify({
        razaoSocial,
        emails: splitSupplierInfo(data.emails),
        telefones: splitSupplierInfo(data.telefones),
        enderecos: splitSupplierInfo(data.enderecos),
        observacoes: String(data.observacoes || "").trim()
      })
    });
    const index = state.fornecedores.findIndex((item) => normalizeText(item.razaoSocial) === normalizeText(supplier.razaoSocial));
    if (index >= 0) state.fornecedores[index] = supplier;
    else state.fornecedores.push(supplier);
    supplierInfoDialog?.close();
    await renderSuppliersView();
  } catch (error) {
    supplierInfoMessage.textContent = error.message || "Nao foi possivel salvar as informacoes.";
  } finally {
    setFormBusy(event.currentTarget, false);
  }
});

cancelSupplierInfo?.addEventListener("click", () => {
  supplierInfoDialog?.close();
});

navItems.forEach((item) => {
  item.addEventListener("click", (event) => {
    event.preventDefault();
    void openSection(item.dataset.section);
    closeMobileMenu();
  });
});

function setMobileMenu(open) {
  document.body.classList.toggle("mobile-menu-open", open);
  mobileMenuToggle?.setAttribute("aria-expanded", String(open));
  mobileMenuToggle?.setAttribute("aria-label", open ? "Fechar menu" : "Abrir menu");
  sidebarBackdrop?.classList.toggle("hidden", !open);
  if (open) requestAnimationFrame(() => sidebar.querySelector(".nav-item:not(.hidden)")?.focus());
}

function closeMobileMenu() {
  setMobileMenu(false);
}

mobileMenuToggle?.addEventListener("click", () => {
  document.body.classList.remove("sidebar-collapsed");
  setMobileMenu(!document.body.classList.contains("mobile-menu-open"));
});
sidebarBackdrop?.addEventListener("click", closeMobileMenu);
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && document.body.classList.contains("mobile-menu-open")) {
    closeMobileMenu();
    mobileMenuToggle?.focus();
  }
});
window.addEventListener("resize", () => {
  if (window.innerWidth > 980) {
    closeMobileMenu();
  } else {
    document.body.classList.remove("sidebar-collapsed");
  }
});

sidebarToggle?.addEventListener("click", () => {
  document.body.classList.toggle("sidebar-collapsed");
  const collapsed = document.body.classList.contains("sidebar-collapsed");
  sidebarToggle.textContent = collapsed ? "›" : "‹";
  sidebarToggle.setAttribute("aria-label", collapsed ? "Expandir menu" : "Minimizar menu");
});

sidebarResizer?.addEventListener("pointerdown", (event) => {
  if (document.body.classList.contains("sidebar-collapsed")) return;
  event.preventDefault();
  sidebarResizer.setPointerCapture(event.pointerId);
  document.body.classList.add("resizing-sidebar");
});

sidebarResizer?.addEventListener("pointermove", (event) => {
  if (!document.body.classList.contains("resizing-sidebar")) return;
  const width = Math.min(360, Math.max(208, event.clientX));
  document.documentElement.style.setProperty("--sidebar-width", `${width}px`);
});

sidebarResizer?.addEventListener("pointerup", (event) => {
  sidebarResizer.releasePointerCapture(event.pointerId);
  document.body.classList.remove("resizing-sidebar");
});

sidebarResizer?.addEventListener("pointercancel", () => {
  document.body.classList.remove("resizing-sidebar");
});

detailPanel.addEventListener("click", async (event) => {
  try {
    if (event.target.dataset.openEdit) {
      openProcessDialog(state.selectedProcess);
    }

    const notesId = event.target.dataset.openNotes;
    if (notesId) {
      await openObservationsDialog(notesId);
    }

    const attachKey = event.target.dataset.attachDocument;
    if (attachKey) {
      await attachDocument(attachKey);
    }

    const testEmailProcessId = event.target.dataset.sendTestEmail;
    if (testEmailProcessId) {
      await sendTestEmail(testEmailProcessId);
    }

    const openPath = event.target.dataset.openDocument;
    if (openPath) {
      await downloadDocument(openPath);
    }

    const downloadPath = event.target.dataset.downloadDocument;
    if (downloadPath) {
      await downloadDocument(downloadPath);
    }

    const removeDocumentKey = event.target.dataset.removeDocument;
    if (removeDocumentKey) {
      await removeDocument(removeDocumentKey);
    }

    const editObservationId = event.target.dataset.editObservation;
    if (editObservationId) {
      await editObservation(editObservationId);
    }

    const deleteObservationId = event.target.dataset.deleteObservation;
    if (deleteObservationId) {
      await deleteObservation(deleteObservationId);
    }

    if (event.target.dataset.updateStatus) {
      await saveNewProcessData();
    }

    if (event.target.dataset.registerPartialDelivery) {
      await registerPartialDelivery();
    }

    if (event.target.dataset.showNewData) {
      const step = nextProcessStep(state.selectedProcess);
      if (["Entrega parcial", "Entregue"].includes(step?.status)) {
        openDeliveryDialog("", step.status === "Entregue");
        return;
      }
      const panel = detailPanel.querySelector("[data-new-data-panel]");
      panel?.classList.toggle("hidden");
      panel?.querySelector("[data-detail-date]")?.focus();
    }
  } catch (error) {
    if (error.name !== "AbortError") alert(error.message || "Nao foi possivel concluir a operacao.");
  }
});

async function sendTestEmail(processId) {
  try {
    const result = await api("/api/emails/run-due", {
      method: "POST",
      body: JSON.stringify({ processId, force: true, tipo: "oficioFornecedor" })
    });
    if (!result.enabled) {
      alert(result.error || "Configure o servidor SMTP antes de enviar.");
      return;
    }
    if (result.sent?.length) {
      state.emailHistory = await api("/api/emails/history");
      state.emailHistoryLoaded = true;
      renderDetailPanel();
      alert(`E-mail de teste enviado para ${result.sent[0].destinatarios.join(", ")}.`);
      return;
    }
    if (result.failed?.length) {
      alert(result.failed[0].erro || "Falha ao enviar e-mail de teste.");
      return;
    }
    alert("Nenhum e-mail foi enviado para este empenho.");
  } catch (error) {
    alert(error.message || "Nao foi possivel enviar o e-mail de teste.");
  }
}

observationForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  observationMessage.textContent = "";
  const data = Object.fromEntries(new FormData(observationForm));
  setFormBusy(observationForm, true, "Registrando...");
  try {
    await api(`/api/processes/${state.observationProcessId}/observations`, {
      method: "POST",
      body: JSON.stringify(data)
    });
    observationForm.reset();
    await refreshObservationViews();
    observationMessage.textContent = "Observacao registrada.";
  } catch (error) {
    observationMessage.textContent = error.message || "Nao foi possivel registrar a observacao.";
  } finally {
    setFormBusy(observationForm, false);
  }
});

async function openObservationsDialog(processId) {
  state.observationProcessId = processId;
  observationMessage.textContent = "";
  observationsList.innerHTML = '<p class="empty-state" role="status">Carregando observacoes...</p>';
  const processo = processById(processId);
  observationForm.classList.toggle("hidden", !canEditGeneralInUi(processo));
  dialog.showModal();
  try {
    await loadObservations();
  } catch (error) {
    renderInlineError(observationsList, error.message || "Nao foi possivel carregar as observacoes.");
  }
}

async function loadObservations() {
  const items = await api(`/api/processes/${state.observationProcessId}/observations`);
  const processo = processById(state.observationProcessId);
  observationsList.innerHTML = items.length ? items.map((item) => `
    <article class="note">
      <span>${escapeHtml(formatDateTime(item.criadoEm))} - ${escapeHtml(item.usuario)}</span>
      <div>${escapeHtml(item.conteudo)}</div>
      ${canManageObservation(item, processo) ? `<div class="note-actions">
        <button type="button" class="secondary" data-edit-observation="${escapeAttribute(item.id)}">Alterar</button>
        <button type="button" class="secondary" data-delete-observation="${escapeAttribute(item.id)}">Excluir</button>
      </div>` : ""}
    </article>
  `).join("") : "<p>Nenhuma observacao registrada.</p>";
  return items;
}

observationsList.addEventListener("click", async (event) => {
  const editObservationId = event.target.dataset.editObservation;
  if (editObservationId) await editObservation(editObservationId);

  const deleteObservationId = event.target.dataset.deleteObservation;
  if (deleteObservationId) await deleteObservation(deleteObservationId);
});

editObservationForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  editObservationMessage.textContent = "";
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form));
  const conteudo = String(data.conteudo || "").trim();
  if (!conteudo || conteudo.length > 350) {
    editObservationMessage.textContent = "A observacao deve ter entre 1 e 350 caracteres.";
    return;
  }
  setFormBusy(form, true, "Salvando...");
  try {
    await api(`/api/processes/${encodeURIComponent(data.processId)}/observations/${encodeURIComponent(data.observationId)}`, {
      method: "PUT",
      body: JSON.stringify({ conteudo })
    });
    editObservationDialog.close();
    await refreshObservationViews();
    observationMessage.textContent = "Observacao alterada.";
  } catch (error) {
    editObservationMessage.textContent = error.message || "Nao foi possivel alterar a observacao.";
  } finally {
    setFormBusy(form, false);
  }
});

editObservationDialog?.addEventListener("close", () => {
  editObservationForm?.reset();
  if (editObservationMessage) editObservationMessage.textContent = "";
});

deliveryForm?.addEventListener("submit", saveDeliveryFromDialog);
cancelDelivery?.addEventListener("click", () => deliveryDialog?.close());
deliveryDialog?.addEventListener("close", resetDeliveryDialog);
deliveryForm?.addEventListener("input", (event) => {
  event.target.removeAttribute("aria-invalid");
  deliveryMessage.textContent = "";
});

function fillForm(processo) {
  processForm.elements.id.value = processo.id;
  processForm.elements.versao.value = processo.versao;
  for (const [key, value] of Object.entries(processo)) {
    if (processForm.elements[key]) processForm.elements[key].value = value ?? "";
  }
  if (processForm.elements.dataProcesso) processForm.elements.dataProcesso.value = displayDate(processo.dataProcesso);
  if (processForm.elements.dataEnvioFornecedor && !processForm.elements.dataEnvioFornecedor.value) {
    processForm.elements.dataEnvioFornecedor.value = processo.dataEnvioEmpenho || "";
  }
  renderMaterialRows(processo.materiais);
  formMessage.textContent = "Editando processo selecionado.";
}

function clearForm() {
  processForm.reset();
  processForm.elements.id.value = "";
  processForm.elements.versao.value = "";
  formMessage.textContent = "";
  renderMaterialRows();
}

function openProcessDialog(processo = null) {
  clearForm();
  processDialogTitle.textContent = processo ? "Editar processo" : "Novo processo";
  if (processo) fillForm(processo);
  processDialog.showModal();
}

async function openProcessDetail(processo, returnSection = "processes") {
  if (!processo) return;
  detailController?.abort();
  const controller = new AbortController();
  detailController = controller;
  const sequence = ++detailSequence;
  state.selectedProcess = processo;
  state.detailReturnSection = returnSection;
  state.detailTab = "general";
  state.detailObservations = [];
  state.detailObservationsError = "";
  processListView.classList.add("hidden");
  dashboardView.classList.add("hidden");
  suppliersView.classList.add("hidden");
  usersView.classList.add("hidden");
  settingsView.classList.add("hidden");
  auditView.classList.add("hidden");
  processDetailView.classList.remove("hidden");
  if (sectionTitle) sectionTitle.textContent = "Empenhos";
  detailTabs.forEach((tab) => setTabActive(tab, tab.dataset.detailTab === "general"));
  renderProcessDetail();

  void ensureSuppliersLoaded().then(() => {
    if (sequence === detailSequence && state.selectedProcess?.id === processo.id) renderProcessDetail();
  }).catch(() => null);
  try {
    const observations = await loadDetailObservations(processo.id, { signal: controller.signal });
    if (sequence !== detailSequence || state.selectedProcess?.id !== processo.id) return;
    state.detailObservations = observations;
    renderProcessDetail();
  } catch (error) {
    if (error.name !== "AbortError" && sequence === detailSequence && state.selectedProcess?.id === processo.id) {
      state.detailObservationsError = error.message || "Nao foi possivel carregar as observacoes.";
      renderProcessDetail();
    }
  } finally {
    if (detailController === controller) detailController = null;
  }
}

function closeProcessDetail() {
  detailController?.abort();
  detailController = null;
  detailSequence += 1;
  const returnSection = state.detailReturnSection || "processes";
  state.selectedProcess = null;
  void openSection(returnSection);
}

async function downloadProcess(processId, format) {
  const normalized = format === "pdf" ? "pdf" : "zip";
  const response = await fetch(`/api/processes/${processId}/download?format=${normalized}`, {
    credentials: "same-origin"
  });
  if (response.status === 401) handleUnauthorized();
  if (!response.ok) throw new Error("Nao foi possivel baixar o processo.");
  const blobUrl = URL.createObjectURL(await response.blob());
  triggerBlobDownload(blobUrl, normalized === "pdf" ? "processo.pdf" : "processo.zip");
}

function renderProcessDetail() {
  const processo = state.selectedProcess;
  if (!processo) return;
  detailProcessNumber.textContent = processo.numeroProcesso || "Processo sem numero";
  detailStatusBadges.innerHTML = statusBadges(processo);
  detailSubtitle.textContent = `${processo.fornecedor || "Fornecedor nao informado"} · Empenho ${processo.numeroEmpenho || "nao informado"}`;
  renderDetailPanel();
}

function renderDetailPanel() {
  const processo = state.selectedProcess;
  if (!processo) return;

  const renderers = {
    general: renderGeneralModule,
    documents: renderDocumentsModule,
    timeline: renderTimelineModule,
    deliveries: renderDeliveriesModule,
    observations: renderObservationsModule,
    emails: renderEmailsModule
  };

  detailPanel.innerHTML = (renderers[state.detailTab] || renderTimelineModule)(processo);
}

function renderGeneralModule(processo) {
  const fornecedor = supplierFor(processo);
  const totalQuantity = processo.materiais.reduce((sum, material) => sum + Number(material.quantidade || 0), 0);
  const unitAverage = totalQuantity ? processo.valorTotal / totalQuantity : 0;

  return `
    <div class="detail-grid">
      ${detailField("Fornecedor", processo.fornecedor)}
      ${detailField("Data do processo", dateCell(processo.dataProcesso))}
      ${detailField("CNPJ", fornecedor?.cnpj)}
      ${detailField("Materiais", processo.materiais.map((material) => material.descricao).join(", "))}
      ${detailField("Valor unitario medio", money(unitAverage))}
      ${detailField("Quantidade", totalQuantity || "-")}
      ${detailField("Valor total", money(processo.valorTotal))}
      ${detailField("Data de envio para fornecedor", dateCell(deadlineDate(processo)))}
      ${detailField("Data de entrega", dateCell(processo.dataEntrega))}
      ${detailField("Data de envio para liquidacao", dateCell(processo.dataEnvioLiquidacao))}
      ${detailField("Data de liquidacao", dateCell(processo.dataLiquidacao))}
      ${detailField("Data de pagamento", dateCell(processo.dataPagamento))}
      ${detailField("Dias decorridos", deadlineDate(processo) && !["Entregue", "Liquidado", "Pago", "Anulado"].includes(processo.status) ? `${processo.diasDecorridos} dias` : "-")}
      ${processo.status === "Anulado" ? detailField("Motivo da anulacao", processo.motivoAnulacao) : ""}
    </div>
    <div class="detail-actions">
      ${canEditGeneralInUi(processo) ? '<button type="button" class="detail-primary-action" data-open-edit="true">Editar dados do processo</button>' : ""}
      ${newDataButton(processo)}
    </div>
    ${newDataPanel(processo)}
  `;
}

function renderDocumentsModule(processo) {
  const documents = [
    ["processoSped", "Processo SPED", processo.documentos?.processoSped],
    ["notaEmpenho", "Nota de Empenho", processo.documentos?.notaEmpenho],
    ["notaFiscal", "Nota Fiscal", processo.documentos?.notaFiscal]
  ];
  const complementaryDocuments = documentList(processo.documentos?.complementares);

  return `
    <div class="module-list">
      ${documents.map(([key, label, value]) => {
        const doc = documentInfo(value);
        return `
        <article class="module-row">
          <div>
            <strong>${escapeHtml(label)}</strong>
            ${doc.path
              ? `<button type="button" class="document-name" data-open-document="${escapeAttribute(doc.path)}">${escapeHtml(doc.fileName)}</button>`
              : `<span>${`Nao ha ${label} anexado`}</span>`}
          </div>
          <div class="document-actions">
            ${doc.path ? "" : `<button type="button" class="secondary" data-attach-document="${key}" ${canAttachDocumentInUi(processo, key) ? "" : "disabled"}>Anexar</button>`}
            <button type="button" class="secondary danger-action" ${doc.path && canAttachDocumentInUi(processo, key) ? `data-remove-document="${key}"` : "disabled"}>Remover</button>
            <button type="button" class="secondary" ${doc.path ? `data-download-document="${escapeAttribute(doc.path)}"` : "disabled"}>Baixar</button>
          </div>
        </article>
      `;}).join("")}
      ${complementaryDocuments.length
        ? complementaryDocuments.map((doc, index) => `
          <article class="module-row document-extra-item">
            <div>
              <button type="button" class="document-name document-title" data-open-document="${escapeAttribute(doc.path)}">${escapeHtml(doc.titulo || doc.nome || doc.fileName)}</button>
              ${doc.descricao ? `<span>${escapeHtml(doc.descricao)}</span>` : ""}
              <span>${escapeHtml(doc.fileName)}</span>
            </div>
            <div class="document-actions">
              <button type="button" class="secondary danger-action" ${canAttachDocumentInUi(processo, "complementares") ? `data-remove-document="complementares:${index}"` : "disabled"}>Remover</button>
              <button type="button" class="secondary" data-download-document="${escapeAttribute(doc.path)}">Baixar</button>
            </div>
          </article>
        `).join("")
        : ""}
      <div class="document-extra-toolbar">
        <button type="button" class="secondary small-action" data-attach-document="complementares" ${canAttachDocumentInUi(processo, "complementares") ? "" : "disabled"}>+ Novo Documento</button>
      </div>
    </div>
  `;
}

function renderTimelineModule(processo) {
  const events = timelineEvents(processo);

  return `
    <ol class="timeline">
      ${events.map((event) => `
        <li class="${timelineEventClass(event)}">
          <strong>${escapeHtml(event.label)}</strong>
          <span>${escapeHtml(event.date ? (event.showTime ? formatDateTime(event.date) : formatDate(event.date)) : "Pendente")}</span>
          ${event.meta ? `<span>${escapeHtml(event.meta)}</span>` : ""}
          ${event.details ? `<span>${escapeHtml(event.details)}</span>` : ""}
          ${event.documento?.path ? documentTimelinePreview(event.documento) : ""}
        </li>
      `).join("")}
    </ol>
  `;
}

function renderDeliveriesModule(processo) {
  const delivered = ["Entrega parcial", "Entregue", "Liquidado", "Pago"].includes(processo.status);
  return `
    <div class="module-list">
      <article class="module-row">
        <div>
          <strong>${delivered ? "Entrega registrada" : "Nenhuma entrega registrada"}</strong>
          <span>${delivered ? `Data: ${dateCell(processo.dataEntrega)}` : "Use este modulo para registrar quantidade entregue, pendente e data da entrega."}</span>
        </div>
        ${canRegisterDeliveryInUi(processo) ? '<button type="button" class="secondary" data-register-partial-delivery="true">Registrar entrega parcial</button>' : ""}
      </article>
    </div>
  `;
}

function renderObservationsModule(processo) {
  const observations = state.detailObservationsError
    ? `<p class="form-message error" role="alert">${escapeHtml(state.detailObservationsError)}</p>`
    : state.detailObservations.length
    ? state.detailObservations.map((observacao) => `
      <article class="note">
        <span>${escapeHtml(formatDateTime(observacao.criadoEm))} - ${escapeHtml(observacao.usuario)}</span>
        <div>${escapeHtml(observacao.conteudo)}</div>
        ${canManageObservation(observacao, processo) ? `<div class="note-actions">
          <button type="button" class="secondary" data-edit-observation="${escapeAttribute(observacao.id)}">Alterar</button>
          <button type="button" class="secondary" data-delete-observation="${escapeAttribute(observacao.id)}">Excluir</button>
        </div>` : ""}
      </article>
    `).join("")
    : "<p>Nenhuma observacao registrada.</p>";

  return `
    <div class="module-list">
      <article class="module-row">
        <div>
          <strong>Observacoes do processo</strong>
          <span>Abra a janela de observacoes para consultar e registrar anotacoes cronologicas.</span>
        </div>
        <button type="button" class="secondary" data-open-notes="${escapeAttribute(processo.id)}">Abrir observacoes</button>
      </article>
      <div class="notes-inline">${observations}</div>
    </div>
  `;
}

function renderEmailsModule(processo) {
  const history = state.emailHistory.filter((entry) => entry.processoId === processo.id);
  return `
    <div class="module-list">
      <article class="module-row">
        <div>
          <strong>Notificacoes automaticas</strong>
          <span>Envio via SMTP para o e-mail cadastrado no fornecedor.</span>
        </div>
        ${currentUser.role === "admin" ? `<button type="button" class="secondary" data-send-test-email="${escapeAttribute(processo.id)}">Enviar teste</button>` : ""}
      </article>
      <article class="module-row">
        <div>
          <strong>Historico de e-mails</strong>
          <span>Data, hora, destinatario, assunto e status do envio.</span>
        </div>
        <span>${history.length} envio(s)</span>
      </article>
      ${history.map((entry) => `<article class="module-row"><div><strong>${escapeHtml(entry.assunto || entry.tipo)}</strong><span>${formatDateTime(entry.enviadoEm || entry.criadoEm)} · ${escapeHtml(entry.status)} · ${escapeHtml((entry.destinatarios || []).join(", "))}</span></div></article>`).join("")}
    </div>
  `;
}

function detailField(label, value) {
  return `
    <div class="detail-field">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value || "-")}</strong>
    </div>
  `;
}

function supplierFor(processo) {
  return state.fornecedores.find((fornecedor) => fornecedor.razaoSocial === processo.fornecedor);
}

async function loadDetailObservations(processId, options = {}) {
  return api(`/api/processes/${processId}/observations`, options);
}

async function ensureSuppliersLoaded() {
  if (state.suppliersLoaded) return state.fornecedores;
  if (state.suppliersLoading) return state.suppliersLoading;
  const request = api("/api/suppliers")
    .then((suppliers) => {
      state.fornecedores = suppliers;
      state.suppliersLoaded = true;
      return suppliers;
    })
    .finally(() => {
      if (state.suppliersLoading === request) state.suppliersLoading = null;
    });
  state.suppliersLoading = request;
  return request;
}

async function refreshAudit() {
  if (!state.auditLoaded || !["admin", "auditor"].includes(currentUser.role)) return;
  state.auditoria = await api("/api/audit");
}

async function attachDocument(documentKey) {
  if (!state.selectedProcess) return;
  const file = await pickDocumentFile();
  if (!file) return;
  if (!validateSelectedDocument(file)) return;
  if (documentKey === "complementares") {
    openComplementaryDocumentForm(file);
    return;
  }
  try {
    const contentBase64 = await fileToBase64(file);
    const updatedProcess = await api(`/api/processes/${state.selectedProcess.id}/documents`, {
      method: "POST",
      body: JSON.stringify({
        documentKey,
        fileName: file.name,
        mimeType: file.type || "",
        contentBase64
      })
    });
    state.selectedProcess = updatedProcess;
    await refresh();
    renderProcessDetail();
  } catch (error) {
    alert(error.message || "Nao foi possivel anexar o documento.");
  }
}

function openComplementaryDocumentForm(file) {
  state.pendingDocumentFile = file;
  const suggestedName = String(file.name || "").replace(/\.pdf$/i, "");
  documentMetadataForm.reset();
  documentMetadataForm.elements.titulo.value = suggestedName;
  documentSelectedFile.textContent = `Arquivo selecionado: ${file.name}`;
  documentMetadataDialog.showModal();
  documentMetadataForm.elements.titulo.focus();
}

async function saveComplementaryDocument() {
  if (!state.selectedProcess || !state.pendingDocumentFile) return;
  const file = state.pendingDocumentFile;
  const data = Object.fromEntries(new FormData(documentMetadataForm));
  const titulo = String(data.titulo || "").trim();
  if (!titulo) return;
  try {
    const contentBase64 = await fileToBase64(file);
    const updatedProcess = await api(`/api/processes/${state.selectedProcess.id}/documents`, {
      method: "POST",
      body: JSON.stringify({
        documentKey: "complementares",
        fileName: file.name,
        mimeType: file.type || "",
        contentBase64,
        titulo,
        descricao: String(data.descricao || "").trim()
      })
    });
    state.pendingDocumentFile = null;
    documentMetadataDialog.close();
    state.selectedProcess = updatedProcess;
    await refresh();
    renderProcessDetail();
  } catch (error) {
    alert(error.message || "Nao foi possivel anexar o documento.");
  }
}

async function removeDocument(documentKey) {
  if (!state.selectedProcess) return;
  if (!confirm("Remover este documento anexado?")) return;
  const updatedProcess = await api(`/api/processes/${state.selectedProcess.id}/documents/${documentKey}`, {
    method: "DELETE"
  });
  state.selectedProcess = updatedProcess;
  await refresh();
  await refreshAudit();
  renderProcessDetail();
}

function pickDocumentFile() {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    let settled = false;
    const finish = (file) => {
      if (settled) return;
      settled = true;
      resolve(file || null);
    };
    input.type = "file";
    input.accept = ".pdf,.xlsx,.xls,.csv,.docx,.doc,.odt,.ods,.txt,.png,.jpg,.jpeg,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/msword";
    input.addEventListener("change", () => finish(input.files?.[0]), { once: true });
    input.addEventListener("cancel", () => finish(null), { once: true });
    window.addEventListener("focus", () => setTimeout(() => {
      if (!input.files?.length) finish(null);
    }, 300), { once: true });
    input.click();
  });
}

function validateSelectedDocument(file) {
  if (file.size <= MAX_DOCUMENT_FILE_BYTES) return true;
  alert("O arquivo deve ter no maximo 15 MB.");
  return false;
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      resolve(String(reader.result).split(",")[1] || "");
    });
    reader.addEventListener("error", () => reject(reader.error));
    reader.readAsDataURL(file);
  });
}

async function editObservation(observationId) {
  try {
    const current = state.detailObservations.find((item) => item.id === observationId)
      || await findDialogObservation(observationId);
    if (!current || !editObservationDialog || !editObservationForm) return;
    const processId = current?.processoId || state.observationProcessId || state.selectedProcess?.id;
    editObservationForm.reset();
    editObservationMessage.textContent = "";
    editObservationForm.elements.processId.value = processId;
    editObservationForm.elements.observationId.value = observationId;
    editObservationForm.elements.conteudo.value = current.conteudo || "";
    editObservationDialog.showModal();
    editObservationForm.elements.conteudo.focus();
  } catch (error) {
    observationMessage.textContent = error.message || "Nao foi possivel abrir a observacao.";
  }
}

async function deleteObservation(observationId) {
  if (!confirm("Excluir esta observacao?")) return;
  try {
    const current = state.detailObservations.find((item) => item.id === observationId)
      || await findDialogObservation(observationId);
    const processId = current?.processoId || state.observationProcessId || state.selectedProcess?.id;
    if (!processId) throw new Error("Processo da observacao nao encontrado.");
    await api(`/api/processes/${processId}/observations/${observationId}`, {
      method: "DELETE"
    });
    await refreshObservationViews();
    observationMessage.textContent = "Observacao excluida.";
  } catch (error) {
    observationMessage.textContent = error.message || "Nao foi possivel excluir a observacao.";
  }
}

async function saveNewProcessData() {
  if (!state.selectedProcess) return;
  const statusField = detailPanel.querySelector("[data-detail-status]");
  const dateField = detailPanel.querySelector("[data-detail-date]");
  const status = statusField?.value;
  if (["Entrega parcial", "Entregue"].includes(status)) {
    openDeliveryDialog(dateField?.value || "", status === "Entregue");
    return;
  }
  const date = normalizeDateInput(dateField?.value);
  const step = nextProcessStep(state.selectedProcess);
  if (!status || !date) {
    alert("Informe a data para salvar.");
    return;
  }

  const overrides = { status };
  if (step?.field) overrides[step.field] = date;

  const updatedProcess = await api(`/api/processes/${state.selectedProcess.id}`, {
    method: "PUT",
    body: JSON.stringify(processUpdatePayload(overrides))
  });
  state.selectedProcess = updatedProcess;
  await refresh();
  await refreshAudit();
  renderProcessDetail();
}
function registerPartialDelivery() {
  openDeliveryDialog(state.selectedProcess?.dataEntrega || "", false);
}

function openDeliveryDialog(date = "", complete = false) {
  const processo = state.selectedProcess;
  if (!processo || !deliveryDialog || !deliveryForm) return;
  resetDeliveryDialog();
  const balances = deliveryBalanceRows(processo);
  state.deliveryDraft = { processId: processo.id, complete };
  deliveryDialogTitle.textContent = complete ? "Registrar entrega final" : "Registrar entrega parcial";
  deliveryForm.elements.data.value = displayDate(date);
  deliveryMaterials.innerHTML = balances.length ? balances.map(({ materialIndex, material, remaining }) => {
    const inputId = `deliveryQuantity-${materialIndex}`;
    const balanceId = `deliveryBalance-${materialIndex}`;
    return `
      <div class="delivery-material-row">
        <div class="delivery-material-summary">
          <strong>${escapeHtml(material.descricao || `Material ${materialIndex + 1}`)}</strong>
          <span id="${balanceId}">Saldo disponivel: ${escapeHtml(formatQuantity(remaining))}</span>
        </div>
        <label for="${inputId}">Quantidade recebida
          <input id="${inputId}" name="quantidade-${materialIndex}" type="number" inputmode="decimal" min="0" max="${remaining}" step="any" value="${complete ? remaining : ""}" data-delivery-quantity="${materialIndex}" aria-describedby="${balanceId}">
        </label>
      </div>
    `;
  }).join("") : '<p class="empty-state">Nao ha saldo pendente para os materiais deste processo.</p>';
  deliveryForm.querySelector('button[type="submit"]').disabled = !balances.length;
  if (!balances.length) deliveryMessage.textContent = "Todos os materiais ja foram recebidos.";
  deliveryDialog.showModal();
  requestAnimationFrame(() => deliveryForm.elements.data.focus());
}

function deliveryBalanceRows(processo) {
  const delivered = new Map();
  (processo.entregas || []).forEach((entrega) => (entrega.itens || []).forEach((item) => {
    delivered.set(item.materialIndex, (delivered.get(item.materialIndex) || 0) + Number(item.quantidade || 0));
  }));
  return (processo.materiais || []).map((material, materialIndex) => ({
    material,
    materialIndex,
    remaining: Math.max(0, Number(material.quantidade || 0) - (delivered.get(materialIndex) || 0))
  })).filter((item) => item.remaining > 0);
}

async function saveDeliveryFromDialog(event) {
  event.preventDefault();
  const processo = state.selectedProcess;
  const draft = state.deliveryDraft;
  if (!processo || !draft || processo.id !== draft.processId) {
    deliveryMessage.textContent = "O processo selecionado mudou. Feche esta janela e tente novamente.";
    return;
  }

  deliveryMessage.textContent = "";
  deliveryForm.querySelectorAll("[aria-invalid]").forEach((input) => input.removeAttribute("aria-invalid"));
  const dateInput = deliveryForm.elements.data;
  const data = normalizeDateInput(dateInput.value);
  if (!data) {
    dateInput.setAttribute("aria-invalid", "true");
    deliveryMessage.textContent = "Informe uma data valida no formato DD-MM-AAAA.";
    dateInput.focus();
    return;
  }

  const balances = new Map(deliveryBalanceRows(processo).map((item) => [item.materialIndex, item]));
  const itens = [];
  let firstInvalidInput = null;
  deliveryForm.querySelectorAll("[data-delivery-quantity]").forEach((input) => {
    const materialIndex = Number(input.dataset.deliveryQuantity);
    const balance = balances.get(materialIndex);
    const rawValue = String(input.value || "").trim();
    if (input.validity.badInput) {
      input.setAttribute("aria-invalid", "true");
      firstInvalidInput ||= input;
      return;
    }
    if (!rawValue) return;
    const quantidade = Number(rawValue);
    if (!balance || !Number.isFinite(quantidade) || quantidade < 0 || quantidade > balance.remaining) {
      input.setAttribute("aria-invalid", "true");
      firstInvalidInput ||= input;
      return;
    }
    if (quantidade > 0) itens.push({ materialIndex, quantidade });
  });
  if (firstInvalidInput) {
    deliveryMessage.textContent = "Revise as quantidades: cada valor deve ser numerico e nao pode superar o saldo indicado.";
    firstInvalidInput.focus();
    return;
  }
  if (!itens.length) {
    deliveryMessage.textContent = "Informe ao menos uma quantidade recebida maior que zero.";
    deliveryForm.querySelector("[data-delivery-quantity]")?.focus();
    return;
  }

  setFormBusy(deliveryForm, true, "Salvando...");
  let updatedProcess;
  try {
    updatedProcess = await api(`/api/processes/${processo.id}/deliveries`, {
      method: "POST",
      body: JSON.stringify({ data, itens })
    });
  } catch (error) {
    deliveryMessage.textContent = error.message || "Nao foi possivel registrar a entrega.";
    return;
  } finally {
    setFormBusy(deliveryForm, false);
  }

  state.selectedProcess = updatedProcess;
  deliveryDialog.close();
  renderProcessDetail();
  try {
    await refresh();
    await refreshAudit();
    renderProcessDetail();
  } catch (error) {
    showAppError(`A entrega foi registrada, mas a lista nao foi atualizada: ${error.message}`);
  }
}

function resetDeliveryDialog() {
  state.deliveryDraft = null;
  deliveryForm?.reset();
  deliveryMaterials?.replaceChildren();
  if (deliveryMessage) deliveryMessage.textContent = "";
  const submit = deliveryForm?.querySelector('button[type="submit"]');
  if (submit) submit.disabled = false;
}

function formatQuantity(value) {
  return Number(value || 0).toLocaleString("pt-BR", { maximumFractionDigits: 6 });
}

function processUpdatePayload(overrides = {}) {
  const processo = state.selectedProcess;
  return {
    numeroProcesso: processo.numeroProcesso || "",
    numeroEmpenho: processo.numeroEmpenho || "",
    fornecedor: processo.fornecedor || "",
    dataProcesso: processo.dataProcesso || "",
    materiais: processo.materiais || [],
    dataEnvioFornecedor: processo.dataEnvioFornecedor || deadlineDate(processo),
    dataEntrega: processo.dataEntrega || "",
    dataEnvioLiquidacao: processo.dataEnvioLiquidacao || "",
    dataLiquidacao: processo.dataLiquidacao || "",
    dataPagamento: processo.dataPagamento || "",
    status: processo.status || "Enviado para SALC",
    versao: processo.versao,
    ...overrides
  };
}

async function refreshObservationViews() {
  if (state.observationProcessId) await loadObservations();
  if (state.selectedProcess) {
    state.detailObservations = await loadDetailObservations(state.selectedProcess.id);
    if (["timeline", "observations"].includes(state.detailTab)) renderDetailPanel();
  }
}

async function findDialogObservation(observationId) {
  if (!state.observationProcessId) return null;
  const items = await api(`/api/processes/${state.observationProcessId}/observations`);
  return items.find((item) => item.id === observationId);
}

function documentInfo(value) {
  if (!value) return {};
  if (typeof value === "string") return { fileName: value, path: "" };
  return value;
}

function documentList(value) {
  if (!value) return [];
  const items = Array.isArray(value) ? value : [value];
  return items.map(documentInfo).filter((doc) => doc.path);
}

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

async function openSection(section) {
  if (["users", "settings"].includes(section) && currentUser?.role !== "admin") section = "dashboard";
  if (section === "audit" && !["admin", "auditor"].includes(currentUser?.role)) section = "dashboard";
  state.activeSection = section;
  detailController?.abort();
  detailSequence += 1;
  activateSectionShell(section);

  const renderers = {
    dashboard: () => renderDashboardView(),
    processes: () => renderProcessesView(),
    suppliers: () => renderSuppliersView(),
    audit: () => renderAuditView(),
    users: () => renderUsersView(),
    settings: () => renderSettingsView()
  };
  if (!renderers[section]) return;
  try {
    await renderers[section]();
  } catch (error) {
    if (error.name === "AbortError") return;
    if (section === "processes") {
      table.innerHTML = `<tr class="empty-table-row"><td colspan="10" role="alert">${escapeHtml(error.message || "Nao foi possivel carregar os processos.")}</td></tr>`;
      return;
    }
    const target = { dashboard: dashboardView, suppliers: suppliersView, audit: auditView, users: usersView, settings: settingsView }[section];
    renderSectionError(target, error.message || "Nao foi possivel carregar esta secao.", section);
  }
}

function activateSectionShell(section) {
  state.activeSection = section;
  navItems.forEach((item) => {
    const active = item.dataset.section === section;
    item.classList.toggle("active", active);
    if (active) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  });
  const titles = { dashboard: "Painel", processes: "Empenhos", suppliers: "Fornecedores", audit: "Auditoria", users: "Usuarios e permissoes", settings: "Templates" };
  if (sectionTitle) sectionTitle.textContent = titles[section] || "";
  processListView.classList.toggle("hidden", section !== "processes");
  dashboardView.classList.toggle("hidden", section !== "dashboard");
  suppliersView.classList.toggle("hidden", section !== "suppliers");
  auditView.classList.toggle("hidden", section !== "audit");
  usersView.classList.toggle("hidden", section !== "users");
  settingsView.classList.toggle("hidden", section !== "settings");
  processDetailView.classList.add("hidden");
  state.selectedProcess = null;
}

function renderDashboardView() {
  const year = Number(state.dashboardYear) || state.dashboardYears[0] || new Date().getFullYear();
  const charts = state.dashboardCharts;
  dashboardView.innerHTML = `
    <div class="content-header">
      <div>
        <h1>Painel</h1>
      </div>
      <select class="dashboard-year" id="dashboardYearSelect" aria-label="Ano do painel">
        ${dashboardYearOptions(year, state.dashboardYears)}
      </select>
    </div>
    <div class="dashboard-grid">
      ${dashboardMetricsMarkup(state.dashboardMetrics)}
    </div>
    <div class="charts-grid">
      ${executionGroupedChart(charts.execucaoMensal)}
      ${budgetStatusChart(charts.distribuicaoStatus)}
      ${financialChart()}
    </div>
  `;
  dashboardView.querySelector("#dashboardYearSelect").addEventListener("change", async (event) => {
    const select = event.currentTarget;
    setControlBusy(select, true);
    dashboardView.setAttribute("aria-busy", "true");
    try {
      const result = await loadDashboardData(select.value);
      if (result && state.activeSection === "dashboard") renderDashboardView();
    } catch (error) {
      renderSectionError(dashboardView, error.message || "Nao foi possivel carregar o painel deste ano.", "dashboard");
    } finally {
      setControlBusy(select, false);
      dashboardView.removeAttribute("aria-busy");
    }
  });
}

function dashboardMetricsMarkup(data = {}) {
  const items = (Array.isArray(data.porStatus) ? data.porStatus : []).filter((entry) => Array.isArray(entry) && Number(entry[1]) > 0);
  return items.map(([label, value]) => `
    <article class="metric">
      <span>${escapeHtml(label)}</span>
      <strong>${Number(value) || 0}</strong>
    </article>
  `).join("") || '<p class="empty-state">Nenhum processo contabilizado neste painel.</p>';
}

function dashboardYearOptions(selected, years = state.dashboardYears) {
  const options = years.length ? years : [Number(selected) || new Date().getFullYear()];
  return options.map((year) => `<option value="${year}" ${Number(year) === Number(selected) ? "selected" : ""}>Ano: ${year}</option>`).join("");
}

function executionGroupedChart(rows = []) {
  const max = Math.max(...rows.flatMap((row) => [row.empenhado, row.liquidado, row.pago]), 1);
  const yTicks = [max, max * 0.75, max * 0.5, max * 0.25, 0];
  return `
    <article class="chart-card grouped-chart-card">
      <div class="chart-title-row">
        <h2>Execucao mensal</h2>
        <div class="chart-legend">
          <span><i class="legend-committed"></i>Empenhado</span>
          <span><i class="legend-liquidated"></i>Liquidado</span>
          <span><i class="legend-paid"></i>Pago</span>
        </div>
      </div>
      ${monthlyExecutionTable(rows)}
      <div class="chart-scroll" tabindex="0" aria-label="Grafico de execucao mensal; a tabela acessivel apresenta todos os valores">
        <div class="grouped-chart" aria-hidden="true">
          <div class="y-axis">
            ${yTicks.map((tick) => `<span>${compactMoney(tick)}</span>`).join("")}
          </div>
          <div class="grouped-plot">
            <div class="grid-lines"></div>
            <div class="month-groups">
              ${rows.map((row) => groupedMonth(row, max)).join("")}
            </div>
          </div>
        </div>
      </div>
    </article>
  `;
}

function monthlyExecutionTable(rows = []) {
  return `
    <table class="sr-only chart-data-table">
      <caption>Valores da execucao mensal</caption>
      <thead><tr><th>Mes</th><th>Empenhado</th><th>Liquidado</th><th>Pago</th></tr></thead>
      <tbody>${rows.map((row) => `<tr><th>${escapeHtml(row.mes)}</th><td>${escapeHtml(money(row.empenhado))}</td><td>${escapeHtml(money(row.liquidado))}</td><td>${escapeHtml(money(row.pago))}</td></tr>`).join("")}</tbody>
    </table>
  `;
}

function financialChart() {
  const committed = state.dashboardMetrics.valorEmpenhado || 0;
  const liquidated = state.dashboardMetrics.valorLiquidado || 0;
  const paid = state.dashboardMetrics.valorPago || 0;
  return chartCard("Indicadores financeiros", [
    ["Empenhado", committed],
    ["Liquidado", liquidated],
    ["Pago", paid]
  ], money);
}

function groupedMonth(row, max) {
  const series = [
    ["empenhado", "Empenhado", row.empenhado],
    ["liquidado", "Liquidado", row.liquidado],
    ["pago", "Pago", row.pago]
  ];
  return `
    <div class="month-group">
      <div class="group-bars">
        ${series.map(([key, label, value]) => `
          <div class="group-bar ${key}" style="height: ${Number(value) ? Math.max(6, (Number(value) / max) * 100) : 0}%">
            <div class="column-tooltip">${escapeHtml(row.mes)} - ${label}: ${money(value)}</div>
          </div>
        `).join("")}
      </div>
      <span>${escapeHtml(row.mes)}</span>
    </div>
  `;
}

function budgetStatusChart(entries = []) {
  const normalized = entries.map((entry) => [entry.status, entry.quantidade]);
  return pieChartCard("Distribuicao por status", normalized);
}

function chartCard(title, entries, formatter) {
  const max = Math.max(...entries.map(([, value]) => Number(value)), 1);
  return `
    <article class="chart-card">
      <h2>${title}</h2>
      <div class="chart-bars">
        ${entries.map(([label, value]) => `
          <div class="chart-row">
            <span>${label}</span>
            <div class="bar-track">
              <div class="bar-fill ${chartKey(label)}" style="width: ${Math.max(4, (Number(value) / max) * 100)}%"></div>
            </div>
            <strong>${formatter(value)}</strong>
          </div>
        `).join("")}
      </div>
    </article>
  `;
}

function pieChartCard(title, entries = []) {
  const total = entries.reduce((sum, [, value]) => sum + Number(value), 0) || 1;
  const fallbackColors = ["#14213a", "#6b7280", "#7c3aed", "#b42318"];
  let cursor = -90;
  const slices = entries.map(([label, value], index) => {
    const percent = total ? (Number(value) / total) * 100 : 0;
    const start = cursor;
    const end = cursor + (percent / 100) * 360;
    cursor = end;
    return {
      label,
      value: Number(value),
      percent,
      color: chartColor(label, fallbackColors[index % fallbackColors.length]),
      start,
      end,
      mid: start + (end - start) / 2
    };
  });

  return `
    <article class="chart-card pie-card">
      <h2>${escapeHtml(title)}</h2>
      <table class="sr-only chart-data-table">
        <caption>${escapeHtml(title)}</caption>
        <thead><tr><th>Status</th><th>Quantidade</th></tr></thead>
        <tbody>${slices.map((slice) => `<tr><th>${escapeHtml(slice.label)}</th><td>${slice.value}</td></tr>`).join("")}</tbody>
      </table>
      <div class="pie-layout">
        <svg class="external-pie" viewBox="0 0 620 360" role="img" aria-label="${escapeAttribute(`${title}: ${slices.map((slice) => `${slice.label} ${slice.value}`).join(", ") || "sem dados"}`)}">
          ${slices.map((slice) => pieSlice(slice, total)).join("")}
        </svg>
      </div>
    </article>
  `;
}

function pieSlice(slice, total) {
  if (!slice.value) return "";
  const center = { x: 310, y: 178 };
  const radius = 112;
  const labelRadius = 170;
  const edge = polarPoint(center, radius, slice.mid);
  const labelPoint = polarPoint(center, labelRadius, slice.mid);
  const textAnchor = labelPoint.x >= center.x ? "start" : "end";
  const labelX = labelPoint.x + (labelPoint.x >= center.x ? 14 : -14);
  const label = `${slice.label}: ${slice.value}`;
  const path = describeArcSector(center.x, center.y, radius, slice.start, slice.end);

  return `
    <g class="pie-slice">
      <path class="pie-sector" d="${path}" fill="${slice.color}"></path>
      <path class="pie-leader" d="M ${edge.x} ${edge.y} L ${labelPoint.x} ${labelPoint.y} L ${labelX} ${labelPoint.y}" stroke="${slice.color}"></path>
      <text class="pie-label" x="${labelX}" y="${labelPoint.y + 4}" text-anchor="${textAnchor}">${escapeHtml(label)}</text>
      <foreignObject class="pie-tooltip" x="${center.x - 86}" y="${center.y - 30}" width="172" height="60">
        <div xmlns="http://www.w3.org/1999/xhtml">
          <span>${escapeHtml(slice.label)}</span>
          <strong>${slice.value} processos</strong>
        </div>
      </foreignObject>
    </g>
  `;
}

function describeArcSector(cx, cy, radius, startAngle, endAngle) {
  const start = polarPoint({ x: cx, y: cy }, radius, endAngle);
  const end = polarPoint({ x: cx, y: cy }, radius, startAngle);
  const largeArc = endAngle - startAngle <= 180 ? 0 : 1;
  return [
    `M ${cx} ${cy}`,
    `L ${start.x} ${start.y}`,
    `A ${radius} ${radius} 0 ${largeArc} 0 ${end.x} ${end.y}`,
    "Z"
  ].join(" ");
}

function polarPoint(center, radius, angle) {
  const radians = (angle * Math.PI) / 180;
  return {
    x: center.x + radius * Math.cos(radians),
    y: center.y + radius * Math.sin(radians)
  };
}

function chartColor(label, fallback) {
  if (label === "Empenhado") return "#2563eb";
  if (label === "Liquidado") return "#b86e07";
  if (label === "Pago") return "#17665d";
  return fallback;
}

function chartKey(label) {
  if (label === "Empenhado") return "empenhado";
  if (label === "Liquidado") return "liquidado";
  if (label === "Pago") return "pago";
  return "";
}

function newDataButton(processo) {
  if (!canEditGeneralInUi(processo)) return "";
  const step = nextProcessStep(processo);
  if (!step) return "";
  return `<button type="button" class="secondary" data-show-new-data="true">${step.button}</button>`;
}

function newDataPanel(processo) {
  if (!canEditGeneralInUi(processo)) return "";
  const step = nextProcessStep(processo);
  if (!step || ["Entrega parcial", "Entregue"].includes(step.status)) return "";
  return `
    <div class="new-data-panel hidden" data-new-data-panel>
      <input type="hidden" data-detail-status value="${step.status}">
      <span class="new-data-title">${step.title}</span>
      <label>Data
        <input type="text" inputmode="numeric" placeholder="DD-MM-AAAA" pattern="\\d{2}-\\d{2}-\\d{4}" maxlength="10" data-detail-date required>
      </label>
      <button type="button" class="secondary" data-update-status="true">Salvar</button>
    </div>
  `;
}

function nextProcessStep(processo) {
  if (!processo || ["Pago", "Anulado"].includes(processo.status)) return null;
  const steps = {
    "Enviado para SALC": {
      button: "Registrar envio de empenho para fornecedor",
      title: "Informe a data de envio do empenho para fornecedor",
      status: "Empenho enviado ao fornecedor",
      field: "dataEnvioFornecedor"
    },
    "Empenho enviado ao fornecedor": {
      button: "Registrar entrega",
      title: "Informe a data de entrega",
      status: "Entregue",
      field: "dataEntrega"
    },
    "Aguardando entrega": {
      button: "Registrar entrega",
      title: "Informe a data de entrega",
      status: "Entregue",
      field: "dataEntrega"
    },
    "Entrega parcial": {
      button: "Registrar entrega final",
      title: "Informe a data de entrega final",
      status: "Entregue",
      field: "dataEntrega"
    },
    "Entregue": {
      button: "Registrar envio para liquidacao",
      title: "Informe a data de envio para liquidacao",
      status: "Enviado para liquidacao",
      field: "dataEnvioLiquidacao"
    },
    "Aguardando envio para liquidacao": {
      button: "Registrar envio para liquidacao",
      title: "Informe a data de envio para liquidacao",
      status: "Enviado para liquidacao",
      field: "dataEnvioLiquidacao"
    },
    "Enviado para liquidacao": {
      button: "Registrar liquidacao",
      title: "Informe a data de liquidacao",
      status: "Liquidado",
      field: "dataLiquidacao"
    },
    "Liquidado": {
      button: "Registrar pagamento",
      title: "Informe a data de pagamento",
      status: "Pago",
      field: "dataPagamento"
    }
  };
  return steps[processo.status] || null;
}
function canEditGeneralInUi(processo) {
  if (!processo || processo.status === "Anulado") return false;
  if (currentUser.role === "auditor") return false;
  if (processo.status === "Pago") return false;
  if (processo.status === "Liquidado") return isCurrentUserAdmin();
  return true;
}

function processById(processId) {
  return state.allProcesses.find((processo) => processo.id === processId)
    || (state.selectedProcess?.id === processId ? state.selectedProcess : null);
}

function canManageObservation(observation, processo = state.selectedProcess) {
  if (!observation || !canEditGeneralInUi(processo)) return false;
  return isCurrentUserAdmin() || observation.usuarioEmail === currentUser?.email;
}

function canRegisterDeliveryInUi(processo) {
  return canEditGeneralInUi(processo)
    && ["Empenho enviado ao fornecedor", "Aguardando entrega", "Entrega parcial"].includes(processo.status)
    && Boolean(deadlineDate(processo));
}

function canAttachDocumentInUi(processo, documentKey) {
  if (!processo || processo.inativo || ["Anulado", "Pago"].includes(processo.status) || !documentKey || currentUser.role === "auditor") return false;
  if (documentKey === "notaFiscal") {
    return ["Entrega parcial", "Entregue", "Aguardando envio para liquidacao", "Enviado para liquidacao", "Liquidado"].includes(processo.status);
  }
  return true;
}

async function renderSuppliersView() {
  if (!state.suppliersLoaded || !state.processesLoaded) {
    suppliersView.innerHTML = '<p class="empty-state">Carregando fornecedores...</p>';
    await Promise.all([ensureSuppliersLoaded(), ensureProcessesLoaded()]);
  }
  const suppliers = supplierDirectory();
  const query = state.supplierSearch.trim();
  const matches = query
    ? suppliers.filter((fornecedor) => normalizeText(fornecedor.razaoSocial).includes(normalizeText(query)))
    : suppliers;
  const selected = query && matches.length === 1 ? matches[0] : null;

  suppliersView.innerHTML = `
    <div class="content-header">
      <div>
        <h1>Fornecedores</h1>
      </div>
    </div>
    <div class="filters supplier-filters">
      <label class="search-box supplier-search" aria-label="Pesquisar fornecedores">
        <span>⌕</span>
        <input id="supplierSearchInput" placeholder="Buscar fornecedor pelo nome" value="${escapeAttribute(state.supplierSearch)}">
      </label>
    </div>
    ${query && !matches.length ? `<p class="empty-state">Nenhum fornecedor encontrado na base de dados.</p>` : ""}
    ${selected ? supplierDetail(selected) : ""}
    <div class="module-list">
      ${matches.map((fornecedor) => supplierRow(fornecedor)).join("")}
    </div>
  `;

  suppliersView.querySelector("#supplierSearchInput")?.addEventListener("input", debounce((event) => {
    const cursor = event.target.selectionStart;
    state.supplierSearch = event.target.value;
    state.supplierHistory = "";
    void renderSuppliersView().then(() => {
      const input = suppliersView.querySelector("#supplierSearchInput");
      input?.focus();
      input?.setSelectionRange(cursor, cursor);
    });
  }, 160));
  suppliersView.querySelectorAll("[data-supplier-history]").forEach((button) => {
    button.addEventListener("click", () => {
      state.supplierHistory = state.supplierHistory === button.dataset.supplierHistory ? "" : button.dataset.supplierHistory;
      renderSuppliersView();
    });
  });
  suppliersView.querySelectorAll("[data-supplier-info]").forEach((button) => {
    button.addEventListener("click", () => openSupplierInfoDialog(button.dataset.supplierInfo));
  });
  suppliersView.querySelectorAll("[data-supplier-process]").forEach((row) => {
    row.addEventListener("click", () => {
      const processo = state.allProcesses.find((item) => item.id === row.dataset.supplierProcess);
      openProcessDetail(processo, "suppliers");
    });
  });
}

function supplierDirectory() {
  const byName = new Map();
  state.fornecedores.forEach((fornecedor) => {
    const normalized = normalizeSupplier(fornecedor);
    if (!normalized.razaoSocial) return;
    byName.set(normalizeText(normalized.razaoSocial), normalized);
  });
  state.allProcesses.forEach((processo) => {
    if (!processo.fornecedor) return;
    const key = normalizeText(processo.fornecedor);
    if (!byName.has(key)) byName.set(key, normalizeSupplier({ razaoSocial: processo.fornecedor }));
  });
  return [...byName.values()].sort((a, b) => a.razaoSocial.localeCompare(b.razaoSocial));
}

function normalizeSupplier(fornecedor = {}) {
  return {
    ...fornecedor,
    razaoSocial: fornecedor.razaoSocial || fornecedor.nome || "",
    emails: uniqueList([fornecedor.email, ...(fornecedor.emails || [])]),
    telefones: uniqueList([fornecedor.telefone, ...(fornecedor.telefones || [])]),
    enderecos: uniqueList([fornecedor.endereco, ...(fornecedor.enderecos || [])])
  };
}

function supplierRow(fornecedor) {
  const key = normalizeText(fornecedor.razaoSocial);
  const historyOpen = state.supplierHistory === key;
  return `
    <article class="module-row supplier-row">
      <div>
        <strong>${escapeHtml(fornecedor.razaoSocial)}</strong>
        ${supplierSummaryLine("CNPJ", [fornecedor.cnpj])}
        ${supplierSummaryLine("E-mails", fornecedor.emails)}
        ${supplierSummaryLine("Telefones", fornecedor.telefones)}
        ${supplierSummaryLine("Enderecos", fornecedor.enderecos)}
      </div>
      <div class="supplier-actions">
        <button type="button" class="secondary" data-supplier-history="${escapeAttribute(key)}">Historico de processos</button>
        ${currentUser.role === "auditor" ? "" : `<button type="button" data-supplier-info="${escapeAttribute(fornecedor.razaoSocial)}">Adicionar informacoes</button>`}
      </div>
    </article>
    ${historyOpen ? supplierHistory(fornecedor) : ""}
  `;
}

function supplierDetail(fornecedor) {
  return `
    <section class="supplier-detail">
      <div>
        <strong>${escapeHtml(fornecedor.razaoSocial)}</strong>
        ${supplierSummaryLine("CNPJ", [fornecedor.cnpj])}
        ${supplierSummaryLine("E-mails", fornecedor.emails)}
        ${supplierSummaryLine("Telefones", fornecedor.telefones)}
        ${supplierSummaryLine("Enderecos", fornecedor.enderecos)}
        ${fornecedor.observacoes ? `<span>Observacoes: ${escapeHtml(fornecedor.observacoes)}</span>` : ""}
      </div>
      <div class="supplier-actions">
        <button type="button" class="secondary" data-supplier-history="${escapeAttribute(normalizeText(fornecedor.razaoSocial))}">Historico de processos</button>
        ${currentUser.role === "auditor" ? "" : `<button type="button" data-supplier-info="${escapeAttribute(fornecedor.razaoSocial)}">Adicionar informacoes</button>`}
      </div>
    </section>
  `;
}

function supplierHistory(fornecedor) {
  const processos = processesForSupplier(fornecedor.razaoSocial);
  return `
    <section class="supplier-history">
      <strong>Historico de processos</strong>
      ${processos.length ? `
        <div class="table-wrap compact-table">
          <table>
            <caption class="sr-only">Processos vinculados a ${escapeHtml(fornecedor.razaoSocial)}</caption>
            <thead>
              <tr>
                <th>Processo</th>
                <th>Empenho</th>
                <th>Valor total</th>
                <th>Status</th>
                <th>Envio fornecedor</th>
              </tr>
            </thead>
            <tbody>
              ${processos.map((processo) => `
                <tr class="clickable-row" data-supplier-process="${escapeAttribute(processo.id)}">
                  <td><button type="button" class="link-button">${empty(processo.numeroProcesso)}</button></td>
                  <td>${empty(processo.numeroEmpenho)}</td>
                  <td class="money-cell">${money(processo.valorTotal)}</td>
                  <td>${statusBadges(processo)}</td>
                  <td>${dateCell(deadlineDate(processo))}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      ` : `<p class="empty-state">Nenhum processo vinculado a este fornecedor.</p>`}
    </section>
  `;
}

function processesForSupplier(name = "") {
  const key = normalizeText(name);
  return state.allProcesses
    .filter((processo) => normalizeText(processo.fornecedor) === key)
    .sort((a, b) => String(b.criadoEm || "").localeCompare(String(a.criadoEm || "")));
}

function openSupplierInfoDialog(name = "") {
  const supplier = supplierDirectory().find((item) => normalizeText(item.razaoSocial) === normalizeText(name)) || { razaoSocial: name };
  supplierInfoForm.reset();
  supplierInfoForm.elements.razaoSocial.value = supplier.razaoSocial || name;
  supplierInfoForm.elements.emails.value = (supplier.emails || []).join("\n");
  supplierInfoForm.elements.telefones.value = (supplier.telefones || []).join("\n");
  supplierInfoForm.elements.enderecos.value = (supplier.enderecos || []).join("\n");
  supplierInfoForm.elements.observacoes.value = supplier.observacoes || "";
  supplierInfoMessage.textContent = "";
  supplierInfoDialog?.showModal();
}

function splitSupplierInfo(value = "") {
  return uniqueList(String(value).split(/[\n,;]+/));
}

function supplierSummaryLine(label, values = []) {
  const valid = uniqueList(values);
  return valid.length ? `<span>${label}: ${valid.map(escapeHtml).join(", ")}</span>` : "";
}

function uniqueList(values = []) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function normalizeText(value = "") {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

async function renderAuditView() {
  if (!state.auditLoaded) {
    auditView.innerHTML = '<p class="empty-state">Carregando auditoria...</p>';
    await loadAuditData();
  }
  const processEvents = state.auditoria.map((entry) => ({
    date: entry.criadoEm,
    type: entry.acao,
    actor: entry.usuario,
    target: entry.processoId,
    details: entry.detalhes
  }));
  const securityEvents = state.securityAudit.map((entry) => ({
    date: entry.createdAt,
    type: entry.eventType,
    actor: entry.actorEmail || "Sistema",
    target: entry.targetUserId || "-",
    details: Object.keys(entry.metadata || {}).length ? JSON.stringify(entry.metadata) : ""
  }));
  const events = [...processEvents, ...securityEvents]
    .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
  auditView.innerHTML = `
    <div class="content-header"><div><h1>Auditoria</h1><p>Eventos imutaveis de processos, acesso e seguranca.</p></div><button type="button" class="secondary" id="refreshAuditButton">Atualizar</button></div>
    <div class="table-wrap"><table><caption class="sr-only">Eventos de auditoria</caption><thead><tr><th>Data</th><th>Evento</th><th>Ator</th><th>Alvo</th><th>Detalhes</th></tr></thead>
      <tbody>${events.length ? events.map((entry) => `<tr><td>${escapeHtml(formatDateTime(entry.date))}</td><td>${escapeHtml(entry.type)}</td><td>${escapeHtml(entry.actor)}</td><td>${escapeHtml(entry.target)}</td><td>${escapeHtml(entry.details)}</td></tr>`).join("") : '<tr class="empty-table-row"><td colspan="5">Nenhum evento registrado.</td></tr>'}</tbody>
    </table></div>
  `;
  auditView.querySelector("#refreshAuditButton")?.addEventListener("click", refreshAuditView);
}

async function refreshAuditView() {
  const button = auditView.querySelector("#refreshAuditButton");
  setButtonBusy(button, true, "Atualizando...");
  try {
    await loadAuditData(true);
    await renderAuditView();
  } catch (error) {
    renderSectionError(auditView, error.message || "Nao foi possivel atualizar a auditoria.", "audit");
  } finally {
    setButtonBusy(button, false);
  }
}

async function loadAuditData(force = false) {
  if (state.auditLoaded && !force) return;
  [state.auditoria, state.securityAudit] = await Promise.all([api("/api/audit"), api("/api/security-audit")]);
  state.auditLoaded = true;
}

async function renderSettingsView(message = "", messageType = "success") {
  if (!state.settings) {
    settingsView.innerHTML = `
      <div class="content-header">
        <div>
          <h1>Templates</h1>
        </div>
      </div>
      <p class="empty-state">Carregando templates...</p>
    `;
    await ensureSettingsLoaded();
  }

  settingsView.innerHTML = `
    <div class="content-header">
      <div>
        <h1>Templates</h1>
      </div>
    </div>
    <p class="form-message settings-message ${message ? messageType : ""}" id="settingsMessage" role="status" aria-live="polite">${escapeHtml(message)}</p>
    <div class="settings-grid">
      ${settingsCard("templates", "Templates de e-mail", "Modelos usados nas notificacoes automaticas e reenvios manuais.")}
      ${settingsCard("notifications", "Prazos para notificacoes", `${state.settings.notificationRules.diasAvisoInterno.join(", ")} dias; oficio no dia ${state.settings.notificationRules.diaOficioFornecedor}.`)}
    </div>
    <section class="settings-panel">
      ${state.settings.localFallback ? `<p class="settings-note">Servidor atual nao possui a rota de configuracoes; exibindo valores padrao. Reinicie o servidor atualizado para salvar alteracoes.</p>` : ""}
      ${renderSettingsPanel()}
    </section>
  `;
  bindSettingsHandlers();
}

async function loadSettings() {
  try {
    return await api("/api/settings");
  } catch (error) {
    if (error.message !== "Rota nao encontrada") throw error;
    return defaultSettings();
  }
}

async function ensureSettingsLoaded() {
  if (state.settings) return state.settings;
  if (state.settingsLoading) return state.settingsLoading;
  const request = loadSettings()
    .then((settings) => {
      state.settings = settings;
      return settings;
    })
    .finally(() => {
      if (state.settingsLoading === request) state.settingsLoading = null;
    });
  state.settingsLoading = request;
  return request;
}

function defaultSettings() {
  return {
    emailTemplates: {
      avisoPrazos: {
        assunto: "Aviso de prazo - Processo {numeroProcesso}",
        corpo: "O processo {numeroProcesso} do fornecedor {fornecedor} esta com {dias} dias desde o envio do empenho.",
        anexos: []
      },
      oficioFornecedor: {
        assunto: "Oficio ao fornecedor - Empenho {numeroEmpenho}",
        corpo: "Prezado fornecedor, solicitamos atualizacao sobre a entrega vinculada ao empenho {numeroEmpenho}.",
        anexos: []
      }
    },
    notificationRules: {
      diasAvisoInterno: [7, 14, 21, 31],
      diaOficioFornecedor: 30
    },
    responsaveis: [],
    status: state.meta.status,
    filtrosRapidos: state.meta.filtrosRapidos,
    usuarios: [],
    localFallback: true
  };
}

function settingsCard(panel, title, description) {
  return `
    <article class="settings-card ${state.settingsPanel === panel ? "active" : ""}">
      <strong>${escapeHtml(title)}</strong>
      <span>${escapeHtml(description)}</span>
      <button type="button" class="secondary" data-settings-panel="${escapeAttribute(panel)}">Configurar</button>
    </article>
  `;
}

function renderSettingsPanel() {
  if (state.settingsPanel === "notifications") return renderNotificationSettings();
  return renderEmailTemplateSettings();
}

async function renderUsersView(message = "", messageType = "success") {
  if (!state.settings) {
    usersView.innerHTML = `
      <div class="content-header"><div><h1>Usuarios e permissoes</h1></div></div>
      <p class="empty-state" role="status">Carregando usuarios...</p>
    `;
    await ensureSettingsLoaded();
  }
  usersView.innerHTML = `
    <div class="content-header">
      <div><h1>Usuarios e permissoes</h1><p>Gerencie acessos, perfis e senhas dos usuarios.</p></div>
    </div>
    <p class="form-message users-message ${message ? messageType : ""}" id="usersMessage" role="status" aria-live="polite">${escapeHtml(message)}</p>
    <section class="settings-panel">${renderUserSettings()}</section>
  `;
  bindUserHandlers(usersView);
}

function renderEmailTemplateSettings() {
  const labels = {
    avisoPrazos: "Avisos nos dias 7, 14, 21 e 31",
    oficioFornecedor: "Oficio no dia 30"
  };
  return `
    <form id="emailTemplatesForm" class="settings-form">
      <div class="section-title">
        <strong>Templates de e-mail</strong>
      </div>
      ${Object.entries(state.settings.emailTemplates).map(([key, template]) => `
        <fieldset class="settings-fieldset">
          <legend>${labels[key] || key}</legend>
          <label>Assunto <input name="${key}.assunto" value="${escapeAttribute(template.assunto)}"></label>
          <label>Corpo <textarea name="${key}.corpo" rows="4">${escapeHtml(template.corpo)}</textarea></label>
          ${templateAttachmentList(key, template.anexos)}
          <button type="button" class="secondary" data-attach-template="${escapeAttribute(key)}">Adicionar anexo</button>
        </fieldset>
      `).join("")}
      <div class="actions">
        <button type="submit">Salvar templates</button>
      </div>
    </form>
  `;
}

function renderUserSettings() {
  return `
    <form id="newManagedUserForm" class="settings-form">
      <div class="section-title"><strong>Novo usuario</strong></div>
      <label>Nome <input name="nome" required></label>
      <label>E-mail <input name="email" type="email" required></label>
      <label>Perfil
        <select name="role"><option value="almoxarifado">Almoxarifado</option><option value="auditor">Auditor</option><option value="admin">Administrador</option></select>
      </label>
      <label>Senha inicial <input name="senhaTemporaria" type="password" autocomplete="new-password" minlength="8" maxlength="256" required title="Minimo de 8 caracteres, com maiuscula, numero e caractere especial que nao seja espaco"></label>
      <div class="actions"><button type="submit">Criar usuario</button></div>
    </form>
    <div class="module-list">
      ${state.settings.usuarios.map((user) => `
        <article class="module-row">
          <div><strong>${escapeHtml(user.nome)}</strong><span>${escapeHtml(user.email)} · ${user.ativo ? "ativo" : "inativo"}${user.precisaDefinirSenha ? " · troca de senha pendente" : ""}</span>${user.justificativaAcesso ? `<span>${escapeHtml(user.justificativaAcesso)}</span>` : ""}</div>
          <div class="document-actions">
            <select data-user-role="${escapeAttribute(user.id)}" aria-label="Perfil de ${escapeAttribute(user.nome || user.email)}">
              ${["almoxarifado", "auditor", "admin"].map((role) => `<option value="${role}" ${user.role === role ? "selected" : ""}>${role}</option>`).join("")}
            </select>
            <button type="button" class="secondary" data-toggle-user="${escapeAttribute(user.id)}" data-user-active="${user.ativo}" aria-label="${user.ativo ? "Desativar" : "Ativar"} ${escapeAttribute(user.nome || user.email)}">${user.ativo ? "Desativar" : "Ativar"}</button>
            <button type="button" class="secondary" data-password-user="${escapeAttribute(user.id)}" aria-label="Redefinir senha de ${escapeAttribute(user.nome || user.email)}">Redefinir senha</button>
            <button type="button" class="secondary" data-revoke-user="${escapeAttribute(user.id)}" aria-label="Revogar sessoes de ${escapeAttribute(user.nome || user.email)}">Revogar sessoes</button>
            <button type="button" class="secondary danger-button" data-delete-user="${escapeAttribute(user.id)}" aria-label="Excluir ${escapeAttribute(user.nome || user.email)}">Excluir</button>
          </div>
        </article>
      `).join("") || '<p class="empty-state">Nenhum usuario cadastrado.</p>'}
    </div>
  `;
}

function renderNotificationSettings() {
  const rules = state.settings.notificationRules;
  return `
    <form id="notificationSettingsForm" class="settings-form">
      <div class="section-title">
        <strong>Prazos para notificacoes</strong>
        <span>Controle dos marcos usados para alertas internos e oficio ao fornecedor.</span>
      </div>
      <label>Dias de aviso interno <input name="diasAvisoInterno" value="${escapeAttribute(rules.diasAvisoInterno.join(", "))}"></label>
      <label>Dia para oficio ao fornecedor <input name="diaOficioFornecedor" type="number" min="1" step="1" value="${Number(rules.diaOficioFornecedor || 30)}"></label>
      <div class="actions">
        <button type="submit">Salvar prazos</button>
      </div>
    </form>
  `;
}

function bindSettingsHandlers() {
  enhancePasswordFields(settingsView);
  settingsView.querySelectorAll("[data-settings-panel]").forEach((button) => {
    button.addEventListener("click", () => {
      state.settingsPanel = button.dataset.settingsPanel;
      renderSettingsView();
    });
  });
  settingsView.querySelector("#emailTemplatesForm")?.addEventListener("submit", saveEmailTemplates);
  settingsView.querySelectorAll("[data-remove-template-attachment]").forEach((button) => {
    button.addEventListener("click", () => void removeTemplateDocument(button.dataset.templateKey, button.dataset.removeTemplateAttachment));
  });
  settingsView.querySelectorAll("[data-download-document]").forEach((button) => {
    button.addEventListener("click", () => void downloadDocument(button.dataset.downloadDocument).catch((error) => {
      void renderSettingsView(error.message || "Nao foi possivel baixar o documento.", "error");
    }));
  });
  settingsView.querySelector("#notificationSettingsForm")?.addEventListener("submit", saveNotificationSettings);
  settingsView.querySelectorAll("[data-attach-template]").forEach((button) => {
    button.addEventListener("click", () => attachTemplateDocument(button.dataset.attachTemplate));
  });
}

function bindUserHandlers(root) {
  enhancePasswordFields(root);
  root.querySelector("#newManagedUserForm")?.addEventListener("submit", createManagedUser);
  root.querySelectorAll("[data-user-role]").forEach((select) => {
    select.addEventListener("change", () => updateManagedUser(select.dataset.userRole, { role: select.value }, select));
  });
  root.querySelectorAll("[data-toggle-user]").forEach((button) => {
    button.addEventListener("click", () => updateManagedUser(button.dataset.toggleUser, { ativo: button.dataset.userActive !== "true" }, button));
  });
  root.querySelectorAll("[data-revoke-user]").forEach((button) => {
    button.addEventListener("click", () => updateManagedUser(button.dataset.revokeUser, { revogarSessoes: true }, button));
  });
  root.querySelectorAll("[data-password-user]").forEach((button) => {
    button.addEventListener("click", () => openManagedUserPasswordDialog(button.dataset.passwordUser));
  });
  root.querySelectorAll("[data-delete-user]").forEach((button) => {
    button.addEventListener("click", () => deleteManagedUser(button.dataset.deleteUser, button));
  });
}

async function createManagedUser(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const body = Object.fromEntries(new FormData(event.currentTarget));
  if (!isValidPasswordInput(body.senhaTemporaria)) {
    await renderUsersView(passwordPolicyMessage(), "error");
    return;
  }
  setFormBusy(form, true, "Criando...");
  try {
    await api("/api/admin/users", { method: "POST", body: JSON.stringify(body) });
    form.reset();
    resetPasswordVisibility(form);
    await reloadUsersAfterMutation("Usuario criado com sucesso.");
  } catch (error) {
    await renderUsersView(error.message || "Nao foi possivel criar o usuario.", "error");
  } finally {
    setFormBusy(form, false);
  }
}

async function updateManagedUser(userId, changes, control = null) {
  const affectsCurrentUser = isCurrentManagedUser(userId);
  setControlBusy(control, true);
  try {
    await api(`/api/admin/users/${encodeURIComponent(userId)}`, { method: "PATCH", body: JSON.stringify(changes) });
    const managedUser = state.settings?.usuarios?.find((user) => user.id === userId);
    if (managedUser && Object.prototype.hasOwnProperty.call(changes, "role")) managedUser.role = changes.role;
    if (managedUser && Object.prototype.hasOwnProperty.call(changes, "ativo")) managedUser.ativo = changes.ativo;
    const message = changes.revogarSessoes ? "Sessoes revogadas." : "Usuario atualizado com sucesso.";
    if (affectsCurrentUser) {
      await revalidateSessionAfterSelfAdminMutation(message);
      return;
    }
    await renderUsersView(message);
  } catch (error) {
    await renderUsersView(error.message || "Nao foi possivel atualizar o usuario.", "error");
  } finally {
    setControlBusy(control, false);
  }
}

function openManagedUserPasswordDialog(userId) {
  const user = state.settings?.usuarios?.find((item) => item.id === userId);
  if (!user || !adminPasswordDialog || !adminPasswordForm) return;
  resetSensitiveForm(adminPasswordForm, adminPasswordMessage);
  adminPasswordForm.elements.userId.value = userId;
  adminPasswordUser.textContent = `Usuario: ${user.nome || user.email}`;
  adminPasswordDialog.showModal();
  adminPasswordForm.elements.senha.focus();
}

async function saveManagedUserPassword(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form));
  adminPasswordMessage.textContent = "";
  if (data.senha !== data.confirmacao) {
    adminPasswordMessage.textContent = "A confirmacao da senha deve ser identica.";
    return;
  }
  if (!isValidPasswordInput(data.senha)) {
    adminPasswordMessage.textContent = passwordPolicyMessage();
    return;
  }
  const affectsCurrentUser = isCurrentManagedUser(data.userId);
  setFormBusy(form, true, "Redefinindo...");
  try {
    const updatedUser = await api(`/api/admin/users/${encodeURIComponent(data.userId)}`, {
      method: "PATCH",
      body: JSON.stringify({ senha: data.senha })
    });
    const index = state.settings?.usuarios?.findIndex((user) => user.id === data.userId) ?? -1;
    if (index >= 0) state.settings.usuarios[index] = { ...state.settings.usuarios[index], ...updatedUser };
    adminPasswordDialog.close();
    if (affectsCurrentUser) {
      await revalidateSessionAfterSelfAdminMutation("Senha redefinida com sucesso.");
      return;
    }
    await renderUsersView("Senha redefinida e sessoes anteriores revogadas.");
  } catch (error) {
    adminPasswordMessage.textContent = error.message || "Nao foi possivel redefinir a senha.";
  } finally {
    setFormBusy(form, false);
  }
}

async function deleteManagedUser(userId, control = null) {
  if (!confirm("Excluir este usuario?")) return;
  const affectsCurrentUser = isCurrentManagedUser(userId);
  setControlBusy(control, true);
  try {
    await api(`/api/admin/users/${encodeURIComponent(userId)}`, { method: "DELETE" });
    state.settings.usuarios = state.settings.usuarios.filter((user) => user.id !== userId);
    if (affectsCurrentUser) {
      await revalidateSessionAfterSelfAdminMutation("Usuario excluido.");
      return;
    }
    await renderUsersView("Usuario excluido com sucesso.");
  } catch (error) {
    await renderUsersView(error.message || "Nao foi possivel excluir o usuario.", "error");
  } finally {
    setControlBusy(control, false);
  }
}

function isCurrentManagedUser(userId) {
  const managedUser = state.settings?.usuarios?.find((user) => user.id === userId);
  return Boolean(
    managedUser?.email
      && currentUser?.email
      && String(managedUser.email).trim().toLowerCase() === String(currentUser.email).trim().toLowerCase()
  );
}

async function revalidateSessionAfterSelfAdminMutation(successMessage) {
  try {
    const user = await api("/auth/session", { skipAuthRedirect: true });
    setCurrentUser(user);
    await openSection("dashboard");
    showAppNotice(successMessage);
    return true;
  } catch (error) {
    clearClientSession();
    showAuth();
    authMessage.textContent = error.status === 401
      ? "Sua sessao foi encerrada devido a alteracao no proprio usuario. Entre novamente para continuar."
      : "A alteracao foi salva, mas nao foi possivel revalidar sua sessao. Entre novamente para continuar.";
    return false;
  }
}

async function reloadUsersAfterMutation(successMessage) {
  try {
    state.settings = await api("/api/settings");
    await renderUsersView(successMessage);
  } catch (error) {
    await renderUsersView(`${successMessage} Nao foi possivel atualizar a lista agora.`, "warning");
  }
}

async function saveEmailTemplates(event) {
  event.preventDefault();
  if (settingsFallbackActive()) return;
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(event.currentTarget));
  const emailTemplates = {};
  Object.keys(state.settings.emailTemplates).forEach((key) => {
    emailTemplates[key] = {
      assunto: data[`${key}.assunto`] || "",
      corpo: data[`${key}.corpo`] || "",
      anexos: state.settings.emailTemplates[key]?.anexos || []
    };
  });
  setFormBusy(form, true, "Salvando...");
  try {
    state.settings = await api("/api/settings/email-templates", {
      method: "PUT",
      body: JSON.stringify({ emailTemplates })
    });
    await renderSettingsView("Templates salvos com sucesso.");
  } catch (error) {
    await renderSettingsView(error.message || "Nao foi possivel salvar os templates.", "error");
  } finally {
    setFormBusy(form, false);
  }
}

function templateAttachmentList(templateKey, anexos = []) {
  const items = Array.isArray(anexos) ? anexos : [];
  if (!items.length) return `<p class="empty-state compact-empty">Nenhum anexo configurado.</p>`;
  return `
    <div class="module-list compact-list">
      ${items.map((attachment) => `
        <article class="module-row compact-row">
          <div>
            <strong>${escapeHtml(attachment.fileName)}</strong>
            <span>${attachment.uploadedAt ? formatDateTime(attachment.uploadedAt) : ""}</span>
          </div>
          <div class="document-actions">
            <button type="button" class="secondary" data-download-document="${escapeAttribute(attachment.path)}">Baixar</button>
            <button type="button" class="secondary danger-action" data-template-key="${escapeAttribute(templateKey)}" data-remove-template-attachment="${escapeAttribute(attachment.id)}">Remover</button>
          </div>
        </article>
      `).join("")}
    </div>
  `;
}

async function attachTemplateDocument(templateKey) {
  if (!templateKey || settingsFallbackActive()) return;
  const file = await pickDocumentFile();
  if (!file) return;
  if (!validateSelectedDocument(file)) return;
  try {
    const contentBase64 = await fileToBase64(file);
    state.settings = await api(`/api/settings/email-templates/${encodeURIComponent(templateKey)}/attachments`, {
      method: "POST",
      body: JSON.stringify({
        fileName: file.name,
        mimeType: file.type || "",
        contentBase64
      })
    });
    renderSettingsView();
  } catch (error) {
    alert(error.message || "Nao foi possivel anexar o documento ao template.");
  }
}

async function removeTemplateDocument(templateKey, attachmentId) {
  if (!templateKey || !attachmentId || settingsFallbackActive()) return;
  if (!confirm("Remover este anexo do template?")) return;
  try {
    state.settings = await api(`/api/settings/email-templates/${encodeURIComponent(templateKey)}/attachments/${encodeURIComponent(attachmentId)}`, {
      method: "DELETE"
    });
    await renderSettingsView("Anexo removido com sucesso.");
  } catch (error) {
    await renderSettingsView(error.message || "Nao foi possivel remover o anexo.", "error");
  }
}

async function downloadDocument(path) {
  if (!path) return;
  const response = await fetch(path, {
    credentials: "same-origin"
  });
  if (response.status === 401) handleUnauthorized();
  if (!response.ok) throw new Error("Nao foi possivel baixar o documento.");
  const blobUrl = URL.createObjectURL(await response.blob());
  triggerBlobDownload(blobUrl);
}

async function saveNotificationSettings(event) {
  event.preventDefault();
  if (settingsFallbackActive()) return;
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(event.currentTarget));
  setFormBusy(form, true, "Salvando...");
  try {
    state.settings = await api("/api/settings/notifications", {
      method: "PUT",
      body: JSON.stringify({
        diasAvisoInterno: String(data.diasAvisoInterno || "").split(/[\n,; ]+/),
        diaOficioFornecedor: Number(data.diaOficioFornecedor || 30)
      })
    });
    await renderSettingsView("Prazos salvos com sucesso.");
  } catch (error) {
    await renderSettingsView(error.message || "Nao foi possivel salvar os prazos.", "error");
  } finally {
    setFormBusy(form, false);
  }
}

function settingsFallbackActive() {
  if (!state.settings?.localFallback) return false;
  alert("Reinicie o servidor atualizado para salvar configuracoes.");
  return true;
}

function renderMaterialRows(materiais = [{ descricao: "", valorUnitario: "", quantidade: "" }]) {
  materialsList.innerHTML = "";
  materiais.forEach((material) => addMaterialRow(material));
  ensureOneMaterialRow();
}

function addMaterialRow(material = { descricao: "", valorUnitario: "", quantidade: "" }) {
  const row = document.createElement("div");
  row.className = "material-row";
  row.innerHTML = `
    <label>Descricao <input data-material-field="descricao" maxlength="100" value="${escapeAttribute(material.descricao || "")}"></label>
    <label>Valor unitario <input data-material-field="valorUnitario" type="number" min="0" step="0.01" value="${Number(material.valorUnitario || 0) || ""}"></label>
    <label>Quantidade <input data-material-field="quantidade" type="number" min="0" step="1" value="${Number(material.quantidade || 0) || ""}"></label>
    <button type="button" class="secondary remove-material" data-remove-material="true">Remover</button>
  `;
  materialsList.append(row);
}

function ensureOneMaterialRow() {
  if (!materialsList.children.length) addMaterialRow();
}

function readMaterials() {
  return [...materialsList.querySelectorAll(".material-row")]
    .map((row) => ({
      descricao: row.querySelector('[data-material-field="descricao"]').value.trim(),
      valorUnitario: Number(row.querySelector('[data-material-field="valorUnitario"]').value || 0),
      quantidade: Number(row.querySelector('[data-material-field="quantidade"]').value || 0)
    }))
    .filter((material) => material.descricao);
}

function fillSelect(select, items, placeholder) {
  if (!select) return;
  select.innerHTML = [`<option value="">${escapeHtml(placeholder)}</option>`]
    .concat(items.map((item) => `<option value="${escapeAttribute(item)}">${escapeHtml(item)}</option>`))
    .join("");
}

function renderQuickFilters() {
  const filters = ["Todos", ...state.meta.filtrosRapidos];
  quickFilterBar.innerHTML = filters.map((label) => `
    <button type="button" class="filter-chip ${(label === "Todos" ? "" : label) === quickFilter.value ? "active" : ""}" data-filter="${escapeAttribute(label === "Todos" ? "" : label)}" aria-pressed="${String((label === "Todos" ? "" : label) === quickFilter.value)}">
      ${label === "Todos" ? "▽ " : ""}${escapeHtml(label)}
    </button>
  `).join("");

  if (quickFilterBar.dataset.bound === "true") return;
  quickFilterBar.dataset.bound = "true";
  quickFilterBar.addEventListener("click", (event) => {
    const chip = event.target.closest(".filter-chip");
    if (!chip) return;
    quickFilter.value = chip.dataset.filter;
    quickFilterBar.querySelectorAll(".filter-chip").forEach((button) => {
      button.classList.toggle("active", button === chip);
      button.setAttribute("aria-pressed", String(button === chip));
    });
    void refresh({ reload: false });
  });
}

async function api(path, options = {}) {
  const requestSessionGeneration = sessionGeneration;
  const {
    skipAuthRedirect = false,
    legacyToken = "",
    headers: suppliedHeaders = {},
    ...fetchOptions
  } = options;
  const headers = new Headers(suppliedHeaders);
  if (fetchOptions.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (legacyToken) headers.set("authorization", `Bearer ${legacyToken}`);
  const response = await fetch(path, {
    ...fetchOptions,
    credentials: "same-origin",
    headers
  });
  const text = await response.text();
  if (requestSessionGeneration !== sessionGeneration) {
    const error = new Error("A requisicao pertence a uma sessao encerrada.");
    error.name = "AbortError";
    throw error;
  }
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: response.ok ? "Resposta invalida do servidor." : "Falha na operacao." };
    }
  }
  if (!response.ok) {
    const error = new Error(data.error || "Falha na operacao");
    error.status = response.status;
    if (response.status === 401 && !skipAuthRedirect) handleUnauthorized();
    throw error;
  }
  return data;
}

function documentCell(label, documentName, documentPath) {
  if (!label) return "-";
  if (!documentPath) return `<span class="doc-link missing" title="Nao ha ${escapeAttribute(documentName)} anexado">${escapeHtml(label)}</span>`;
  return `<span class="doc-link" title="${escapeAttribute(typeof documentPath === "string" ? documentPath : documentPath.path || "Documento anexado")}">${escapeHtml(label)}</span>`;
}

function materialsSummary(materiais = []) {
  const valid = materiais.filter((material) => material.descricao);
  if (!valid.length) return "";
  if (valid.length === 1) return valid[0].descricao;
  return `${valid[0].descricao} + ${valid.length - 1} itens`;
}

function materialsCell(materiais = []) {
  const summary = materialsSummary(materiais);
  if (!summary) return "-";
  const full = materiais
    .filter((material) => material.descricao)
    .map((material) => material.descricao)
    .join(", ");
  return `<span class="materials-cell" title="${escapeAttribute(full)}">${escapeHtml(summary)}</span>`;
}

function statusClass(status) {
  if (status === "Pago") return "locked";
  if (status === "Anulado") return "cancelled";
  if (status === "Liquidado") return "warning";
  return "ok";
}

function statusBadges(processo) {
  const badges = [`<span class="status ${statusClass(processo.status)}">${escapeHtml(statusLabel(processo.status))}</span>`];
  if (isOverdue(processo)) {
    badges.push(`<span class="status overdue">+${overdueDays(processo)}d em atraso</span>`);
  }
  return `<div class="status-stack">${badges.join("")}</div>`;
}

function isOverdue(processo) {
  return processo.diasDecorridos > 30 && !["Entregue", "Liquidado", "Pago", "Anulado"].includes(processo.status);
}

function overdueDays(processo) {
  return Math.max(0, Number(processo.diasDecorridos || 0) - 30);
}

function isCurrentUserAdmin() {
  return currentUser.role === "admin";
}

function empty(value) {
  return escapeHtml(value || "-");
}

function money(value) {
  return Number(value || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function compactMoney(value) {
  const amount = Number(value || 0);
  if (amount >= 1000) return `${Math.round(amount / 1000)}k`;
  return `${Math.round(amount)}`;
}

function dateCell(value) {
  if (!value) return "-";
  const isoDate = String(value).slice(0, 10);
  const match = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return escapeHtml(match ? `${match[3]}-${match[2]}-${match[1]}` : isoDate);
}

function displayDate(value) {
  if (!value) return "";
  const match = String(value).slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[3]}-${match[2]}-${match[1]}` : String(value);
}

function normalizeDateInput(value) {
  const match = String(value || "").trim().match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!match) return "";
  const iso = `${match[3]}-${match[2]}-${match[1]}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === iso ? iso : "";
}

function passwordPolicyMessage() {
  return PASSWORD_POLICY_MESSAGE;
}

function daysCell(processo) {
  if (!deadlineDate(processo)) return "-";
  if (["Entregue", "Liquidado", "Pago", "Anulado"].includes(processo.status)) return "-";
  return `<span class="days ${processo.faixaPrazo}">${processo.diasDecorridos}</span>`;
}

function timelineEvents(processo) {
  const explicitEvents = [
    processo.status === "Entrega parcial" && processo.dataEntrega && { label: "Entrega parcial", date: processo.dataEntrega },
    ["Entregue", "Liquidado", "Pago"].includes(processo.status) && processo.dataEntrega && { label: "Entregue", date: processo.dataEntrega },
    processo.dataEnvioLiquidacao && { label: "Enviado para liquidacao", date: processo.dataEnvioLiquidacao },
    ["Liquidado", "Pago"].includes(processo.status) && { label: "Liquidado", date: processo.dataLiquidacao || processo.dataEnvioLiquidacao || processo.atualizadoEm },
    processo.status === "Pago" && { label: "Pago", date: processo.dataPagamento || processo.atualizadoEm },
    processo.status === "Anulado" && { label: "Anulado", date: processo.anuladoEm || processo.atualizadoEm }
  ].filter(Boolean);

  const auditEvents = visibleAuditEntries(processo)
    .map((entry) => ({
      label: auditLabel(entry),
      date: entry.criadoEm,
      meta: entry.usuario || "Usuario",
      details: entry.detalhes || "",
      documento: entry.documento || documentFromAuditEntry(processo, entry),
      kind: entry.acao === "Remocao de documento" ? "danger" : "",
      showTime: true
    }));

  const observationEvents = state.detailObservations
    .map((observacao) => ({
      label: `Observacao: ${observacao.conteudo}`,
      date: observacao.atualizadoEm || observacao.criadoEm,
      kind: "observation"
    }));

  const events = dedupeTimelineDocuments([...auditEvents, ...explicitEvents, ...observationEvents]
    .filter((event) => event.label && event.date)
    .filter((event, index, list) => list.findIndex((item) => (
      item.label === event.label
        && formatDateTime(item.date) === formatDateTime(event.date)
        && (item.details || "") === (event.details || "")
    )) === index)
    .sort((a, b) => new Date(a.date) - new Date(b.date)));

  return events;
}

function dedupeTimelineDocuments(events = []) {
  const seen = new Set();
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const path = events[index].documento?.path;
    if (!path) continue;
    if (seen.has(path)) {
      events[index] = { ...events[index], documento: null };
      continue;
    }
    seen.add(path);
  }
  return events;
}

function timelineEventClass(event) {
  return [
    event.date ? "done" : "",
    event.kind === "observation" ? "observation" : "",
    event.kind === "danger" ? "danger" : ""
  ].filter(Boolean).join(" ");
}

function documentTimelinePreview(documento = {}) {
  const path = String(documento.path || "");
  const title = documento.nome || documento.fileName || "Documento anexado";
  if (!path) return "";
  return `
    <div class="timeline-document-preview">
      <span>${escapeHtml(title)}</span>
      <button type="button" class="secondary small-action" data-download-document="${escapeAttribute(path)}">Abrir documento</button>
    </div>
  `;
}

function documentFromAuditEntry(processo = {}, entry = {}) {
  if (entry.acao !== "Anexo de documento") return null;
  const key = String(entry.detalhes || "").match(/Documento (.+) anexado\./)?.[1];
  if (!key) return null;
  const value = processo.documentos?.[key];
  if (!value) return null;
  if (key === "complementares") return closestDocumentByDate(documentList(value), entry.criadoEm);
  const documento = documentInfo(value);
  return isDocumentNearAuditDate(documento, entry.criadoEm) ? documento : null;
}

function closestDocumentByDate(documents = [], date = "") {
  const target = new Date(date).getTime();
  if (!documents.length || Number.isNaN(target)) return null;
  const closest = documents
    .map((documento) => ({
      documento,
      distance: Math.abs(new Date(documento.uploadedAt || "").getTime() - target)
    }))
    .filter((item) => !Number.isNaN(item.distance))
    .sort((a, b) => a.distance - b.distance)[0];
  return closest && closest.distance <= 120000 ? closest.documento : null;
}

function isDocumentNearAuditDate(documento = {}, date = "") {
  if (!documento.path || !documento.uploadedAt) return false;
  const uploadedAt = new Date(documento.uploadedAt).getTime();
  const auditDate = new Date(date).getTime();
  return !Number.isNaN(uploadedAt) && !Number.isNaN(auditDate) && Math.abs(uploadedAt - auditDate) <= 120000;
}

function deadlineDate(processo) {
  return processo.dataEnvioFornecedor || processo.dataEnvioEmpenho || "";
}

function auditLabel(entry) {
  if (entry.acao === "Criacao de processo") return "Processo criado";
  if (entry.acao === "Anulacao de empenho") return "Empenho anulado";
  if (entry.acao === "Carga inicial") return "Registro importado";
  if (entry.acao === "Anexo de documento" || entry.acao === "Remocao de documento") {
    return humanizeCamelCase(entry.detalhes || entry.acao);
  }
  const statusMatch = String(entry.detalhes || "").match(/Status atual: (.+)\.$/);
  if (statusMatch) return statusMatch[1];
  return humanizeCamelCase(entry.acao || "Alteracao");
}

function humanizeCamelCase(value = "") {
  return String(value)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\bSPED\b/gi, "sped")
    .toLowerCase();
}

function visibleAuditEntries(processo) {
  return state.auditoria
    .filter((entry) => entry.processoId === processo.id)
    .filter((entry) => entry.acao !== "Carga inicial")
    .sort((a, b) => new Date(a.criadoEm) - new Date(b.criadoEm));
}

function formatDate(value) {
  return displayDate(String(value || "").slice(0, 10)) || "-";
}

function formatDateTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  const pad = (part) => String(part).padStart(2, "0");
  return `${pad(date.getDate())}-${pad(date.getMonth() + 1)}-${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function statusLabel(status = "") {
  return status
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase();
}

function escapeAttribute(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function debounce(fn, wait) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

function setButtonBusy(button, busy, busyLabel = "Aguarde...") {
  if (!button) return;
  if (busy) {
    if (!button.dataset.idleLabel) button.dataset.idleLabel = button.textContent;
    button.disabled = true;
    button.textContent = busyLabel;
    button.setAttribute("aria-busy", "true");
    return;
  }
  button.disabled = false;
  if (button.dataset.idleLabel) button.textContent = button.dataset.idleLabel;
  delete button.dataset.idleLabel;
  button.removeAttribute("aria-busy");
}

function setFormBusy(form, busy, busyLabel = "Salvando...") {
  if (!form) return;
  const submit = form.querySelector('button[type="submit"], button:not([type])');
  setButtonBusy(submit, busy, busyLabel);
  form.setAttribute("aria-busy", String(busy));
}

function setControlBusy(control, busy) {
  if (!control) return;
  control.disabled = busy;
  if (busy) control.setAttribute("aria-busy", "true");
  else control.removeAttribute("aria-busy");
}

function resetSensitiveForm(form, messageElement) {
  form?.reset();
  resetPasswordVisibility(form);
  if (messageElement) messageElement.textContent = "";
}

function renderInlineError(container, message) {
  if (!container) return;
  container.replaceChildren();
  const error = document.createElement("p");
  error.className = "form-message error";
  error.setAttribute("role", "alert");
  error.textContent = message;
  container.append(error);
}

function renderSectionError(container, message, section) {
  if (!container) return;
  container.replaceChildren();
  const wrapper = document.createElement("section");
  wrapper.className = "section-error";
  const text = document.createElement("p");
  text.setAttribute("role", "alert");
  text.textContent = message;
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "secondary";
  retry.textContent = "Tentar novamente";
  retry.addEventListener("click", () => openSection(section), { once: true });
  wrapper.append(text, retry);
  container.append(wrapper);
}
