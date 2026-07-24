import {
  enhancePasswordFields,
  isValidPasswordInput,
  PASSWORD_POLICY_MESSAGE,
  resetPasswordVisibility
} from "./password-fields.js";
import {
  allowedBoardTransitions,
  boardDeadlineDate,
  boardFilterOptions,
  boardResponsible,
  countProcessDocuments,
  filterBoardProcesses,
  getProcessDeadlineState,
  groupProcessesByStatus,
  processObservationCount,
  safeBoardStatusId
} from "./kanban-board.js";
import {
  formatCurrencyInput,
  formatCommitmentNumber,
  normalizeCommitmentSequence,
  parseCurrencyInput,
  parseCommitmentNumber
} from "./process-fields.js";

const state = {
  meta: { status: [], filtrosRapidos: [], transicoes: {} },
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
  detailObservationsLoaded: false,
  detailAudit: [],
  deliveryDraft: null,
  processStepDraft: null,
  timelineDeleteDraft: null,
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
  detailObservationsError: "",
  boardFilters: { search: "", status: "", supplier: "", responsible: "", deadline: "" },
  boardHideEmptyColumns: false,
  boardUpdatingProcesses: new Set(),
  boardDraggingProcessId: "",
  boardScrollLeft: 0,
  boardColumnScrollPositions: {},
  boardPreferencesUser: ""
};

const MAX_DOCUMENT_FILE_BYTES = 15 * 1024 * 1024;
const DOCUMENT_FETCH_TIMEOUT_MS = 30_000;
const DOCUMENT_MEDIA_RENDER_TIMEOUT_MS = 10_000;
const DOCUMENT_TEXT_PREVIEW_BYTES = 200_000;
const APP_SECTIONS = new Set(["dashboard", "processes", "board", "suppliers", "audit", "users", "settings"]);
const ACTIVE_SECTION_STORAGE_PREFIX = "almoxActiveSection";
const ALLOWED_DOCUMENT_RESPONSE_MIME_TYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "text/csv",
  "application/csv",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/zip",
  "text/plain",
  "image/png",
  "image/jpeg",
  "application/octet-stream"
]);

let currentUser = null;
let legacyAuthToken = localStorage.getItem("almoxAuthToken") || "";
let refreshController = null;
let refreshSequence = 0;
let dashboardSequence = 0;
let detailController = null;
let detailSequence = 0;
let handlingUnauthorized = false;
let sessionGeneration = 0;
let timelinePreviewSequence = 0;
let timelinePreviewController = null;
let timelinePreviewObserver = null;
let timelinePreviewQueue = Promise.resolve();
const timelinePreviewTimers = new Set();
let documentPreviewSequence = 0;
let documentPreviewController = null;
let documentPreviewMediaTimer = null;
let standardDocumentController = null;
let complementaryDocumentController = null;
let documentPreviewUrl = "";
let documentPreviewBlob = null;
let documentPreviewFileName = "";
const timelinePreviewUrls = new Set();
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
const commitmentYear = document.querySelector("#commitmentYear");
const commitmentSequence = document.querySelector("#commitmentSequence");
const commitmentNumberPreview = document.querySelector("#commitmentNumberPreview");
const processDialog = document.querySelector("#processDialog");
const processDialogTitle = document.querySelector("#processDialogTitle");
const newProcessButton = document.querySelector("#newProcessButton");
const downloadProcessesButton = document.querySelector("#downloadProcessesButton");
const refreshProcessesButton = document.querySelector("#refreshProcessesButton");
const processExportFormat = document.querySelector("#processExportFormat");
const addMaterialButton = document.querySelector("#addMaterialButton");
const materialsList = document.querySelector("#materialsList");
const formMessage = document.querySelector("#formMessage");
const table = document.querySelector("#processTable");
const dialog = document.querySelector("#observationsDialog");
const observationsDialogTitle = document.querySelector("#observationsDialogTitle");
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
const processStepDialog = document.querySelector("#processStepDialog");
const processStepForm = document.querySelector("#processStepForm");
const processStepDialogTitle = document.querySelector("#processStepDialogTitle");
const processStepDialogDescription = document.querySelector("#processStepDialogDescription");
const processStepDateGroup = document.querySelector("#processStepDateGroup");
const processStepDateLabel = document.querySelector("#processStepDateLabel");
const processStepMessage = document.querySelector("#processStepMessage");
const cancelProcessStep = document.querySelector("#cancelProcessStep");
const deleteTimelineDialog = document.querySelector("#deleteTimelineDialog");
const deleteTimelineForm = document.querySelector("#deleteTimelineForm");
const deleteTimelineDescription = document.querySelector("#deleteTimelineDescription");
const deleteTimelineMessage = document.querySelector("#deleteTimelineMessage");
const cancelDeleteTimeline = document.querySelector("#cancelDeleteTimeline");
const rollbackStatusDialog = document.querySelector("#rollbackStatusDialog");
const rollbackStatusForm = document.querySelector("#rollbackStatusForm");
const rollbackStatusDescription = document.querySelector("#rollbackStatusDescription");
const rollbackStatusMessage = document.querySelector("#rollbackStatusMessage");
const cancelRollbackStatus = document.querySelector("#cancelRollbackStatus");
const cancelProcessDialog = document.querySelector("#cancelProcessDialog");
const cancelProcessForm = document.querySelector("#cancelProcessForm");
const cancelProcessMessage = document.querySelector("#cancelProcessMessage");
const closeCancelProcess = document.querySelector("#closeCancelProcess");
const processListView = document.querySelector("#processListView");
const processDetailView = document.querySelector("#processDetailView");
const backToProcesses = document.querySelector("#backToProcesses");
const detailProcessNumber = document.querySelector("#detailProcessNumber");
const detailStatusBadges = document.querySelector("#detailStatusBadges");
const detailSubtitle = document.querySelector("#detailSubtitle");
const detailPanel = document.querySelector("#detailPanel");
const detailTabs = document.querySelectorAll(".detail-tab");
const downloadDialog = document.querySelector("#downloadDialog");
const downloadChoices = document.querySelectorAll("[data-download-format]");
const documentPreviewDialog = document.querySelector("#documentPreviewDialog");
const documentPreviewDialogTitle = document.querySelector("#documentPreviewDialogTitle");
const documentPreviewContent = document.querySelector("#documentPreviewContent");
const documentPreviewStatus = document.querySelector("#documentPreviewStatus");
const documentPreviewMessage = document.querySelector("#documentPreviewMessage");
const documentPreviewDownload = document.querySelector("#documentPreviewDownload");
const supplierInfoDialog = document.querySelector("#supplierInfoDialog");
const supplierInfoForm = document.querySelector("#supplierInfoForm");
const supplierInfoMessage = document.querySelector("#supplierInfoMessage");
const cancelSupplierInfo = document.querySelector("#cancelSupplierInfo");
const dashboardView = document.querySelector("#dashboardView");
const boardView = document.querySelector("#boardView");
const kanbanBoard = document.querySelector("#kanbanBoard");
const boardMessage = document.querySelector("#boardMessage");
const boardSearchInput = document.querySelector("#boardSearchInput");
const boardResponsibleFilter = document.querySelector("#boardResponsibleFilter");
const boardSupplierFilter = document.querySelector("#boardSupplierFilter");
const boardDeadlineFilter = document.querySelector("#boardDeadlineFilter");
const boardStatusFilter = document.querySelector("#boardStatusFilter");
const boardHideEmptyColumns = document.querySelector("#boardHideEmptyColumns");
const clearBoardFilters = document.querySelector("#clearBoardFilters");
const refreshBoardButton = document.querySelector("#refreshBoardButton");
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
const processCreatorName = document.querySelector("#processCreatorName");
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

bindDateInputs();
initCommitmentFields();
initTheme();
await initAuth();

function bindDateInputs() {
  document.querySelectorAll("[data-date-input]").forEach((input) => {
    input.addEventListener("input", () => {
      input.value = formatDateInput(input.value);
    });
  });
}

function initCommitmentFields() {
  if (!commitmentYear || !commitmentSequence) return;
  const currentYear = new Date().getFullYear();
  commitmentYear.innerHTML = Array.from({ length: currentYear - 1999 }, (_, index) => currentYear - index)
    .map((year) => `<option value="${year}">${year}</option>`)
    .join("");
  commitmentYear.value = String(currentYear);
  commitmentYear.addEventListener("change", updateCommitmentNumberPreview);
  commitmentSequence.addEventListener("input", () => {
    commitmentSequence.value = String(commitmentSequence.value || "").replace(/\D/g, "").slice(0, 11);
    updateCommitmentNumberPreview();
  });
  commitmentSequence.addEventListener("blur", () => {
    commitmentSequence.value = normalizeCommitmentSequence(commitmentSequence.value);
    updateCommitmentNumberPreview();
  });
  updateCommitmentNumberPreview();
}

function updateCommitmentNumberPreview() {
  if (!commitmentNumberPreview) return;
  const formatted = formatCommitmentNumber(commitmentYear?.value, commitmentSequence?.value);
  commitmentNumberPreview.textContent = formatted ? `Empenho: ${formatted}` : `Exemplo: ${commitmentYear?.value || new Date().getFullYear()}NE00010`;
}

function configureCommitmentFields(numeroEmpenho = "") {
  if (!commitmentYear || !commitmentSequence || !processForm?.elements.numeroEmpenho) return;
  const parsed = parseCommitmentNumber(numeroEmpenho);
  const legacy = Boolean(numeroEmpenho && !parsed);
  commitmentYear.disabled = legacy;
  commitmentSequence.disabled = legacy;
  commitmentYear.required = !legacy;
  commitmentSequence.required = !legacy;
  if (parsed) {
    if (![...commitmentYear.options].some((option) => option.value === parsed.year)) {
      const option = document.createElement("option");
      option.value = parsed.year;
      option.textContent = parsed.year;
      commitmentYear.add(option);
    }
    commitmentYear.value = parsed.year;
    commitmentSequence.value = parsed.sequence;
  } else if (legacy) {
    commitmentSequence.value = "";
  } else {
    commitmentYear.value = String(new Date().getFullYear());
    commitmentSequence.value = "";
    processForm.elements.numeroEmpenho.value = "";
  }
  if (legacy) commitmentNumberPreview.textContent = `Formato legado preservado: ${numeroEmpenho}`;
  else updateCommitmentNumberPreview();
}

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
    setButtonBusy(logoutButton, true, "Saindo...");
    try {
      const response = await fetch("/auth/logout", {
        method: "POST",
        credentials: "same-origin",
        signal: controller.signal
      });
      if (!response.ok && response.status !== 401) throw new Error("Nao foi possivel encerrar a sessao.");
      clearClientSession();
      showAuth();
      authMessage.textContent = "";
    } catch (error) {
      const message = error.name === "AbortError"
        ? "O servidor demorou para confirmar o encerramento."
        : error.message || "Nao foi possivel confirmar o encerramento no servidor.";
      showAppError(`${message} Tente novamente.`);
    } finally {
      window.clearTimeout(timeout);
      setButtonBusy(logoutButton, false);
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
  cancelStandardDocumentUpload();
  refreshSequence += 1;
  dashboardSequence += 1;
  detailSequence += 1;
  clearTimelineDocumentPreviews();
  resetDocumentPreviewDialog();
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
    processStepDialog,
    deleteTimelineDialog,
    rollbackStatusDialog,
    cancelProcessDialog,
    downloadDialog,
    documentPreviewDialog,
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
  state.meta = { status: [], filtrosRapidos: [], transicoes: {} };
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
  state.detailObservationsLoaded = false;
  state.detailAudit = [];
  state.deliveryDraft = null;
  state.processStepDraft = null;
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
  state.boardFilters = { search: "", status: "", supplier: "", responsible: "", deadline: "" };
  state.boardHideEmptyColumns = false;
  state.boardUpdatingProcesses = new Set();
  state.boardDraggingProcessId = "";
  state.boardScrollLeft = 0;
  state.boardColumnScrollPositions = {};
  state.boardPreferencesUser = "";
  table?.replaceChildren();
  detailPanel?.replaceChildren();
  dashboardView?.replaceChildren();
  if (kanbanBoard) kanbanBoard.replaceChildren();
  if (boardMessage) boardMessage.textContent = "";
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
    id: user.id || "",
    email: user.email || "",
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
  await openSection(savedActiveSection());
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
  await ensureProcessesLoaded({ force: true });
  applyProcessFilters();
  renderProcessData();
}

async function renderBoardView({ force = false } = {}) {
  ensureBoardPreferences();
  if (!state.processesLoaded || force) {
    setBoardMessage("Carregando processos...");
    await ensureProcessesLoaded({ force });
  }
  syncBoardControls();
  renderKanbanBoard();
}

function renderKanbanBoard() {
  if (!kanbanBoard) return;
  if (kanbanBoard.childElementCount) captureBoardScrollPositions();
  const statuses = [...(state.meta.status || [])];
  const filtered = filterBoardProcesses(state.allProcesses, state.boardFilters);
  const groups = groupProcessesByStatus(filtered, statuses);
  const visibleStatuses = state.boardHideEmptyColumns
    ? statuses.filter((status) => groups.get(status)?.length)
    : statuses;

  if (!statuses.length) {
    kanbanBoard.innerHTML = '<p class="empty-state" role="status">Nenhum status disponível para montar o quadro.</p>';
    return;
  }
  if (!visibleStatuses.length) {
    kanbanBoard.innerHTML = '<p class="empty-state board-empty-state" role="status">Nenhum processo corresponde aos filtros atuais.</p>';
    return;
  }

  kanbanBoard.innerHTML = visibleStatuses
    .map((status) => createKanbanColumn(status, groups.get(status) || []))
    .join("");
  setBoardMessage(`${filtered.length} processo(s) visível(is) no quadro.`);
  restoreBoardScrollPositions();
}

function createKanbanColumn(status, processes) {
  const total = processes.reduce((sum, process) => sum + Number(process.valorTotal || 0), 0);
  return `
    <section class="kanban-column" data-status="${escapeAttribute(safeBoardStatusId(status))}" data-board-status="${escapeAttribute(status)}" aria-labelledby="board-column-${escapeAttribute(safeBoardStatusId(status))}">
      <header class="kanban-column-header">
        <div>
          <h2 id="board-column-${escapeAttribute(safeBoardStatusId(status))}">${escapeHtml(status)}</h2>
          <span>${escapeHtml(money(total))}</span>
        </div>
        <strong aria-label="${processes.length} processos">${processes.length}</strong>
      </header>
      <div class="kanban-column-cards" data-board-column-scroll="${escapeAttribute(status)}">
        ${processes.length
          ? processes.map((process) => createKanbanCard(process)).join("")
          : '<p class="kanban-column-empty">Nenhum processo neste status.</p>'}
      </div>
    </section>
  `;
}

