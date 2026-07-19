export const STATUS = [
  "Enviado para SALC",
  "Empenho enviado ao fornecedor",
  "Aguardando entrega",
  "Entrega parcial",
  "Entregue",
  "Aguardando envio para liquidacao",
  "Enviado para liquidacao",
  "Liquidado",
  "Pago",
  "Anulado"
];

export const PROCESS_WORKFLOW = STATUS.filter((status) => !["Aguardando envio para liquidacao", "Anulado"].includes(status));

export const PROCESS_TRANSITIONS = Object.fromEntries([
  ...PROCESS_WORKFLOW.map((status, index) => [status, PROCESS_WORKFLOW[index + 1] || ""]),
  ["Aguardando envio para liquidacao", "Enviado para liquidacao"]
]);

export const DEFAULT_BUSINESS_TIME_ZONE = "America/Sao_Paulo";

const DELIVERY_REACHED_STATUSES = new Set([
  "Entregue",
  "Aguardando envio para liquidacao",
  "Enviado para liquidacao",
  "Liquidado",
  "Pago"
]);

const AWAITING_DELIVERY_STATUSES = new Set([
  "Empenho enviado ao fornecedor",
  "Aguardando entrega"
]);

export const QUICK_FILTERS = [
  "Em atraso",
  "Aguardando entrega",
  "Entrega parcial",
  "Pendentes de liquidacao",
  "Liquidado",
  "Pago",
  "Anulado",
  "Mais de 30 dias"
];

export const REQUIRED_DOCUMENT_KEYS = ["processoSped", "notaEmpenho", "notaFiscal"];
export const LIQUIDATION_DOCUMENT_KEYS = ["processoSped", "notaEmpenho"];

export const DOCUMENT_LABELS = {
  processoSped: "Processo SPED",
  notaEmpenho: "Nota de Empenho",
  notaFiscal: "Nota Fiscal"
};

export function canEditProcess(processo, userRole = "almoxarifado", nextStatus = "") {
  if (!processo || processo.inativo) return false;
  if (processo.status === "Pago") return false;
  if (processo.status === "Anulado") return false;
  if (processo.status === "Liquidado") return userRole === "admin";
  return userRole === "admin" || userRole === "almoxarifado";
}

export function canCancelProcess(processo, user = {}) {
  if (!processo || processo.inativo) return false;
  if (processo.status === "Anulado") return false;
  if (processo.status === "Pago") return false;
  if (user.role === "admin") return true;
  if (processo.status === "Liquidado") return false;
  if (processo.criadoPorId) return Boolean(user.id) && processo.criadoPorId === user.id;
  return Boolean(processo.criadoPorEmail && user.email && processo.criadoPorEmail === user.email);
}

export function hasProcessReachedDelivery(processo = {}) {
  return DELIVERY_REACHED_STATUSES.has(String(processo.status || ""));
}

export function isProcessAwaitingDelivery(processo = {}) {
  return AWAITING_DELIVERY_STATUSES.has(String(processo.status || ""));
}

export function isValidStatusTransition(currentStatus = "", nextStatus = "") {
  if (currentStatus === nextStatus) return true;
  if (["Entrega parcial", "Entregue", "Anulado"].includes(nextStatus)) return false;
  return Boolean(currentStatus) && PROCESS_TRANSITIONS[currentStatus] === nextStatus;
}

export function previousProcessStatuses(currentStatus = "") {
  const currentIndex = PROCESS_WORKFLOW.indexOf(currentStatus);
  return currentIndex > 0 ? PROCESS_WORKFLOW.slice(0, currentIndex) : [];
}

export function isValidStatusRollback(currentStatus = "", targetStatus = "") {
  return previousProcessStatuses(currentStatus).includes(targetStatus);
}

