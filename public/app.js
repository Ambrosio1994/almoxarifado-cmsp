const state = {
  meta: { status: [], filtrosRapidos: [] },
  processos: [],
  dashboardMetrics: {},
  allProcesses: [],
  fornecedores: [],
  auditoria: [],
  emailHistory: [],
  securityAudit: [],
  detailObservations: [],
  editing: null,
  observationProcessId: null,
  selectedProcess: null,
  detailReturnSection: "processes",
  pendingDocumentFile: null,
  detailTab: "general",
  dashboardYear: "",
  supplierSearch: "",
  supplierHistory: "",
  settings: null,
  settingsPanel: "templates"
};

let currentUser = {
  email: "admin@cmsp.local",
  name: "Administrador",
  role: "admin",
  foto: ""
};
let authToken = localStorage.getItem("almoxAuthToken") || "";
const authScreen = document.querySelector("#authScreen");
const appShell = document.querySelector("#appShell");
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
const statusSelect = document.querySelector("#statusSelect");
const statusFilter = document.querySelector("#statusFilter");
const quickFilter = document.querySelector("#quickFilter");
const quickFilterBar = document.querySelector("#quickFilterBar");
const yearFilter = document.querySelector("#yearFilter");
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
const metrics = document.querySelector("#metrics");
const dialog = document.querySelector("#observationsDialog");
const observationsList = document.querySelector("#observationsList");
const observationForm = document.querySelector("#observationForm");
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
const cancelSupplierInfo = document.querySelector("#cancelSupplierInfo");
const dashboardView = document.querySelector("#dashboardView");
const suppliersView = document.querySelector("#suppliersView");
const auditView = document.querySelector("#auditView");
const settingsView = document.querySelector("#settingsView");
const navItems = document.querySelectorAll(".nav-item");
const sectionTitle = document.querySelector("#sectionTitle");
const sidebarToggle = document.querySelector("#sidebarToggle");
const sidebarResizer = document.querySelector("#sidebarResizer");
const themeToggle = document.querySelector("#themeToggle");
const documentMetadataDialog = document.querySelector("#documentMetadataDialog");
const documentMetadataForm = document.querySelector("#documentMetadataForm");
const documentSelectedFile = document.querySelector("#documentSelectedFile");
const cancelDocumentMetadata = document.querySelector("#cancelDocumentMetadata");
const changePasswordDialog = document.querySelector("#changePasswordDialog");
const changePasswordForm = document.querySelector("#changePasswordForm");
const changePasswordMessage = document.querySelector("#changePasswordMessage");

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
  if (!authToken) {
    showAuth();
    return;
  }

  try {
    const user = await api("/auth/session");
    setCurrentUser(user);
    showApp();
    await boot();
  } catch {
    localStorage.removeItem("almoxAuthToken");
    authToken = "";
    showAuth();
  }
}

function bindAuthEvents() {
  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(loginForm));
    if (passwordStep?.classList.contains("hidden")) {
      passwordStep.classList.remove("hidden");
      passwordStep.querySelector("input").required = true;
      emailSubmitButton.textContent = "Entrar";
      passwordStep.querySelector("input").focus();
      return;
    }
    try {
      const response = await api("/auth/login", {
        method: "POST",
        body: JSON.stringify(data)
      });
      startSession(response);
    } catch (error) {
      authMessage.textContent = error.message;
    }
  });

  logoutButton.addEventListener("click", async () => {
    await api("/auth/logout", { method: "POST" }).catch(() => null);
    localStorage.removeItem("almoxAuthToken");
    authToken = "";
    location.reload();
  });

  sidebarProfile?.addEventListener("click", () => changePasswordDialog?.showModal());
  sidebarProfile?.addEventListener("keydown", (event) => {
    if (["Enter", " "].includes(event.key)) changePasswordDialog?.showModal();
  });
  changePasswordForm?.addEventListener("submit", changePassword);
}

async function changePassword(event) {
  event.preventDefault();
  changePasswordMessage.textContent = "";
  try {
    const response = await api("/auth/change-password", {
      method: "POST",
      body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget)))
    });
    authToken = response.token;
    localStorage.setItem("almoxAuthToken", authToken);
    event.currentTarget.reset();
    changePasswordDialog.close();
  } catch (error) {
    changePasswordMessage.textContent = error.message;
  }
}

async function startSession(response) {
  authToken = response.token;
  localStorage.setItem("almoxAuthToken", authToken);
  setCurrentUser(response.user);
  showApp();
  await boot();
}

function setCurrentUser(user) {
  currentUser = {
    email: user.email,
    name: user.nome || user.name || user.email,
    role: user.role || "almoxarifado",
    foto: user.foto || ""
  };
  renderSidebarProfile();
}

function showAuth() {
  authScreen.classList.remove("hidden");
  appShell.classList.add("hidden");
  sidebar.classList.add("hidden");
  showAuthPanel("login");
}

function showApp() {
  authScreen.classList.add("hidden");
  appShell.classList.remove("hidden");
  sidebar.classList.remove("hidden");
  renderSidebarProfile();
}