function createKanbanCard(process) {
  const material = (process.materiais || []).find((item) => item?.descricao)?.descricao || "";
  const responsible = boardResponsible(process);
  const documents = countProcessDocuments(process);
  const observations = processObservationCount(process);
  const deadlineState = getProcessDeadlineState(process);
  const deadline = boardDeadlineDate(process);
  const targets = boardMoveTargets(process);
  const updating = state.boardUpdatingProcesses.has(process.id);
  const movable = targets.length > 0 && !updating;
  const accessibleName = processAccessibleName(process);
  return `
    <article class="kanban-card deadline-${escapeAttribute(deadlineState)}${updating ? " is-updating" : ""}"
      data-board-card="true" data-process-id="${escapeAttribute(process.id)}" draggable="${movable}"
      tabindex="0" role="button" aria-label="Abrir ${escapeAttribute(accessibleName)}" aria-busy="${updating}">
      <div class="kanban-card-heading">
        <strong>${escapeHtml(process.numeroProcesso || "Processo não informado")}</strong>
        ${isOverdue(process) ? '<span class="kanban-overdue-label">Em atraso</span>' : ""}
      </div>
      ${process.numeroEmpenho ? `<span class="kanban-card-empenho">NE ${escapeHtml(process.numeroEmpenho)}</span>` : ""}
      ${process.fornecedor ? `<span class="kanban-card-line"><b>Fornecedor</b>${escapeHtml(process.fornecedor)}</span>` : ""}
      ${material ? `<span class="kanban-card-line"><b>Material</b>${escapeHtml(material)}</span>` : ""}
      <strong class="kanban-card-value">${escapeHtml(money(process.valorTotal))}</strong>
      <div class="kanban-card-meta">
        ${Number.isFinite(Number(process.diasDecorridos)) ? `<span>${escapeHtml(String(Number(process.diasDecorridos)))} dias</span>` : ""}
        ${deadline ? `<span>Prazo: ${escapeHtml(formatDate(deadline))}</span>` : '<span>Sem prazo</span>'}
        ${responsible ? `<span>Responsável: ${escapeHtml(responsible)}</span>` : ""}
      </div>
      ${(documents || observations) ? `<div class="kanban-card-indicators">
        ${documents ? `<span aria-label="${documents} documentos">▤ ${documents}</span>` : ""}
        ${observations ? `<span aria-label="${observations} observações">◫ ${observations}</span>` : ""}
      </div>` : ""}
      ${movable ? `<label class="kanban-move-control"><span>Mover para…</span><select data-board-move="${escapeAttribute(process.id)}" aria-label="Mover ${escapeAttribute(accessibleName)} para outro status">
        <option value="">Selecione o destino</option>
        ${targets.map((status) => `<option value="${escapeAttribute(status)}">${escapeHtml(status)}</option>`).join("")}
      </select></label>` : ""}
      ${updating ? '<span class="kanban-updating-label">Atualizando…</span>' : ""}
    </article>
  `;
}

function boardMoveTargets(process) {
  if (!canEditGeneralInUi(process)) return [];
  return allowedBoardTransitions(process.status, state.meta.transicoes, state.meta.status);
}

function isAllowedBoardTransition(process, targetStatus) {
  return Boolean(process && boardMoveTargets(process).includes(targetStatus));
}

function updateBoardFiltersFromControls() {
  captureBoardScrollPositions();
  state.boardFilters = {
    search: boardSearchInput?.value || "",
    responsible: boardResponsibleFilter?.value || "",
    supplier: boardSupplierFilter?.value || "",
    deadline: boardDeadlineFilter?.value || "",
    status: boardStatusFilter?.value || ""
  };
  saveBoardPreferences();
  renderKanbanBoard();
}

function syncBoardControls() {
  const options = boardFilterOptions(state.allProcesses);
  if (!options.responsibles.includes(state.boardFilters.responsible)) state.boardFilters.responsible = "";
  if (!options.suppliers.includes(state.boardFilters.supplier)) state.boardFilters.supplier = "";
  if (!(state.meta.status || []).includes(state.boardFilters.status)) state.boardFilters.status = "";
  fillBoardSelect(boardResponsibleFilter, options.responsibles, "Todos os responsáveis", state.boardFilters.responsible);
  fillBoardSelect(boardSupplierFilter, options.suppliers, "Todos os fornecedores", state.boardFilters.supplier);
  fillBoardSelect(boardStatusFilter, state.meta.status || [], "Todos os status", state.boardFilters.status);
  if (boardSearchInput) boardSearchInput.value = state.boardFilters.search;
  if (boardDeadlineFilter) boardDeadlineFilter.value = state.boardFilters.deadline;
  if (boardHideEmptyColumns) boardHideEmptyColumns.checked = state.boardHideEmptyColumns;
}

function fillBoardSelect(select, values, placeholder, selected) {
  if (!select) return;
  select.innerHTML = `<option value="">${escapeHtml(placeholder)}</option>${values
    .map((value) => `<option value="${escapeAttribute(value)}">${escapeHtml(value)}</option>`)
    .join("")}`;
  select.value = values.includes(selected) ? selected : "";
}

function boardPreferencesKey() {
  const userKey = String(currentUser?.id || currentUser?.email || "usuario").trim().toLowerCase();
  return `almoxBoardPreferences:${userKey}`;
}

function ensureBoardPreferences() {
  const key = boardPreferencesKey();
  if (state.boardPreferencesUser === key) return;
  state.boardPreferencesUser = key;
  try {
    const saved = JSON.parse(localStorage.getItem(key) || "{}");
    const filters = saved.filters && typeof saved.filters === "object" ? saved.filters : {};
    state.boardFilters = {
      search: String(filters.search || ""),
      status: String(filters.status || ""),
      supplier: String(filters.supplier || ""),
      responsible: String(filters.responsible || ""),
      deadline: String(filters.deadline || "")
    };
    state.boardHideEmptyColumns = Boolean(saved.hideEmptyColumns);
    state.boardScrollLeft = Math.max(0, Number(saved.scrollLeft || 0));
    state.boardColumnScrollPositions = saved.columnScrollPositions && typeof saved.columnScrollPositions === "object"
      ? saved.columnScrollPositions
      : {};
  } catch {
    state.boardFilters = { search: "", status: "", supplier: "", responsible: "", deadline: "" };
  }
}

function saveBoardPreferences() {
  try {
    localStorage.setItem(boardPreferencesKey(), JSON.stringify({
      filters: state.boardFilters,
      hideEmptyColumns: state.boardHideEmptyColumns,
      scrollLeft: state.boardScrollLeft,
      columnScrollPositions: state.boardColumnScrollPositions
    }));
  } catch {
    // O quadro continua funcional se o armazenamento local estiver indisponível.
  }
}

function captureBoardScrollPositions() {
  if (!kanbanBoard || kanbanBoard.classList.contains("hidden")) return;
  state.boardScrollLeft = kanbanBoard.scrollLeft;
  kanbanBoard.querySelectorAll("[data-board-column-scroll]").forEach((column) => {
    state.boardColumnScrollPositions[column.dataset.boardColumnScroll] = column.scrollTop;
  });
}

function restoreBoardScrollPositions() {
  window.requestAnimationFrame(() => {
    if (!kanbanBoard) return;
    kanbanBoard.scrollLeft = state.boardScrollLeft;
    kanbanBoard.querySelectorAll("[data-board-column-scroll]").forEach((column) => {
      column.scrollTop = Number(state.boardColumnScrollPositions[column.dataset.boardColumnScroll] || 0);
    });
  });
}

function setBoardMessage(message = "", tone = "") {
  if (!boardMessage) return;
  boardMessage.textContent = message;
  boardMessage.classList.toggle("error", tone === "error");
}

function openBoardProcess(processId) {
  const process = processById(processId);
  if (!process) return;
  captureBoardScrollPositions();
  saveBoardPreferences();
  void openProcessDetail(process, "board");
}

async function requestBoardTransition(processId, targetStatus) {
  const process = processById(processId);
  if (!process) {
    setBoardMessage("O processo não está mais disponível. Atualize o quadro.", "error");
    return;
  }
  if (state.boardUpdatingProcesses.has(processId)) return;
  if (!isAllowedBoardTransition(process, targetStatus)) {
    renderKanbanBoard();
    setBoardMessage(`Não é possível mover este processo de “${process.status}” para “${targetStatus}”.`, "error");
    return;
  }
  const deliveryTransition = (["Empenho enviado ao fornecedor", "Aguardando entrega"].includes(process.status) && targetStatus === "Entrega parcial")
    || (process.status === "Entrega parcial" && targetStatus === "Entregue");
  if (deliveryTransition) {
    state.boardUpdatingProcesses.add(processId);
    state.selectedProcess = process;
    renderKanbanBoard();
    openDeliveryDialog("", targetStatus === "Entregue", "board");
    return;
  }
  const step = nextProcessStep(process);
  if (!step || step.status !== targetStatus) {
    setBoardMessage("A próxima etapa mudou. Atualize o quadro e tente novamente.", "error");
    return;
  }

  if (step.field) {
    state.boardUpdatingProcesses.add(processId);
    state.selectedProcess = process;
    renderKanbanBoard();
    openProcessStepDialog(step, "board");
    return;
  }
  await updateBoardProcess(process, targetStatus);
}

async function updateBoardProcess(process, targetStatus) {
  state.boardUpdatingProcesses.add(process.id);
  setBoardMessage(`Atualizando ${processAccessibleName(process)}…`);
  renderKanbanBoard();
  let finalMessage = "";
  let finalTone = "";
  try {
    const updated = await api(`/api/processes/${process.id}`, {
      method: "PUT",
      body: JSON.stringify(processUpdatePayloadFor(process, { status: targetStatus }))
    });
    replaceProcessInState(updated);
    applyProcessFilters();
    finalMessage = `Processo movido para “${targetStatus}”.`;
    await loadDashboardData(state.dashboardYear).catch(() => null);
  } catch (error) {
    finalMessage = `Não foi possível atualizar o status. O processo permaneceu em “${process.status}”. ${error.message || ""}`.trim();
    finalTone = "error";
  } finally {
    state.boardUpdatingProcesses.delete(process.id);
    renderKanbanBoard();
    setBoardMessage(finalMessage, finalTone);
  }
}

function replaceProcessInState(updated) {
  state.allProcesses = state.allProcesses.map((process) => process.id === updated.id ? updated : process);
  state.processos = state.processos.map((process) => process.id === updated.id ? updated : process);
  if (state.selectedProcess?.id === updated.id) state.selectedProcess = updated;
}

function cleanupBoardDragState() {
  state.boardDraggingProcessId = "";
  kanbanBoard?.querySelectorAll(".is-dragging, .is-drag-over").forEach((item) => {
    item.classList.remove("is-dragging", "is-drag-over");
  });
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
        processo.criadoPor,
        processo.criadoPorEmail,
        ...(processo.materiais || []).map((material) => material.descricao)
      ].some((value) => normalizeText(value).includes(query));
    })
    .filter((processo) => matchesQuickFilter(processo, quick));
}