export function rollbackProcessStatus(processo = {}, targetStatus = "") {
  if (!isValidStatusRollback(processo.status, targetStatus)) return null;

  const targetIndex = PROCESS_WORKFLOW.indexOf(targetStatus);
  const updated = { ...processo, status: targetStatus };
  const milestones = [
    ["dataEnvioFornecedor", "Empenho enviado ao fornecedor"],
    ["dataEnvioEmpenho", "Empenho enviado ao fornecedor"],
    ["dataEntrega", "Entrega parcial"],
    ["dataEnvioLiquidacao", "Enviado para liquidacao"],
    ["dataLiquidacao", "Liquidado"],
    ["dataPagamento", "Pago"]
  ];
  for (const [field, milestoneStatus] of milestones) {
    if (targetIndex < PROCESS_WORKFLOW.indexOf(milestoneStatus)) updated[field] = "";
  }
  return updated;
}

export function isPdfDocument(fileName = "", mimeType = "") {
  const normalizedMime = String(mimeType || "").toLowerCase();
  const normalizedName = String(fileName || "").toLowerCase();
  return normalizedMime === "application/pdf" || normalizedName.endsWith(".pdf");
}

export function isAllowedDocument(fileName = "", mimeType = "") {
  const normalizedMime = String(mimeType || "").toLowerCase();
  const normalizedName = String(fileName || "").toLowerCase();
  const allowedExtensions = [".pdf", ".xlsx", ".xls", ".csv", ".docx", ".doc", ".odt", ".ods", ".txt", ".png", ".jpg", ".jpeg"];
  const allowedMimes = [
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-excel",
    "text/csv",
    "application/csv",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/msword",
    "application/vnd.oasis.opendocument.text",
    "application/vnd.oasis.opendocument.spreadsheet",
    "text/plain",
    "image/png",
    "image/jpeg"
  ];
  return allowedExtensions.some((extension) => normalizedName.endsWith(extension)) || allowedMimes.includes(normalizedMime);
}

export function validateDocumentUpload(fileName = "", mimeType = "", content = Buffer.alloc(0)) {
  if (!isSafeUploadFileName(fileName)) return false;
  if (!isAllowedDocument(fileName, mimeType)) return false;
  const detectedMime = detectDocumentMime(content);
  if (!detectedMime) return false;
  if (detectedMime === "application/x-msdownload") return false;
  if (!hasDocumentEndMarker(content, detectedMime)) return false;

  const normalizedName = String(fileName || "").toLowerCase();
  const normalizedMime = String(mimeType || "").toLowerCase();
  const extensionMimes = [
    [".pdf", ["application/pdf"]],
    [".png", ["image/png"]],
    [".jpg", ["image/jpeg"]],
    [".jpeg", ["image/jpeg"]],
    [".csv", ["text/csv", "text/plain"]],
    [".txt", ["text/plain"]],
    [".xlsx", ["application/zip"]],
    [".docx", ["application/zip"]],
    [".ods", ["application/zip"]],
    [".odt", ["application/zip"]],
    [".xls", ["application/vnd.ms-excel", "application/octet-stream"]],
    [".doc", ["application/msword", "application/octet-stream"]]
  ];
  const entry = extensionMimes.find(([extension]) => normalizedName.endsWith(extension));
  if (!entry) return false;
  const [, allowedDetectedMimes] = entry;
  if (!allowedDetectedMimes.includes(detectedMime)) return false;
  return !normalizedMime || allowedDetectedMimes.includes(normalizedMime) || normalizedMime === "application/octet-stream";
}

function hasDocumentEndMarker(content = Buffer.alloc(0), detectedMime = detectDocumentMime(content)) {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content || "");
  if (detectedMime === "application/pdf") {
    if (!/^%PDF-\d\.\d/.test(buffer.subarray(0, 16).toString("latin1"))) return false;
    return buffer.subarray(Math.max(0, buffer.length - 4096)).toString("latin1").includes("%%EOF");
  }
  if (detectedMime === "image/png") {
    const pngEnd = Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
    return buffer.length >= 20 && buffer.subarray(-pngEnd.length).equals(pngEnd);
  }
  if (detectedMime === "image/jpeg") {
    return buffer.length >= 4 && buffer[buffer.length - 2] === 0xff && buffer[buffer.length - 1] === 0xd9;
  }
  if (detectedMime === "application/zip") {
    return buffer.subarray(Math.max(0, buffer.length - 65_557)).indexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])) >= 0;
  }
  return true;
}

