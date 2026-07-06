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

export function canAttachDocument(processo = {}, documentKey = "") {
  return Boolean(processo && !processo.inativo && processo.status !== "Anulado" && documentKey);
}

export function processHasRequiredDocuments(processo = {}) {
  const documentos = processo.documentos || {};
  return REQUIRED_DOCUMENT_KEYS.every((key) => Boolean(documentos[key]));
}

export function isPublicConsultation(method = "", pathname = "") {
  if (String(method).toUpperCase() !== "GET") return false;
  return [
    /^\/api\/meta$/,
    /^\/api\/dashboard$/,
    /^\/api\/dashboard\/execucao-mensal$/,
    /^\/api\/dashboard\/distribuicao-status$/,
    /^\/api\/settings$/,
    /^\/api\/emails\/status$/,
    /^\/api\/processes$/,
    /^\/api\/processes\/export\/?$/,
    /^\/api\/processes\/download\/?$/,
    /^\/api\/processes\/[^/]+\/observations$/,
    /^\/api\/processes\/[^/]+\/download$/,
    /^\/api\/suppliers$/,
    /^\/api\/audit$/
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

export function createAuditEntry({ processoId, usuario, acao, detalhes, documento }) {
  return {
    id: crypto.randomUUID(),
    processoId,
    usuario,
    acao,
    detalhes,
    documento,
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