function matchesQuickFilter(processo, quickFilterValue) {
  if (!quickFilterValue) return true;
  if (["Em atraso", "Mais de 30 dias"].includes(quickFilterValue)) return isOverdue(processo);
  if (quickFilterValue === "Pendentes de liquidacao") {
    return ["Entregue", "Aguardando envio para liquidacao", "Enviado para liquidacao"].includes(processo.status)
      && !processo.dataLiquidacao;
  }
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
  const revokeTimer = setTimeout(() => URL.revokeObjectURL(url), 10_000);
  revokeTimer?.unref?.();
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
      <td>${empty(processo.criadoPor || processo.criadoPorEmail)}</td>
      <td>${statusBadges(processo)}</td>
    </tr>
  `).join("") : '<tr class="empty-table-row"><td colspan="11">Nenhum processo encontrado.</td></tr>';
}

function processAccessibleName(processo = {}) {
  if (processo.numeroProcesso) return `processo ${processo.numeroProcesso}`;
  if (processo.numeroEmpenho) return `empenho ${processo.numeroEmpenho}`;
  return "processo sem numero";
}

processForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const editingLegacyCommitment = Boolean(commitmentSequence?.disabled && processForm.elements.numeroEmpenho.value);
  if (!editingLegacyCommitment) {
    const numeroEmpenho = formatCommitmentNumber(commitmentYear?.value, commitmentSequence?.value);
    if (!numeroEmpenho) {
      formMessage.textContent = "Selecione o ano e informe somente o número sequencial do empenho.";
      commitmentSequence?.focus();
      return;
    }
    processForm.elements.numeroEmpenho.value = numeroEmpenho;
  }
  const data = Object.fromEntries(new FormData(processForm));
  data.materiais = readMaterials();
  if (data.materiais.some((material) => !Number.isFinite(material.valorUnitario))) {
    formMessage.textContent = "Informe os valores unitarios no formato 1.234,56.";
    return;
  }
  const id = data.id;
  const isCreating = !id;
  delete data.id;
  formMessage.textContent = "";
  if (!String(data.numeroProcesso || "").trim() && !String(data.numeroEmpenho || "").trim()) {
    formMessage.textContent = "Informe o numero do processo, o numero do empenho ou ambos.";
    return;
  }
  if (!String(data.criadoPor || "").trim()) {
    formMessage.textContent = "Informe o requisitante.";
    processCreatorName?.focus();
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
    if (isCreating) {
      const createdProcess = state.allProcesses.find((processo) => processo.id === savedProcess.id) || savedProcess;
      await openProcessDetail(createdProcess, "processes");
    } else if (wasSelected) {
      [state.detailObservations, state.detailAudit] = await Promise.all([
        loadDetailObservations(savedProcess.id),
        loadDetailAudit(savedProcess.id)
      ]);
      state.detailObservationsLoaded = true;
      renderProcessDetail();
    }
  } catch (error) {
    showAppError(`O processo foi salvo, mas a lista nao foi atualizada: ${error.message}`);
    if (isCreating) await openProcessDetail(savedProcess, "processes");
  }
});

document.querySelector("#clearForm").addEventListener("click", () => clearForm({ preserveIdentity: true }));
newProcessButton.addEventListener("click", () => openProcessDialog());
downloadProcessesButton?.addEventListener("click", downloadProcesses);
refreshProcessesButton?.addEventListener("click", async () => {
  setButtonBusy(refreshProcessesButton, true, "Atualizando...");
  try {
    await refresh({ reload: true, updateDashboard: false });
  } catch (error) {
    showAppError(error.message || "Nao foi possivel atualizar os empenhos.");
  } finally {
    setButtonBusy(refreshProcessesButton, false);
  }
});
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
documentMetadataDialog?.addEventListener("close", () => {
  complementaryDocumentController?.abort();
  complementaryDocumentController = null;
  state.pendingDocumentFile = null;
  documentMetadataForm?.reset();
  if (documentSelectedFile) documentSelectedFile.textContent = "";
});
materialsList.addEventListener("click", (event) => {
  if (!event.target.dataset.removeMaterial) return;
  event.target.closest(".material-row").remove();
  ensureOneMaterialRow();
  updateMaterialTotals();
});
materialsList.addEventListener("input", updateMaterialTotals);
materialsList.addEventListener("focusout", (event) => {
  if (event.target.dataset.materialField !== "valorUnitario" || !event.target.value.trim()) return;
  const amount = parseCurrencyInput(event.target.value);
  if (Number.isFinite(amount)) event.target.value = formatCurrencyInput(amount);
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

boardSearchInput?.addEventListener("input", debounce(() => updateBoardFiltersFromControls(), 180));
[boardResponsibleFilter, boardSupplierFilter, boardDeadlineFilter, boardStatusFilter].forEach((control) => {
  control?.addEventListener("change", updateBoardFiltersFromControls);
});
boardHideEmptyColumns?.addEventListener("change", () => {
  captureBoardScrollPositions();
  state.boardHideEmptyColumns = boardHideEmptyColumns.checked;
  saveBoardPreferences();
  renderKanbanBoard();
});
clearBoardFilters?.addEventListener("click", () => {
  state.boardFilters = { search: "", status: "", supplier: "", responsible: "", deadline: "" };
  syncBoardControls();
  saveBoardPreferences();
  renderKanbanBoard();
  boardSearchInput?.focus();
});
refreshBoardButton?.addEventListener("click", async () => {
  setButtonBusy(refreshBoardButton, true, "Atualizando...");
  try {
    await renderBoardView({ force: true });
    setBoardMessage("Quadro atualizado.");
  } catch (error) {
    setBoardMessage(error.message || "Não foi possível atualizar o quadro.", "error");
  } finally {
    setButtonBusy(refreshBoardButton, false);
  }
});
kanbanBoard?.addEventListener("scroll", debounce(() => {
  state.boardScrollLeft = kanbanBoard.scrollLeft;
  saveBoardPreferences();
}, 160));
kanbanBoard?.addEventListener("click", (event) => {
  if (event.target.closest("select, button, input, a, label")) return;
  const card = event.target.closest("[data-board-card]");
  if (card) openBoardProcess(card.dataset.processId);
});
kanbanBoard?.addEventListener("keydown", (event) => {
  const card = event.target.closest("[data-board-card]");
  if (!card || event.target !== card || !["Enter", " "].includes(event.key)) return;
  event.preventDefault();
  openBoardProcess(card.dataset.processId);
});
kanbanBoard?.addEventListener("change", (event) => {
  const select = event.target.closest("[data-board-move]");
  if (!select || !select.value) return;
  void requestBoardTransition(select.dataset.boardMove, select.value);
});
kanbanBoard?.addEventListener("dragstart", (event) => {
  const card = event.target.closest("[data-board-card]");
  if (!card?.draggable || state.boardUpdatingProcesses.has(card.dataset.processId)) {
    event.preventDefault();
    return;
  }
  state.boardDraggingProcessId = card.dataset.processId;
  card.classList.add("is-dragging");
  event.dataTransfer?.setData("text/plain", card.dataset.processId);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
});
kanbanBoard?.addEventListener("dragover", (event) => {
  const column = event.target.closest("[data-board-status]");
  const process = processById(state.boardDraggingProcessId);
  if (!column || !process || !isAllowedBoardTransition(process, column.dataset.boardStatus)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  kanbanBoard.querySelectorAll(".kanban-column.is-drag-over").forEach((item) => item.classList.remove("is-drag-over"));
  column.classList.add("is-drag-over");
});
kanbanBoard?.addEventListener("dragleave", (event) => {
  const column = event.target.closest("[data-board-status]");
  if (column && !column.contains(event.relatedTarget)) column.classList.remove("is-drag-over");
});
kanbanBoard?.addEventListener("drop", (event) => {
  event.preventDefault();
  const column = event.target.closest("[data-board-status]");
  const processId = state.boardDraggingProcessId || event.dataTransfer?.getData("text/plain");
  cleanupBoardDragState();
  if (column && processId) void requestBoardTransition(processId, column.dataset.boardStatus);
});
kanbanBoard?.addEventListener("dragend", cleanupBoardDragState);

detailTabs.forEach((tab) => {
  tab.addEventListener("click", async () => {
    state.detailTab = tab.dataset.detailTab;
    detailTabs.forEach((item) => setTabActive(item, item === tab));
    detailPanel.setAttribute("aria-busy", "true");
    try {
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

documentPreviewDownload?.addEventListener("click", async () => {
  if (!documentPreviewBlob || !documentPreviewFileName) return;
  try {
    const blobUrl = URL.createObjectURL(documentPreviewBlob);
    triggerBlobDownload(blobUrl, documentPreviewFileName);
  } catch (error) {
    if (documentPreviewMessage) {
      documentPreviewMessage.textContent = error.message || "Nao foi possivel baixar o documento.";
      documentPreviewMessage.classList.add("error");
    }
  }
});
documentPreviewDialog?.addEventListener("close", resetDocumentPreviewDialog);

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
  if (open) window.requestAnimationFrame(() => sidebar.querySelector(".nav-item:not(.hidden)")?.focus());
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
    if (event.target.dataset.downloadProcess) {
      if (state.selectedProcess) downloadDialog?.showModal();
      return;
    }

    if (event.target.dataset.openEdit) {
      openProcessDialog(state.selectedProcess);
    }

    const notesId = event.target.closest("[data-open-notes]")?.dataset.openNotes;
    if (notesId) {
      await openObservationsDialog(notesId, { focusComposer: true });
      return;
    }

    const attachButton = event.target.closest("[data-attach-document]");
    const attachKey = attachButton?.dataset.attachDocument;
    if (attachKey) {
      await attachDocument(attachKey, attachButton);
      return;
    }

    const testEmailProcessId = event.target.dataset.sendTestEmail;
    if (testEmailProcessId) {
      await sendTestEmail(testEmailProcessId);
    }

    const retryPreview = event.target.closest("[data-retry-document-preview]");
    if (retryPreview) {
      await retryTimelineDocumentPreview(retryPreview);
      return;
    }

    const openButton = event.target.closest("[data-open-document]");
    const openPath = openButton?.dataset.openDocument;
    if (openPath) {
      await openDocument(openPath, {
        fileName: openButton.dataset.documentName,
        mimeType: openButton.dataset.documentMime
      });
      return;
    }

    const downloadButton = event.target.closest("[data-download-document]");
    const downloadPath = downloadButton?.dataset.downloadDocument;
    if (downloadPath) {
      await downloadDocument(downloadPath, downloadButton.dataset.documentName);
      return;
    }

    const removeDocumentKey = event.target.closest("[data-remove-document]")?.dataset.removeDocument;
    if (removeDocumentKey) {
      await removeDocument(removeDocumentKey);
      return;
    }

    const editObservationId = event.target.dataset.editObservation;
    if (editObservationId) {
      await editObservation(editObservationId);
    }

    const deleteObservationId = event.target.dataset.deleteObservation;
    if (deleteObservationId) {
      await deleteObservation(deleteObservationId);
    }

    const deleteTimelineButton = event.target.closest("[data-delete-timeline]");
    if (deleteTimelineButton) {
      openDeleteTimelineDialog({
        type: deleteTimelineButton.dataset.timelineType,
        id: deleteTimelineButton.dataset.timelineId,
        label: deleteTimelineButton.dataset.timelineLabel
      });
      return;
    }

    if (event.target.dataset.registerPartialDelivery) {
      await registerPartialDelivery();
    }

    if (event.target.dataset.cancelProcess) {
      cancelProcessForm?.reset();
      if (cancelProcessMessage) cancelProcessMessage.textContent = "";
      cancelProcessDialog?.showModal();
      cancelProcessForm?.elements.motivo?.focus();
    }

    if (event.target.dataset.rollbackStatus) {
      openRollbackStatusDialog();
    }

    if (event.target.dataset.inactivateProcess) {
      await inactivateSelectedProcess();
    }

    if (event.target.dataset.showNewData) {
      const step = nextProcessStep(state.selectedProcess);
      if (!step) return;
      if (["Entrega parcial", "Entregue"].includes(step?.status)) {
        openDeliveryDialog("", step.status === "Entregue");
        return;
      }
      openProcessStepDialog(step);
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
    observationMessage.textContent = "Observação registrada.";
  } catch (error) {
    observationMessage.textContent = error.message || "Não foi possível registrar a observação.";
  } finally {
    setFormBusy(observationForm, false);
  }
});

async function openObservationsDialog(processId, { focusComposer = false } = {}) {
  state.observationProcessId = processId;
  observationMessage.textContent = "";
  observationsList.innerHTML = '<p class="empty-state" role="status">Carregando observações...</p>';
  const processo = processById(processId);
  const canCompose = canEditGeneralInUi(processo);
  observationForm.classList.toggle("hidden", !canCompose);
  observationsDialogTitle.textContent = focusComposer && canCompose ? "Adicionar observação" : "Observações";
  dialog.showModal();
  if (focusComposer && canCompose) observationForm.elements.conteudo.focus();
  try {
    await loadObservations();
  } catch (error) {
    renderInlineError(observationsList, error.message || "Não foi possível carregar as observações.");
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
  `).join("") : "<p>Nenhuma observação registrada.</p>";
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
    editObservationMessage.textContent = "A observação deve ter entre 1 e 350 caracteres.";
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
    observationMessage.textContent = "Observação alterada.";
  } catch (error) {
    editObservationMessage.textContent = error.message || "Não foi possível alterar a observação.";
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
processStepForm?.addEventListener("submit", saveProcessStep);
cancelProcessStep?.addEventListener("click", () => processStepDialog?.close());
processStepDialog?.addEventListener("close", resetProcessStepDialog);
processStepForm?.addEventListener("input", (event) => {
  event.target.removeAttribute("aria-invalid");
  if (processStepMessage) processStepMessage.textContent = "";
});
cancelDeleteTimeline?.addEventListener("click", () => deleteTimelineDialog?.close());
deleteTimelineDialog?.addEventListener("close", () => {
  state.timelineDeleteDraft = null;
  deleteTimelineForm?.reset();
  if (deleteTimelineMessage) deleteTimelineMessage.textContent = "";
});
deleteTimelineForm?.addEventListener("submit", saveTimelineDeletion);
cancelRollbackStatus?.addEventListener("click", () => rollbackStatusDialog?.close());
rollbackStatusDialog?.addEventListener("close", () => {
  rollbackStatusForm?.reset();
  if (rollbackStatusMessage) rollbackStatusMessage.textContent = "";
});
rollbackStatusForm?.addEventListener("submit", saveStatusRollback);
closeCancelProcess?.addEventListener("click", () => cancelProcessDialog?.close());
cancelProcessDialog?.addEventListener("close", () => {
  cancelProcessForm?.reset();
  if (cancelProcessMessage) cancelProcessMessage.textContent = "";
});
cancelProcessForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const processo = state.selectedProcess;
  const motivo = String(new FormData(event.currentTarget).get("motivo") || "").trim();
  if (!processo || !motivo || motivo.length > 1000) {
    cancelProcessMessage.textContent = "Informe um motivo de anulacao com ate 1000 caracteres.";
    return;
  }
  setFormBusy(event.currentTarget, true, "Anulando...");
  try {
    const updated = await api(`/api/processes/${processo.id}/cancel`, {
      method: "POST",
      body: JSON.stringify({ motivo })
    });
    state.selectedProcess = updated;
    cancelProcessDialog.close();
    renderProcessDetail();
    await refreshAfterMutation("O empenho foi anulado");
  } catch (error) {
    cancelProcessMessage.textContent = error.message || "Nao foi possivel anular o empenho.";
  } finally {
    setFormBusy(event.currentTarget, false);
  }
});

function fillForm(processo) {
  processForm.elements.id.value = processo.id;
  processForm.elements.versao.value = processo.versao;
  for (const [key, value] of Object.entries(processo)) {
    if (processForm.elements[key]) processForm.elements[key].value = value ?? "";
  }
  if (processForm.elements.dataProcesso) processForm.elements.dataProcesso.value = displayDate(processo.dataProcesso);
  if (processCreatorName) processCreatorName.value = processo.criadoPor || processo.criadoPorEmail || "";
  configureCommitmentFields(processo.numeroEmpenho || "");
  if (processForm.elements.dataEnvioFornecedor && !processForm.elements.dataEnvioFornecedor.value) {
    processForm.elements.dataEnvioFornecedor.value = processo.dataEnvioEmpenho || "";
  }
  renderMaterialRows(processo.materiais);
  formMessage.textContent = "Editando processo selecionado.";
}

function clearForm({ preserveIdentity = false } = {}) {
  const id = preserveIdentity ? processForm.elements.id.value : "";
  const versao = preserveIdentity ? processForm.elements.versao.value : "";
  processForm.reset();
  processForm.elements.id.value = id;
  processForm.elements.versao.value = versao;
  configureCommitmentFields("");
  formMessage.textContent = "";
  renderMaterialRows();
  if (id) formMessage.textContent = "Campos limpos. O salvamento continuara alterando o processo selecionado.";
}

function openProcessDialog(processo = null) {
  clearForm();
  processDialogTitle.textContent = processo ? "Editar processo" : "Novo processo";
  if (processo) fillForm(processo);
  processDialog.showModal();
}

async function openProcessDetail(processo, returnSection = "processes") {
  if (!processo) return;
  cancelStandardDocumentUpload();
  detailController?.abort();
  const controller = new AbortController();
  detailController = controller;
  const sequence = ++detailSequence;
  state.selectedProcess = processo;
  state.detailReturnSection = returnSection;
  state.detailTab = "general";
  state.detailObservations = [];
  state.detailObservationsLoaded = false;
  state.detailAudit = [];
  state.detailObservationsError = "";
  processListView.classList.add("hidden");
  dashboardView.classList.add("hidden");
  boardView.classList.add("hidden");
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
    const [observations, auditEntries] = await Promise.all([
      loadDetailObservations(processo.id, { signal: controller.signal }),
      loadDetailAudit(processo.id, { signal: controller.signal })
    ]);
    if (sequence !== detailSequence || state.selectedProcess?.id !== processo.id) return;
    state.detailObservations = observations;
    state.detailObservationsLoaded = true;
    state.detailAudit = auditEntries;
    renderProcessDetail();
  } catch (error) {
    if (error.name !== "AbortError" && sequence === detailSequence && state.selectedProcess?.id === processo.id) {
      state.detailObservationsError = error.message || "Não foi possível carregar as observações.";
      renderProcessDetail();
    }
  } finally {
    if (detailController === controller) detailController = null;
  }
}

function closeProcessDetail() {
  cancelStandardDocumentUpload();
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
  if (response.status === 401) {
    handleUnauthorized();
    throw new Error("Sua sessao expirou.");
  }
  if (!response.ok) throw new Error(await documentResponseError(response));
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

  clearTimelineDocumentPreviews();
  detailPanel.innerHTML = (renderers[state.detailTab] || renderTimelineModule)(processo);
  if (state.detailTab === "timeline") void hydrateTimelineDocumentPreviews();
}

