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