export function validateProcessDocumentUpload(documentKey = "", fileName = "", mimeType = "", content = Buffer.alloc(0)) {
  if (REQUIRED_DOCUMENT_KEYS.includes(documentKey) && !isPdfDocument(fileName, mimeType)) return false;
  return validateDocumentUpload(fileName, mimeType, content);
}

function isSafeUploadFileName(fileName = "") {
  const normalizedName = String(fileName || "");
  return Boolean(normalizedName.trim()) && !normalizedName.includes("..") && !/[\\/]/.test(normalizedName);
}

export function detectDocumentMime(content = Buffer.alloc(0)) {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content || "");
  if (buffer.length < 2) return "";
  if (buffer.subarray(0, 4).equals(Buffer.from("%PDF"))) return "application/pdf";
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.subarray(0, 2).toString("latin1") === "MZ") return "application/x-msdownload";
  if (buffer.subarray(0, 2).toString("latin1") === "PK") return "application/zip";
  if (isMostlyText(buffer)) return "text/plain";
  return "application/octet-stream";
}

function isMostlyText(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 2048));
  if (!sample.length) return false;
  let textBytes = 0;
  for (const byte of sample) {
    if (byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte <= 126) || byte >= 160) textBytes += 1;
  }
  return textBytes / sample.length > 0.9;
}

export function canAttachDocument(processo = {}, documentKey = "") {
  if (!processo || processo.inativo || ["Anulado", "Pago"].includes(processo.status) || !documentKey) return false;
  if (documentKey === "notaFiscal") {
    return ["Entrega parcial", "Entregue", "Aguardando envio para liquidacao", "Enviado para liquidacao", "Liquidado"].includes(processo.status);
  }
  return true;
}

export function canRemoveDocument(processo = {}, documentKey = "") {
  if (!canAttachDocument(processo, documentKey)) return false;
  if (REQUIRED_DOCUMENT_KEYS.includes(documentKey)
      && ["Enviado para liquidacao", "Liquidado", "Pago"].includes(processo.status)) {
    return false;
  }
  return true;
}

export function processHasRequiredDocuments(processo = {}) {
  const documentos = processo.documentos || {};
  return LIQUIDATION_DOCUMENT_KEYS.some((key) => Boolean(documentos[key]));
}

export function isMutationRequest(method = "") {
  return String(method).toUpperCase() !== "GET";
}

export function calculateElapsedDays(dateText, now = new Date(), timeZone = DEFAULT_BUSINESS_TIME_ZONE) {
  if (!dateText) return 0;
  const start = dateOnlyUtcValue(dateText);
  const current = dateOnlyUtcValue(dateKeyInTimeZone(now, timeZone));
  if (!Number.isFinite(start) || !Number.isFinite(current)) return 0;
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.max(0, Math.floor((current - start) / msPerDay));
}

export function deadlineBand(days) {
  if (days >= 31) return "critical";
  if (days >= 30) return "notice";
  if (days >= 21) return "high";
  if (days >= 14) return "medium";
  if (days >= 7) return "low";
  return "ok";
}

export function enrichProcess(processo, now = new Date(), timeZone = DEFAULT_BUSINESS_TIME_ZONE) {
  const dataReferenciaPrazo = processDeadlineDate(processo);
  const diasDecorridos = calculateElapsedDays(dataReferenciaPrazo, now, timeZone);
  const materiais = normalizeMaterials(processo);
  return {
    ...processo,
    dataReferenciaPrazo,
    materiais,
    diasDecorridos,
    faixaPrazo: deadlineBand(diasDecorridos),
    valorTotal: calculateMaterialsTotal(materiais)
  };
}

export function processDeadlineDate(processo = {}) {
  return processo.dataEnvioFornecedor || processo.dataEnvioEmpenho || "";
}

export function normalizeMaterials(processo = {}) {
  if (Array.isArray(processo.materiais) && processo.materiais.length) {
    return processo.materiais.map(normalizeMaterial).filter((material) => material.descricao);
  }

  if (processo.material || processo.valorUnitario || processo.quantidade) {
    return [normalizeMaterial({
      descricao: processo.material,
      valorUnitario: processo.valorUnitario,
      quantidade: processo.quantidade
    })].filter((material) => material.descricao);
  }

  return [];
}