function renderGeneralModule(processo) {
  const fornecedor = supplierFor(processo);

  return `
    <div class="general-data-layout">
      <div class="general-data-row general-data-identity">
        ${detailField("Fornecedor", processo.fornecedor)}
        ${detailField("CNPJ", processo.cnpj || fornecedor?.cnpj)}
      </div>
      <div class="general-data-row general-data-process">
        ${detailField("Processo", processo.numeroProcesso)}
        ${detailField("Empenho", processo.numeroEmpenho)}
        ${detailField("Requisitante", processo.criadoPor || processo.criadoPorEmail)}
        ${detailField("Data do processo", dateCell(processo.dataProcesso))}
        ${detailField("Valor total", money(processo.valorTotal))}
      </div>
      <div class="general-data-row general-data-dates">
        ${detailField("Data de envio para fornecedor", dateCell(deadlineDate(processo)))}
        ${detailField("Data de entrega", dateCell(processo.dataEntrega))}
        ${detailField("Data de envio para liquidação", dateCell(processo.dataEnvioLiquidacao))}
        ${detailField("Data da liquidação", dateCell(processo.dataLiquidacao))}
        ${detailField("Data do pagamento", dateCell(processo.dataPagamento))}
      </div>
      ${detailMaterialsField(processo.materiais)}
      ${processo.status === "Anulado" ? `<div class="general-data-row general-data-note">${detailField("Motivo da anulação", processo.motivoAnulacao)}</div>` : ""}
    </div>
    <div class="detail-actions">
      ${canEditGeneralInUi(processo) ? '<button type="button" class="detail-primary-action" data-open-edit="true">Editar dados do processo</button>' : ""}
      ${newDataButton(processo)}
      ${canRollbackStatusInUi(processo) ? '<button type="button" class="secondary" data-rollback-status="true">Retroceder status</button>' : ""}
      ${canCancelProcessInUi(processo) ? '<button type="button" class="secondary danger-action" data-cancel-process="true">Anular empenho</button>' : ""}
      ${canInactivateProcessInUi(processo) ? '<button type="button" class="secondary danger-action" data-inactivate-process="true">Inativar empenho</button>' : ""}
    </div>
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
      <div class="detail-actions">
        <button type="button" class="download-button" data-download-process="true">Baixar processo completo</button>
      </div>
      <progress class="document-upload-progress hidden" data-document-upload-progress aria-label="Carregando documento"></progress>
      ${documents.map(([key, label, value]) => {
        const doc = documentInfo(value);
        return `
        <article class="module-row">
          <div>
            <strong>${escapeHtml(label)}</strong>
            ${doc.path
              ? `<button type="button" class="document-name" data-open-document="${escapeAttribute(doc.path)}" data-document-name="${escapeAttribute(doc.fileName)}" data-document-mime="${escapeAttribute(doc.mimeType || "")}">${escapeHtml(doc.fileName)}</button>`
              : `<span>${`Nao ha ${label} anexado`}</span>`}
          </div>
          <div class="document-actions">
            <button type="button" class="secondary" ${canAttachDocumentInUi(processo, key) ? `data-attach-document="${key}"` : "disabled"}>${doc.path ? "Substituir" : "Anexar"}</button>
            <button type="button" class="secondary danger-action" ${doc.path && canRemoveDocumentInUi(processo, key) ? `data-remove-document="${key}"` : "disabled"}>Remover</button>
            <button type="button" class="secondary" ${doc.path ? `data-download-document="${escapeAttribute(doc.path)}" data-document-name="${escapeAttribute(doc.fileName)}"` : "disabled"}>Baixar</button>
          </div>
        </article>
      `;}).join("")}
      ${complementaryDocuments.length
        ? complementaryDocuments.map((doc, index) => `
          <article class="module-row document-extra-item">
            <div>
              <button type="button" class="document-name document-title" data-open-document="${escapeAttribute(doc.path)}" data-document-name="${escapeAttribute(doc.fileName)}" data-document-mime="${escapeAttribute(doc.mimeType || "")}">${escapeHtml(doc.titulo || doc.nome || doc.fileName)}</button>
              ${doc.descricao ? `<span>${escapeHtml(doc.descricao)}</span>` : ""}
              <span>${escapeHtml(doc.fileName)}</span>
            </div>
            <div class="document-actions">
              <button type="button" class="secondary danger-action" ${canRemoveDocumentInUi(processo, "complementares") ? `data-remove-document="complementares:${doc.sourceIndex ?? index}"` : "disabled"}>Remover</button>
              <button type="button" class="secondary" data-download-document="${escapeAttribute(doc.path)}" data-document-name="${escapeAttribute(doc.fileName)}">Baixar</button>
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
          ${isCurrentUserAdmin() && event.sourceType && event.sourceId
            ? `<button type="button" class="secondary small-action timeline-delete-action" data-delete-timeline="true" data-timeline-type="${escapeAttribute(event.sourceType)}" data-timeline-id="${escapeAttribute(event.sourceId)}" data-timeline-label="${escapeAttribute(event.label)}">Excluir</button>`
            : ""}
        </li>
      `).join("")}
    </ol>
  `;
}

function openDeleteTimelineDialog(item = {}) {
  if (!isCurrentUserAdmin() || !state.selectedProcess || !item.type || !item.id || !deleteTimelineDialog || !deleteTimelineForm) return;
  state.timelineDeleteDraft = { processId: state.selectedProcess.id, ...item };
  deleteTimelineForm.reset();
  deleteTimelineDescription.textContent = `Item: ${item.label || "Dado da linha do tempo"}`;
  if (deleteTimelineMessage) deleteTimelineMessage.textContent = "";
  deleteTimelineDialog.showModal();
  deleteTimelineForm.elements.motivo.focus();
}

async function saveTimelineDeletion(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const draft = state.timelineDeleteDraft;
  const motivo = String(new FormData(form).get("motivo") || "").trim();
  if (!draft || draft.processId !== state.selectedProcess?.id) return;
  if (motivo.length > 1000) {
    deleteTimelineMessage.textContent = "O motivo deve ter ate 1000 caracteres.";
    return;
  }
  setFormBusy(form, true, "Excluindo...");
  try {
    await api(`/api/processes/${draft.processId}/timeline-items`, {
      method: "DELETE",
      body: JSON.stringify({ tipo: draft.type, id: draft.id, motivo })
    });
    deleteTimelineDialog.close();
    await refreshAfterMutation("O dado foi excluido da linha do tempo");
  } catch (error) {
    deleteTimelineMessage.textContent = error.message || "Nao foi possivel excluir o dado da linha do tempo.";
  } finally {
    setFormBusy(form, false);
  }
}

function renderDeliveriesModule(processo) {
  const deliveries = Array.isArray(processo.entregas) ? processo.entregas : [];
  return `
    <div class="module-list">
      <article class="module-row">
        <div>
          <strong>${deliveries.length ? `${deliveries.length} entrega(s) registrada(s)` : "Nenhuma entrega registrada"}</strong>
          <span>${deliveries.length ? `Ultima entrega: ${dateCell(processo.dataEntrega)}` : "Use este modulo para registrar quantidade entregue, pendente e data da entrega."}</span>
        </div>
        ${canRegisterDeliveryInUi(processo) ? '<button type="button" class="secondary" data-register-partial-delivery="true">Registrar entrega parcial</button>' : ""}
      </article>
      ${deliveries.map((entrega, deliveryIndex) => `
        <article class="module-row delivery-history-item">
          <div>
            <strong>Entrega ${deliveryIndex + 1} · ${dateCell(entrega.data)}</strong>
            <span>${escapeHtml((entrega.itens || []).map((item) => {
              const material = deliveryMaterialForItem(processo, item);
              return `${material?.descricao || "Material"}: ${formatQuantity(item.quantidade)}`;
            }).join("; ") || "Sem itens informados")}</span>
            <span>Recebido por: ${escapeHtml(entrega.recebidoPor || "Nao informado")}</span>
            ${entrega.observacao ? `<span>Observação: ${escapeHtml(entrega.observacao)}</span>` : ""}
          </div>
        </article>
      `).join("")}
    </div>
  `;
}

