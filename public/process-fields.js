const COMMITMENT_NUMBER_PATTERN = /^(\d{4})NE000([1-9]\d*)$/;

export function normalizeCommitmentSequence(value = "") {
  const digits = String(value).replace(/\D/g, "").replace(/^0+/, "");
  return digits === "" ? "" : digits;
}

export function formatCommitmentNumber(year, sequence) {
  const normalizedYear = String(year || "").trim();
  const normalizedSequence = normalizeCommitmentSequence(sequence);
  if (!/^\d{4}$/.test(normalizedYear) || !normalizedSequence) return "";
  return `${normalizedYear}NE000${normalizedSequence}`;
}

export function parseCommitmentNumber(value = "") {
  const match = String(value).trim().toUpperCase().match(COMMITMENT_NUMBER_PATTERN);
  return match ? { year: match[1], sequence: match[2] } : null;
}

export function isStandardCommitmentNumber(value = "") {
  return COMMITMENT_NUMBER_PATTERN.test(String(value).trim().toUpperCase());
}

export function parseCurrencyInput(value = "", maximumFractionDigits = 4) {
  const raw = String(value ?? "").trim().replace(/\s|R\$/gi, "");
  if (!raw) return 0;
  const normalized = raw.includes(",")
    ? raw.replace(/\./g, "").replace(",", ".")
    : (/^\d{1,3}(?:\.\d{3})+$/.test(raw) ? raw.replace(/\./g, "") : raw);
  const decimalPattern = new RegExp(`^\\d+(?:\\.\\d{1,${maximumFractionDigits}})?$`);
  if (!decimalPattern.test(normalized)) return Number.NaN;
  const amount = Number(normalized);
  return Number.isFinite(amount) && amount >= 0 ? amount : Number.NaN;
}

export function formatCurrencyInput(value = "") {
  const amount = typeof value === "number" ? value : parseCurrencyInput(value, 2);
  if (!Number.isFinite(amount)) return "";
  return amount.toLocaleString("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

export function formatUnitPriceInput(value = "") {
  const amount = typeof value === "number" ? value : parseCurrencyInput(value, 4);
  if (!Number.isFinite(amount)) return "";
  return amount.toLocaleString("pt-BR", {
    minimumFractionDigits: 4,
    maximumFractionDigits: 4
  });
}
