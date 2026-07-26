export const SECTION_PATHS = Object.freeze({
  dashboard: "/graficos",
  processes: "/empenhos",
  board: "/quadro",
  suppliers: "/fornecedores",
  settings: "/configuracoes",
  audit: "/auditoria",
  users: "/usuarios"
});

export const DETAIL_TAB_PATHS = Object.freeze({
  general: "dados-gerais",
  documents: "documentos",
  timeline: "linha-do-tempo",
  deliveries: "entregas",
  observations: "observacoes",
  emails: "emails"
});

const SECTIONS_BY_PATH = new Map(
  Object.entries(SECTION_PATHS).map(([section, path]) => [path, section])
);
const DETAIL_TABS_BY_PATH = new Map(
  Object.entries(DETAIL_TAB_PATHS).map(([tab, path]) => [path, tab])
);

export function sectionPath(section) {
  return SECTION_PATHS[section] || SECTION_PATHS.dashboard;
}

export function processPath(processId, tab = "general") {
  const normalizedId = normalizeProcessId(processId);
  if (!normalizedId) return SECTION_PATHS.processes;
  const tabPath = DETAIL_TAB_PATHS[tab] || DETAIL_TAB_PATHS.general;
  return `${SECTION_PATHS.processes}/${encodeURIComponent(normalizedId)}/${tabPath}`;
}

export function parseAppRoute(pathname = "/") {
  const normalizedPath = normalizePathname(pathname);
  if (normalizedPath === "/") {
    return { kind: "root", canonicalPath: "/" };
  }

  const section = SECTIONS_BY_PATH.get(normalizedPath);
  if (section) {
    return { kind: "section", section, canonicalPath: sectionPath(section) };
  }

  const segments = normalizedPath.split("/").filter(Boolean);
  if (segments[0] !== "empenhos" || segments.length < 2 || segments.length > 3) {
    return { kind: "not-found", canonicalPath: normalizedPath };
  }

  let processId = "";
  try {
    processId = normalizeProcessId(decodeURIComponent(segments[1]));
  } catch {
    return { kind: "not-found", canonicalPath: normalizedPath };
  }
  if (!processId) return { kind: "not-found", canonicalPath: normalizedPath };

  const tab = segments.length === 2 ? "general" : DETAIL_TABS_BY_PATH.get(segments[2]);
  if (!tab) return { kind: "not-found", canonicalPath: normalizedPath };

  return {
    kind: "process",
    section: "processes",
    processId,
    tab,
    canonicalPath: processPath(processId, tab)
  };
}

export function isAppRoutePath(pathname = "/") {
  return parseAppRoute(pathname).kind !== "not-found";
}

export function isSpaNavigationPath(pathname = "/") {
  if (isAppRoutePath(pathname)) return true;
  const normalizedPath = normalizePathname(pathname);
  const lastSegment = normalizedPath.split("/").filter(Boolean).at(-1) || "";
  return Boolean(lastSegment) && !lastSegment.includes(".");
}

function normalizePathname(pathname) {
  const raw = String(pathname || "/").split(/[?#]/, 1)[0] || "/";
  const withLeadingSlash = raw.startsWith("/") ? raw : `/${raw}`;
  if (withLeadingSlash === "/") return "/";
  return withLeadingSlash.replace(/\/+$/, "") || "/";
}

function normalizeProcessId(value) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.includes("/") || /[\u0000-\u001f\u007f]/.test(normalized)) return "";
  return normalized;
}