function renderObservationsModule(processo) {
  const totalLabel = state.detailObservationsError
    ? "total indisponível"
    : !state.detailObservationsLoaded
    ? "carregando total…"
    : `${state.detailObservations.length} ${state.detailObservations.length === 1 ? "observação" : "observações"}`;
  const observations = state.detailObservationsError
    ? `<p class="form-message error" role="alert">${escapeHtml(state.detailObservationsError)}</p>`
    : !state.detailObservationsLoaded
    ? '<p class="empty-state" role="status">Carregando observações...</p>'
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
    : "<p>Nenhuma observação registrada.</p>";

  return `
    <div class="module-list">
      <article class="module-row">
        <div>
          <strong>Observações do processo · ${totalLabel}</strong>
          <span>Todas as observações estão listadas abaixo, da mais recente para a mais antiga.</span>
        </div>
        ${canEditGeneralInUi(processo) ? `<button type="button" class="secondary" data-open-notes="${escapeAttribute(processo.id)}">Adicionar</button>` : ""}
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

function detailMaterialsField(materiais = []) {
  const rows = materiais.filter((material) => material.descricao).map((material) => {
    const quantity = Number(material.quantidade || 0);
    const unitValue = Number(material.valorUnitario || 0);
    return `
      <tr>
        <td>${escapeHtml(material.descricao)}</td>
        <td class="detail-material-number">${escapeHtml(formatQuantity(quantity))}</td>
        <td class="detail-material-number">${escapeHtml(money(unitValue))}</td>
        <td class="detail-material-number detail-material-total">${escapeHtml(money(quantity * unitValue))}</td>
      </tr>
    `;
  }).join("");
  return `
    <div class="detail-materials-field">
      <table class="detail-material-table">
        <caption>Materiais</caption>
        <thead>
          <tr>
            <th scope="col">Material</th>
            <th scope="col" class="detail-material-number">Unidades</th>
            <th scope="col" class="detail-material-number">Valor unitário</th>
            <th scope="col" class="detail-material-number">Valor total</th>
          </tr>
        </thead>
        <tbody>${rows || '<tr><td colspan="4">Nenhum material informado.</td></tr>'}</tbody>
      </table>
    </div>
  `;
}

function supplierFor(processo) {
  return state.fornecedores.find((fornecedor) => fornecedor.razaoSocial === processo.fornecedor);
}

async function loadDetailObservations(processId, options = {}) {
  return api(`/api/processes/${processId}/observations`, options);
}

async function loadDetailAudit(processId, options = {}) {
  return api(`/api/processes/${processId}/audit`, options);
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

async function attachDocument(documentKey, triggerButton = null) {
  if (!state.selectedProcess) return;
  const processId = state.selectedProcess.id;
  const file = await pickDocumentFile(documentKey);
  if (!file || state.selectedProcess?.id !== processId) return;
  if (!validateSelectedDocument(file, documentKey)) return;
  if (documentKey === "complementares") {
    openComplementaryDocumentForm(file);
    return;
  }
  const controller = new AbortController();
  standardDocumentController?.abort();
  standardDocumentController = controller;
  setControlBusy(triggerButton, true);
  setDocumentUploadProgress(true, detailPanel);
  try {
    const contentBase64 = await fileToBase64(file, controller.signal);
    if (controller.signal.aborted || state.selectedProcess?.id !== processId) throw createAbortError();
    const updatedProcess = await api(`/api/processes/${processId}/documents`, {
      method: "POST",
      signal: controller.signal,
      body: JSON.stringify({
        documentKey,
        fileName: file.name,
        mimeType: file.type || "",
        contentBase64
      })
    });
    if (controller.signal.aborted || state.selectedProcess?.id !== processId) return;
    state.selectedProcess = updatedProcess;
    renderProcessDetail();
    await refreshAfterMutation("O documento foi anexado");
  } catch (error) {
    if (error.name !== "AbortError") alert(error.message || "Nao foi possivel anexar o documento.");
  } finally {
    if (standardDocumentController === controller) standardDocumentController = null;
    setControlBusy(triggerButton, false);
    setDocumentUploadProgress(false, detailPanel);
  }
}

function cancelStandardDocumentUpload() {
  standardDocumentController?.abort();
  standardDocumentController = null;
}

function openComplementaryDocumentForm(file) {
  state.pendingDocumentFile = file;
  const suggestedName = String(file.name || "").replace(/\.[^.]+$/i, "");
  documentMetadataForm.reset();
  documentMetadataForm.elements.titulo.value = suggestedName;
  documentSelectedFile.textContent = `Arquivo selecionado: ${file.name}`;
  documentMetadataDialog.showModal();
  documentMetadataForm.elements.titulo.focus();
}

async function saveComplementaryDocument() {
  if (!state.selectedProcess || !state.pendingDocumentFile) return;
  const processId = state.selectedProcess.id;
  const file = state.pendingDocumentFile;
  const data = Object.fromEntries(new FormData(documentMetadataForm));
  const titulo = String(data.titulo || "").trim();
  if (!titulo) return;
  const controller = new AbortController();
  complementaryDocumentController?.abort();
  complementaryDocumentController = controller;
  setControlBusy(documentMetadataForm.querySelector('button[type="submit"]'), true);
  setDocumentUploadProgress(true, documentMetadataForm);
  try {
    const contentBase64 = await fileToBase64(file, controller.signal);
    if (controller.signal.aborted || state.selectedProcess?.id !== processId) return;
    const updatedProcess = await api(`/api/processes/${processId}/documents`, {
      method: "POST",
      signal: controller.signal,
      body: JSON.stringify({
        documentKey: "complementares",
        fileName: file.name,
        mimeType: file.type || "",
        contentBase64,
        titulo,
        descricao: String(data.descricao || "").trim()
      })
    });
    if (controller.signal.aborted || state.selectedProcess?.id !== processId) return;
    state.pendingDocumentFile = null;
    documentMetadataDialog.close();
    state.selectedProcess = updatedProcess;
    renderProcessDetail();
    await refreshAfterMutation("O documento foi anexado");
  } catch (error) {
    if (error.name !== "AbortError") alert(error.message || "Nao foi possivel anexar o documento.");
  } finally {
    if (complementaryDocumentController === controller) complementaryDocumentController = null;
    setControlBusy(documentMetadataForm.querySelector('button[type="submit"]'), false);
    setDocumentUploadProgress(false, documentMetadataForm);
  }
}

function setDocumentUploadProgress(loading, root = document) {
  root?.querySelectorAll("[data-document-upload-progress]").forEach((progress) => {
    progress.classList.toggle("hidden", !loading);
  });
}

async function removeDocument(documentKey) {
  if (!state.selectedProcess) return;
  const processId = state.selectedProcess.id;
  if (!confirm("Remover este documento anexado?")) return;
  const updatedProcess = await api(`/api/processes/${processId}/documents/${documentKey}`, {
    method: "DELETE"
  });
  if (state.selectedProcess?.id !== processId) return;
  state.selectedProcess = updatedProcess;
  renderProcessDetail();
  await refreshAfterMutation("O documento foi removido");
}

function pickDocumentFile(documentKey = "complementares") {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    let settled = false;
    const finish = (file) => {
      if (settled) return;
      settled = true;
      resolve(file || null);
    };
    input.type = "file";
    input.accept = documentKey === "complementares"
      ? ".pdf,.xlsx,.xls,.csv,.docx,.doc,.odt,.ods,.txt,.png,.jpg,.jpeg,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/msword"
      : ".pdf,application/pdf";
    input.addEventListener("change", () => finish(input.files?.[0]), { once: true });
    input.addEventListener("cancel", () => finish(null), { once: true });
    window.addEventListener("focus", () => setTimeout(() => {
      if (!input.files?.length) finish(null);
    }, 300), { once: true });
    input.click();
  });
}

function validateSelectedDocument(file, documentKey = "complementares") {
  if (file.size > MAX_DOCUMENT_FILE_BYTES) {
    alert("O arquivo deve ter no maximo 15 MB.");
    return false;
  }
  if (documentKey !== "complementares" && file.type !== "application/pdf" && !String(file.name || "").toLowerCase().endsWith(".pdf")) {
    alert("Processo SPED, Nota de Empenho e Nota Fiscal devem ser enviados em PDF.");
    return false;
  }
  return true;
}

function fileToBase64(file, signal) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    let settled = false;
    const cleanup = () => signal?.removeEventListener("abort", handleSignalAbort);
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const handleSignalAbort = () => {
      try {
        reader.abort();
      } catch {
        // The reader may already have completed between the signal and this callback.
      }
      finish(reject, createAbortError());
    };
    reader.addEventListener("load", () => finish(resolve, String(reader.result).split(",")[1] || ""), { once: true });
    reader.addEventListener("error", () => finish(reject, reader.error || new Error("Nao foi possivel ler o arquivo.")), { once: true });
    reader.addEventListener("abort", () => finish(reject, createAbortError()), { once: true });
    if (signal?.aborted) {
      finish(reject, createAbortError());
      return;
    }
    signal?.addEventListener("abort", handleSignalAbort, { once: true });
    try {
      reader.readAsDataURL(file);
    } catch (error) {
      finish(reject, error);
    }
  });
}

function createAbortError(message = "Operacao cancelada.") {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
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
    observationMessage.textContent = error.message || "Não foi possível abrir a observação.";
  }
}

async function deleteObservation(observationId) {
  if (!confirm("Excluir esta observação?")) return;
  try {
    const current = state.detailObservations.find((item) => item.id === observationId)
      || await findDialogObservation(observationId);
    const processId = current?.processoId || state.observationProcessId || state.selectedProcess?.id;
    if (!processId) throw new Error("Processo da observação não encontrado.");
    await api(`/api/processes/${processId}/observations/${observationId}`, {
      method: "DELETE"
    });
    await refreshObservationViews();
    observationMessage.textContent = "Observação excluída.";
  } catch (error) {
    observationMessage.textContent = error.message || "Não foi possível excluir a observação.";
  }
}

function openProcessStepDialog(step, source = "detail") {
  const processo = state.selectedProcess;
  if (!processo || !step || !processStepDialog || !processStepForm) return;

  resetProcessStepDialog();
  state.processStepDraft = {
    processId: processo.id,
    fromStatus: processo.status,
    status: step.status,
    field: step.field || "",
    source
  };
  processStepDialogTitle.textContent = step.button;
  processStepDialogDescription.textContent = step.title;
  processStepDateGroup?.classList.toggle("hidden", !step.field);
  if (processStepDateLabel) processStepDateLabel.textContent = step.dateLabel || "Data";

  const dateInput = processStepForm.elements.data;
  if (dateInput) {
    dateInput.required = Boolean(step.field);
    dateInput.value = step.field ? displayDate(processo[step.field]) : "";
  }
  processStepDialog.showModal();
  window.requestAnimationFrame(() => (step.field ? dateInput : processStepForm.querySelector('button[type="submit"]'))?.focus());
}

async function saveProcessStep(event) {
  event.preventDefault();
  const draft = state.processStepDraft;
  const processo = state.selectedProcess;
  if (!draft || !processo || processo.id !== draft.processId) {
    processStepDialog?.close();
    return;
  }

  const step = nextProcessStep(processo);
  const allowedValue = state.meta.transicoes?.[processo.status];
  const allowed = Array.isArray(allowedValue) ? allowedValue : (allowedValue ? [allowedValue] : []);
  if (!step || processo.status !== draft.fromStatus || step.status !== draft.status || (step.field || "") !== draft.field
      || (allowed.length && !allowed.includes(step.status))) {
    if (processStepMessage) processStepMessage.textContent = "A proxima etapa mudou. Atualize a tela e tente novamente.";
    return;
  }

  const dateInput = processStepForm?.elements.data;
  const date = step.field ? normalizeDateInput(dateInput?.value) : "";
  if (step.field && !date) {
    if (processStepMessage) processStepMessage.textContent = "Informe uma data valida para salvar.";
    dateInput?.setAttribute("aria-invalid", "true");
    dateInput?.focus();
    return;
  }

  const overrides = { status: step.status };
  if (step.field) overrides[step.field] = date;

  if (step.status === "Pago") {
    if (!confirm("Deseja realmente alterar este processo para Pago?")) {
      processStepMessage.textContent = "O pagamento não foi confirmado.";
      return;
    }
    if (!confirm("Após confirmar o pagamento, o processo será bloqueado para edição. Esta ação exige confirmação adicional. Deseja continuar?")) {
      processStepMessage.textContent = "A confirmação adicional do pagamento foi cancelada.";
      return;
    }
  }

  setFormBusy(processStepForm, true, "Salvando...");
  try {
    const updatedProcess = await api(`/api/processes/${processo.id}`, {
      method: "PUT",
      body: JSON.stringify(processUpdatePayload(overrides))
    });
    state.selectedProcess = updatedProcess;
    processStepDialog?.close();
    renderProcessDetail();
    await refreshAfterMutation("A etapa foi salva");
  } catch (error) {
    if (processStepMessage) processStepMessage.textContent = error.message || "Nao foi possivel salvar a etapa.";
  } finally {
    setFormBusy(processStepForm, false);
  }
}

function resetProcessStepDialog() {
  const boardProcessId = state.processStepDraft?.source === "board" ? state.processStepDraft.processId : "";
  state.processStepDraft = null;
  if (boardProcessId) {
    state.boardUpdatingProcesses.delete(boardProcessId);
    if (processDetailView.classList.contains("hidden")) state.selectedProcess = null;
    if (state.activeSection === "board") renderKanbanBoard();
  }
  processStepForm?.reset();
  processStepForm?.querySelectorAll("[aria-invalid]").forEach((input) => input.removeAttribute("aria-invalid"));
  processStepDateGroup?.classList.remove("hidden");
  if (processStepMessage) processStepMessage.textContent = "";
}

function previousStatusesInUi(processo) {
  const workflow = (state.meta.status || []).filter((status) => status !== "Anulado");
  const currentIndex = workflow.indexOf(processo?.status);
  return currentIndex > 0 ? workflow.slice(0, currentIndex) : [];
}

function canRollbackStatusInUi(processo) {
  return Boolean(isCurrentUserAdmin() && processo && !processo.inativo && previousStatusesInUi(processo).length);
}

function openRollbackStatusDialog() {
  const processo = state.selectedProcess;
  if (!canRollbackStatusInUi(processo) || !rollbackStatusDialog || !rollbackStatusForm) return;
  rollbackStatusForm.reset();
  rollbackStatusDescription.textContent = `Status atual: ${processo.status}. Selecione o status anterior correto.`;
  rollbackStatusForm.elements.status.innerHTML = previousStatusesInUi(processo)
    .map((status) => `<option value="${escapeAttribute(status)}">${escapeHtml(status)}</option>`)
    .join("");
  if (rollbackStatusMessage) rollbackStatusMessage.textContent = "";
  rollbackStatusDialog.showModal();
  rollbackStatusForm.elements.status.focus();
}

async function saveStatusRollback(event) {
  event.preventDefault();
  const processo = state.selectedProcess;
  const data = Object.fromEntries(new FormData(event.currentTarget));
  const motivo = String(data.motivo || "").trim();
  if (!processo || !previousStatusesInUi(processo).includes(data.status) || !motivo || motivo.length > 1000) {
    rollbackStatusMessage.textContent = "Selecione um status anterior e informe o motivo do retrocesso.";
    return;
  }
  setFormBusy(event.currentTarget, true, "Salvando...");
  try {
    const updated = await api(`/api/processes/${processo.id}/rollback-status`, {
      method: "POST",
      body: JSON.stringify({ status: data.status, motivo, versao: processo.versao })
    });
    state.selectedProcess = updated;
    rollbackStatusDialog.close();
    renderProcessDetail();
    await refreshAfterMutation("O status foi retrocedido");
  } catch (error) {
    rollbackStatusMessage.textContent = error.message || "Nao foi possivel retroceder o status.";
  } finally {
    setFormBusy(event.currentTarget, false);
  }
}

function registerPartialDelivery() {
  openDeliveryDialog(state.selectedProcess?.dataEntrega || "", false);
}

function openDeliveryDialog(date = "", complete = false, source = "detail") {
  const processo = state.selectedProcess;
  if (!processo || !deliveryDialog || !deliveryForm) return;
  resetDeliveryDialog();
  const balances = deliveryBalanceRows(processo);
  state.deliveryDraft = { processId: processo.id, complete, source };
  deliveryDialogTitle.textContent = complete ? "Registrar entrega final" : "Registrar entrega";
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
        <label for="${inputId}">Quantidade recebida (opcional)
          <input id="${inputId}" name="quantidade-${materialIndex}" type="number" inputmode="decimal" min="0" max="${remaining}" step="any" placeholder="Saldo completo" data-delivery-quantity="${materialIndex}" aria-describedby="${balanceId}">
        </label>
      </div>
    `;
  }).join("") : '<p class="empty-state">Nao ha saldo pendente para os materiais deste processo.</p>';
  deliveryForm.querySelector('button[type="submit"]').disabled = !balances.length;
  if (!balances.length) deliveryMessage.textContent = "Todos os materiais ja foram recebidos.";
  deliveryDialog.showModal();
  window.requestAnimationFrame(() => deliveryForm.elements.data.focus());
}

function deliveryBalanceRows(processo) {
  const delivered = new Map();
  (processo.entregas || []).forEach((entrega) => (entrega.itens || []).forEach((item) => {
    const material = deliveryMaterialForItem(processo, item);
    const key = material?.id || `index:${item.materialIndex}`;
    delivered.set(key, (delivered.get(key) || 0) + Number(item.quantidade || 0));
  }));
  return (processo.materiais || []).map((material, materialIndex) => ({
    material,
    materialIndex,
    remaining: Math.max(0, Number(material.quantidade || 0) - (delivered.get(material.id || `index:${materialIndex}`) || 0))
  })).filter((item) => item.remaining > 0);
}