export function calculateMaterialsTotal(materiais = []) {
  let totalCents = 0;
  for (const material of materiais) {
    const lineTotal = Number(material.valorUnitario || 0) * Number(material.quantidade || 0);
    if (!Number.isFinite(lineTotal)) return 0;
    const lineCents = Math.round((lineTotal + Number.EPSILON) * 100);
    if (!Number.isSafeInteger(lineCents) || !Number.isSafeInteger(totalCents + lineCents)) return 0;
    totalCents += lineCents;
  }
  return totalCents / 100;
}

export function summarizeMaterials(materiais = []) {
  const normalized = materiais.map(normalizeMaterial).filter((material) => material.descricao);
  if (!normalized.length) return "";
  if (normalized.length === 1) return normalized[0].descricao;
  return `${normalized[0].descricao} + ${normalized.length - 1} itens`;
}

export function isProcessOverdue(processo = {}) {
  return processo.diasDecorridos > 30
    && processo.status !== "Anulado"
    && !hasProcessReachedDelivery(processo);
}

export function createAuditEntry({ processoId, usuario, usuarioEmail, usuarioId, acao, detalhes, documento, alteracoes }) {
  return {
    id: crypto.randomUUID(),
    processoId,
    usuario,
    usuarioEmail: usuarioEmail || "",
    usuarioId: usuarioId || "",
    acao,
    detalhes,
    documento,
    alteracoes,
    criadoEm: new Date().toISOString()
  };
}

export function filterProcesses(processos, query = {}) {
  const termo = normalize(query.q || "");
  return processos
    .filter((processo) => !processo.inativo)
    .filter((processo) => {
      if (query.status && processo.status !== query.status) return false;
      const dataReferencia = processDeadlineDate(processo);
      if (query.ano && String(new Date(`${dataReferencia}T00:00:00`).getFullYear()) !== String(query.ano)) return false;
      if (!termo) return true;

      return [
        processo.numeroProcesso,
        processo.numeroEmpenho,
        processo.numeroNotaFiscal,
        processo.fornecedor,
        processo.material,
        processo.status,
        ...normalizeMaterials(processo).map((material) => material.descricao)
      ].some((value) => normalize(value).includes(termo));
    });
}

export function applyQuickFilter(processos, quickFilter) {
  if (!quickFilter) return processos;

  return processos.filter((processo) => {
    if (quickFilter === "Em atraso") return isProcessOverdue(processo);
    if (quickFilter === "Aguardando entrega") return isProcessAwaitingDelivery(processo);
    if (quickFilter === "Entrega parcial") return processo.status === "Entrega parcial";
    if (quickFilter === "Pendentes de liquidacao") return ["Entregue", "Aguardando envio para liquidacao"].includes(processo.status);
    if (quickFilter === "Liquidado") return processo.status === "Liquidado";
    if (quickFilter === "Pago") return processo.status === "Pago";
    if (quickFilter === "Anulado") return processo.status === "Anulado";
    if (quickFilter === "Mais de 30 dias") return isProcessOverdue(processo);
    return true;
  });
}

export function dashboardMetrics(processos, year) {
  const scoped = dashboardProcessesForYear(processos, year);
  const ativos = scoped.filter((processo) => processo.status !== "Anulado");
  const financialProcesses = processos.filter((processo) => !processo.inativo && processo.status !== "Anulado");
  const liquidated = financialProcesses.filter((processo) =>
    ["Liquidado", "Pago"].includes(processo.status)
      && dashboardDateMatchesYear(liquidationDate(processo), year));
  const paid = financialProcesses.filter((processo) =>
    processo.status === "Pago" && dashboardDateMatchesYear(processo.dataPagamento, year));

  return {
    processosAtivos: ativos.length,
    aguardandoEntrega: ativos.filter((processo) => isProcessAwaitingDelivery(processo)).length,
    atrasados: ativos.filter((processo) => isProcessOverdue(processo)).length,
    enviadosLiquidacao: ativos.filter((processo) => processo.status === "Enviado para liquidacao").length,
    pendentesLiquidacao: ativos.filter((processo) => ["Entregue", "Aguardando envio para liquidacao"].includes(processo.status)).length,
    valorEmpenhado: ativos.reduce((total, processo) => total + processo.valorTotal, 0),
    valorLiquidado: liquidated.reduce((total, processo) => total + processo.valorTotal, 0),
    valorPago: paid.reduce((total, processo) => total + processo.valorTotal, 0),
    porStatus: STATUS
      .map((status) => [status, scoped.filter((processo) => processo.status === status).length])
      .filter(([, count]) => count > 0)
  };
}

