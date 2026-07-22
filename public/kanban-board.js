const DAY_MS = 24 * 60 * 60 * 1000;

export function normalizeBoardText(value = "") {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

export function safeBoardStatusId(status = "") {
  const normalized = normalizeBoardText(status)
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || "sem_status";
}

export function groupProcessesByStatus(processes = [], statuses = []) {
  const groups = new Map(statuses.map((status) => [status, []]));
  for (const process of processes) {
    if (groups.has(process.status)) groups.get(process.status).push(process);
  }
  return groups;
}

export function filterBoardProcesses(processes = [], filters = {}) {
  const search = normalizeBoardText(filters.search);
  return processes.filter((process) => {
    if (process.inativo) return false;
    if (filters.status && process.status !== filters.status) return false;
    if (filters.supplier && process.fornecedor !== filters.supplier) return false;
    if (filters.responsible && boardResponsible(process) !== filters.responsible) return false;
    if (filters.deadline && getProcessDeadlineState(process) !== filters.deadline) return false;
    if (!search) return true;
    return boardSearchValues(process).some((value) => normalizeBoardText(value).includes(search));
  });
}

export function boardFilterOptions(processes = []) {
  return {
    suppliers: uniqueSorted(processes.map((process) => process.fornecedor)),
    responsibles: uniqueSorted(processes.map(boardResponsible))
  };
}

export function allowedBoardTransitions(status = "", transitions = {}, activeStatuses = []) {
  const configured = transitions?.[status];
  const targets = Array.isArray(configured) ? configured : (configured ? [configured] : []);
  const active = new Set(activeStatuses);
  return targets.filter((target, index) => target && active.has(target) && targets.indexOf(target) === index);
}

export function getProcessDeadlineState(process = {}) {
  const reference = process.dataReferenciaPrazo || process.dataEnvioFornecedor || process.dataEnvioEmpenho || "";
  if (!reference) return "none";
  if (["Entregue", "Aguardando envio para liquidacao", "Enviado para liquidacao", "Liquidado", "Pago", "Anulado"].includes(process.status)) {
    return "normal";
  }
  const days = Number(process.diasDecorridos || 0);
  if (days > 30) return "overdue";
  if (days === 30) return "today";
  if (days >= 23) return "upcoming";
  return "normal";
}

export function boardDeadlineDate(process = {}) {
  const reference = process.dataReferenciaPrazo || process.dataEnvioFornecedor || process.dataEnvioEmpenho || "";
  const match = String(reference).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return "";
  const timestamp = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) + (30 * DAY_MS);
  return new Date(timestamp).toISOString().slice(0, 10);
}

export function countProcessDocuments(process = {}) {
  return Object.values(process.documentos || {}).reduce((total, value) => {
    if (Array.isArray(value)) return total + value.filter(Boolean).length;
    return total + (value ? 1 : 0);
  }, 0);
}

export function processObservationCount(process = {}) {
  if (Array.isArray(process.observacoes)) return process.observacoes.length;
  return Number(process.observationCount || process.observacoesCount || 0) || 0;
}

export function boardResponsible(process = {}) {
  return String(process.responsavel || process.criadoPor || process.criadoPorEmail || "").trim();
}

function boardSearchValues(process = {}) {
  return [
    process.numeroProcesso,
    process.numeroEmpenho,
    process.numeroNotaFiscal,
    process.fornecedor,
    boardResponsible(process),
    process.observacao,
    ...(process.materiais || []).map((material) => material.descricao),
    ...(Array.isArray(process.observacoes) ? process.observacoes.map((item) => item?.conteudo || item) : [])
  ];
}

function uniqueSorted(values = []) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right, "pt-BR", { sensitivity: "base" }));
}