function renderSidebarProfile() {
  if (!sidebarProfile) return;
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
    passwordStep?.classList.add("hidden");
    if (passwordStep?.querySelector("input")) {
      passwordStep.querySelector("input").required = false;
      passwordStep.querySelector("input").value = "";
    }
    if (emailSubmitButton) emailSubmitButton.textContent = "Continuar com e-mail";
  }
}

async function boot() {
  state.meta = await api("/api/meta");
  state.fornecedores = await api("/api/suppliers");
  state.auditoria = ["admin", "auditor"].includes(currentUser.role) ? await api("/api/audit") : [];
  state.emailHistory = ["admin", "auditor"].includes(currentUser.role) ? await api("/api/emails/history") : [];
  state.securityAudit = ["admin", "auditor"].includes(currentUser.role) ? await api("/api/security-audit") : [];
  document.querySelector('[data-section="settings"]')?.classList.toggle("hidden", currentUser.role !== "admin");
  document.querySelector('[data-section="audit"]')?.classList.toggle("hidden", !["admin", "auditor"].includes(currentUser.role));
  newProcessButton?.classList.toggle("hidden", currentUser.role === "auditor");
  observationForm?.classList.toggle("hidden", currentUser.role === "auditor");
  fillSelect(statusSelect, state.meta.status, "Todos os status");
  fillSelect(statusFilter, state.meta.status, "Todos os status");
  fillSelect(quickFilter, state.meta.filtrosRapidos, "Filtros rapidos");
  await refresh();
  renderYearOptions();
  renderQuickFilters();
  openSection("dashboard");
}

async function refresh() {
  const params = new URLSearchParams();
  if (searchInput.value) params.set("q", searchInput.value);
  if (statusFilter.value) params.set("status", statusFilter.value);
  if (quickFilter.value) params.set("filtroRapido", quickFilter.value);
  if (yearFilter?.value) params.set("ano", yearFilter.value);
  const processPath = `/api/processes?${params}`;
  state.processos = await api(processPath);
  state.allProcesses = params.toString() ? await api("/api/processes") : state.processos;
  renderTable();
  state.dashboardMetrics = await api("/api/dashboard");
  renderMetrics(state.dashboardMetrics);
}

function processFilterParams() {
  const params = new URLSearchParams();
  if (searchInput.value) params.set("q", searchInput.value);
  if (statusFilter.value) params.set("status", statusFilter.value);
  if (quickFilter.value) params.set("filtroRapido", quickFilter.value);
  if (yearFilter?.value) params.set("ano", yearFilter.value);
  return params;
}

async function downloadProcesses() {
  const params = new URLSearchParams();
  const format = processExportFormat?.value || "excel";
  params.set("format", format);
  const response = await fetch(`/api/processes/download?${params}`, {
    headers: {
      "x-user-email": currentUser.email,
      "x-user-name": currentUser.name,
      ...(authToken ? { authorization: `Bearer ${authToken}` } : {})
    }
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    alert(data.error || "Nao foi possivel gerar o download.");
    return;
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = processExportFileName(format);
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function processExportFileName(format = "excel") {
  const date = new Date().toISOString().slice(0, 10);
  const extensions = { excel: "xls", pdf: "pdf", csv: "csv" };
  return `empenhos-${date}.${extensions[format] || "xls"}`;
}

function renderMetrics(data) {
  const items = (data.porStatus || []).filter(([, value]) => value > 0);

  metrics.innerHTML = items.map(([label, value]) => `
    <article class="metric">
      <span>${escapeHtml(label)}</span>
      <strong>${value}</strong>
    </article>
  `).join("");
}

function renderTable() {
  table.innerHTML = state.processos.map((processo) => `
    <tr data-edit="${escapeAttribute(processo.id)}">
      <td class="strong-cell">${empty(processo.numeroProcesso)}</td>
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
  `).join("");
}

processForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(processForm));
  data.materiais = readMaterials();
  const id = data.id;
  delete data.id;

  try {
    const savedProcess = await api(id ? `/api/processes/${id}` : "/api/processes", {
      method: id ? "PUT" : "POST",
      body: JSON.stringify(data)
    });
    formMessage.textContent = "Processo salvo.";
    clearForm();
    processDialog.close();
    await refresh();
    await refreshAudit();
    if (state.selectedProcess?.id === savedProcess.id) {
      state.selectedProcess = savedProcess;
      await loadDetailObservations(savedProcess.id);
      renderProcessDetail();
    }
  } catch (error) {
    formMessage.textContent = error.message;
  }
});