function deliveryMaterialForItem(processo, item = {}) {
  const materials = processo.materiais || [];
  if (item.materialId) {
    const byId = materials.find((material) => material.id === item.materialId);
    if (byId) return byId;
  }
  return materials[Number(item.materialIndex)] || null;
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
  let hasEnteredQuantity = false;
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
    hasEnteredQuantity = true;
    const quantidade = Number(rawValue);
    if (!balance || !Number.isFinite(quantidade) || quantidade < 0 || quantidade > balance.remaining) {
      input.setAttribute("aria-invalid", "true");
      firstInvalidInput ||= input;
      return;
    }
    if (quantidade > 0) itens.push({ materialIndex, materialId: balance.material.id, quantidade });
  });
  if (firstInvalidInput) {
    deliveryMessage.textContent = "Revise as quantidades: cada valor deve ser numerico e nao pode superar o saldo indicado.";
    firstInvalidInput.focus();
    return;
  }
  if (!hasEnteredQuantity) {
    for (const { materialIndex, material, remaining } of balances.values()) {
      itens.push({ materialIndex, materialId: material.id, quantidade: remaining });
    }
  }
  if (!itens.length) {
    deliveryMessage.textContent = "Não há saldo pendente para registrar nesta entrega.";
    deliveryForm.querySelector("[data-delivery-quantity]")?.focus();
    return;
  }

  setFormBusy(deliveryForm, true, "Salvando...");
  let updatedProcess;
  try {
    updatedProcess = await api(`/api/processes/${processo.id}/deliveries`, {
      method: "POST",
      body: JSON.stringify({ data, itens, observacao: String(deliveryForm.elements.observacao?.value || "").trim() })
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
    await refreshDetailAudit();
    renderProcessDetail();
    if (state.activeSection === "board") renderKanbanBoard();
  } catch (error) {
    showAppError(`A entrega foi registrada, mas a lista nao foi atualizada: ${error.message}`);
  }
}

function resetDeliveryDialog() {
  const boardProcessId = state.deliveryDraft?.source === "board" ? state.deliveryDraft.processId : "";
  state.deliveryDraft = null;
  if (boardProcessId) {
    state.boardUpdatingProcesses.delete(boardProcessId);
    if (processDetailView.classList.contains("hidden")) state.selectedProcess = null;
    if (state.activeSection === "board") renderKanbanBoard();
  }
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
  return processUpdatePayloadFor(state.selectedProcess, overrides);
}

function processUpdatePayloadFor(processo, overrides = {}) {
  return {
    numeroProcesso: processo.numeroProcesso || "",
    numeroEmpenho: processo.numeroEmpenho || "",
    fornecedor: processo.fornecedor || "",
    dataProcesso: processo.dataProcesso || "",
    dataEnvioSalc: processo.dataEnvioSalc || "",
    materiais: processo.materiais || [],
    dataEnvioFornecedor: processo.dataEnvioFornecedor || deadlineDate(processo),
    dataEntrega: processo.dataEntrega || "",
    dataEnvioLiquidacao: processo.dataEnvioLiquidacao || "",
    dataLiquidacao: processo.dataLiquidacao || "",
    dataPagamento: processo.dataPagamento || "",
    status: processo.status || "Criado",
    versao: processo.versao,
    ...overrides
  };
}

async function refreshObservationViews() {
  if (state.observationProcessId) await loadObservations();
  if (state.selectedProcess) {
    [state.detailObservations, state.detailAudit] = await Promise.all([
      loadDetailObservations(state.selectedProcess.id),
      loadDetailAudit(state.selectedProcess.id)
    ]);
    state.detailObservationsLoaded = true;
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
  if (typeof value === "string") {
    return value.startsWith("/uploads/")
      ? { fileName: documentFileNameFromPath(value), path: value }
      : { fileName: value, path: "" };
  }
  if (typeof value !== "object" || Array.isArray(value)) return {};
  const path = String(value.path || "").trim();
  return {
    ...value,
    path,
    fileName: String(value.fileName || value.nome || documentFileNameFromPath(path) || "Documento anexado").trim()
  };
}

function documentList(value) {
  if (!value) return [];
  const items = Array.isArray(value) ? value : [value];
  return items
    .map((item, sourceIndex) => ({ ...documentInfo(item), sourceIndex }))
    .filter((doc) => doc.path);
}

function documentFileNameFromPath(path = "") {
  try {
    const url = new URL(path, window.location.origin);
    const segment = url.pathname.split("/").pop() || "";
    return decodeURIComponent(segment) || "Documento anexado";
  } catch {
    return "Documento anexado";
  }
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
  if (state.activeSection === "board" && section !== "board") {
    captureBoardScrollPositions();
    saveBoardPreferences();
  }
  if (!APP_SECTIONS.has(section)) section = "dashboard";
  if (["users", "settings"].includes(section) && currentUser?.role !== "admin") section = "dashboard";
  if (section === "audit" && !["admin", "auditor"].includes(currentUser?.role)) section = "dashboard";
  state.activeSection = section;
  rememberActiveSection(section);
  detailController?.abort();
  detailSequence += 1;
  activateSectionShell(section);

  const renderers = {
    dashboard: () => renderDashboardView(),
    processes: () => renderProcessesView(),
    board: () => renderBoardView(),
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
    if (section === "board") {
      const message = error.message || "Não foi possível carregar os processos no quadro.";
      setBoardMessage(message, "error");
      renderSectionError(kanbanBoard, message, section, () => renderBoardView({ force: true }));
      return;
    }
    const target = { dashboard: dashboardView, suppliers: suppliersView, audit: auditView, users: usersView, settings: settingsView }[section];
    renderSectionError(target, error.message || "Nao foi possivel carregar esta secao.", section);
  }
}

function activeSectionStorageKey() {
  const userKey = String(currentUser?.email || currentUser?.id || "usuario").trim().toLowerCase();
  return `${ACTIVE_SECTION_STORAGE_PREFIX}:${userKey}`;
}

function savedActiveSection() {
  try {
    const section = window.sessionStorage.getItem(activeSectionStorageKey());
    return APP_SECTIONS.has(section) ? section : "dashboard";
  } catch {
    return "dashboard";
  }
}

function rememberActiveSection(section) {
  try {
    window.sessionStorage.setItem(activeSectionStorageKey(), section);
  } catch {
    // A navegacao continua funcionando mesmo se o navegador bloquear o armazenamento.
  }
}

function activateSectionShell(section) {
  cancelStandardDocumentUpload();
  state.activeSection = section;
  navItems.forEach((item) => {
    const active = item.dataset.section === section;
    item.classList.toggle("active", active);
    if (active) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  });
  const titles = { dashboard: "Painel", processes: "Empenhos", board: "Quadro de processos", suppliers: "Fornecedores", audit: "Auditoria", users: "Usuarios e permissoes", settings: "Templates" };
  if (sectionTitle) sectionTitle.textContent = titles[section] || "";
  processListView.classList.toggle("hidden", section !== "processes");
  dashboardView.classList.toggle("hidden", section !== "dashboard");
  boardView.classList.toggle("hidden", section !== "board");
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
        <span class="dashboard-scope" id="dashboardScope">Processos pelo ano do empenho; valores pelo ano de cada movimentacao.</span>
      </div>
      <select class="dashboard-year" id="dashboardYearSelect" aria-label="Ano do painel" aria-describedby="dashboardScope">
        ${dashboardYearOptions(year, state.dashboardYears)}
      </select>
    </div>
    <section class="dashboard-grid" aria-label="Indicadores operacionais">
      ${dashboardMetricsMarkup(state.dashboardMetrics)}
    </section>
    <div class="charts-grid">
      ${executionGroupedChart(charts.execucaoMensal)}
      ${statusDistributionChart(charts.distribuicaoStatus)}
      ${financialChart()}
    </div>
  `;
  dashboardView.querySelector("#dashboardYearSelect").addEventListener("change", async (event) => {
    const select = event.currentTarget;
    const requestedYear = select.value;
    setControlBusy(select, true);
    dashboardView.setAttribute("aria-busy", "true");
    try {
      const result = await loadDashboardData(requestedYear);
      if (result && state.activeSection === "dashboard") {
        renderDashboardView();
        focusDashboardYear();
      }
    } catch (error) {
      renderDashboardLoadError(error.message || "Nao foi possivel carregar o painel deste ano.", requestedYear);
    } finally {
      setControlBusy(select, false);
      dashboardView.removeAttribute("aria-busy");
    }
  });
}

function dashboardMetricsMarkup(data = {}) {
  const items = [
    ["Processos do ano", data.processosAtivos],
    ["Em atraso", data.atrasados, "attention"],
    ["Aguardando entrega", data.aguardandoEntrega],
    ["Pendentes de liquidacao", data.pendentesLiquidacao]
  ];
  return items.map(([label, value, tone = ""]) => `
    <article class="metric ${tone}" aria-label="${escapeAttribute(`${label}: ${Number(value) || 0}`)}">
      <span>${escapeHtml(label)}</span>
      <strong aria-hidden="true">${Number(value) || 0}</strong>
    </article>
  `).join("");
}

function dashboardYearOptions(selected, years = state.dashboardYears) {
  const options = years.length ? years : [Number(selected) || new Date().getFullYear()];
  return options.map((year) => `<option value="${year}" ${Number(year) === Number(selected) ? "selected" : ""}>Ano: ${year}</option>`).join("");
}

function executionGroupedChart(rows = []) {
  const hasData = rows.some((row) => [row.empenhado, row.liquidado, row.pago].some((value) => Number(value) > 0));
  if (!hasData) {
    return emptyChartCard("Execucao mensal", "Nenhuma movimentacao financeira registrada neste ano.", "grouped-chart-card");
  }
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
      <div class="chart-scroll" tabindex="0" aria-label="Grafico de execucao mensal. Use Tab nas barras ou abra a tabela para consultar os valores.">
        <div class="grouped-chart">
          <div class="y-axis" aria-hidden="true">
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
    <details class="chart-data-details">
      <summary>Ver valores mensais em tabela</summary>
      <div class="chart-table-wrap">
        <table class="chart-data-table">
          <caption class="sr-only">Valores da execucao mensal</caption>
          <thead><tr><th>Mes</th><th>Empenhado</th><th>Liquidado</th><th>Pago</th></tr></thead>
          <tbody>${rows.map((row) => `<tr><th>${escapeHtml(row.mes)}</th><td>${escapeHtml(money(row.empenhado))}</td><td>${escapeHtml(money(row.liquidado))}</td><td>${escapeHtml(money(row.pago))}</td></tr>`).join("")}</tbody>
        </table>
      </div>
    </details>
  `;
}

function financialChart() {
  const committed = state.dashboardMetrics.valorEmpenhado || 0;
  const liquidated = state.dashboardMetrics.valorLiquidado || 0;
  const paid = state.dashboardMetrics.valorPago || 0;
  return chartCard("Movimentacao financeira no ano", [
    ["Empenhado", committed],
    ["Liquidado", liquidated],
    ["Pago", paid]
  ], money, "Nenhum valor financeiro registrado neste ano.");
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
        ${series.map(([key, label, value]) => groupedBar(row.mes, key, label, value, max)).join("")}
      </div>
      <span aria-hidden="true">${escapeHtml(row.mes)}</span>
    </div>
  `;
}

function groupedBar(month, key, label, value, max) {
  const numericValue = Number(value) || 0;
  if (numericValue <= 0) return `<span class="group-bar ${key}" style="height: 0" aria-hidden="true"></span>`;
  const accessibleLabel = `${month}, ${label}: ${money(numericValue)}`;
  return `
    <button type="button" class="group-bar ${key}" style="height: ${Math.max(6, (numericValue / max) * 100)}%" aria-label="${escapeAttribute(accessibleLabel)}">
      <span class="column-tooltip" aria-hidden="true">${escapeHtml(accessibleLabel)}</span>
    </button>
  `;
}

function statusDistributionChart(entries = []) {
  const normalized = entries.map((entry) => [entry.status, entry.quantidade]);
  return chartCard("Distribuicao dos processos por status", normalized, (value) => String(Number(value) || 0), "Nenhum processo associado a este ano.");
}

function chartCard(title, entries = [], formatter = String, emptyMessage = "Nenhum dado disponivel.") {
  const hasData = entries.some(([, value]) => Number(value) > 0);
  if (!hasData) return emptyChartCard(title, emptyMessage);
  const max = Math.max(...entries.map(([, value]) => Number(value)), 1);
  return `
    <article class="chart-card">
      <h2>${escapeHtml(title)}</h2>
      <div class="chart-bars">
        ${entries.map(([label, value]) => `
          <div class="chart-row">
            <span title="${escapeAttribute(label)}">${escapeHtml(label)}</span>
            <div class="bar-track" aria-hidden="true">
              <div class="bar-fill ${chartKey(label) || "status"}" style="width: ${Number(value) > 0 ? Math.max(4, (Number(value) / max) * 100) : 0}%"></div>
            </div>
            <strong>${formatter(value)}</strong>
          </div>
        `).join("")}
      </div>
    </article>
  `;
}

function emptyChartCard(title, message, extraClass = "") {
  return `
    <article class="chart-card ${extraClass}">
      <h2>${escapeHtml(title)}</h2>
      <p class="chart-empty-state" role="status">${escapeHtml(message)}</p>
    </article>
  `;
}

function focusDashboardYear() {
  dashboardView.querySelector("#dashboardYearSelect")?.focus();
}

function renderDashboardLoadError(message, requestedYear) {
  renderSectionError(dashboardView, message, "dashboard", async () => {
    const result = await loadDashboardData(requestedYear);
    if (result && state.activeSection === "dashboard") {
      renderDashboardView();
      focusDashboardYear();
    }
  });
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

function nextProcessStep(processo) {
  if (!processo || ["Pago", "Anulado"].includes(processo.status)) return null;
  const steps = {
    Criado: {
      button: "Registrar envio para SALC",
      title: "Informe a data do envio para SALC.",
      status: "Enviado para SALC",
      field: "dataEnvioSalc",
      dateLabel: "Data do envio para SALC"
    },
    "Enviado para SALC": {
      button: "Registrar envio ao fornecedor",
      title: "Informe a data do envio ao fornecedor.",
      status: "Empenho enviado ao fornecedor",
      field: "dataEnvioFornecedor",
      dateLabel: "Data do envio ao fornecedor"
    },
    "Empenho enviado ao fornecedor": {
      button: "Registrar entrega",
      title: "Informe a data da entrega. As quantidades são opcionais.",
      status: "Entrega parcial",
      field: "dataEntrega"
    },
    "Aguardando entrega": {
      button: "Registrar entrega",
      title: "Informe a data da entrega. As quantidades são opcionais.",
      status: "Entrega parcial",
      field: "dataEntrega"
    },
    "Entrega parcial": {
      button: "Registrar entrega final",
      title: "Informe a data da entrega final. As quantidades são opcionais.",
      status: "Entregue",
      field: "dataEntrega"
    },
    "Entregue": {
      button: "Confirmar envio para liquidação",
      title: "Informe a data do envio para liquidação.",
      status: "Enviado para liquidacao",
      field: "dataEnvioLiquidacao",
      dateLabel: "Data do envio para liquidação"
    },
    "Aguardando envio para liquidacao": {
      button: "Confirmar envio para liquidação",
      title: "Informe a data do envio para liquidação.",
      status: "Enviado para liquidacao",
      field: "dataEnvioLiquidacao",
      dateLabel: "Data do envio para liquidação"
    },
    "Enviado para liquidacao": {
      button: "Registrar liquidação",
      title: "Informe a data da liquidação.",
      status: "Liquidado",
      field: "dataLiquidacao",
      dateLabel: "Data da liquidação"
    },
    "Liquidado": {
      button: "Registrar pagamento",
      title: "Informe a data do pagamento.",
      status: "Pago",
      field: "dataPagamento",
      dateLabel: "Data do pagamento"
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

function canCancelProcessInUi(processo) {
  if (!processo || processo.inativo || ["Anulado", "Pago"].includes(processo.status)) return false;
  if (isCurrentUserAdmin()) return true;
  if (currentUser?.role !== "almoxarifado" || processo.status === "Liquidado") return false;
  if (processo.criadoPorId) return Boolean(currentUser?.id) && processo.criadoPorId === currentUser.id;
  return Boolean(processo.criadoPorEmail && currentUser?.email && processo.criadoPorEmail === currentUser.email);
}

function canInactivateProcessInUi(processo) {
  return Boolean(processo && !processo.inativo && processo.status !== "Pago" && isCurrentUserAdmin());
}

async function inactivateSelectedProcess() {
  const processo = state.selectedProcess;
  if (!canInactivateProcessInUi(processo)) return;
  if (!confirm("Inativar este empenho? Ele deixara de aparecer nas listas ativas.")) return;
  const updated = await api(`/api/processes/${processo.id}/inactivate`, { method: "POST" });
  state.selectedProcess = updated;
  closeProcessDetail();
  await refreshAfterMutation("O empenho foi inativado");
}

async function refreshAfterMutation(successPrefix = "A alteracao foi salva") {
  try {
    await refresh();
  } catch (error) {
    showAppError(`${successPrefix}, mas a lista nao foi atualizada: ${error.message}`);
    if (state.selectedProcess) renderProcessDetail();
    return;
  }
  try {
    await refreshAudit();
    await refreshDetailAudit();
  } catch (error) {
    showAppError(`${successPrefix} e a lista foi atualizada, mas a auditoria nao: ${error.message}`);
  }
  if (state.selectedProcess) renderProcessDetail();
  if (state.activeSection === "board") renderKanbanBoard();
}

async function refreshDetailAudit() {
  if (!state.selectedProcess) return;
  state.detailAudit = await loadDetailAudit(state.selectedProcess.id);
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
  if (processo.status === "Liquidado" && !isCurrentUserAdmin()) return false;
  if (documentKey === "notaFiscal") {
    return ["Entrega parcial", "Entregue", "Aguardando envio para liquidacao", "Enviado para liquidacao", "Liquidado"].includes(processo.status);
  }
  return true;
}

function canRemoveDocumentInUi(processo, documentKey) {
  if (!canAttachDocumentInUi(processo, documentKey)) return false;
  const required = ["processoSped", "notaEmpenho", "notaFiscal"].includes(String(documentKey || "").split(":")[0]);
  if (required && ["Enviado para liquidacao", "Liquidado", "Pago"].includes(processo.status)) return false;
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
        ${fornecedor.observacoes ? `<span>Observações: ${escapeHtml(fornecedor.observacoes)}</span>` : ""}
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
    button.addEventListener("click", () => void downloadDocument(button.dataset.downloadDocument, button.dataset.documentName).catch((error) => {
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
            <button type="button" class="secondary" data-download-document="${escapeAttribute(attachment.path)}" data-document-name="${escapeAttribute(attachment.fileName)}">Baixar</button>
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

async function downloadDocument(path, preferredFileName = "") {
  const resource = await fetchDocumentResource(path, { preferredFileName });
  const blobUrl = URL.createObjectURL(resource.blob);
  triggerBlobDownload(blobUrl, resource.fileName);
}

async function fetchDocumentResource(path, options = {}) {
  const documentPath = normalizeDocumentPath(path);
  if (!documentPath) throw new Error("Caminho de documento invalido.");
  if (options.signal?.aborted) throw createAbortError();
  const requestController = new AbortController();
  let timedOut = false;
  const abortFromParent = () => requestController.abort();
  options.signal?.addEventListener("abort", abortFromParent, { once: true });
  const timeoutId = window.setTimeout(() => {
    timedOut = true;
    requestController.abort();
  }, options.timeoutMs || DOCUMENT_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(documentPath, {
      credentials: "same-origin",
      signal: requestController.signal
    });
    if (response.status === 401) {
      const error = new Error("Sua sessao expirou.");
      error.status = 401;
      handleUnauthorized();
      throw error;
    }
    if (!response.ok) {
      const error = new Error(await documentResponseError(response));
      error.status = response.status;
      throw error;
    }
    const blob = await response.blob();
    const responseFileName = documentFileNameFromDisposition(response.headers.get("content-disposition"));
    const fileName = safeClientFileName(responseFileName || options.preferredFileName || documentFileNameFromPath(documentPath));
    const mimeType = normalizeMimeType(blob.type || response.headers.get("content-type"));
    validateFetchedDocument(blob, mimeType);
    return { blob, fileName, mimeType };
  } catch (error) {
    if (timedOut) {
      const timeoutError = new Error("O servidor demorou demais para carregar o documento. Tente novamente.");
      timeoutError.status = 408;
      throw timeoutError;
    }
    if (options.signal?.aborted) throw createAbortError();
    if (error.name === "AbortError" || error.status || error.code === "INVALID_DOCUMENT_RESPONSE") throw error;
    throw new Error("Nao foi possivel conectar ao servidor para carregar o documento.");
  } finally {
    window.clearTimeout(timeoutId);
    options.signal?.removeEventListener("abort", abortFromParent);
  }
}

function validateFetchedDocument(blob, mimeType = "") {
  if (!blob?.size) {
    const error = new Error("O arquivo anexado esta vazio.");
    error.code = "INVALID_DOCUMENT_RESPONSE";
    throw error;
  }
  if (mimeType && !ALLOWED_DOCUMENT_RESPONSE_MIME_TYPES.has(mimeType)) {
    const error = new Error("O servidor retornou um formato invalido para este documento.");
    error.code = "INVALID_DOCUMENT_RESPONSE";
    throw error;
  }
}

async function documentResponseError(response) {
  const contentType = normalizeMimeType(response.headers.get("content-type"));
  if (contentType === "application/json") {
    const body = await response.json().catch(() => ({}));
    if (body?.error) return String(body.error);
  } else {
    const text = String(await response.text().catch(() => "")).trim();
    if (text && text.length <= 500 && !/^</.test(text)) return text;
  }
  if (response.status === 403) return "Voce nao possui permissao para acessar este documento.";
  if (response.status === 404) return "Documento nao encontrado ou removido.";
  if (response.status === 410) return "O arquivo anexado nao esta mais disponivel. Anexe-o novamente.";
  return "Nao foi possivel carregar o documento.";
}

function documentFileNameFromDisposition(value = "") {
  const encoded = String(value).match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded);
    } catch {
      // Fall back to the regular filename parameter.
    }
  }
  return String(value).match(/filename="?([^";]+)"?/i)?.[1]?.trim() || "";
}

function safeClientFileName(value = "documento") {
  return String(value || "documento")
    .replace(/[\\/\0\r\n]+/g, "-")
    .trim()
    .slice(0, 255) || "documento";
}

function normalizeMimeType(value = "") {
  return String(value || "").split(";", 1)[0].trim().toLowerCase();
}

function mimeAllowsExtensionFallback(mimeType = "") {
  return !mimeType || mimeType === "application/octet-stream";
}

function normalizeDocumentPath(path) {
  try {
    const url = new URL(path, window.location.origin);
    if (url.origin !== window.location.origin || !url.pathname.startsWith("/uploads/")) return "";
    return url.pathname;
  } catch {
    return "";
  }
}

async function openDocument(path, metadata = {}) {
  const documentPath = normalizeDocumentPath(path);
  if (!documentPath) throw new Error("Caminho de documento invalido.");
  const documentMetadata = documentInfo({ ...metadata, path: documentPath });
  if (!documentPreviewDialog || !documentPreviewContent) {
    await downloadDocument(documentPath, documentMetadata.fileName);
    return;
  }

  resetDocumentPreviewDialog();
  const controller = new AbortController();
  documentPreviewController = controller;
  documentPreviewFileName = documentMetadata.fileName;
  documentPreviewDialogTitle.textContent = documentMetadata.fileName || "Visualizar documento";
  documentPreviewContent.setAttribute("aria-busy", "true");
  documentPreviewContent.replaceChildren();
  if (documentPreviewStatus) documentPreviewStatus.textContent = "Carregando documento...";
  documentPreviewDownload.disabled = true;
  documentPreviewMessage?.classList.remove("error");
  if (!documentPreviewDialog.open) documentPreviewDialog.showModal();
  const sequence = ++documentPreviewSequence;

  let resource;
  try {
    resource = await fetchDocumentResource(documentPath, {
      signal: controller.signal,
      preferredFileName: documentMetadata.fileName
    });
  } catch (error) {
    if (error.name !== "AbortError" && sequence === documentPreviewSequence) {
      renderDocumentPreviewError(error.message || "Nao foi possivel abrir o documento.");
    }
    return;
  }

  if (sequence !== documentPreviewSequence || !documentPreviewDialog.open) return;
  documentPreviewBlob = resource.blob;
  documentPreviewFileName = resource.fileName;
  documentPreviewDialogTitle.textContent = resource.fileName;
  documentPreviewDownload.disabled = false;
  if (documentPreviewStatus) documentPreviewStatus.textContent = "Preparando visualizacao...";
  try {
    documentPreviewUrl = URL.createObjectURL(resource.blob);
    const preview = await createDocumentPreviewElement(documentPreviewUrl, resource, documentPath, resource.fileName);
    if (sequence !== documentPreviewSequence || !documentPreviewDialog.open) return;
    documentPreviewContent.replaceChildren(preview);
    if (["IFRAME", "IMG"].includes(preview.tagName)) {
      if (documentPreviewStatus) documentPreviewStatus.textContent = "Renderizando visualizacao...";
      monitorDocumentPreviewMedia(preview, sequence);
    } else {
      URL.revokeObjectURL(documentPreviewUrl);
      documentPreviewUrl = "";
      documentPreviewContent.setAttribute("aria-busy", "false");
      if (documentPreviewStatus) documentPreviewStatus.textContent = "";
    }
  } catch (error) {
    if (documentPreviewUrl) {
      URL.revokeObjectURL(documentPreviewUrl);
      documentPreviewUrl = "";
    }
    if (error.name !== "AbortError" && sequence === documentPreviewSequence) {
      renderDocumentPreviewError("O documento foi carregado, mas nao foi possivel gerar a visualizacao. Use Baixar.", { downloadAvailable: true });
    }
  }
}

function renderDocumentPreviewError(message, { downloadAvailable = false } = {}) {
  const errorContent = document.createElement("p");
  errorContent.className = "document-preview-error";
  errorContent.setAttribute("role", "alert");
  errorContent.textContent = message;
  documentPreviewContent?.replaceChildren(errorContent);
  documentPreviewContent?.setAttribute("aria-busy", "false");
  if (documentPreviewStatus) documentPreviewStatus.textContent = "";
  if (documentPreviewDownload) documentPreviewDownload.disabled = !downloadAvailable;
  if (documentPreviewMessage) documentPreviewMessage.textContent = "";
}

function resetDocumentPreviewDialog() {
  documentPreviewSequence += 1;
  documentPreviewController?.abort();
  documentPreviewController = null;
  clearDocumentPreviewMediaTimer();
  if (documentPreviewUrl) URL.revokeObjectURL(documentPreviewUrl);
  documentPreviewUrl = "";
  documentPreviewBlob = null;
  documentPreviewFileName = "";
  documentPreviewContent?.replaceChildren();
  documentPreviewContent?.setAttribute("aria-busy", "false");
  if (documentPreviewStatus) documentPreviewStatus.textContent = "";
  if (documentPreviewDownload) documentPreviewDownload.disabled = true;
  if (documentPreviewMessage) {
    documentPreviewMessage.textContent = "";
    documentPreviewMessage.classList.remove("error");
  }
}

async function createDocumentPreviewElement(blobUrl, resource, path, title) {
  const mimeType = normalizeMimeType(resource.mimeType || resource.blob?.type);
  const fileName = String(resource.fileName || path || "").toLowerCase().split(/[?#]/, 1)[0];
  const extensionFallback = mimeAllowsExtensionFallback(mimeType);
  if (mimeType === "application/pdf" || (extensionFallback && fileName.endsWith(".pdf"))) {
    const frame = document.createElement("iframe");
    frame.title = `Previa da primeira pagina de ${title}`;
    frame.src = `${blobUrl}#page=1&view=FitH`;
    return frame;
  }
  if (["image/png", "image/jpeg"].includes(mimeType) || (extensionFallback && /\.(png|jpe?g)$/.test(fileName))) {
    const image = document.createElement("img");
    image.src = blobUrl;
    image.alt = title;
    return image;
  }
  if (["text/plain", "text/csv", "application/csv"].includes(mimeType) || (extensionFallback && /\.(txt|csv)$/.test(fileName))) {
    const truncated = resource.blob.size > DOCUMENT_TEXT_PREVIEW_BYTES;
    const text = await resource.blob.slice(0, DOCUMENT_TEXT_PREVIEW_BYTES, resource.blob.type).text();
    const preview = document.createElement("pre");
    preview.className = "document-text-preview";
    preview.textContent = `${text}${truncated ? "\n\n[Previa limitada ao inicio do documento.]" : ""}`;
    return preview;
  }
  const message = document.createElement("p");
  message.className = "selected-file";
  message.textContent = "Este formato nao possui visualizacao integrada. Use Baixar para abrir no aplicativo adequado.";
  return message;
}

function monitorDocumentPreviewMedia(preview, sequence) {
  if (!preview || !["IFRAME", "IMG"].includes(preview.tagName)) {
    documentPreviewContent?.setAttribute("aria-busy", "false");
    return;
  }
  let settled = false;
  clearDocumentPreviewMediaTimer();
  const finish = (failed = false) => {
    if (settled) return;
    settled = true;
    clearDocumentPreviewMediaTimer();
    if (sequence !== documentPreviewSequence) return;
    documentPreviewContent?.setAttribute("aria-busy", "false");
    if (documentPreviewStatus) documentPreviewStatus.textContent = "";
    if (failed && documentPreviewMessage) {
      documentPreviewMessage.textContent = "O arquivo foi carregado, mas o navegador nao conseguiu gerar a previa. Use Baixar.";
      documentPreviewMessage.classList.add("error");
    }
  };
  preview.addEventListener("load", () => finish(false), { once: true });
  preview.addEventListener("error", () => finish(true), { once: true });
  documentPreviewMediaTimer = window.setTimeout(() => finish(true), DOCUMENT_MEDIA_RENDER_TIMEOUT_MS);
  if (preview.tagName === "IMG" && preview.complete) finish(preview.naturalWidth === 0);
}

function clearDocumentPreviewMediaTimer() {
  if (documentPreviewMediaTimer !== null) window.clearTimeout(documentPreviewMediaTimer);
  documentPreviewMediaTimer = null;
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
  row.dataset.materialId = material.id || "";
  row.innerHTML = `
    <label>Descricao <input data-material-field="descricao" maxlength="100" value="${escapeAttribute(material.descricao || "")}"></label>
    <label>Quantidade <input data-material-field="quantidade" type="number" min="0" step="any" value="${Number(material.quantidade || 0) || ""}"></label>
    <label>Valor unitario <input data-material-field="valorUnitario" type="text" inputmode="decimal" placeholder="0,00" value="${material.valorUnitario ? escapeAttribute(formatCurrencyInput(Number(material.valorUnitario))) : ""}"></label>
    <div class="material-line-total"><span>Valor total</span><output data-material-total>R$ 0,00</output></div>
    <button type="button" class="secondary remove-material" data-remove-material="true">Remover</button>
  `;
  materialsList.append(row);
  updateMaterialTotals();
}

function ensureOneMaterialRow() {
  if (!materialsList.children.length) addMaterialRow();
}

function readMaterials() {
  return [...materialsList.querySelectorAll(".material-row")]
    .map((row) => ({
      ...(row.dataset.materialId ? { id: row.dataset.materialId } : {}),
      descricao: row.querySelector('[data-material-field="descricao"]').value.trim(),
      valorUnitario: parseCurrencyInput(row.querySelector('[data-material-field="valorUnitario"]').value),
      quantidade: Number(row.querySelector('[data-material-field="quantidade"]').value || 0)
    }))
    .filter((material) => material.descricao);
}

function updateMaterialTotals() {
  let processTotalCents = 0;
  materialsList.querySelectorAll(".material-row").forEach((row) => {
    const quantity = Number(row.querySelector('[data-material-field="quantidade"]')?.value || 0);
    const unitValue = parseCurrencyInput(row.querySelector('[data-material-field="valorUnitario"]')?.value || "");
    const lineCents = Number.isFinite(quantity) && quantity >= 0 && Number.isFinite(unitValue)
      ? Math.round((quantity * unitValue + Number.EPSILON) * 100)
      : 0;
    processTotalCents += lineCents;
    const output = row.querySelector("[data-material-total]");
    if (output) output.textContent = money(lineCents / 100);
  });
  const processTotal = document.querySelector("#processMaterialsTotal");
  if (processTotal) processTotal.textContent = money(processTotalCents / 100);
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
  return processo.diasDecorridos > 30 && !hasReachedDeliveryInUi(processo) && processo.status !== "Anulado";
}

function hasReachedDeliveryInUi(processo = {}) {
  return ["Entregue", "Aguardando envio para liquidacao", "Enviado para liquidacao", "Liquidado", "Pago"].includes(processo.status);
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

function formatDateInput(value = "") {
  const digits = String(value).replace(/\D/g, "").slice(0, 8);
  const parts = [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4, 8)].filter(Boolean);
  return parts.join("-");
}

function normalizeDateInput(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length !== 8) return "";
  const iso = `${digits.slice(4, 8)}-${digits.slice(2, 4)}-${digits.slice(0, 2)}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === iso ? iso : "";
}

function passwordPolicyMessage() {
  return PASSWORD_POLICY_MESSAGE;
}

function daysCell(processo) {
  if (!deadlineDate(processo)) return "-";
  if (hasReachedDeliveryInUi(processo) || processo.status === "Anulado") return "-";
  return `<span class="days ${processo.faixaPrazo}">${processo.diasDecorridos}</span>`;
}

function timelineEvents(processo) {
  const hiddenKeys = hiddenTimelineKeys(processo);
  const explicitEvents = [
    processo.status === "Entrega parcial" && processo.dataEntrega && { label: "Entrega parcial", date: processo.dataEntrega, sourceType: "marco", sourceId: "entrega-parcial" },
    hasReachedDeliveryInUi(processo) && processo.dataEntrega && { label: "Entregue", date: processo.dataEntrega, sourceType: "marco", sourceId: "entregue" },
    processo.dataEnvioLiquidacao && { label: "Enviado para liquidação", date: processo.dataEnvioLiquidacao, sourceType: "marco", sourceId: "envio-liquidacao" },
    ["Liquidado", "Pago"].includes(processo.status) && { label: "Liquidado", date: processo.dataLiquidacao || processo.dataEnvioLiquidacao || processo.atualizadoEm, sourceType: "marco", sourceId: "liquidado" },
    processo.status === "Pago" && { label: "Pago", date: processo.dataPagamento || processo.atualizadoEm, sourceType: "marco", sourceId: "pago" },
    processo.status === "Anulado" && { label: "Anulado", date: processo.anuladoEm || processo.atualizadoEm, sourceType: "marco", sourceId: "anulado" }
  ].filter(Boolean);

  const auditEvents = visibleAuditEntries(processo)
    .map((entry) => {
      const businessDate = timelineAuditBusinessDate(processo, entry);
      return {
        label: auditLabel(entry),
        date: businessDate || entry.criadoEm,
        meta: entry.usuario || "Usuário",
        details: timelineAuditDetails(entry),
        documento: currentDocumentFromAuditEntry(processo, entry),
        kind: entry.acao === "Remocao de documento" ? "danger" : "",
        showTime: !businessDate,
        sourceType: "auditoria",
        sourceId: entry.id
      };
    });

  const observationEvents = state.detailObservations
    .map((observacao) => ({
      label: `Observação: ${observacao.conteudo}`,
      date: observacao.atualizadoEm || observacao.criadoEm,
      kind: "observation",
      sourceType: "observacao",
      sourceId: observacao.id
    }));

  const events = dedupeTimelineDocuments([...auditEvents, ...explicitEvents, ...observationEvents]
    .filter((event) => event.label && event.date)
    .filter((event) => !hiddenKeys.has(`${event.sourceType}:${event.sourceId}`))
    .filter((event, index, list) => list.findIndex((item) => (
      item.label === event.label
        && formatDateTime(item.date) === formatDateTime(event.date)
        && (item.details || "") === (event.details || "")
    )) === index)
    .sort((a, b) => new Date(a.date) - new Date(b.date)));

  return events;
}

function hiddenTimelineKeys(processo) {
  return new Set(state.detailAudit
    .filter((entry) => entry.processoId === processo.id && entry.acao === "Exclusao de dado da linha do tempo")
    .map((entry) => entry.alteracoes?.linhaDoTempo?.novo)
    .filter(Boolean));
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
  const fileName = documento.fileName || documento.nome || documentFileNameFromPath(path);
  const documentPath = normalizeDocumentPath(path);
  if (!documentPath) return "";
  return `
    <div class="timeline-document-preview">
      ${documentTimelinePreviewContent(documento, documentPath, title)}
      <span>${escapeHtml(title)}</span>
      <button type="button" class="secondary small-action" data-open-document="${escapeAttribute(path)}" data-document-name="${escapeAttribute(fileName)}" data-document-mime="${escapeAttribute(documento.mimeType || "")}">Abrir documento</button>
    </div>
  `;
}

function documentTimelinePreviewContent(documento = {}, path = "", title = "") {
  const mimeType = String(documento.mimeType || "").toLowerCase();
  const fileName = String(documento.fileName || documento.nome || path || "").toLowerCase().split(/[?#]/, 1)[0];
  const accessibleTitle = `Prévia da primeira página de ${title}`;
  if (mimeType === "application/pdf" || fileName.endsWith(".pdf")) {
    return `<div class="timeline-document-preview-media"><iframe title="${escapeAttribute(accessibleTitle)}" data-document-preview="${escapeAttribute(path)}" loading="lazy" aria-busy="true"></iframe><span data-document-preview-loading>Carregando prévia...</span></div>`;
  }
  if (["image/png", "image/jpeg"].includes(mimeType) || /\.(png|jpe?g)$/.test(fileName)) {
    return `<div class="timeline-document-preview-media"><img data-document-preview="${escapeAttribute(path)}" alt="${escapeAttribute(accessibleTitle)}" loading="lazy" aria-busy="true"><span data-document-preview-loading>Carregando prévia...</span></div>`;
  }
  return '<span class="timeline-document-preview-unavailable">Prévia disponível para PDF ou imagem.</span>';
}

async function hydrateTimelineDocumentPreviews() {
  const sequence = timelinePreviewSequence;
  const previews = [...detailPanel.querySelectorAll("[data-document-preview]")];
  if (!previews.length) return;
  const controller = new AbortController();
  timelinePreviewController = controller;
  const enqueue = (items) => {
    timelinePreviewQueue = timelinePreviewQueue
      .then(() => hydrateTimelinePreviewBatch(items, sequence, controller.signal))
      .catch((error) => {
        if (error.name !== "AbortError") console.error(error);
      });
  };

  if (typeof window.IntersectionObserver === "function") {
    timelinePreviewObserver = new window.IntersectionObserver((entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting).map((entry) => entry.target);
      for (const preview of visible) timelinePreviewObserver?.unobserve(preview);
      if (visible.length) enqueue(visible);
    }, { rootMargin: "320px 0px" });
    for (const preview of previews) timelinePreviewObserver.observe(preview);
    return;
  }

  enqueue(previews);
}

async function hydrateTimelinePreviewBatch(previews, sequence, signal) {
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < previews.length) {
      const preview = previews[nextIndex];
      nextIndex += 1;
      await hydrateTimelineDocumentPreview(preview, sequence, signal);
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, previews.length) }, () => worker()));
}

async function hydrateTimelineDocumentPreview(preview, sequence, signal) {
  const path = preview.dataset.documentPreview;
  const container = preview.parentElement;
  try {
    const resource = await fetchDocumentResource(path, { signal });
    if (sequence !== timelinePreviewSequence || !preview.isConnected || state.detailTab !== "timeline") return;
    const blobUrl = URL.createObjectURL(resource.blob);
    if (sequence !== timelinePreviewSequence || !preview.isConnected || state.detailTab !== "timeline") {
      URL.revokeObjectURL(blobUrl);
      return;
    }
    timelinePreviewUrls.add(blobUrl);
    const media = createTimelinePreviewMedia(resource, blobUrl, preview);
    if (!media) {
      URL.revokeObjectURL(blobUrl);
      timelinePreviewUrls.delete(blobUrl);
      showTimelinePreviewError(container, path, "Prévia não disponível para este formato.", false);
      return;
    }
    preview.replaceWith(media);
    monitorTimelinePreviewMedia(media, container, path, sequence, blobUrl);
  } catch (error) {
    if (error.name === "AbortError" || sequence !== timelinePreviewSequence || !preview.isConnected) return;
    showTimelinePreviewError(container, path, error.message || "Não foi possível carregar a prévia.");
  }
}

function createTimelinePreviewMedia(resource, blobUrl, originalPreview) {
  const mimeType = normalizeMimeType(resource.mimeType || resource.blob?.type);
  const fileName = String(resource.fileName || "").toLowerCase();
  const extensionFallback = mimeAllowsExtensionFallback(mimeType);
  const previewTitle = originalPreview.getAttribute("title")
    || originalPreview.getAttribute("alt")
    || originalPreview.dataset.documentPreviewTitle
    || `Prévia de ${resource.fileName}`;
  let media;
  if (mimeType === "application/pdf" || (extensionFallback && fileName.endsWith(".pdf"))) {
    media = document.createElement("iframe");
    media.src = `${blobUrl}#page=1&view=FitH`;
    media.title = previewTitle;
  } else if (["image/png", "image/jpeg"].includes(mimeType) || (extensionFallback && /\.(png|jpe?g)$/.test(fileName))) {
    media = document.createElement("img");
    media.src = blobUrl;
    media.alt = previewTitle;
  } else {
    return null;
  }
  media.setAttribute("aria-busy", "true");
  return media;
}

