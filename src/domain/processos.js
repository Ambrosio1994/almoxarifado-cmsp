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
  if (processo.criadoPorId) return Boolean(user.id) && processo.criadoPorId === user.id;
  return Boolean(processo.criadoPorEmail && user.email && processo.criadoPorEmail === user.email);
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

export function processHasRequiredDocuments(processo = {}) {
  const documentos = processo.documentos || {};
  return REQUIRED_DOCUMENT_KEYS.every((key) => Boolean(documentos[key]));
}

export function isPublicConsultation(method = "", pathname = "") {
  if (String(method).toUpperCase() !== "GET") return false;
  return [
    /^\/api\/meta$/,
    /^\/health$/,
    /^\/api\/dashboard$/,
    /^\/api\/dashboard\/execucao-mensal$/,
    /^\/api\/dashboard\/distribuicao-status$/,
    /^\/api\/dashboard\/charts$/,
    /^\/api\/processes$/,
    /^\/api\/processes\/export\/?$/
  ].some((pattern) => pattern.test(pathname));
}

export function mutationRequiresAuthenticatedUser(method = "") {
  return String(method).toUpperCase() !== "GET";
}

export function calculateElapsedDays(dateText, now = new Date()) {
  if (!dateText) return 0;
  const start = new Date(`${dateText}T00:00:00`);
  if (Number.isNaN(start.getTime())) return 0;
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.max(0, Math.floor((startOfDay(now) - startOfDay(start)) / msPerDay));
}

export function deadlineBand(days) {
  if (days >= 31) return "critical";
  if (days >= 30) return "notice";
  if (days >= 21) return "high";
  if (days >= 14) return "medium";
  if (days >= 7) return "low";
  return "ok";
}

export function enrichProcess(processo, now = new Date()) {
  const dataReferenciaPrazo = processDeadlineDate(processo);
  const diasDecorridos = calculateElapsedDays(dataReferenciaPrazo, now);
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
  return materiais.reduce((total, material) => (
    total + Number(material.valorUnitario || 0) * Number(material.quantidade || 0)
  ), 0);
}

export function summarizeMaterials(materiais = []) {
  const normalized = materiais.map(normalizeMaterial).filter((material) => material.descricao);
  if (!normalized.length) return "";
  if (normalized.length === 1) return normalized[0].descricao;
  return `${normalized[0].descricao} + ${normalized.length - 1} itens`;
}

export function isProcessOverdue(processo = {}) {
  return processo.diasDecorridos > 30 && !["Entregue", "Liquidado", "Pago", "Anulado"].includes(processo.status);
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
    if (quickFilter === "Aguardando entrega") return processo.status === "Aguardando entrega";
    if (quickFilter === "Entrega parcial") return processo.status === "Entrega parcial";
    if (quickFilter === "Pendentes de liquidacao") return ["Entregue", "Aguardando envio para liquidacao"].includes(processo.status);
    if (quickFilter === "Liquidado") return processo.status === "Liquidado";
    if (quickFilter === "Pago") return processo.status === "Pago";
    if (quickFilter === "Anulado") return processo.status === "Anulado";
    if (quickFilter === "Mais de 30 dias") return isProcessOverdue(processo);
    return true;
  });
}

export function dashboardMetrics(processos) {
  const ativos = processos.filter((processo) => !processo.inativo);
  const sumByStatus = (status) => ativos
    .filter((processo) => processo.status === status)
    .reduce((total, processo) => total + processo.valorTotal, 0);

  return {
    processosAtivos: ativos.length,
    aguardandoEntrega: ativos.filter((processo) => processo.status === "Aguardando entrega").length,
    atrasados: ativos.filter((processo) => isProcessOverdue(processo)).length,
    enviadosLiquidacao: ativos.filter((processo) => processo.status === "Enviado para liquidacao").length,
    valorEmpenhado: ativos.reduce((total, processo) => total + processo.valorTotal, 0),
    valorLiquidado: sumByStatus("Liquidado"),
    valorPago: sumByStatus("Pago"),
    porStatus: STATUS
      .map((status) => [status, ativos.filter((processo) => processo.status === status).length])
      .filter(([, count]) => count > 0)
  };
}

export function dashboardAvailableYears(processos = []) {
  return [...new Set(processos
    .filter((processo) => !processo.inativo)
    .map((processo) => String(processDeadlineDate(processo) || "").match(/^(\d{4})-\d{2}-\d{2}$/)?.[1])
    .filter(Boolean)
    .map(Number))]
    .sort((left, right) => right - left);
}

export function dashboardMonthlyExecution(processos, year = new Date().getFullYear()) {
  const months = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
  const rows = months.map((mes) => ({ mes, empenhado: 0, liquidado: 0, pago: 0 }));

  processos
    .filter((processo) => !processo.inativo)
    .forEach((processo) => {
      addMonthlyValue(rows, processDeadlineDate(processo), year, "empenhado", processo.valorTotal);

      if (["Liquidado", "Pago"].includes(processo.status)) {
        addMonthlyValue(rows, processo.dataLiquidacao || processo.dataEnvioLiquidacao || processo.atualizadoEm, year, "liquidado", processo.valorTotal);
      }

      if (processo.status === "Pago") {
        addMonthlyValue(rows, processo.dataPagamento || processo.atualizadoEm, year, "pago", processo.valorTotal);
      }
    });

  return rows;
}

export function dashboardStatusDistribution(processos, year = new Date().getFullYear()) {
  const totals = { Empenhado: 0, Liquidado: 0, Pago: 0 };

  processos
    .filter((processo) => !processo.inativo)
    .filter((processo) => String(new Date(`${processDeadlineDate(processo)}T00:00:00`).getFullYear()) === String(year))
    .forEach((processo) => {
      if (processo.status === "Pago") totals.Pago += 1;
      else if (processo.status === "Liquidado") totals.Liquidado += 1;
      else totals.Empenhado += 1;
    });

  return Object.entries(totals)
    .map(([status, quantidade]) => ({ status, quantidade }))
    .filter((item) => item.quantidade > 0);
}

function addMonthlyValue(rows, dateText, year, key, value) {
  if (!dateText) return;
  const date = new Date(`${String(dateText).slice(0, 10)}T00:00:00`);
  if (Number.isNaN(date.getTime()) || String(date.getFullYear()) !== String(year)) return;
  rows[date.getMonth()][key] += Number(value || 0);
}

function normalize(value = "") {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function normalizeMaterial(material = {}) {
  return {
    descricao: String(material.descricao || "").trim(),
    valorUnitario: Number(material.valorUnitario || 0),
    quantidade: Number(material.quantidade || 0)
  };
}