document.querySelector("#clearForm").addEventListener("click", clearForm);
newProcessButton.addEventListener("click", () => openProcessDialog());
downloadProcessesButton?.addEventListener("click", downloadProcesses);
addMaterialButton.addEventListener("click", () => addMaterialRow());
searchInput.addEventListener("input", debounce(refresh, 250));
statusFilter.addEventListener("change", refresh);
quickFilter.addEventListener("change", refresh);
yearFilter?.addEventListener("change", refresh);
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
  const editId = event.target.dataset.edit || event.target.closest("tr")?.dataset.edit;
  const notesId = event.target.dataset.notes;

  if (editId) {
    const processo = state.processos.find((item) => item.id === editId);
    openProcessDetail(processo, "processes");
  }

  if (notesId) {
    state.observationProcessId = notesId;
    await loadObservations();
    dialog.showModal();
  }
});

backToProcesses.addEventListener("click", closeProcessDetail);

detailTabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    state.detailTab = tab.dataset.detailTab;
    detailTabs.forEach((item) => item.classList.toggle("active", item === tab));
    renderDetailPanel();
  });
});

downloadProcessButton.addEventListener("click", () => {
  if (!state.selectedProcess) return;
  downloadDialog?.showModal();
});

downloadChoices.forEach((button) => {
  button.addEventListener("click", () => {
    if (!state.selectedProcess) return;
    downloadDialog?.close();
    downloadProcess(state.selectedProcess.id, button.dataset.downloadFormat);
  });
});

supplierInfoForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(supplierInfoForm));
  const razaoSocial = String(data.razaoSocial || "").trim();
  if (!razaoSocial) return;
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
  renderSuppliersView();
});

cancelSupplierInfo?.addEventListener("click", () => {
  supplierInfoDialog?.close();
});

navItems.forEach((item) => {
  item.addEventListener("click", (event) => {
    event.preventDefault();
    openSection(item.dataset.section);
  });
});

sidebarToggle?.addEventListener("click", () => {
  document.body.classList.toggle("sidebar-collapsed");
  sidebarToggle.textContent = document.body.classList.contains("sidebar-collapsed") ? "›" : "‹";
});

sidebarResizer?.addEventListener("pointerdown", (event) => {
  if (document.body.classList.contains("sidebar-collapsed")) return;
  event.preventDefault();
  sidebarResizer.setPointerCapture(event.pointerId);
  document.body.classList.add("resizing-sidebar");
});