function monitorTimelinePreviewMedia(media, container, path, sequence, blobUrl) {
  let settled = false;
  let timerId = null;
  const clearTimer = () => {
    if (timerId === null) return;
    window.clearTimeout(timerId);
    timelinePreviewTimers.delete(timerId);
    timerId = null;
  };
  const finish = (failed = false) => {
    if (settled) return;
    settled = true;
    clearTimer();
    if (sequence !== timelinePreviewSequence || !media.isConnected) return;
    media.setAttribute("aria-busy", "false");
    container?.querySelector("[data-document-preview-loading]")?.remove();
    if (failed) {
      releaseTimelinePreviewUrl(blobUrl);
      showTimelinePreviewError(container, path, "O navegador não conseguiu renderizar esta prévia.");
    }
  };
  media.addEventListener("load", () => finish(false), { once: true });
  media.addEventListener("error", () => finish(true), { once: true });
  timerId = window.setTimeout(() => finish(true), DOCUMENT_MEDIA_RENDER_TIMEOUT_MS);
  timelinePreviewTimers.add(timerId);
  if (media.tagName === "IMG" && media.complete) finish(media.naturalWidth === 0);
}

function showTimelinePreviewError(container, path, message, retry = true) {
  if (!container) return;
  const previousPreview = container.querySelector("iframe, img, [data-document-preview]");
  const previewTitle = previousPreview?.getAttribute("title")
    || previousPreview?.getAttribute("alt")
    || previousPreview?.dataset.documentPreviewTitle
    || container.dataset.documentPreviewTitle
    || "Prévia do documento";
  container.dataset.documentPreviewPath = normalizeDocumentPath(path);
  container.dataset.documentPreviewTitle = previewTitle;
  container.replaceChildren();
  const text = document.createElement("span");
  text.className = "timeline-document-preview-unavailable";
  text.textContent = message;
  container.append(text);
  if (retry) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "secondary small-action";
    button.dataset.retryDocumentPreview = path;
    button.textContent = "Tentar prévia novamente";
    container.append(button);
  }
}