export function dashboardAvailableYears(processos = []) {
  return [...new Set(processos
    .filter((processo) => !processo.inativo)
    .flatMap((processo) => [
      processDeadlineDate(processo),
      liquidationDate(processo),
      processo.dataPagamento
    ])
    .map(dashboardDateYear)
    .filter(Boolean)
    .map(Number))]
    .sort((left, right) => right - left);
}

export function dashboardMonthlyExecution(processos, year = new Date().getFullYear()) {
  const months = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
  const rows = months.map((mes) => ({ mes, empenhado: 0, liquidado: 0, pago: 0 }));

  processos
    .filter((processo) => !processo.inativo && processo.status !== "Anulado")
    .forEach((processo) => {
      addMonthlyValue(rows, processDeadlineDate(processo), year, "empenhado", processo.valorTotal);

      if (["Liquidado", "Pago"].includes(processo.status)) {
        addMonthlyValue(rows, liquidationDate(processo), year, "liquidado", processo.valorTotal);
      }

      if (processo.status === "Pago") {
        addMonthlyValue(rows, processo.dataPagamento, year, "pago", processo.valorTotal);
      }
    });

  return rows;
}

export function dashboardStatusDistribution(processos, year = new Date().getFullYear()) {
  const scoped = processos
    .filter((processo) => !processo.inativo)
    .filter((processo) => dashboardDateMatchesYear(processDeadlineDate(processo), year));

  return STATUS
    .map((status) => ({
      status,
      quantidade: scoped.filter((processo) => processo.status === status).length
    }))
    .filter((item) => item.quantidade > 0);
}

function addMonthlyValue(rows, dateText, year, key, value) {
  if (!dateText) return;
  const date = String(dateText).slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!date || Number(date[1]) !== Number(year)) return;
  const monthIndex = Number(date[2]) - 1;
  if (monthIndex < 0 || monthIndex > 11) return;
  rows[monthIndex][key] += Number(value || 0);
}

function dashboardProcessesForYear(processos = [], year) {
  return processos
    .filter((processo) => !processo.inativo)
    .filter((processo) => dashboardDateMatchesYear(processDeadlineDate(processo), year));
}

function dashboardDateMatchesYear(value, year) {
  return !year || dashboardDateYear(value) === Number(year);
}

function dashboardDateYear(value) {
  const match = String(value || "").match(/^(\d{4})-\d{2}-\d{2}/);
  return match ? Number(match[1]) : 0;
}

function liquidationDate(processo = {}) {
  return processo.dataLiquidacao || processo.dataEnvioLiquidacao || "";
}

function normalize(value = "") {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

export function dateKeyInTimeZone(value = new Date(), timeZone = DEFAULT_BUSINESS_TIME_ZONE) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(date);
    const entries = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${entries.year}-${entries.month}-${entries.day}`;
  } catch {
    return "";
  }
}

function dateOnlyUtcValue(value = "") {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return Number.NaN;
  const timestamp = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const normalized = new Date(timestamp).toISOString().slice(0, 10);
  return normalized === String(value) ? timestamp : Number.NaN;
}

function normalizeMaterial(material = {}, index = 0) {
  const normalized = {
    descricao: String(material.descricao || "").trim(),
    valorUnitario: Number(material.valorUnitario || 0),
    quantidade: Number(material.quantidade || 0)
  };
  normalized.id = material.id ? String(material.id) : legacyMaterialId(material, index);
  return normalized;
}

function legacyMaterialId(material = {}, index = 0) {
  const source = `${index}|${material.descricao || ""}|${material.valorUnitario || 0}|${material.quantidade || 0}`;
  let hash = 2166136261;
  for (const character of source) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `legacy-material-${index}-${(hash >>> 0).toString(16)}`;
}