sidebarResizer?.addEventListener("pointermove", (event) => {
  if (!document.body.classList.contains("resizing-sidebar")) return;
  const width = Math.min(360, Math.max(188, event.clientX));
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
  if (event.target.dataset.openEdit) {
    openProcessDialog(state.selectedProcess);
  }

  const notesId = event.target.dataset.openNotes;
  if (notesId) {
    state.observationProcessId = notesId;
    await loadObservations();
    dialog.showModal();
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
    downloadDocument(downloadPath);
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

  if (event.target.dataset.cancelProcess) {
    await cancelSelectedProcess();
  }

  if (event.target.dataset.updateStatus) {
    await saveNewProcessData();
  }

  if (event.target.dataset.registerPartialDelivery) {
    await registerPartialDelivery();
  }

  if (event.target.dataset.showNewData) {
    const panel = detailPanel.querySelector("[data-new-data-panel]");
    panel?.classList.toggle("hidden");
    panel?.querySelector("[data-detail-date]")?.focus();
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
  const data = Object.fromEntries(new FormData(observationForm));
  await api(`/api/processes/${state.observationProcessId}/observations`, {
    method: "POST",
    body: JSON.stringify(data)
  });
  observationForm.reset();
  await loadObservations();
  if (state.selectedProcess?.id === state.observationProcessId) {
    await loadDetailObservations(state.observationProcessId);
    if (["timeline", "observations"].includes(state.detailTab)) renderDetailPanel();
  }
});

async function loadObservations() {
  const items = await api(`/api/processes/${state.observationProcessId}/observations`);
  observationsList.innerHTML = items.length ? items.map((item) => `
    <article class="note">
      <span>${new Date(item.criadoEm).toLocaleString("pt-BR")} - ${escapeHtml(item.usuario)}</span>
      <div>${escapeHtml(item.conteudo)}</div>
      <div class="note-actions">
        <button type="button" class="secondary" data-edit-observation="${escapeAttribute(item.id)}">Alterar</button>
        <button type="button" class="secondary" data-delete-observation="${escapeAttribute(item.id)}">Excluir</button>
      </div>
    </article>
  `).join("") : "<p>Nenhuma observacao registrada.</p>";
}

observationsList.addEventListener("click", async (event) => {
  const editObservationId = event.target.dataset.editObservation;
  if (editObservationId) await editObservation(editObservationId);

  const deleteObservationId = event.target.dataset.deleteObservation;
  if (deleteObservationId) await deleteObservation(deleteObservationId);
});

function fillForm(processo) {
  processForm.id.value = processo.id;
  processForm.versao.value = processo.versao;
  for (const [key, value] of Object.entries(processo)) {
    if (processForm.elements[key]) processForm.elements[key].value = value ?? "";
  }
  if (processForm.elements.dataEnvioFornecedor && !processForm.elements.dataEnvioFornecedor.value) {
    processForm.elements.dataEnvioFornecedor.value = processo.dataEnvioEmpenho || "";
  }
  renderMaterialRows(processo.materiais);
  formMessage.textContent = "Editando processo selecionado.";
}

function clearForm() {
  processForm.reset();
  processForm.id.value = "";
  processForm.versao.value = "";
  formMessage.textContent = "";
  renderMaterialRows();
}

function openProcessDialog(processo = null) {
  clearForm();
  processDialogTitle.textContent = processo ? "Editar processo" : "Novo processo";
  if (processo) fillForm(processo);
  processDialog.showModal();
}

function openProcessDetail(processo, returnSection = "processes") {
  if (!processo) return;
  state.selectedProcess = processo;
  state.detailReturnSection = returnSection;
  state.detailTab = "general";
  processListView.classList.add("hidden");
  dashboardView.classList.add("hidden");
  suppliersView.classList.add("hidden");
  settingsView.classList.add("hidden");
  auditView.classList.add("hidden");
  processDetailView.classList.remove("hidden");
  if (sectionTitle) sectionTitle.textContent = "Empenhos";
  detailTabs.forEach((tab) => tab.classList.toggle("active", tab.dataset.detailTab === "general"));
  loadDetailObservations(processo.id).then(() => renderProcessDetail());
}

function closeProcessDetail() {
  const returnSection = state.detailReturnSection || "processes";
  state.selectedProcess = null;
  processDetailView.classList.add("hidden");
  navItems.forEach((item) => item.classList.toggle("active", item.dataset.section === returnSection));
  if (sectionTitle) sectionTitle.textContent = returnSection === "suppliers" ? "Fornecedores" : "Empenhos";

  if (returnSection === "suppliers") {
    processListView.classList.add("hidden");
    dashboardView.classList.add("hidden");
    settingsView.classList.add("hidden");
    auditView.classList.add("hidden");
    suppliersView.classList.remove("hidden");
    renderSuppliersView();
    return;
  }

  suppliersView.classList.add("hidden");
  dashboardView.classList.add("hidden");
  settingsView.classList.add("hidden");
  auditView.classList.add("hidden");
  processListView.classList.remove("hidden");
}

async function downloadProcess(processId, format) {
  const normalized = format === "pdf" ? "pdf" : "zip";
  const response = await fetch(`/api/processes/${processId}/download?format=${normalized}`, {
    headers: authToken ? { authorization: `Bearer ${authToken}` } : {}
  });
  if (!response.ok) throw new Error("Nao foi possivel baixar o processo.");
  const blobUrl = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = blobUrl;
  link.download = normalized === "pdf" ? "processo.pdf" : "processo.zip";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
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
          <span>${event.date ? (event.showTime ? formatDateTime(event.date) : formatDate(event.date)) : "Pendente"}</span>
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
        ${currentUser.role === "auditor" ? "" : '<button type="button" class="secondary" data-register-partial-delivery="true">Registrar entrega parcial</button>'}
      </article>
    </div>
  `;
}

function renderObservationsModule(processo) {
  const observations = state.detailObservations.length
    ? state.detailObservations.map((observacao) => `
      <article class="note">
        <span>${new Date(observacao.criadoEm).toLocaleString("pt-BR")} - ${escapeHtml(observacao.usuario)}</span>
        <div>${escapeHtml(observacao.conteudo)}</div>
        ${(currentUser.role === "admin" || observacao.usuarioEmail === currentUser.email) ? `<div class="note-actions">
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
        <button type="button" class="secondary" data-open-notes="${processo.id}">Abrir observacoes</button>
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
        ${currentUser.role === "admin" ? `<button type="button" class="secondary" data-send-test-email="${processo.id}">Enviar teste</button>` : ""}
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

async function loadDetailObservations(processId) {
  state.detailObservations = await api(`/api/processes/${processId}/observations`);
}

async function refreshAudit() {
  state.auditoria = ["admin", "auditor"].includes(currentUser.role) ? await api("/api/audit") : [];
}

async function attachDocument(documentKey) {
  if (!state.selectedProcess) return;
  const file = await pickDocumentFile();
  if (!file) return;
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
    input.type = "file";
    input.accept = ".pdf,.xlsx,.xls,.csv,.docx,.doc,.odt,.ods,.txt,.png,.jpg,.jpeg,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/msword";
    input.addEventListener("change", () => resolve(input.files?.[0] || null), { once: true });
    input.click();
  });
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
  const current = state.detailObservations.find((item) => item.id === observationId)
    || await findDialogObservation(observationId);
  const conteudo = prompt("Alterar observacao:", current?.conteudo || "");
  if (!conteudo?.trim()) return;
  const processId = current?.processoId || state.observationProcessId || state.selectedProcess?.id;

  await api(`/api/processes/${processId}/observations/${observationId}`, {
    method: "PUT",
    body: JSON.stringify({ conteudo: conteudo.trim() })
  });
  await refreshObservationViews();
}

async function deleteObservation(observationId) {
  if (!confirm("Excluir esta observacao?")) return;
  const current = state.detailObservations.find((item) => item.id === observationId)
    || await findDialogObservation(observationId);
  const processId = current?.processoId || state.observationProcessId || state.selectedProcess?.id;
  await api(`/api/processes/${processId}/observations/${observationId}`, {
    method: "DELETE"
  });
  await refreshObservationViews();
}

async function cancelSelectedProcess() {
  if (!state.selectedProcess) return;
  const motivo = prompt("Informe o motivo da anulacao do empenho:");
  if (!motivo?.trim()) return;

  const updatedProcess = await api(`/api/processes/${state.selectedProcess.id}/cancel`, {
    method: "POST",
    body: JSON.stringify({ motivo: motivo.trim() })
  });
  state.selectedProcess = updatedProcess;
  await refresh();
  await refreshAudit();
  renderProcessDetail();
}

async function saveNewProcessData() {
  if (!state.selectedProcess) return;
  const statusField = detailPanel.querySelector("[data-detail-status]");
  const dateField = detailPanel.querySelector("[data-detail-date]");
  const status = statusField?.value;
  const date = dateField?.value;
  const step = nextProcessStep(state.selectedProcess);
  if (!status || !date) {
    alert("Informe a data para salvar.");
    return;
  }

  if (["Entrega parcial", "Entregue"].includes(status)) {
    await registerDelivery(date, status === "Entregue");
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
async function registerPartialDelivery() {
  if (!state.selectedProcess) return;
  const date = prompt("Informe a data da entrega parcial (AAAA-MM-DD):", state.selectedProcess.dataEntrega || "");
  if (!date?.trim()) return;

  await registerDelivery(date.trim(), false);
}

async function registerDelivery(date, complete) {
  const processo = state.selectedProcess;
  const delivered = new Map();
  (processo.entregas || []).forEach((entrega) => (entrega.itens || []).forEach((item) => {
    delivered.set(item.materialIndex, (delivered.get(item.materialIndex) || 0) + Number(item.quantidade || 0));
  }));
  const itens = [];
  for (const [materialIndex, material] of (processo.materiais || []).entries()) {
    const remaining = Math.max(0, Number(material.quantidade || 0) - (delivered.get(materialIndex) || 0));
    if (!remaining) continue;
    const answer = prompt(
      `Quantidade recebida de ${material.descricao} (saldo ${remaining}):`,
      complete ? String(remaining) : "0"
    );
    if (answer === null) return;
    const quantidade = Number(String(answer).replace(",", "."));
    if (Number.isFinite(quantidade) && quantidade > 0) itens.push({ materialIndex, quantidade });
  }
  if (!itens.length) {
    alert("Informe ao menos uma quantidade recebida.");
    return;
  }
  const updatedProcess = await api(`/api/processes/${processo.id}/deliveries`, {
    method: "POST",
    body: JSON.stringify({ data, itens })
  });
  state.selectedProcess = updatedProcess;
  await refresh();
  await refreshAudit();
  renderProcessDetail();
}

function processUpdatePayload(overrides = {}) {
  const processo = state.selectedProcess;
  return {
    numeroProcesso: processo.numeroProcesso || "",
    numeroEmpenho: processo.numeroEmpenho || "",
    fornecedor: processo.fornecedor || "",
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
    await loadDetailObservations(state.selectedProcess.id);
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

function openSection(section) {
  navItems.forEach((item) => item.classList.toggle("active", item.dataset.section === section));
  const titles = { dashboard: "Painel", processes: "Empenhos", suppliers: "Fornecedores", audit: "Auditoria", settings: "Templates" };
  if (sectionTitle) sectionTitle.textContent = titles[section] || "";
  processListView.classList.toggle("hidden", section !== "processes");
  dashboardView.classList.toggle("hidden", section !== "dashboard");
  suppliersView.classList.toggle("hidden", section !== "suppliers");
  auditView.classList.toggle("hidden", section !== "audit");
  settingsView.classList.toggle("hidden", section !== "settings");
  processDetailView.classList.add("hidden");
  state.selectedProcess = null;

  if (section === "dashboard") renderDashboardView();
  if (section === "suppliers") renderSuppliersView();
  if (section === "audit") renderAuditView();
  if (section === "settings") renderSettingsView();
}

async function renderDashboardView() {
  dashboardView.innerHTML = `
    <div class="content-header">
      <div>
        <h1>Painel</h1>
      </div>
      <select class="dashboard-year" id="dashboardYearSelect" aria-label="Ano do painel">
        ${dashboardYearOptions(state.dashboardYear)}
      </select>
    </div>
    <div class="dashboard-grid">
      ${metrics.innerHTML}
    </div>
    <div class="chart-card">
      <p class="empty-state">Carregando graficos...</p>
    </div>
  `;

  const yearSelect = dashboardView.querySelector("#dashboardYearSelect");
  yearSelect.addEventListener("change", (event) => {
    state.dashboardYear = event.target.value;
    renderDashboardView();
  });
  const year = state.dashboardYear || yearSelect.value || new Date().getFullYear();
  const [monthlyExecution, statusDistribution] = await Promise.all([
    api(`/api/dashboard/execucao-mensal?ano=${year}`),
    api(`/api/dashboard/distribuicao-status?ano=${year}`)
  ]);

  dashboardView.innerHTML = `
    <div class="content-header">
      <div>
        <h1>Painel</h1>
      </div>
      <select class="dashboard-year" id="dashboardYearSelect" aria-label="Ano do painel">
        ${dashboardYearOptions(year)}
      </select>
    </div>
    <div class="dashboard-grid">
      ${metrics.innerHTML}
    </div>
    <div class="charts-grid">
      ${executionGroupedChart(monthlyExecution)}
      ${budgetStatusChart(statusDistribution)}
      ${financialChart()}
    </div>
  `;
  dashboardView.querySelector("#dashboardYearSelect").addEventListener("change", (event) => {
    state.dashboardYear = event.target.value;
    renderDashboardView();
  });
}

function dashboardYearOptions(selected = "") {
  const years = [...new Set(state.processos
    .map((processo) => deadlineDate(processo) ? new Date(`${deadlineDate(processo)}T00:00:00`).getFullYear() : "")
    .filter(Boolean))]
    .sort((a, b) => b - a);
  const current = selected || years[0] || new Date().getFullYear();
  return years.map((year) => `<option value="${year}" ${String(year) === String(current) ? "selected" : ""}>Ano: ${year}</option>`).join("");
}

function executionGroupedChart(rows) {
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
      <div class="grouped-chart">
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
    </article>
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
            <div class="column-tooltip">${row.mes} - ${label}: ${money(value)}</div>
          </div>
        `).join("")}
      </div>
      <span>${row.mes}</span>
    </div>
  `;
}

function budgetStatusChart(entries) {
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

function columnChartCard(title, entries, formatter) {
  const max = Math.max(...entries.map(([, value]) => Number(value)), 1);
  const yTicks = [max, max * 0.75, max * 0.5, max * 0.25, 0];
  return `
    <article class="chart-card monthly-chart">
      <h2>${title}</h2>
      <div class="column-chart">
        <div class="y-axis">
          ${yTicks.map((tick) => `<span>${compactMoney(tick)}</span>`).join("")}
        </div>
        <div class="plot-area">
          <div class="grid-lines"></div>
          <div class="columns">
            ${entries.map(([label, value]) => `
              <div class="column-item">
                <div class="column-bar" style="height: ${Math.max(8, (Number(value) / max) * 100)}%"></div>
                <div class="column-tooltip">${monthLabel(label)}: empenhado ${formatter(value)}</div>
                <span>${monthLabel(label)}</span>
              </div>
            `).join("")}
          </div>
        </div>
      </div>
    </article>
  `;
}

function pieChartCard(title, entries) {
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
      <h2>${title}</h2>
      <div class="pie-layout">
        <svg class="external-pie" viewBox="0 0 620 360" role="img" aria-label="${title}">
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
      <text class="pie-label" x="${labelX}" y="${labelPoint.y + 4}" text-anchor="${textAnchor}">${label}</text>
      <foreignObject class="pie-tooltip" x="${center.x - 86}" y="${center.y - 30}" width="172" height="60">
        <div xmlns="http://www.w3.org/1999/xhtml">
          <span>${slice.label}</span>
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
  if (!step) return "";
  return `
    <div class="new-data-panel hidden" data-new-data-panel>
      <input type="hidden" data-detail-status value="${step.status}">
      <span class="new-data-title">${step.title}</span>
      <label>Data
        <input type="date" data-detail-date required>
      </label>
      <button type="button" class="secondary" data-update-status="true">Salvar</button>
    </div>
  `;
}

function canEditStatusInUi(processo) {
  if (!processo || ["Pago", "Anulado"].includes(processo.status)) return false;
  return Boolean(nextProcessStep(processo, true));
}

function nextProcessStep(processo, skipPermissionCheck = false) {
  if (!processo || (!skipPermissionCheck && ["Pago", "Anulado"].includes(processo.status))) return null;
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

function canAttachDocumentInUi(processo, documentKey) {
  if (!processo || processo.inativo || ["Anulado", "Pago"].includes(processo.status) || !documentKey || currentUser.role === "auditor") return false;
  if (documentKey === "notaFiscal") {
    return ["Entrega parcial", "Entregue", "Aguardando envio para liquidacao", "Enviado para liquidacao", "Liquidado"].includes(processo.status);
  }
  return true;
}

function renderSuppliersView() {
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

  suppliersView.querySelector("#supplierSearchInput")?.addEventListener("input", (event) => {
    const cursor = event.target.selectionStart;
    state.supplierSearch = event.target.value;
    state.supplierHistory = "";
    renderSuppliersView();
    const input = suppliersView.querySelector("#supplierSearchInput");
    input?.focus();
    input?.setSelectionRange(cursor, cursor);
  });
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
                  <td><button type="button" class="link-button">${empty(escapeHtml(processo.numeroProcesso))}</button></td>
                  <td>${empty(escapeHtml(processo.numeroEmpenho))}</td>
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

function renderAuditView() {
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
    <div class="table-wrap"><table><thead><tr><th>Data</th><th>Evento</th><th>Ator</th><th>Alvo</th><th>Detalhes</th></tr></thead>
      <tbody>${events.map((entry) => `<tr><td>${escapeHtml(formatDateTime(entry.date))}</td><td>${escapeHtml(entry.type)}</td><td>${escapeHtml(entry.actor)}</td><td>${escapeHtml(entry.target)}</td><td>${escapeHtml(entry.details)}</td></tr>`).join("")}</tbody>
    </table></div>
  `;
  auditView.querySelector("#refreshAuditButton")?.addEventListener("click", refreshAuditView);
}

async function refreshAuditView() {
  [state.auditoria, state.securityAudit] = await Promise.all([api("/api/audit"), api("/api/security-audit")]);
  renderAuditView();
}

async function renderSettingsView() {
  if (!state.settings) {
    settingsView.innerHTML = `
      <div class="content-header">
        <div>
          <h1>Templates</h1>
        </div>
      </div>
      <p class="empty-state">Carregando templates...</p>
    `;
    state.settings = await loadSettings();
  }

  settingsView.innerHTML = `
    <div class="content-header">
      <div>
        <h1>Templates</h1>
      </div>
    </div>
    <div class="settings-grid">
      ${settingsCard("templates", "Templates de e-mail", "Modelos usados nas notificacoes automaticas e reenvios manuais.")}
      ${settingsCard("notifications", "Prazos para notificacoes", `${state.settings.notificationRules.diasAvisoInterno.join(", ")} dias; oficio no dia ${state.settings.notificationRules.diaOficioFornecedor}.`)}
      ${settingsCard("users", "Usuarios e permissoes", `${state.settings.usuarios.length} usuario(s) cadastrado(s).`)}
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
      <strong>${title}</strong>
      <span>${description}</span>
      <button type="button" class="secondary" data-settings-panel="${panel}">Configurar</button>
    </article>
  `;
}

function renderSettingsPanel() {
  if (state.settingsPanel === "notifications") return renderNotificationSettings();
  if (state.settingsPanel === "users") return renderUserSettings();
  return renderEmailTemplateSettings();
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
      <label>Senha inicial <input name="senhaTemporaria" type="password" minlength="12" required></label>
      <div class="actions"><button type="submit">Criar usuario</button></div>
    </form>
    <div class="module-list">
      ${state.settings.usuarios.map((user) => `
        <article class="module-row">
          <div><strong>${escapeHtml(user.nome)}</strong><span>${escapeHtml(user.email)} · ${user.ativo ? "ativo" : "aguardando aprovacao"}</span>${user.justificativaAcesso ? `<span>${escapeHtml(user.justificativaAcesso)}</span>` : ""}</div>
          <div class="document-actions">
            <select data-user-role="${escapeAttribute(user.id)}">
              ${["almoxarifado", "auditor", "admin"].map((role) => `<option value="${role}" ${user.role === role ? "selected" : ""}>${role}</option>`).join("")}
            </select>
            <button type="button" class="secondary" data-toggle-user="${escapeAttribute(user.id)}" data-user-active="${user.ativo}">${user.ativo ? "Desativar" : "Ativar"}</button>
            <button type="button" class="secondary" data-revoke-user="${escapeAttribute(user.id)}">Revogar sessoes</button>
          </div>
        </article>
      `).join("")}
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
  settingsView.querySelectorAll("[data-settings-panel]").forEach((button) => {
    button.addEventListener("click", () => {
      state.settingsPanel = button.dataset.settingsPanel;
      renderSettingsView();
    });
  });
  settingsView.querySelector("#emailTemplatesForm")?.addEventListener("submit", saveEmailTemplates);
  settingsView.querySelectorAll("[data-remove-template-attachment]").forEach((button) => {
    button.addEventListener("click", () => removeTemplateDocument(button.dataset.templateKey, button.dataset.removeTemplateAttachment));
  });
  settingsView.querySelectorAll("[data-download-document]").forEach((button) => {
    button.addEventListener("click", () => downloadDocument(button.dataset.downloadDocument));
  });
  settingsView.querySelector("#notificationSettingsForm")?.addEventListener("submit", saveNotificationSettings);
  settingsView.querySelector("#newManagedUserForm")?.addEventListener("submit", createManagedUser);
  settingsView.querySelectorAll("[data-attach-template]").forEach((button) => {
    button.addEventListener("click", () => attachTemplateDocument(button.dataset.attachTemplate));
  });
  settingsView.querySelectorAll("[data-user-role]").forEach((select) => {
    select.addEventListener("change", () => updateManagedUser(select.dataset.userRole, { role: select.value }));
  });
  settingsView.querySelectorAll("[data-toggle-user]").forEach((button) => {
    button.addEventListener("click", () => updateManagedUser(button.dataset.toggleUser, { ativo: button.dataset.userActive !== "true" }));
  });
  settingsView.querySelectorAll("[data-revoke-user]").forEach((button) => {
    button.addEventListener("click", () => updateManagedUser(button.dataset.revokeUser, { revogarSessoes: true }));
  });
}

async function createManagedUser(event) {
  event.preventDefault();
  const body = Object.fromEntries(new FormData(event.currentTarget));
  await api("/api/admin/users", { method: "POST", body: JSON.stringify(body) });
  state.settings = await api("/api/settings");
  renderSettingsView();
}

async function updateManagedUser(userId, changes) {
  await api(`/api/admin/users/${encodeURIComponent(userId)}`, { method: "PATCH", body: JSON.stringify(changes) });
  state.settings = await api("/api/settings");
  renderSettingsView();
}

async function saveEmailTemplates(event) {
  event.preventDefault();
  if (settingsFallbackActive()) return;
  const data = Object.fromEntries(new FormData(event.currentTarget));
  const emailTemplates = {};
  Object.keys(state.settings.emailTemplates).forEach((key) => {
    emailTemplates[key] = {
      assunto: data[`${key}.assunto`] || "",
      corpo: data[`${key}.corpo`] || "",
      anexos: state.settings.emailTemplates[key]?.anexos || []
    };
  });
  state.settings = await api("/api/settings/email-templates", {
    method: "PUT",
    body: JSON.stringify({ emailTemplates })
  });
  renderSettingsView();
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
  state.settings = await api(`/api/settings/email-templates/${encodeURIComponent(templateKey)}/attachments/${encodeURIComponent(attachmentId)}`, {
    method: "DELETE"
  });
  renderSettingsView();
}

async function downloadDocument(path) {
  if (!path) return;
  const response = await fetch(path, {
    headers: authToken ? { authorization: `Bearer ${authToken}` } : {}
  });
  if (!response.ok) throw new Error("Nao foi possivel baixar o documento.");
  const blobUrl = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = blobUrl;
  link.download = "";
  link.click();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
}

async function saveNotificationSettings(event) {
  event.preventDefault();
  if (settingsFallbackActive()) return;
  const data = Object.fromEntries(new FormData(event.currentTarget));
  state.settings = await api("/api/settings/notifications", {
    method: "PUT",
    body: JSON.stringify({
      diasAvisoInterno: String(data.diasAvisoInterno || "").split(/[\n,; ]+/),
      diaOficioFornecedor: Number(data.diaOficioFornecedor || 30)
    })
  });
  renderSettingsView();
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
    <label>Descricao <input data-material-field="descricao" value="${escapeAttribute(material.descricao || "")}"></label>
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
  select.innerHTML = [`<option value="">${placeholder}</option>`]
    .concat(items.map((item) => `<option value="${item}">${item}</option>`))
    .join("");
}

function renderQuickFilters() {
  const filters = ["Todos", ...state.meta.filtrosRapidos];
  quickFilterBar.innerHTML = filters.map((label) => `
    <button type="button" class="filter-chip ${label === "Todos" ? "active" : ""}" data-filter="${label === "Todos" ? "" : label}">
      ${label === "Todos" ? "▽ " : ""}${label}
    </button>
  `).join("");

  quickFilterBar.addEventListener("click", async (event) => {
    const chip = event.target.closest(".filter-chip");
    if (!chip) return;
    quickFilter.value = chip.dataset.filter;
    quickFilterBar.querySelectorAll(".filter-chip").forEach((button) => {
      button.classList.toggle("active", button === chip);
    });
    await refresh();
  });
}

function renderYearOptions() {
  if (!yearFilter) return;
  const years = [...new Set(state.processos
    .map((processo) => deadlineDate(processo) ? new Date(`${deadlineDate(processo)}T00:00:00`).getFullYear() : "")
    .filter(Boolean))]
    .sort((a, b) => b - a);

  yearFilter.innerHTML = '<option value="">Ano: Todos</option>'
    + years.map((year) => `<option value="${year}">Ano: ${year}</option>`).join("");
  if (years.includes(2026)) yearFilter.value = "2026";
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      "x-user-email": currentUser.email,
      "x-user-name": currentUser.name,
      ...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
      ...(options.headers || {})
    }
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Falha na operacao");
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

function canCancelInUi(processo) {
  if (!processo || ["Anulado", "Pago"].includes(processo.status) || currentUser.role === "auditor") return false;
  if (isCurrentUserAdmin()) return true;
  return processo.criadoPorEmail === currentUser.email;
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

function monthLabel(value) {
  if (value === "Sem data") return value;
  const [, month] = String(value).split("-");
  return ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"][Number(month) - 1] || value;
}

function compactMoney(value) {
  const amount = Number(value || 0);
  if (amount >= 1000) return `${Math.round(amount / 1000)}k`;
  return `${Math.round(amount)}`;
}

function dateCell(value) {
  return escapeHtml(value || "-");
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
  return String(value || "").slice(0, 10);
}

function formatDateTime(value) {
  if (!value) return "-";
  return new Date(value).toLocaleString("pt-BR");
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