async function retryTimelineDocumentPreview(button) {
  if (state.detailTab !== "timeline") return;
  const container = button.closest(".timeline-document-preview-media");
  const path = normalizeDocumentPath(button.dataset.retryDocumentPreview || container?.dataset.documentPreviewPath);
  if (!container || !path) return;
  let controller = timelinePreviewController;
  if (!controller || controller.signal.aborted) {
    controller = new AbortController();
    timelinePreviewController = controller;
  }
  const placeholder = document.createElement("span");
  placeholder.hidden = true;
  placeholder.dataset.documentPreview = path;
  placeholder.dataset.documentPreviewTitle = container.dataset.documentPreviewTitle || "Prévia do documento";
  placeholder.setAttribute("aria-busy", "true");
  const loading = document.createElement("span");
  loading.dataset.documentPreviewLoading = "true";
  loading.textContent = "Carregando prévia...";
  container.replaceChildren(placeholder, loading);
  await hydrateTimelineDocumentPreview(placeholder, timelinePreviewSequence, controller.signal);
}

function releaseTimelinePreviewUrl(blobUrl) {
  if (!blobUrl || !timelinePreviewUrls.delete(blobUrl)) return;
  URL.revokeObjectURL(blobUrl);
}

function clearTimelineDocumentPreviews() {
  timelinePreviewSequence += 1;
  timelinePreviewObserver?.disconnect();
  timelinePreviewObserver = null;
  timelinePreviewController?.abort();
  timelinePreviewController = null;
  timelinePreviewQueue = Promise.resolve();
  for (const timerId of timelinePreviewTimers) window.clearTimeout(timerId);
  timelinePreviewTimers.clear();
  for (const blobUrl of timelinePreviewUrls) URL.revokeObjectURL(blobUrl);
  timelinePreviewUrls.clear();
}

function currentDocumentFromAuditEntry(processo = {}, entry = {}) {
  if (entry.acao !== "Anexo de documento") return null;
  const recorded = documentInfo(entry.documento);
  if (recorded.path) {
    const recordedPath = normalizeDocumentPath(recorded.path);
    if (!recordedPath) return null;
    return currentProcessDocuments(processo)
      .find((documento) => normalizeDocumentPath(documento.path) === recordedPath) || null;
  }
  return documentFromAuditEntry(processo, entry);
}

function currentProcessDocuments(processo = {}) {
  return Object.values(processo.documentos || {}).flatMap((value) => (
    (Array.isArray(value) ? value : [value]).map(documentInfo).filter((documento) => documento.path)
  ));
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

function timelineAuditBusinessDate(processo, entry = {}) {
  if (entry.acao === "Criacao de processo") return processo.dataProcesso || "";
  if (entry.acao === "Registro de entrega") {
    const deliveryId = entry.alteracoes?.entregaId?.novo || entry.alteracoes?.entregaId;
    return (processo.entregas || []).find((entrega) => entrega.id === deliveryId)?.data || "";
  }

  const status = entry.alteracoes?.status?.novo;
  const dateFieldsByStatus = {
    "Enviado para SALC": ["dataEnvioSalc"],
    "Empenho enviado ao fornecedor": ["dataEnvioFornecedor", "dataEnvioEmpenho"],
    "Entrega parcial": ["dataEntrega"],
    Entregue: ["dataEntrega"],
    "Enviado para liquidacao": ["dataEnvioLiquidacao"],
    Liquidado: ["dataLiquidacao"],
    Pago: ["dataPagamento"]
  };
  for (const field of dateFieldsByStatus[status] || []) {
    const date = entry.alteracoes?.[field]?.novo;
    if (date) return date;
  }
  return "";
}

function auditLabel(entry) {
  if (entry.acao === "Criacao de processo") return "Processo criado";
  if (entry.acao === "Anulacao de empenho") return "Empenho anulado";
  if (entry.acao === "Carga inicial") return "Registro importado";
  if (entry.acao === "Anexo de documento" || entry.acao === "Remocao de documento") {
    const documentKey = auditDocumentKey(entry);
    const documentLabel = timelineDocumentLabel(documentKey);
    if (documentLabel) {
      const feminine = ["notaEmpenho", "notaFiscal"].includes(documentKey);
      const suffix = entry.acao === "Anexo de documento"
        ? (feminine ? "anexada" : "anexado")
        : (feminine ? "removida" : "removido");
      return `${documentLabel} ${suffix}`;
    }
  }
  const changedStatus = entry.alteracoes?.status?.novo;
  if (changedStatus) return humanizeCamelCase(changedStatus);
  return humanizeCamelCase(entry.acao || "Alteracao");
}

function auditDocumentKey(entry = {}) {
  if (entry.documento?.chave) return String(entry.documento.chave).split(":")[0];
  return String(entry.detalhes || "").match(/^Documento\s+([^\s]+)\s+(?:anexado|removido)\.$/i)?.[1]?.split(":")[0] || "";
}

function timelineDocumentLabel(documentKey = "") {
  return ({
    processoSped: "Processo SPED",
    notaEmpenho: "Nota de empenho",
    notaFiscal: "Nota fiscal",
    complementares: "Documento complementar"
  })[documentKey] || "";
}

function timelineAuditDetails(entry = {}) {
  if (["Anexo de documento", "Remocao de documento"].includes(entry.acao)) return "";
  if (entry.acao === "Alteracao de processo" && entry.alteracoes?.status?.novo) return "";
  return accentTimelineText(entry.detalhes || "");
}

function humanizeCamelCase(value = "") {
  const text = String(value)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\bSPED\b/gi, "sped")
    .toLowerCase();
  const accented = accentTimelineText(text);
  return accented ? accented[0].toUpperCase() + accented.slice(1) : "";
}

function accentTimelineText(value = "") {
  return String(value)
    .replace(/\bobservacao\b/gi, (word) => word[0] === word[0].toUpperCase() ? "Observação" : "observação")
    .replace(/\binclusao\b/gi, (word) => word[0] === word[0].toUpperCase() ? "Inclusão" : "inclusão")
    .replace(/\balteracao\b/gi, (word) => word[0] === word[0].toUpperCase() ? "Alteração" : "alteração")
    .replace(/\bexclusao\b/gi, (word) => word[0] === word[0].toUpperCase() ? "Exclusão" : "exclusão")
    .replace(/\bremocao\b/gi, (word) => word[0] === word[0].toUpperCase() ? "Remoção" : "remoção")
    .replace(/\bcriacao\b/gi, (word) => word[0] === word[0].toUpperCase() ? "Criação" : "criação")
    .replace(/\banulacao\b/gi, (word) => word[0] === word[0].toUpperCase() ? "Anulação" : "anulação")
    .replace(/\binativacao\b/gi, (word) => word[0] === word[0].toUpperCase() ? "Inativação" : "inativação")
    .replace(/\bliquidacao\b/gi, (word) => word[0] === word[0].toUpperCase() ? "Liquidação" : "liquidação")
    .replace(/\bnumero\b/gi, (word) => word[0] === word[0].toUpperCase() ? "Número" : "número")
    .replace(/\bsped\b/gi, "SPED");
}

function visibleAuditEntries(processo) {
  return state.detailAudit
    .filter((entry) => entry.processoId === processo.id)
    .filter((entry) => !["Carga inicial", "Inclusao de observacao", "Exclusao de dado da linha do tempo"].includes(entry.acao))
    .filter((entry) => entry.acao !== "Alteracao de processo" || Boolean(entry.alteracoes?.status?.novo))
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

function renderSectionError(container, message, section, retryAction) {
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
  retry.addEventListener("click", async () => {
    setButtonBusy(retry, true, "Tentando...");
    try {
      if (retryAction) await retryAction();
      else await openSection(section);
    } catch (error) {
      renderSectionError(container, error.message || message, section, retryAction);
    } finally {
      setButtonBusy(retry, false);
    }
  }, { once: true });
  wrapper.append(text, retry);
  container.append(wrapper);
}
