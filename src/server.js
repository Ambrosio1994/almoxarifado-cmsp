import { createServer } from "node:http";
import { connect as connectTls } from "node:tls";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, normalize, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import {
  applyQuickFilter,
  canAttachDocument,
  canCancelProcess,
  canEditProcess,
  canRemoveDocument,
  createAuditEntry,
  dateKeyInTimeZone,
  dashboardAvailableYears,
  dashboardMetrics,
  dashboardMonthlyExecution,
  dashboardStatusDistribution,
  enrichProcess as enrichDomainProcess,
  filterProcesses,
  hasProcessReachedDelivery,
  isPdfDocument,
  isMutationRequest,
  isValidStatusRollback,
  isValidStatusTransition,
  LIQUIDATION_DOCUMENT_KEYS,
  processDeadlineDate,
  processHasRequiredDocuments,
  processObjectType,
  processUsesDelivery,
  QUICK_FILTERS,
  PROCESS_TRANSITIONS,
  PROCESS_OBJECT_TYPES,
  REQUIRED_DOCUMENT_KEYS,
  rollbackProcessStatus,
  SERVICE_TRACKING_MODES,
  SERVICE_TRANSITIONS,
  serviceProgressTotal,
  summarizeMaterials,
  STATUS,
  validateDocumentUpload,
  validateProcessDocumentUpload
} from "./domain/processos.js";
import {
  detectStoreBackend,
  readAuditStore,
  readProcessById,
  readProcessesSnapshot,
  readProcessesPage,
  readProcessesStore,
  readSettingsStore,
  readStore,
  readStoreRevision,
  readSuppliersStore,
  readUserByEmail,
  writeProcessRecords as persistProcessRecords,
  writeStore as persistStore
} from "./storage.js";
import { isSpaNavigationPath } from "../public/app-routes.js";
import {
  cleanupExpiredSessions,
  createSession as createSessionRecord,
  resolveSessionUser,
  revokeSession,
  revokeUserSessions
} from "./repositories/sessions.js";
import { claimEmailDispatch, completeEmailDispatch, failEmailDispatch } from "./repositories/email-dispatches.js";
import { closePool, databaseConfigured, query } from "./db/postgres.js";
import { cleanupRateLimits, clearRateLimit, consumeRateLimitAttempt } from "./repositories/rate-limits.js";
import { listSecurityEvents, recordSecurityEvent } from "./repositories/security-audit.js";
import {
  configuredUploadStorageBackend,
  deleteUploadFile,
  ensureUploadStorageReady,
  getUploadBuffer,
  getUploadMetadata,
  inspectUploadIntegrity,
  putUploadFile,
  refreshUploadIntegrityInBackground,
  streamUploadTo,
  uploadIntegrityState,
  uploadStorageReadinessState
} from "./uploads/upload-storage.js";
import {
  hashPassword,
  isValidPassword,
  MAX_PASSWORD_LENGTH,
  PASSWORD_POLICY_MESSAGE,
  verifyPassword
} from "./security/password-policy.js";
import {
  openRegularFileNoFollow,
  UnsafeFilePathError
} from "./security/private-files.js";

const processStartedAt = performance.now();

loadLocalEnv();

const PORT = Number(process.env.PORT || 3000);
const APP_VERSION = resolvePublicAppVersion(process.env);
const ROOT = fileURLToPath(new URL("../public/", import.meta.url));
const FAVICON_FILE = fileURLToPath(new URL("../new_favicon.png", import.meta.url));
const UPLOAD_ROOT = process.env.UPLOAD_STORAGE_ROOT
  ? resolveUploadRoot(process.env.UPLOAD_STORAGE_ROOT)
  : fileURLToPath(new URL("../uploads/", import.meta.url));
const UPLOAD_STORAGE_BACKEND = (process.env.UPLOAD_STORAGE_BACKEND || "local").trim().toLowerCase();
const ADMIN_EMAILS = new Set(parseList(process.env.ADMIN_EMAILS));
const LOCAL_ADMIN_EMAIL = normalizeEmail(process.env.LOCAL_ADMIN_EMAIL);
const LOCAL_ADMIN_PASSWORD = process.env.LOCAL_ADMIN_PASSWORD || "";
const SMTP_HOST = process.env.SMTP_HOST || "smtp.gmail.com";
const SMTP_PORT = positiveRuntimeInteger(process.env.SMTP_PORT, 465);
const EMAIL_TEST_RECIPIENT = normalizeEmail(process.env.EMAIL_TEST_RECIPIENT || "");
const EMAIL_CONFIGURATION = resolveEmailConfiguration(process.env);
const SMTP_AUTH_USER = EMAIL_CONFIGURATION.authUser;
const SMTP_AUTH_PASSWORD = EMAIL_CONFIGURATION.authPassword;
const EMAIL_FROM_ADDRESS = EMAIL_CONFIGURATION.fromAddress;
const EMAIL_FROM_NAME = process.env.EMAIL_FROM_NAME || "Almoxarifado";
const EMAIL_CHECK_INTERVAL_MS = positiveRuntimeInteger(process.env.EMAIL_CHECK_INTERVAL_MS, 60 * 60 * 1000);
const APP_TIME_ZONE = process.env.APP_TIME_ZONE || "America/Sao_Paulo";
const EMAIL_SCHEDULER_START_DELAY_MS = 10_000;
const EMAIL_SCHEDULER_GRACE_PERIOD_MS = Math.max(60_000, EMAIL_SCHEDULER_START_DELAY_MS * 2);
const EMAIL_SCHEDULER_STALE_AFTER_MS = EMAIL_CHECK_INTERVAL_MS + EMAIL_SCHEDULER_GRACE_PERIOD_MS;
const EMAIL_SCHEDULER_PERSISTENT_ERROR_COUNT = 3;
const SESSION_TIMEOUT_MS = positiveRuntimeInteger(process.env.SESSION_TIMEOUT_MS, 30 * 60 * 1000);
const SESSION_COOKIE_MAX_AGE_MS = Math.max(
  SESSION_TIMEOUT_MS,
  positiveRuntimeInteger(process.env.SESSION_COOKIE_MAX_AGE_MS, 7 * 24 * 60 * 60 * 1000)
);
const LOGIN_RATE_LIMIT_WINDOW_MS = positiveRuntimeInteger(process.env.LOGIN_RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000);
const LOGIN_RATE_LIMIT_MAX = positiveRuntimeInteger(process.env.LOGIN_RATE_LIMIT_MAX, 5);
const TRUST_PROXY = process.env.TRUST_PROXY === "true";
const MAX_JSON_BODY_BYTES = positiveRuntimeInteger(process.env.MAX_JSON_BODY_BYTES, 24 * 1024 * 1024);
const AUTH_MAX_BODY_BYTES = Math.min(
  MAX_JSON_BODY_BYTES,
  positiveRuntimeInteger(process.env.AUTH_MAX_BODY_BYTES, 4 * 1024)
);
const PROFILE_PHOTO_MAX_BYTES = 384 * 1024;
const PROFILE_PHOTO_MAX_BODY_BYTES = Math.min(
  MAX_JSON_BODY_BYTES,
  Math.ceil(PROFILE_PHOTO_MAX_BYTES * 4 / 3) + 2 * 1024
);
const ADMIN_MAX_BODY_BYTES = Math.min(
  MAX_JSON_BODY_BYTES,
  positiveRuntimeInteger(process.env.ADMIN_MAX_BODY_BYTES, 64 * 1024)
);
const LOGIN_SCRYPT_CONCURRENCY = positiveRuntimeInteger(process.env.LOGIN_SCRYPT_CONCURRENCY, 4);
const LOGIN_SCRYPT_MAX_QUEUE = positiveRuntimeInteger(process.env.LOGIN_SCRYPT_MAX_QUEUE, 16);
const DASHBOARD_CACHE_TTL_MS = positiveRuntimeInteger(process.env.DASHBOARD_CACHE_TTL_MS, 5_000);
const MAX_UPLOAD_BYTES = positiveRuntimeInteger(process.env.MAX_UPLOAD_BYTES, 15 * 1024 * 1024);
const MAX_PROCESS_UPLOAD_BYTES = positiveRuntimeInteger(process.env.MAX_PROCESS_UPLOAD_BYTES, 75 * 1024 * 1024);
const MAX_TEMPLATE_UPLOAD_BYTES = positiveRuntimeInteger(process.env.MAX_TEMPLATE_UPLOAD_BYTES, 50 * 1024 * 1024);
const MAX_EMAIL_ATTACHMENT_BYTES = positiveRuntimeInteger(process.env.MAX_EMAIL_ATTACHMENT_BYTES, 15 * 1024 * 1024);
const MAX_PROCESS_DOCUMENTS = positiveRuntimeInteger(process.env.MAX_PROCESS_DOCUMENTS, 50);
const MAX_PROCESS_MATERIALS = positiveRuntimeInteger(process.env.MAX_PROCESS_MATERIALS, 200);
const MAX_SERVICE_EXECUTIONS = positiveRuntimeInteger(process.env.MAX_SERVICE_EXECUTIONS, 500);
const MAX_MATERIAL_LINE_CENTS = Number.MAX_SAFE_INTEGER;
const MAX_TEMPLATE_ATTACHMENTS = positiveRuntimeInteger(process.env.MAX_TEMPLATE_ATTACHMENTS, 20);
const MAX_UPLOAD_FILENAME_LENGTH = 255;
const MAX_UPLOAD_MIME_LENGTH = 100;
const MAX_COMPLEMENT_TITLE_LENGTH = 150;
const MAX_COMPLEMENT_DESCRIPTION_LENGTH = 1_000;
const ALLOWED_STORED_DOCUMENT_MIMES = new Set([
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
]);
const MAX_COMPILED_DOWNLOAD_BYTES = positiveRuntimeInteger(process.env.MAX_COMPILED_DOWNLOAD_BYTES, MAX_PROCESS_UPLOAD_BYTES);
const MAX_CONCURRENT_COMPILED_DOWNLOADS = positiveRuntimeInteger(
  process.env.MAX_COMPILED_DOWNLOADS || process.env.MAX_CONCURRENT_COMPILED_DOWNLOADS,
  2
);
const PDF_COMMAND_TIMEOUT_MS = positiveRuntimeInteger(process.env.PDF_COMMAND_TIMEOUT_MS, 10_000);
const SMTP_CONNECT_TIMEOUT_MS = positiveRuntimeInteger(process.env.SMTP_CONNECT_TIMEOUT_MS, 10_000);
const SMTP_COMMAND_TIMEOUT_MS = positiveRuntimeInteger(process.env.SMTP_COMMAND_TIMEOUT_MS, 15_000);
let emailSchedulerRunning = false;
let emailSchedulerTimeout;
let emailSchedulerInterval;
let emailSchedulerPromise;
const emailSchedulerState = {
  startedAt: null,
  lastRunStartedAt: null,
  lastSuccessAt: null,
  lastErrorAt: null,
  consecutiveErrors: 0
};
let maintenanceInterval;
let localAdminBootstrapped = false;
let activeCompiledDownloads = 0;
let firstRequestCompletedLogged = false;
const loginScryptLimiter = createWorkLimiter(LOGIN_SCRYPT_CONCURRENCY, LOGIN_SCRYPT_MAX_QUEUE);
const dashboardCache = {
  generation: 0,
  revision: null,
  expiresAt: 0,
  value: null,
  pending: null
};
const uploadReferenceCache = {
  generation: 0,
  revision: null,
  references: null,
  pending: null
};

const DEFAULT_SETTINGS = {
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
  responsaveis: []
};

function enrichProcess(processo, now = new Date()) {
  return enrichDomainProcess(processo, now, APP_TIME_ZONE);
}

function parseProcessesPagination(searchParams) {
  const parsePositiveInteger = (name, fallback) => {
    const raw = searchParams.get(name);
    if (raw === null || raw === "") return { value: fallback };
    if (!/^\d+$/.test(raw)) return { error: `O parametro ${name} deve ser um inteiro positivo.` };
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1) return { error: `O parametro ${name} deve ser um inteiro positivo.` };
    return { value };
  };
  const page = parsePositiveInteger("page", 1);
  if (page.error) return page;
  const limit = parsePositiveInteger("limit", 25);
  if (limit.error) return limit;
  return { page: page.value, limit: Math.min(limit.value, 100) };
}

export function createWorkLimiter(maxConcurrency = 1, maxQueue = 1) {
  const concurrency = Math.max(1, Math.floor(Number(maxConcurrency) || 1));
  const queueLimit = Math.max(0, Math.floor(Number(maxQueue) || 0));
  const queue = [];
  let active = 0;

  function drain() {
    while (active < concurrency && queue.length) {
      const entry = queue.shift();
      active += 1;
      Promise.resolve()
        .then(entry.task)
        .then(entry.resolve, entry.reject)
        .finally(() => {
          active -= 1;
          drain();
        });
    }
  }

  return {
    run(task) {
      if (typeof task !== "function") return Promise.reject(new TypeError("A tarefa deve ser uma funcao."));
      if (active >= concurrency && queue.length >= queueLimit) {
        const error = new Error("Fila de autenticacao temporariamente cheia.");
        error.code = "WORK_QUEUE_FULL";
        return Promise.reject(error);
      }
      return new Promise((resolve, reject) => {
        queue.push({ task, resolve, reject });
        drain();
      });
    },
    stats() {
      return { active, queued: queue.length, concurrency, queueLimit };
    }
  };
}

async function writeStore(store, securityEvents = []) {
  await persistStore(store, { securityEvents });
  invalidateDashboardCache();
  invalidateUploadReferenceCache();
}

async function writeChangedProcesses(store, processIds, auditIds = []) {
  await persistProcessRecords(store, { processIds, auditIds });
  invalidateDashboardCache();
  invalidateUploadReferenceCache();
}

function transactionalSecurityEvent(eventType, event = {}) {
  return { eventType, ...event };
}

export function invalidateDashboardCache() {
  dashboardCache.generation += 1;
  dashboardCache.revision = null;
  dashboardCache.expiresAt = 0;
  dashboardCache.value = null;
  dashboardCache.pending = null;
}

function invalidateUploadReferenceCache() {
  uploadReferenceCache.generation += 1;
  uploadReferenceCache.revision = null;
  uploadReferenceCache.references = null;
  uploadReferenceCache.pending = null;
}

async function readDashboardSnapshot() {
  const revision = await readStoreRevision();
  const now = Date.now();
  if (dashboardCache.value && dashboardCache.revision === revision && dashboardCache.expiresAt > now) {
    return dashboardCache.value;
  }
  if (dashboardCache.pending?.revision === revision) return dashboardCache.pending.promise;

  const generation = dashboardCache.generation;
  const promise = readProcessesSnapshot().then((snapshot) => {
    const processos = snapshot.processos.map((processo) => enrichProcess(processo));
    const value = {
      processos,
      anos: dashboardAvailableYears(processos),
      aggregates: new Map()
    };
    if (dashboardCache.generation === generation) {
      dashboardCache.revision = snapshot.revision;
      dashboardCache.expiresAt = Date.now() + DASHBOARD_CACHE_TTL_MS;
      dashboardCache.value = value;
    }
    return value;
  });
  const pending = { revision, promise };
  dashboardCache.pending = pending;
  try {
    return await promise;
  } finally {
    if (dashboardCache.pending === pending) dashboardCache.pending = null;
  }
}

function dashboardSnapshotForYear(snapshot, year) {
  const cacheKey = String(year);
  const cached = snapshot.aggregates?.get(cacheKey);
  if (cached) return cached;
  const value = {
    metrics: dashboardMetrics(snapshot.processos, year),
    charts: {
      execucaoMensal: dashboardMonthlyExecution(snapshot.processos, year),
      distribuicaoStatus: dashboardStatusDistribution(snapshot.processos, year)
    }
  };
  snapshot.aggregates?.set(cacheKey, value);
  return value;
}

function positiveAuthVersion(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
}

function nextAuthVersion(value) {
  const current = positiveAuthVersion(value);
  if (current >= Number.MAX_SAFE_INTEGER) throw new RangeError("Versao de autenticacao esgotada.");
  return current + 1;
}

async function revokeUserSessionsBestEffort(userId, reason) {
  try {
    await revokeUserSessions(userId);
  } catch (error) {
    logError("session_revocation_failed", { userId, reason, message: error.message });
  }
}

export async function requestHandler(req, res) {
  const startedAt = Date.now();
  const requestId = randomBytes(8).toString("hex");
  const requestPathname = sanitizedRequestPath(req);
  try {
    applySecurityHeaders(res);
    res.setHeader("x-request-id", requestId);
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (["/health", "/health/live", "/health/ready"].includes(url.pathname)) {
      await handleHealth(res, url.pathname);
      return;
    }

    if (!applicationStartupComplete) {
      sendJson(res, 503, { error: "Aplicacao ainda esta inicializando o armazenamento de uploads." });
      return;
    }

    if (url.pathname.startsWith("/auth/")) {
      await handleAuth(req, res, url);
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }

    if (url.pathname.startsWith("/uploads/")) {
      await serveUpload(req, res, url.pathname);
      return;
    }

    if (["/favicon.svg", "/favicon.ico", "/my-fav.webp", "/new_favicon.png"].includes(url.pathname)) {
      await serveFavicon(req, res);
      return;
    }

    await serveStatic(req, res, url.pathname);
  } catch (error) {
    logError("request_error", { requestId, method: req.method, path: requestPathname, message: error.message, stack: error.stack });
    sendJson(res, error.statusCode || 500, errorResponsePayload(error));
  } finally {
    logFirstRequestCompleted({
      method: req.method,
      path: requestPathname,
      statusCode: res.statusCode,
      durationMs: Date.now() - startedAt
    });
    if (req.url !== "/health/live") {
      logInfo("request_completed", {
        requestId,
        method: req.method,
        path: requestPathname,
        statusCode: res.statusCode,
        durationMs: Date.now() - startedAt
      });
    }
  }
}

function sanitizedRequestPath(req = {}) {
  try {
    return new URL(String(req.url || "/"), `http://${req.headers?.host || "localhost"}`).pathname;
  } catch {
    return String(req.url || "/").split(/[?#]/, 1)[0] || "/";
  }
}

function decodePathSegment(value) {
  try {
    return decodeURIComponent(String(value || ""));
  } catch {
    return null;
  }
}

const server = createServer(requestHandler);
let applicationStartupComplete = !isMainModule();

if (isMainModule()) {
  try {
    await startApplication();
  } catch (error) {
    logStartupFailure(error);
    process.exitCode = 1;
    await closeServerAfterStartupFailure().catch((closeError) => logError("server_close_failed", { message: safeStartupErrorMessage(closeError) }));
    await closePool().catch((closeError) => logError("database_close_failed", { message: safeStartupErrorMessage(closeError) }));
  }
}

async function startApplication() {
  const uploadStorageCheckOnly = process.argv.includes("--check-upload-storage");
  logStartupStageCompleted("configuration_loaded", processStartedAt, {
    databaseConfigured: databaseConfigured(),
    uploadStorageCheckOnly
  });
  const storeBackend = await measureStartupStage(
    "storage_validation",
    () => detectStoreBackend(),
    (backend) => ({
      storageBackend: backend,
      databaseConfigured: backend === "postgres"
    })
  );
  if (process.env.NODE_ENV === "production" && storeBackend !== "postgres") {
    throw new Error("A aplicacao exige PostgreSQL migrado em producao.");
  }
  if (!uploadStorageCheckOnly) {
    await measureStartupStage("http_listener", () => listenForStartup(), () => ({ port: PORT }));
    for (const signal of ["SIGTERM", "SIGINT"]) {
      process.once(signal, () => gracefulShutdown(signal));
    }
  }
  try {
    await measureStartupStage(
      "upload_storage_ready",
      () => ensureUploadStorageReady({
        backend: UPLOAD_STORAGE_BACKEND,
        root: UPLOAD_ROOT,
        onEvent: logInfo
      }),
      () => ({ uploadBackend: configuredUploadStorageBackend({ backend: UPLOAD_STORAGE_BACKEND }) })
    );
  } catch (error) {
    logError("upload_storage_startup_failed", {
      backend: UPLOAD_STORAGE_BACKEND,
      stage: error?.stage || "unknown",
      message: safeStartupErrorMessage(error),
      code: error?.code || error?.response?.status || null,
      reason: error?.reason || null
    });
    process.exitCode = 1;
    await closeServerAfterStartupFailure();
    await closePool().catch((closeError) => logError("database_close_failed", { message: closeError.message }));
    return;
  }
  if (process.env.NODE_ENV === "production") {
    let uploadIntegrity;
    try {
      uploadIntegrity = await measureStartupStage(
        "upload_integrity_validation",
        () => inspectUploadIntegrity({
          backend: UPLOAD_STORAGE_BACKEND,
          root: UPLOAD_ROOT,
          force: true
        }),
        (result) => ({
          uploadBackend: configuredUploadStorageBackend({ backend: UPLOAD_STORAGE_BACKEND }),
          integrityOk: Boolean(result?.ok)
        })
      );
    } catch (error) {
      logError("upload_storage_startup_failed", {
        backend: UPLOAD_STORAGE_BACKEND,
        stage: "integrity_validation",
        message: safeStartupErrorMessage(error),
        code: error?.code || error?.response?.status || null,
        reason: error?.reason || null
      });
      process.exitCode = 1;
      await closeServerAfterStartupFailure();
      await closePool().catch((closeError) => logError("database_close_failed", { message: closeError.message }));
      return;
    }
    if (!uploadIntegrity.ok) {
      logError("upload_storage_incomplete", uploadIntegrity);
    }
    if (uploadStorageCheckOnly) {
      console.log(JSON.stringify({ event: "upload_storage_check", ...uploadIntegrity }));
      await closePool();
      process.exitCode = uploadIntegrity.ok ? 0 : 1;
      return;
    }
  }
  applicationStartupComplete = true;
  if (!uploadStorageCheckOnly) {
    await measureStartupStage("scheduler_initialized", () => {
      startEmailScheduler();
      startMaintenance();
    });
    logStartupReady({
      storeBackend,
      uploadBackend: configuredUploadStorageBackend({ backend: UPLOAD_STORAGE_BACKEND }),
      port: PORT,
      startupDurationMs: elapsedStartupDurationMs(processStartedAt)
    });
  }
}

async function measureStartupStage(stage, operation, details = () => ({})) {
  const startedAt = performance.now();
  try {
    const result = await operation();
    logStartupStageCompleted(stage, startedAt, details(result));
    return result;
  } catch (error) {
    logError("startup_stage_failed", {
      stage,
      durationMs: elapsedStartupDurationMs(startedAt),
      elapsedMs: elapsedStartupDurationMs(processStartedAt),
      message: safeStartupErrorMessage(error)
    });
    throw error;
  }
}

function logStartupStageCompleted(stage, startedAt, details = {}) {
  logInfo("startup_stage_completed", {
    stage,
    durationMs: elapsedStartupDurationMs(startedAt),
    elapsedMs: elapsedStartupDurationMs(processStartedAt),
    ...details
  });
}

function elapsedStartupDurationMs(startedAt) {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

function listenForStartup() {
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(PORT, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

function closeServerAfterStartupFailure() {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}

async function handleAuth(req, res, url) {
  const loginRoute = req.method === "POST" && url.pathname === "/auth/login";

  if (req.method === "GET" && url.pathname === "/auth/session") {
    const user = await sessionUser(req);
    if (!user) {
      sendJson(res, 401, { error: "Sessao nao encontrada" });
      return;
    }
    setSessionCookie(res, bearerToken(req));
    sendJson(res, 200, publicUser(user));
    return;
  }

  if (loginRoute) {
    const body = await readJson(req, AUTH_MAX_BODY_BYTES);
    const rawEmail = String(body.email || "");
    const rawPassword = String(body.senha || "");
    const credentialsWithinLimits = rawEmail.length <= 254 && rawPassword.length <= MAX_PASSWORD_LENGTH;
    const email = normalizeEmail(rawEmail.slice(0, 254));
    if (!(await reserveLoginAttempt(req, email))) {
      await recordSecurityEventSafely("login_rate_limited", { actorEmail: email, metadata: { ip: clientIp(req) } });
      sendJson(res, 429, { error: "Muitas tentativas de login. Tente novamente em alguns minutos." });
      return;
    }
    let user = null;
    if (credentialsWithinLimits) {
      const localBootstrapRequired = !localAdminBootstrapped
        && Boolean(LOCAL_ADMIN_EMAIL && LOCAL_ADMIN_PASSWORD);
      if (localBootstrapRequired) {
        const store = await readStore();
        await ensureUsers(store);
        user = store.usuarios.find((item) => normalizeEmail(item.email) === email) || null;
      } else {
        user = await readUserByEmail(email);
      }
    }
    let passwordMatches;
    try {
      passwordMatches = await loginScryptLimiter.run(() => verifyPassword(
        rawPassword.slice(0, MAX_PASSWORD_LENGTH),
        user?.ativo !== false ? user?.senhaHash : ""
      ));
    } catch (error) {
      if (error.code !== "WORK_QUEUE_FULL") throw error;
      await recordSecurityEventSafely("login_rate_limited", {
        actorEmail: email,
        metadata: { ip: clientIp(req), reason: "password_work_queue_full" }
      });
      sendJson(res, 429, { error: "Muitas tentativas de login. Tente novamente em alguns minutos." });
      return;
    }
    if (!credentialsWithinLimits || !user || user.ativo === false || !passwordMatches) {
      await recordSecurityEventSafely("login_failed", { actorEmail: email, metadata: { ip: clientIp(req) } });
      sendJson(res, 401, { error: "E-mail ou senha invalidos." });
      return;
    }
    await clearSuccessfulLogin(req, email);
    await recordSecurityEventSafely("login_succeeded", { actorUserId: user.id, actorEmail: user.email, metadata: { ip: clientIp(req) } });
    const token = await createSession(user);
    setSessionCookie(res, token);
    sendJson(res, 200, { user: publicUser(user) });
    return;
  }

  if (req.method === "PUT" && url.pathname === "/auth/profile") {
    if (usesCookieSession(req) && !isSameOriginMutation(req)) {
      sendJson(res, 403, { error: "Origem da requisicao nao autorizada." });
      return;
    }
    const authenticatedUser = await sessionUser(req);
    if (!authenticatedUser) {
      sendJson(res, 401, { error: "Faca login para alterar o perfil." });
      return;
    }
    const body = await readJson(req, AUTH_MAX_BODY_BYTES);
    const nome = String(body.nome || "").trim();
    if (!nome || nome.length > 100) {
      sendJson(res, 400, { error: "Informe um nome de ate 100 caracteres." });
      return;
    }
    const store = await readStore();
    const user = store.usuarios.find((item) => item.id === authenticatedUser.id && item.ativo !== false);
    if (!user || positiveAuthVersion(user.authVersion) !== positiveAuthVersion(authenticatedUser.authVersion)) {
      sendJson(res, 401, { error: "Sessao nao encontrada" });
      return;
    }
    const previousName = user.nome;
    user.nome = nome;
    user.atualizadoEm = new Date().toISOString();
    await writeStore(store, [transactionalSecurityEvent("profile_name_changed", {
      actorUserId: user.id,
      actorEmail: user.email,
      targetUserId: user.id,
      metadata: { previousName, newName: nome }
    })]);
    sendJson(res, 200, { user: publicUser(user) });
    return;
  }

  if (req.method === "PUT" && url.pathname === "/auth/profile-photo") {
    if (usesCookieSession(req) && !isSameOriginMutation(req)) {
      sendJson(res, 403, { error: "Origem da requisicao nao autorizada." });
      return;
    }
    const authenticatedUser = await sessionUser(req);
    if (!authenticatedUser) {
      sendJson(res, 401, { error: "Faca login para alterar a foto do perfil." });
      return;
    }
    const body = await readJson(req, PROFILE_PHOTO_MAX_BODY_BYTES);
    const profilePhoto = normalizeProfilePhotoDataUrl(body.foto);
    if (!profilePhoto) {
      sendJson(res, 400, { error: "Envie uma imagem PNG, JPEG ou WebP valida de ate 384 KB." });
      return;
    }
    const store = await readStore();
    const user = store.usuarios.find((item) => item.id === authenticatedUser.id && item.ativo !== false);
    if (!user || positiveAuthVersion(user.authVersion) !== positiveAuthVersion(authenticatedUser.authVersion)) {
      sendJson(res, 401, { error: "Sessao nao encontrada" });
      return;
    }
    user.foto = profilePhoto;
    user.atualizadoEm = new Date().toISOString();
    await writeStore(store, [transactionalSecurityEvent("profile_photo_changed", {
      actorUserId: user.id,
      actorEmail: user.email,
      targetUserId: user.id,
      metadata: { mimeType: profilePhoto.slice(5, profilePhoto.indexOf(";")) }
    })]);
    sendJson(res, 200, { user: publicUser(user) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/auth/change-password") {
    if (usesCookieSession(req) && !isSameOriginMutation(req)) {
      sendJson(res, 403, { error: "Origem da requisicao nao autorizada." });
      return;
    }
    const authenticatedUser = await sessionUser(req);
    if (!authenticatedUser) {
      sendJson(res, 401, { error: "Faca login para alterar a senha." });
      return;
    }
    const body = await readJson(req, AUTH_MAX_BODY_BYTES);
    const currentPassword = String(body.senhaAtual || "");
    const newPassword = String(body.novaSenha || "");
    const confirmation = String(body.confirmacao || "");
    const store = await readStore();
    const user = store.usuarios.find((item) => item.id === authenticatedUser.id && item.ativo !== false);
    if (!user || positiveAuthVersion(user.authVersion) !== positiveAuthVersion(authenticatedUser.authVersion)) {
      sendJson(res, 401, { error: "Sessao nao encontrada" });
      return;
    }
    const currentPasswordMatches = await verifyPassword(
      currentPassword.slice(0, MAX_PASSWORD_LENGTH),
      currentPassword.length <= MAX_PASSWORD_LENGTH ? user.senhaHash : ""
    );
    if (!user.senhaHash || !currentPasswordMatches) {
      await recordSecurityEventSafely("password_change_failed", {
        actorUserId: authenticatedUser.id, actorEmail: authenticatedUser.email, targetUserId: authenticatedUser.id,
        metadata: { reason: "invalid_current_password", ip: clientIp(req) }
      });
      sendJson(res, 401, { error: "Senha atual invalida." });
      return;
    }
    if (newPassword !== confirmation) {
      sendJson(res, 400, { error: "A confirmacao da nova senha deve ser identica." });
      return;
    }
    if (!isValidPassword(newPassword)) {
      sendJson(res, 400, { error: passwordPolicyMessage() });
      return;
    }
    user.senhaHash = await hashPassword(newPassword);
    user.precisaDefinirSenha = false;
    user.authVersion = nextAuthVersion(user.authVersion);
    user.atualizadoEm = new Date().toISOString();
    await writeStore(store, [transactionalSecurityEvent("password_changed", {
      actorUserId: user.id,
      actorEmail: user.email,
      targetUserId: user.id
    })]);
    await revokeUserSessionsBestEffort(user.id, "password_change");
    const token = await createSession(user);
    setSessionCookie(res, token);
    sendJson(res, 200, { user: publicUser(user) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/auth/logout") {
    if (usesCookieSession(req) && !isSameOriginMutation(req)) {
      sendJson(res, 403, { error: "Origem da requisicao nao autorizada." });
      return;
    }
    const token = bearerToken(req);
    const user = token ? await sessionUser(req) : null;
    if (token) await revokeSession(token);
    clearSessionCookie(res);
    if (user) await recordSecurityEventSafely("logout", { actorUserId: user.id, actorEmail: user.email, targetUserId: user.id });
    sendJson(res, 200, { ok: true });
    return;
  }

  sendJson(res, 404, { error: "Rota de autenticacao nao encontrada" });
}

async function handleApi(req, res, url) {
  if (isMutationRequest(req.method) && usesCookieSession(req) && !isSameOriginMutation(req)) {
    sendJson(res, 403, { error: "Origem da requisicao nao autorizada." });
    return;
  }

  const authenticatedUser = await sessionUser(req);
  if (!authenticatedUser) {
    sendJson(res, 401, { error: "Faca login para continuar." });
    return;
  }
  const user = {
    id: authenticatedUser.id,
    email: authenticatedUser.email,
    name: authenticatedUser.nome,
    role: resolveRole(authenticatedUser)
  };
  const role = user.role;
  const usuario = user.name;
  const auditActor = { usuario, usuarioEmail: user.email, usuarioId: user.id };
  const securityActor = { actorUserId: authenticatedUser.id, actorEmail: authenticatedUser.email };

  if (!roleCanMutate(role) && isMutationRequest(req.method)) {
    sendJson(res, 403, { error: "O perfil de auditor possui acesso somente para consulta." });
    return;
  }

  if (authenticatedUser?.precisaDefinirSenha && isMutationRequest(req.method)) {
    await recordSecurityEventSafely("first_password_required", {
      actorUserId: authenticatedUser.id,
      actorEmail: authenticatedUser.email,
      targetUserId: authenticatedUser.id,
      metadata: { path: url.pathname }
    });
    sendJson(res, 403, { error: "Altere a senha temporaria antes de realizar alteracoes." });
    return;
  }

  if (requiresAdmin(req.method, url.pathname) && role !== "admin") {
    sendJson(res, 403, { error: "Esta operacao exige perfil de administrador." });
    return;
  }
  if (requiresAuditAccess(req.method, url.pathname) && !["admin", "auditor"].includes(role)) {
    sendJson(res, 403, { error: "Esta operacao exige perfil de auditor ou administrador." });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/meta") {
    sendJson(res, 200, {
      status: STATUS.filter((status) => !["Criado", "Aguardando entrega", "Aguardando envio para liquidacao"].includes(status)),
      filtrosRapidos: QUICK_FILTERS,
      transicoes: PROCESS_TRANSITIONS,
      transicoesServico: SERVICE_TRANSITIONS,
      tiposObjeto: PROCESS_OBJECT_TYPES,
      acompanhamentosServico: SERVICE_TRACKING_MODES
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/security-audit") {
    sendJson(res, 200, await listSecurityEvents(url.searchParams.get("limit")));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/settings") {
    const store = await readSettingsStore();
    sendJson(res, 200, settingsPayload(store));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/emails/status") {
    sendJson(res, 200, emailStatusPayload());
    return;
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/dashboard")) {
    const snapshot = await readDashboardSnapshot();
    const anos = snapshot.anos;
    const year = resolveDashboardYear(url.searchParams.get("ano"), anos);
    const dashboard = dashboardSnapshotForYear(snapshot, year);
    if (url.pathname === "/api/dashboard") {
      sendJson(res, 200, {
        metrics: dashboard.metrics,
        charts: dashboard.charts,
        anos,
        ano: year
      });
    }
    else if (url.pathname === "/api/dashboard/execucao-mensal") sendJson(res, 200, dashboard.charts.execucaoMensal);
    else if (url.pathname === "/api/dashboard/distribuicao-status") sendJson(res, 200, dashboard.charts.distribuicaoStatus);
    else if (url.pathname === "/api/dashboard/charts") {
      sendJson(res, 200, dashboard.charts);
    } else sendJson(res, 404, { error: "Rota nao encontrada" });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/processes") {
    const requestedPagination = url.searchParams.has("page") || url.searchParams.has("limit");
    if (requestedPagination) {
      const pagination = parseProcessesPagination(url.searchParams);
      if (pagination.error) {
        sendJson(res, 400, { error: pagination.error });
        return;
      }
      const page = await readProcessesPage({
        page: pagination.page,
        limit: pagination.limit,
        filters: Object.fromEntries(url.searchParams),
        quickFilters: url.searchParams.getAll("filtroRapido")
      });
      sendJson(res, 200, { ...page, data: page.data.map((processo) => enrichProcess(processo)) });
      return;
    }
    const store = await readProcessesStore();
    const filtered = filterProcesses(store.processos, Object.fromEntries(url.searchParams));
    const enriched = filtered.map((processo) => enrichProcess(processo));
    const result = applyQuickFilter(enriched, url.searchParams.getAll("filtroRapido"));
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "GET" && ["/api/processes/download", "/api/processes/download/"].includes(url.pathname)) {
    const store = await readProcessesStore();
    const format = String(url.searchParams.get("format") || "csv").toLowerCase();
    const filtered = filterProcesses(store.processos, Object.fromEntries(url.searchParams));
    const enriched = applyQuickFilter(filtered.map((processo) => enrichProcess(processo)), url.searchParams.getAll("filtroRapido"));
    sendProcessesExport(res, enriched, format);
    return;
  }

  const processMatch = url.pathname.match(/^\/api\/processes\/([^/]+)$/);
  const matchedProcessId = processMatch ? decodePathSegment(processMatch[1]) : "";
  if (processMatch && matchedProcessId === null) {
    sendJson(res, 400, { error: "Identificador de processo invalido" });
    return;
  }
  if (processMatch && req.method === "GET") {
    const processo = await readProcessById(matchedProcessId);
    if (!processo || processo.inativo) {
      sendJson(res, 404, { error: "Processo nao encontrado" });
      return;
    }
    res.setHeader("cache-control", "private, no-store");
    sendJson(res, 200, enrichProcess(processo));
    return;
  }

  // These read-only sections used to load the complete application state.
  // Query only their own collection when PostgreSQL is active so large process
  // and document histories do not delay the Suppliers and Audit screens.
  if (req.method === "GET" && url.pathname === "/api/suppliers") {
    const store = await readSuppliersStore();
    sendJson(res, 200, store.fornecedores);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/audit") {
    const store = await readAuditStore();
    sendJson(res, 200, store.auditoria);
    return;
  }

  let store = await readStore();
  await ensureUsers(store);

  if (req.method === "POST" && url.pathname === "/api/admin/users") {
    const body = await readJson(req, ADMIN_MAX_BODY_BYTES);
    const email = normalizeEmail(body.email);
    const nome = String(body.nome || "").trim();
    const password = String(body.senhaTemporaria || "");
    const newRole = normalizeManagedRole(body.role);
    if (!nome || nome.length > 100 || String(body.email || "").length > 254 || !isSafeEmailAddress(email) || !newRole) {
      sendJson(res, 400, { error: "Informe nome, e-mail valido e perfil." });
      return;
    }
    if (!isValidPassword(password)) {
      sendJson(res, 400, { error: passwordPolicyMessage() });
      return;
    }
    const deletedUser = store.usuarios.find((item) => normalizeEmail(item.email) === email && item.origemCadastro === "excluido");
    if (store.usuarios.some((item) => normalizeEmail(item.email) === email && item.origemCadastro !== "excluido")) {
      sendJson(res, 409, { error: "Ja existe um usuario com este e-mail." });
      return;
    }
    const managedUser = {
      id: deletedUser?.id || crypto.randomUUID(), nome, email, role: newRole, ativo: true,
      origemCadastro: "admin", senhaHash: await hashPassword(password), precisaDefinirSenha: true,
      authVersion: deletedUser ? nextAuthVersion(deletedUser.authVersion) : 1,
      criadoEm: deletedUser?.criadoEm || new Date().toISOString(), atualizadoEm: new Date().toISOString()
    };
    if (deletedUser) store.usuarios[store.usuarios.indexOf(deletedUser)] = managedUser;
    else store.usuarios.push(managedUser);
    await writeStore(store, [transactionalSecurityEvent("user_created", {
      actorUserId: authenticatedUser.id,
      actorEmail: authenticatedUser.email,
      targetUserId: managedUser.id,
      metadata: { role: newRole }
    })]);
    sendJson(res, 201, publicUser(managedUser));
    return;
  }

  const adminUserMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
  if (adminUserMatch && req.method === "PATCH") {
    if (adminUserMatch[1].length > 200) {
      sendJson(res, 400, { error: "Identificador de usuario invalido." });
      return;
    }
    const body = await readJson(req, ADMIN_MAX_BODY_BYTES);
    if ((Object.prototype.hasOwnProperty.call(body, "ativo") && typeof body.ativo !== "boolean")
      || (Object.prototype.hasOwnProperty.call(body, "revogarSessoes") && typeof body.revogarSessoes !== "boolean")) {
      sendJson(res, 400, { error: "Os campos ativo e revogarSessoes devem ser booleanos." });
      return;
    }
    const managedUser = store.usuarios.find((item) => item.id === adminUserMatch[1]);
    if (!managedUser) {
      sendJson(res, 404, { error: "Usuario nao encontrado." });
      return;
    }
    const removesAdminAccess = resolveRole(managedUser) === "admin" && (
      body.ativo === false || (Object.prototype.hasOwnProperty.call(body, "role") && normalizeManagedRole(body.role) !== "admin")
    );
    if (removesAdminAccess && activeAdminCount(store.usuarios) <= 1) {
      sendJson(res, 400, { error: "O ultimo administrador ativo nao pode ser desativado nem perder o perfil administrativo." });
      return;
    }
    if (Object.prototype.hasOwnProperty.call(body, "role")) {
      const newRole = normalizeManagedRole(body.role);
      if (!newRole) {
        sendJson(res, 400, { error: "Perfil invalido." });
        return;
      }
      managedUser.role = newRole;
    }
    const passwordReset = Object.prototype.hasOwnProperty.call(body, "senha");
    if (passwordReset) {
      const newPassword = String(body.senha || "");
      if (!isValidPassword(newPassword)) {
        sendJson(res, 400, { error: passwordPolicyMessage() });
        return;
      }
      managedUser.senhaHash = await hashPassword(newPassword);
      managedUser.precisaDefinirSenha = true;
      body.revogarSessoes = true;
    }
    if (Object.prototype.hasOwnProperty.call(body, "ativo")) managedUser.ativo = body.ativo === true;
    const invalidateSessions = passwordReset || managedUser.ativo === false || body.revogarSessoes === true;
    if (invalidateSessions) managedUser.authVersion = nextAuthVersion(managedUser.authVersion);
    managedUser.atualizadoEm = new Date().toISOString();
    const userSecurityEvents = [transactionalSecurityEvent("user_updated", {
      actorUserId: authenticatedUser.id,
      actorEmail: authenticatedUser.email,
      targetUserId: managedUser.id,
      metadata: {
        role: managedUser.role,
        ativo: managedUser.ativo,
        sessoesRevogadas: body.revogarSessoes === true
      }
    })];
    if (passwordReset) {
      userSecurityEvents.push(transactionalSecurityEvent("user_password_reset", {
        actorUserId: authenticatedUser.id,
        actorEmail: authenticatedUser.email,
        targetUserId: managedUser.id,
        metadata: { sessionsInvalidated: true, firstPasswordRequired: true }
      }));
    }
    await writeStore(store, userSecurityEvents);
    if (invalidateSessions) await revokeUserSessionsBestEffort(managedUser.id, "admin_user_update");
    sendJson(res, 200, publicUser(managedUser));
    return;
  }

  if (adminUserMatch && req.method === "DELETE") {
    if (adminUserMatch[1].length > 200) {
      sendJson(res, 400, { error: "Identificador de usuario invalido." });
      return;
    }
    const managedUser = store.usuarios.find((item) => item.id === adminUserMatch[1]);
    if (!managedUser) {
      sendJson(res, 404, { error: "Usuario nao encontrado." });
      return;
    }
    if (managedUser.ativo !== false && resolveRole(managedUser) === "admin" && activeAdminCount(store.usuarios) <= 1) {
      sendJson(res, 400, { error: "O ultimo administrador ativo nao pode ser excluido." });
      return;
    }
    managedUser.ativo = false;
    managedUser.origemCadastro = "excluido";
    managedUser.authVersion = nextAuthVersion(managedUser.authVersion);
    managedUser.atualizadoEm = new Date().toISOString();
    await writeStore(store, [transactionalSecurityEvent("user_deleted", {
      actorUserId: authenticatedUser.id,
      actorEmail: authenticatedUser.email,
      targetUserId: managedUser.id
    })]);
    await revokeUserSessionsBestEffort(managedUser.id, "admin_user_delete");
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/emails/history") {
    sendJson(res, 200, ensureEmailHistory(store).slice(0, 100));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/emails/run-due") {
    const body = await readJson(req, ADMIN_MAX_BODY_BYTES);
    const forcedTestRecipient = normalizeEmail(body.testRecipient || EMAIL_TEST_RECIPIENT);
    if (body.force && !forcedTestRecipient) {
      sendJson(res, 400, { error: "Configure EMAIL_TEST_RECIPIENT para executar um envio de teste." });
      return;
    }
    const result = await runDueEmailNotifications({
      manual: true,
      force: Boolean(body.force),
      processId: String(body.processId || ""),
      tipo: String(body.tipo || ""),
      testRecipient: body.force ? forcedTestRecipient : ""
    });
    await recordSecurityEventSafely("email_dispatch_run", {
      ...securityActor,
      metadata: {
        forced: Boolean(body.force),
        processId: String(body.processId || ""),
        type: String(body.tipo || ""),
        candidates: result.candidates,
        sent: result.sent.length,
        failed: result.failed.length
      }
    });
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "PUT" && url.pathname === "/api/settings/email-templates") {
    const body = await readJson(req, ADMIN_MAX_BODY_BYTES);
    const templatesInput = body.emailTemplates || body;
    const templatesError = emailTemplatesValidationError(templatesInput);
    if (templatesError) {
      sendJson(res, 400, { error: templatesError });
      return;
    }
    const settings = ensureSettings(store);
    settings.emailTemplates = sanitizeEmailTemplates(templatesInput);
    await writeStore(store, [transactionalSecurityEvent("email_templates_updated", securityActor)]);
    sendJson(res, 200, settingsPayload(store));
    return;
  }

  const templateAttachmentMatch = url.pathname.match(/^\/api\/settings\/email-templates\/([^/]+)\/attachments$/);
  if (templateAttachmentMatch && req.method === "POST") {
    const templateKey = decodeURIComponent(templateAttachmentMatch[1]);
    if (templateKey.length > 100) {
      sendJson(res, 400, { error: "Identificador de template invalido." });
      return;
    }
    const settings = ensureSettings(store);
    const template = settings.emailTemplates[templateKey];
    if (!template) {
      sendJson(res, 404, { error: "Template nao encontrado" });
      return;
    }

    const body = await readJson(req);
    if (!body.fileName || !body.contentBase64) {
      sendJson(res, 400, { error: "Documento, nome do arquivo e conteudo sao obrigatorios" });
      return;
    }
    const metadataError = uploadMetadataError(body);
    if (metadataError) {
      sendJson(res, 400, { error: metadataError });
      return;
    }
    const fileName = String(body.fileName).trim();
    const mimeType = String(body.mimeType || "").trim();

    const content = decodeUploadContent(body.contentBase64);
    if (!validateDocumentUpload(fileName, mimeType, content)) {
      sendJson(res, 400, { error: "Formato de documento nao aceito. Use PDF, Excel, CSV, Word, texto ou imagem." });
      return;
    }

    const existingAttachments = Array.isArray(template.anexos) ? template.anexos : [];
    if (existingAttachments.length >= MAX_TEMPLATE_ATTACHMENTS) {
      sendJson(res, 413, { error: `Cada template aceita no maximo ${MAX_TEMPLATE_ATTACHMENTS} anexos.` });
      return;
    }
    if (await totalStoredAttachmentBytes(existingAttachments, MAX_TEMPLATE_UPLOAD_BYTES) + content.length > MAX_TEMPLATE_UPLOAD_BYTES) {
      sendJson(res, 413, { error: "O limite total de anexos deste template foi atingido." });
      return;
    }

    const safeTemplateKey = safeName(templateKey);
    const attachmentId = crypto.randomUUID();
    const safeFileName = `${attachmentId}-${safeDocumentFileName(fileName)}`;
    const { path: storedPath, sizeBytes } = await putUploadFile(content, {
      fileName: safeFileName,
      mimeType,
      category: "email-templates",
      scope: safeTemplateKey,
      backend: UPLOAD_STORAGE_BACKEND,
      root: UPLOAD_ROOT
    });

    const attachment = {
      id: attachmentId,
      fileName,
      path: storedPath,
      mimeType: mimeType || contentTypeForPath(safeFileName),
      sizeBytes,
      uploadedAt: new Date().toISOString(),
      uploadedBy: usuario,
      uploadedByEmail: user.email,
      uploadedById: user.id
    };
    template.anexos = [...existingAttachments, attachment];
    try {
      await writeStore(store, [transactionalSecurityEvent("email_template_attachment_added", {
        ...securityActor,
        metadata: { templateKey, attachmentId, sizeBytes: content.length }
      })]);
    } catch (error) {
      await deleteUploadFile(storedPath, { root: UPLOAD_ROOT }).catch(() => null);
      throw error;
    }
    sendJson(res, 200, settingsPayload(store));
    return;
  }

  const templateAttachmentItemMatch = url.pathname.match(/^\/api\/settings\/email-templates\/([^/]+)\/attachments\/([^/]+)$/);
  if (templateAttachmentItemMatch && req.method === "DELETE") {
    const templateKey = decodeURIComponent(templateAttachmentItemMatch[1]);
    const attachmentId = decodeURIComponent(templateAttachmentItemMatch[2]);
    const settings = ensureSettings(store);
    const template = settings.emailTemplates[templateKey];
    if (!template) {
      sendJson(res, 404, { error: "Template nao encontrado" });
      return;
    }
    const before = Array.isArray(template.anexos) ? template.anexos.length : 0;
    const removedAttachment = (Array.isArray(template.anexos) ? template.anexos : [])
      .find((attachment) => attachment.id === attachmentId);
    template.anexos = (Array.isArray(template.anexos) ? template.anexos : [])
      .filter((attachment) => attachment.id !== attachmentId);
    if (template.anexos.length === before) {
      sendJson(res, 404, { error: "Anexo nao encontrado" });
      return;
    }
    await writeStore(store, [transactionalSecurityEvent("email_template_attachment_removed", {
      ...securityActor,
      metadata: { templateKey, attachmentId }
    })]);
    await removeUploadedFile(removedAttachment?.path).catch((error) => {
      logError("removed_upload_cleanup_failed", { path: removedAttachment?.path, message: error.message });
    });
    sendJson(res, 200, settingsPayload(store));
    return;
  }

  if (req.method === "PUT" && url.pathname === "/api/settings/notifications") {
    const body = await readJson(req, ADMIN_MAX_BODY_BYTES);
    const settings = ensureSettings(store);
    settings.notificationRules = sanitizeNotificationRules(body.notificationRules || body);
    await writeStore(store, [transactionalSecurityEvent("notification_rules_updated", securityActor)]);
    sendJson(res, 200, settingsPayload(store));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/settings/users") {
    const body = await readJson(req, ADMIN_MAX_BODY_BYTES);
    const settings = ensureSettings(store);
    const nome = String(body.nome || "").trim();
    const email = normalizeEmail(body.email);
    const funcao = String(body.funcao || "").trim();
    if (!nome || nome.length > 100 || String(body.email || "").length > 254 || !isSafeEmailAddress(email) || funcao.length > 100) {
      sendJson(res, 400, { error: "Informe nome, e-mail valido e funcao com tamanhos permitidos." });
      return;
    }
    const existing = settings.responsaveis.find((responsavel) => responsavel.email === email);
    if (existing) {
      existing.nome = nome;
      existing.funcao = funcao || existing.funcao || "";
      existing.ativo = body.ativo !== false;
    } else {
      if (settings.responsaveis.length >= 500) {
        sendJson(res, 413, { error: "O limite de responsaveis foi atingido." });
        return;
      }
      settings.responsaveis.push({
        id: crypto.randomUUID(),
        nome,
        email,
        funcao,
        ativo: true,
        criadoEm: new Date().toISOString()
      });
    }
    await writeStore(store, [transactionalSecurityEvent("notification_recipient_upserted", {
      ...securityActor,
      metadata: { recipientId: existing?.id || settings.responsaveis.at(-1)?.id || "" }
    })]);
    sendJson(res, 200, settingsPayload(store));
    return;
  }

  const settingsUserMatch = url.pathname.match(/^\/api\/settings\/users\/([^/]+)$/);
  if (settingsUserMatch && req.method === "PATCH") {
    const body = await readJson(req, ADMIN_MAX_BODY_BYTES);
    if (Object.prototype.hasOwnProperty.call(body, "ativo") && typeof body.ativo !== "boolean") {
      sendJson(res, 400, { error: "O campo ativo deve ser booleano." });
      return;
    }
    const settings = ensureSettings(store);
    const responsavel = settings.responsaveis.find((item) => item.id === settingsUserMatch[1]);
    if (!responsavel) {
      sendJson(res, 404, { error: "Usuario responsavel nao encontrado." });
      return;
    }
    responsavel.ativo = body.ativo !== false;
    await writeStore(store, [transactionalSecurityEvent("notification_recipient_updated", {
      ...securityActor,
      metadata: { recipientId: responsavel.id, active: responsavel.ativo }
    })]);
    sendJson(res, 200, settingsPayload(store));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/processes") {
    const initialStatus = "Enviado para SALC";
    const body = await readJson(req);
    body.numeroProcesso = normalizeProcessNumber(body.numeroProcesso);
    const validationError = validateProcessBody(body);
    if (validationError) {
      sendJson(res, 400, { error: validationError });
      return;
    }
    const standardizedCommitmentNumber = normalizeNewProcessCommitmentNumber(body.numeroEmpenho);
    if (!standardizedCommitmentNumber) {
      sendJson(res, 400, { error: "Selecione o ano e informe o numero sequencial do empenho no formato AAAANE000NUMERO." });
      return;
    }
    body.numeroEmpenho = standardizedCommitmentNumber;
    if (body.status && body.status !== initialStatus) {
      sendJson(res, 400, { error: `Um processo novo deve iniciar em ${initialStatus}.` });
      return;
    }
    const duplicate = duplicateProcessFields(store.processos, body);
    if (duplicate) {
      sendJson(res, 409, { error: duplicate });
      return;
    }

    const input = sanitizeProcessInput(body);
    input.dataEnvioFornecedor = input.dataEnvioFornecedor || input.dataEnvioEmpenho;
    const processo = {
      id: crypto.randomUUID(),
      ...input,
      status: initialStatus,
      documentos: {},
      criadoEm: new Date().toISOString(),
      atualizadoEm: new Date().toISOString(),
      criadoPor: input.criadoPor || usuario,
      criadoPorEmail: user.email,
      criadoPorId: user.id,
      versao: 1,
      inativo: false
    };
    const statusError = validateProcessForStatus(processo);
    if (statusError) {
      sendJson(res, 400, { error: statusError });
      return;
    }
    store.processos.unshift(processo);
    const creationAudit = createAuditEntry({
      processoId: processo.id,
      ...auditActor,
      acao: "Criacao de processo",
      detalhes: `Processo ${processo.numeroProcesso || "sem numero"} criado e enviado para SALC.`,
      alteracoes: {
        status: { anterior: null, novo: initialStatus }
      }
    });
    store.auditoria.unshift(creationAudit);
    await writeChangedProcesses(store, [processo.id], [creationAudit.id]);
    sendJson(res, 201, enrichProcess(processo));
    return;
  }

  const rollbackStatusMatch = url.pathname.match(/^\/api\/processes\/([^/]+)\/rollback-status$/);
  if (rollbackStatusMatch && req.method === "POST") {
    if (role !== "admin") {
      sendJson(res, 403, { error: "Somente administradores podem retroceder o status de um processo." });
      return;
    }
    const body = await readJson(req);
    const targetStatus = String(body.status || "").trim();
    const reason = String(body.motivo || "").trim();
    if (!reason || reason.length > 1000) {
      sendJson(res, 400, { error: "Informe o motivo do retrocesso com ate 1000 caracteres." });
      return;
    }
    const index = store.processos.findIndex((processo) => processo.id === rollbackStatusMatch[1]);
    if (index === -1) {
      sendJson(res, 404, { error: "Processo nao encontrado" });
      return;
    }
    const current = store.processos[index];
    if (current.inativo || current.status === "Anulado") {
      sendJson(res, 403, { error: "Este processo nao permite retrocesso de status." });
      return;
    }
    if (body.versao && Number(body.versao) !== Number(current.versao)) {
      sendJson(res, 409, { error: "O processo foi alterado por outro usuario. Atualize a tela antes de tentar novamente." });
      return;
    }
    if (!isValidStatusRollback(current.status, targetStatus, current)) {
      sendJson(res, 400, { error: "Selecione um status anterior ao status atual do processo." });
      return;
    }

    const updated = rollbackProcessStatus(current, targetStatus);
    updated.versao = Number(current.versao || 0) + 1;
    updated.atualizadoEm = new Date().toISOString();
    store.processos[index] = updated;
    store.auditoria.unshift(createAuditEntry({
      processoId: updated.id,
      ...auditActor,
      acao: "Retrocesso administrativo de status",
      detalhes: `Status alterado de ${current.status} para ${targetStatus}. Motivo: ${reason}`,
      alteracoes: {
        ...processChanges(current, updated),
        motivo: { anterior: null, novo: reason }
      }
    }));
    await writeStore(store);
    sendJson(res, 200, enrichProcess(updated));
    return;
  }

  if (processMatch && req.method === "PUT") {
    const body = await readJson(req);
    body.numeroProcesso = normalizeProcessNumber(body.numeroProcesso);
    const validationError = validateProcessBody(body);
    if (validationError) {
      sendJson(res, 400, { error: validationError });
      return;
    }
    const index = store.processos.findIndex((processo) => processo.id === matchedProcessId);
    if (index === -1) {
      sendJson(res, 404, { error: "Processo nao encontrado" });
      return;
    }

    const current = store.processos[index];
    current.materiais = enrichProcess(current).materiais;
    if (!canEditProcess(current, role, body.status)) {
      sendJson(res, 403, { error: "Este processo nao pode ser alterado neste status." });
      return;
    }

    const currentMaterialIds = new Set(current.materiais.map((material) => String(material.id || "")));
    const unknownMaterialId = (Array.isArray(body.materiais) ? body.materiais : [])
      .map((material) => normalizeMaterialId(material?.id))
      .find((materialId) => materialId && !currentMaterialIds.has(materialId));
    if (unknownMaterialId) {
      sendJson(res, 400, { error: "Um material existente possui identificador desconhecido. Atualize a tela antes de salvar." });
      return;
    }

    if (body.versao && Number(body.versao) !== Number(current.versao)) {
      sendJson(res, 409, { error: "O processo foi alterado por outro usuario. Atualize a tela antes de salvar." });
      return;
    }

    const requestedType = String(body.tipoObjeto || processObjectType(current));
    const requestedTracking = requestedType === "servico"
      ? String(body.acompanhamentoServico || current.acompanhamentoServico || "continuado")
      : "entrega";
    const classificationChanged = requestedType !== processObjectType(current)
      || requestedTracking !== (processObjectType(current) === "servico" ? (current.acompanhamentoServico || "continuado") : "entrega");
    if (classificationChanged && !["Criado", "Enviado para SALC"].includes(current.status)) {
      sendJson(res, 400, { error: "O tipo e a forma de acompanhamento so podem ser alterados antes do envio ao fornecedor." });
      return;
    }

    if (body.status && !isValidStatusTransition(current.status, body.status, current)) {
      sendJson(res, 400, { error: "Transicao de status invalida. Avance o processo pela proxima etapa prevista." });
      return;
    }

    const duplicate = duplicateProcessFields(store.processos, body, current.id);
    if (duplicate) {
      sendJson(res, 409, { error: duplicate });
      return;
    }

    const sanitized = sanitizeProcessInput(body, current);
    const updated = {
      ...current,
      ...sanitized,
      id: current.id,
      numeroNotaFiscal: current.numeroNotaFiscal,
      versao: current.versao + 1,
      atualizadoEm: new Date().toISOString()
    };

    if (current.status === "Criado" && updated.status === "Enviado para SALC" && !updated.dataEnvioSalc) {
      sendJson(res, 400, { error: "Informe a data de envio para SALC antes de avancar." });
      return;
    }

    const statusError = validateProcessForStatus(updated);
    if (statusError) {
      sendJson(res, 400, { error: statusError });
      return;
    }
    if (["Enviado para liquidacao", "Liquidado", "Pago"].includes(updated.status)
        && !(await processHasAvailableLiquidationDocument(updated))) {
      sendJson(res, 400, { error: "O Processo SPED ou a Nota de Empenho registrado nao esta disponivel no armazenamento. Anexe o arquivo novamente antes da liquidacao." });
      return;
    }
    if (processUsesDelivery(updated) && deliveryExceedsOrdered(updated.entregas || [], [], updated.materiais || [])) {
      sendJson(res, 400, { error: "Os materiais nao podem ficar abaixo das quantidades ja recebidas." });
      return;
    }
    if (processUsesDelivery(updated) && (updated.entregas || []).length) {
      const deliveryComplete = deliveryIsComplete(updated.entregas, updated.materiais || []);
      if (hasProcessReachedDelivery(current) && !deliveryComplete) {
        if (current.status !== "Entregue" || (body.status && body.status !== current.status)) {
          sendJson(res, 400, { error: "Materiais de um processo em liquidacao nao podem criar saldo pendente de entrega." });
          return;
        }
        updated.status = "Entrega parcial";
      } else if (current.status === "Entrega parcial" && deliveryComplete) {
        updated.status = "Entregue";
      }
    }

    store.processos[index] = updated;
    store.auditoria.unshift(createAuditEntry({
      processoId: updated.id,
      ...auditActor,
      acao: "Alteracao de processo",
      detalhes: `Status atual: ${updated.status}.`,
      alteracoes: processChanges(current, updated)
    }));
    await writeStore(store);
    sendJson(res, 200, enrichProcess(updated));
    return;
  }

  const cancelMatch = url.pathname.match(/^\/api\/processes\/([^/]+)\/cancel$/);
  if (cancelMatch && req.method === "POST") {
    const body = await readJson(req);
    const cancellationReason = typeof body?.motivo === "string" ? body.motivo.trim() : "";
    if (!cancellationReason || cancellationReason.length > 1_000) {
      sendJson(res, 400, { error: "Informe um motivo de anulacao com ate 1000 caracteres." });
      return;
    }
    const index = store.processos.findIndex((processo) => processo.id === cancelMatch[1]);
    if (index === -1) {
      sendJson(res, 404, { error: "Processo nao encontrado" });
      return;
    }

    const current = store.processos[index];
    if (!canCancelProcess(current, user)) {
      sendJson(res, 403, { error: "Somente o usuario que adicionou o processo ou o administrador pode anular este empenho." });
      return;
    }

    const updated = {
      ...current,
      status: "Anulado",
      motivoAnulacao: cancellationReason,
      anuladoEm: new Date().toISOString(),
      anuladoPor: usuario,
      versao: Number(current.versao || 0) + 1,
      atualizadoEm: new Date().toISOString()
    };

    store.processos[index] = updated;
    store.auditoria.unshift(createAuditEntry({
      processoId: updated.id,
      ...auditActor,
      acao: "Anulacao de empenho",
      detalhes: `Motivo: ${updated.motivoAnulacao}.`
    }));
    await writeStore(store);
    sendJson(res, 200, enrichProcess(updated));
    return;
  }

  const serviceExecutionMatch = url.pathname.match(/^\/api\/processes\/([^/]+)\/service-executions$/);
  if (serviceExecutionMatch && req.method === "POST") {
    const body = await readJson(req);
    const processo = store.processos.find((item) => item.id === serviceExecutionMatch[1]);
    if (!processo) {
      sendJson(res, 404, { error: "Processo nao encontrado" });
      return;
    }
    if (!canEditProcess(processo, role)) {
      sendJson(res, 403, { error: "Este processo nao pode receber registros de execucao neste status." });
      return;
    }
    if (processObjectType(processo) !== "servico" || processUsesDelivery(processo)) {
      sendJson(res, 400, { error: "Este empenho utiliza acompanhamento por entrega fisica." });
      return;
    }
    if (!["Empenho enviado ao fornecedor", "Em execução"].includes(processo.status)) {
      sendJson(res, 400, { error: "A execucao so pode ser registrada depois do envio do empenho ao fornecedor." });
      return;
    }
    if (!processDeadlineDate(processo)) {
      sendJson(res, 400, { error: "Informe a data de envio do empenho ao fornecedor antes de registrar a execucao." });
      return;
    }
    const previousExecutions = Array.isArray(processo.execucoesServico) ? processo.execucoesServico : [];
    if (previousExecutions.length >= MAX_SERVICE_EXECUTIONS) {
      sendJson(res, 400, { error: `Cada servico aceita no maximo ${MAX_SERVICE_EXECUTIONS} registros de execucao.` });
      return;
    }
    const data = safeDate(body.data);
    const competencia = String(body.competencia || "").trim() || data.slice(0, 7);
    const percentualExecutado = Number(body.percentualExecutado);
    const valorExecutado = body.valorExecutado === "" || body.valorExecutado === null || body.valorExecutado === undefined
      ? 0
      : Number(body.valorExecutado);
    const descricao = String(body.descricao || "").trim();
    const today = dateKeyInTimeZone(new Date(), APP_TIME_ZONE);
    const lastDate = previousExecutions.map((entry) => safeDate(entry.data)).filter(Boolean).sort().at(-1) || "";
    if (!data || data > today || data < processDeadlineDate(processo) || (lastDate && data < lastDate)) {
      sendJson(res, 400, { error: "Informe uma data de execucao valida, nao futura e posterior aos registros anteriores." });
      return;
    }
    if (!/^\d{4}-\d{2}$/.test(competencia) || Number(competencia.slice(5, 7)) < 1 || Number(competencia.slice(5, 7)) > 12) {
      sendJson(res, 400, { error: "Informe a competencia no formato AAAA-MM." });
      return;
    }
    const currentProgress = serviceProgressTotal(processo);
    if (!Number.isFinite(percentualExecutado) || percentualExecutado <= 0 || percentualExecutado > 100 - currentProgress) {
      sendJson(res, 400, { error: `Informe um avanco maior que zero e de no maximo ${Math.max(0, 100 - currentProgress)}%.` });
      return;
    }
    if (!Number.isFinite(valorExecutado) || valorExecutado < 0 || !Number.isSafeInteger(Math.round(valorExecutado * 100))) {
      sendJson(res, 400, { error: "O valor executado deve ser um numero nao negativo valido." });
      return;
    }
    const commitmentValueCents = Math.round(Number(enrichProcess(processo).valorTotal || 0) * 100);
    const previousExecutedValueCents = previousExecutions
      .reduce((total, entry) => total + Math.round(Number(entry.valorExecutado || 0) * 100), 0);
    if (commitmentValueCents > 0 && previousExecutedValueCents + Math.round(valorExecutado * 100) > commitmentValueCents) {
      sendJson(res, 400, { error: "O valor executado acumulado nao pode superar o valor total do empenho." });
      return;
    }
    if (descricao.length > 500) {
      sendJson(res, 400, { error: "A descricao da execucao deve ter no maximo 500 caracteres." });
      return;
    }
    const previousStatus = processo.status;
    const execution = {
      id: crypto.randomUUID(),
      data,
      competencia,
      percentualExecutado,
      valorExecutado,
      descricao,
      registradoPor: usuario,
      registradoPorEmail: user.email,
      criadoEm: new Date().toISOString()
    };
    processo.execucoesServico = [...previousExecutions, execution];
    const totalProgress = serviceProgressTotal(processo);
    processo.status = totalProgress >= 100 ? "Serviço concluído" : "Em execução";
    processo.versao = Number(processo.versao || 0) + 1;
    processo.atualizadoEm = new Date().toISOString();
    store.auditoria.unshift(createAuditEntry({
      processoId: processo.id,
      ...auditActor,
      acao: "Registro de execucao de servico",
      detalhes: `Execucao de ${percentualExecutado}% registrada para a competencia ${competencia}. Total concluido: ${totalProgress}%.`,
      alteracoes: {
        execucaoServicoId: { anterior: null, novo: execution.id },
        percentualConcluido: { anterior: currentProgress, novo: totalProgress },
        ...(previousStatus !== processo.status ? { status: { anterior: previousStatus, novo: processo.status } } : {})
      }
    }));
    await writeStore(store);
    sendJson(res, 201, enrichProcess(processo));
    return;
  }

  const deliveryMatch = url.pathname.match(/^\/api\/processes\/([^/]+)\/deliveries$/);
  if (deliveryMatch && req.method === "POST") {
    const body = await readJson(req);
    const processo = store.processos.find((item) => item.id === deliveryMatch[1]);
    if (!processo) {
      sendJson(res, 404, { error: "Processo nao encontrado" });
      return;
    }
    if (!canEditProcess(processo, role)) {
      sendJson(res, 403, { error: "Este processo nao pode receber entregas neste status." });
      return;
    }
    if (!processUsesDelivery(processo)) {
      sendJson(res, 400, { error: "Este servico deve ser acompanhado por registros de execucao, sem entrega fisica." });
      return;
    }
    if (!["Empenho enviado ao fornecedor", "Aguardando entrega", "Entrega parcial"].includes(processo.status)) {
      sendJson(res, 400, { error: "A entrega so pode ser registrada depois do envio do empenho ao fornecedor." });
      return;
    }
    if (!processDeadlineDate(processo)) {
      sendJson(res, 400, { error: "Informe a data de envio do empenho ao fornecedor antes de registrar entrega." });
      return;
    }
    processo.materiais = enrichProcess(processo).materiais;
    const data = safeDate(body.data);
    if (Object.prototype.hasOwnProperty.call(body, "itens") && !Array.isArray(body.itens)) {
      sendJson(res, 400, { error: "As quantidades entregues devem ser informadas em uma lista valida." });
      return;
    }
    const previousDeliveries = Array.isArray(processo.entregas) ? processo.entregas : [];
    const providedItems = Array.isArray(body.itens) ? body.itens : [];
    const items = providedItems.length
      ? sanitizeDeliveryItems(providedItems, processo.materiais || [])
      : remainingDeliveryItems(previousDeliveries, processo.materiais || []);
    if (!data || !items.length) {
      sendJson(res, 400, { error: "Informe uma data valida para uma entrega com saldo pendente." });
      return;
    }
    const deliveryDateError = validateDeliveryDate(processo, data, previousDeliveries);
    if (deliveryDateError) {
      sendJson(res, 400, { error: deliveryDateError });
      return;
    }
    if (deliveryExceedsOrdered(previousDeliveries, items, processo.materiais || [])) {
      sendJson(res, 400, { error: "A quantidade entregue nao pode superar a quantidade empenhada." });
      return;
    }
    const entrega = {
      id: crypto.randomUUID(), data, itens: items, observacao: String(body.observacao || "").trim(),
      recebidoPor: usuario, recebidoPorEmail: user.email, criadoEm: new Date().toISOString()
    };
    processo.entregas = [...previousDeliveries, entrega];
    const complete = deliveryIsComplete(processo.entregas, processo.materiais || []);
    processo.status = complete ? "Entregue" : "Entrega parcial";
    processo.dataEntrega = data;
    processo.versao = Number(processo.versao || 0) + 1;
    processo.atualizadoEm = new Date().toISOString();
    store.auditoria.unshift(createAuditEntry({
      processoId: processo.id, ...auditActor, acao: "Registro de entrega",
      detalhes: complete ? "Entrega integral registrada." : "Entrega parcial registrada.",
      alteracoes: { entregaId: entrega.id, itens: entrega.itens }
    }));
    await writeStore(store);
    sendJson(res, 201, enrichProcess(processo));
    return;
  }

  const inactivateMatch = url.pathname.match(/^\/api\/processes\/([^/]+)\/inactivate$/);
  if (inactivateMatch && req.method === "POST") {
    if (role !== "admin") {
      sendJson(res, 403, { error: "Somente administradores podem inativar processos." });
      return;
    }
    const processo = store.processos.find((item) => item.id === inactivateMatch[1]);
    if (!processo) {
      sendJson(res, 404, { error: "Processo nao encontrado" });
      return;
    }
    if (processo.status === "Pago") {
      sendJson(res, 403, { error: "Processos pagos permanecem bloqueados e nao podem ser inativados." });
      return;
    }
    if (processo.inativo) {
      sendJson(res, 409, { error: "Este processo ja esta inativo." });
      return;
    }
    processo.inativo = true;
    processo.inativadoEm = new Date().toISOString();
    processo.inativadoPor = usuario;
    processo.versao = Number(processo.versao || 0) + 1;
    store.auditoria.unshift(createAuditEntry({
      processoId: processo.id, ...auditActor, acao: "Inativacao de processo", detalhes: "Processo marcado como inativo."
    }));
    await writeStore(store);
    sendJson(res, 200, enrichProcess(processo));
    return;
  }

  const processAuditMatch = url.pathname.match(/^\/api\/processes\/([^/]+)\/audit$/);
  if (processAuditMatch && req.method === "GET") {
    const processo = store.processos.find((item) => item.id === processAuditMatch[1]);
    if (!processo) {
      sendJson(res, 404, { error: "Processo nao encontrado" });
      return;
    }
    sendJson(res, 200, store.auditoria.filter((entry) => entry.processoId === processo.id));
    return;
  }

  const timelineItemMatch = url.pathname.match(/^\/api\/processes\/([^/]+)\/timeline-items$/);
  if (timelineItemMatch && req.method === "DELETE") {
    if (role !== "admin") {
      sendJson(res, 403, { error: "Somente administradores podem excluir dados da linha do tempo." });
      return;
    }
    const processo = store.processos.find((item) => item.id === timelineItemMatch[1]);
    if (!processo) {
      sendJson(res, 404, { error: "Processo nao encontrado" });
      return;
    }
    const body = await readJson(req);
    const type = String(body.tipo || "").trim();
    const itemId = String(body.id || "").trim();
    const reason = String(body.motivo || "").trim();
    if (reason.length > 1000) {
      sendJson(res, 400, { error: "O motivo da exclusao deve ter ate 1000 caracteres." });
      return;
    }
    const timelineKey = `${type}:${itemId}`;
    const hiddenKeys = new Set(store.auditoria
      .filter((entry) => entry.processoId === processo.id && entry.acao === "Exclusao de dado da linha do tempo")
      .map((entry) => entry.alteracoes?.linhaDoTempo?.novo)
      .filter(Boolean));
    if (hiddenKeys.has(timelineKey)) {
      sendJson(res, 409, { error: "Este dado ja foi excluido da linha do tempo." });
      return;
    }

    const auditTarget = type === "auditoria" && store.auditoria.some((entry) => (
      entry.id === itemId && entry.processoId === processo.id && entry.acao !== "Exclusao de dado da linha do tempo"
    ));
    const observationTarget = type === "observacao" && store.observacoes.some((entry) => (
      entry.id === itemId && entry.processoId === processo.id
    ));
    const milestoneTargets = {
      "entrega-parcial": processo.status === "Entrega parcial" && Boolean(processo.dataEntrega),
      entregue: hasProcessReachedDelivery(processo) && Boolean(processo.dataEntrega),
      "envio-liquidacao": Boolean(processo.dataEnvioLiquidacao),
      liquidado: ["Liquidado", "Pago"].includes(processo.status),
      pago: processo.status === "Pago",
      anulado: processo.status === "Anulado"
    };
    const milestoneTarget = type === "marco" && milestoneTargets[itemId] === true;
    if (!auditTarget && !observationTarget && !milestoneTarget) {
      sendJson(res, 404, { error: "Dado da linha do tempo nao encontrado." });
      return;
    }

    store.auditoria.unshift(createAuditEntry({
      processoId: processo.id,
      ...auditActor,
      acao: "Exclusao de dado da linha do tempo",
      detalhes: `Dado ${timelineKey} ocultado da linha do tempo.${reason ? ` Motivo: ${reason}` : ""}`,
      alteracoes: {
        linhaDoTempo: { anterior: null, novo: timelineKey },
        motivo: { anterior: null, novo: reason || null }
      }
    }));
    await writeStore(store);
    sendJson(res, 200, { ok: true });
    return;
  }

  const obsMatch = url.pathname.match(/^\/api\/processes\/([^/]+)\/observations$/);
  if (obsMatch && req.method === "GET") {
    const observacoes = store.observacoes
      .filter((observacao) => observacao.processoId === obsMatch[1])
      .sort((a, b) => a.criadoEm.localeCompare(b.criadoEm));
    sendJson(res, 200, observacoes);
    return;
  }

  if (obsMatch && req.method === "POST") {
    const body = await readJson(req);
    const content = String(body.conteudo || "").trim();
    if (!content || content.length > 350) {
      sendJson(res, 400, { error: "A observacao deve ter entre 1 e 350 caracteres." });
      return;
    }
    const processo = store.processos.find((item) => item.id === obsMatch[1]);
    if (!processo) {
      sendJson(res, 404, { error: "Processo nao encontrado" });
      return;
    }
    if (!canEditProcess(processo, role)) {
      sendJson(res, 403, { error: "Este processo nao pode ser alterado neste status." });
      return;
    }
    const observacao = {
      id: crypto.randomUUID(),
      processoId: obsMatch[1],
      ...auditActor,
      conteudo: content,
      criadoEm: new Date().toISOString()
    };
    store.observacoes.unshift(observacao);
    store.auditoria.unshift(createAuditEntry({
      processoId: observacao.processoId,
      ...auditActor,
      acao: "Inclusao de observacao",
      detalhes: "Observacao registrada no processo."
    }));
    await writeStore(store);
    sendJson(res, 201, observacao);
    return;
  }

  const obsItemMatch = url.pathname.match(/^\/api\/processes\/([^/]+)\/observations\/([^/]+)$/);
  if (obsItemMatch && req.method === "PUT") {
    const body = await readJson(req);
    const content = String(body.conteudo || "").trim();
    if (!content || content.length > 350) {
      sendJson(res, 400, { error: "A observacao deve ter entre 1 e 350 caracteres." });
      return;
    }
    const processo = store.processos.find((item) => item.id === obsItemMatch[1]);
    if (!processo) {
      sendJson(res, 404, { error: "Processo nao encontrado" });
      return;
    }
    if (!canEditProcess(processo, role)) {
      sendJson(res, 403, { error: "Este processo nao pode ser alterado neste status." });
      return;
    }
    const observacao = store.observacoes.find((item) => item.processoId === obsItemMatch[1] && item.id === obsItemMatch[2]);
    if (!observacao) {
      sendJson(res, 404, { error: "Observacao nao encontrada" });
      return;
    }
    if (role !== "admin" && !observationBelongsToUser(observacao, user)) {
      sendJson(res, 403, { error: "Somente o autor ou administrador pode alterar esta observacao." });
      return;
    }
    observacao.conteudo = content;
    observacao.atualizadoEm = new Date().toISOString();
    store.auditoria.unshift(createAuditEntry({
      processoId: obsItemMatch[1],
      ...auditActor,
      acao: "Alteracao de observacao",
      detalhes: "Observacao atualizada no processo."
    }));
    await writeStore(store);
    sendJson(res, 200, observacao);
    return;
  }

  if (obsItemMatch && req.method === "DELETE") {
    const processo = store.processos.find((item) => item.id === obsItemMatch[1]);
    if (!processo) {
      sendJson(res, 404, { error: "Processo nao encontrado" });
      return;
    }
    if (!canEditProcess(processo, role)) {
      sendJson(res, 403, { error: "Este processo nao pode ser alterado neste status." });
      return;
    }
    const targetObservation = store.observacoes.find((item) => item.processoId === obsItemMatch[1] && item.id === obsItemMatch[2]);
    if (!targetObservation) {
      sendJson(res, 404, { error: "Observacao nao encontrada" });
      return;
    }
    if (role !== "admin" && !observationBelongsToUser(targetObservation, user)) {
      sendJson(res, 403, { error: "Somente o autor ou administrador pode remover esta observacao." });
      return;
    }
    const before = store.observacoes.length;
    store.observacoes = store.observacoes.filter((item) => !(item.processoId === obsItemMatch[1] && item.id === obsItemMatch[2]));
    if (store.observacoes.length === before) {
      sendJson(res, 404, { error: "Observacao nao encontrada" });
      return;
    }
    store.auditoria.unshift(createAuditEntry({
      processoId: obsItemMatch[1],
      ...auditActor,
      acao: "Exclusao de observacao",
      detalhes: "Observacao removida do processo."
    }));
    await writeStore(store);
    sendJson(res, 200, { ok: true });
    return;
  }

  const documentMatch = url.pathname.match(/^\/api\/processes\/([^/]+)\/documents$/);
  if (documentMatch && req.method === "POST") {
    const body = await readJson(req);
    const index = store.processos.findIndex((processo) => processo.id === documentMatch[1]);
    if (index === -1) {
      sendJson(res, 404, { error: "Processo nao encontrado" });
      return;
    }

    if (!body.documentKey || !body.fileName || !body.contentBase64) {
      sendJson(res, 400, { error: "Documento, nome do arquivo e conteudo sao obrigatorios" });
      return;
    }
    const documentKey = String(body.documentKey).trim();
    if (![...REQUIRED_DOCUMENT_KEYS, "complementares"].includes(documentKey)) {
      sendJson(res, 400, { error: "Tipo de documento invalido." });
      return;
    }
    const metadataError = uploadMetadataError(body, { complementary: documentKey === "complementares" });
    if (metadataError) {
      sendJson(res, 400, { error: metadataError });
      return;
    }
    const fileName = String(body.fileName).trim();
    const mimeType = String(body.mimeType || "").trim();
    const title = String(body.titulo || "").trim();
    const description = String(body.descricao || "").trim();

    if (documentKey === "complementares" && !title) {
      sendJson(res, 400, { error: "O nome do documento complementar e obrigatorio" });
      return;
    }

    const current = store.processos[index];
    if (!canEditProcess(current, role)) {
      sendJson(res, 403, { error: "Seu perfil nao pode alterar documentos deste processo." });
      return;
    }
    const content = decodeUploadContent(body.contentBase64);
    if (!validateProcessDocumentUpload(documentKey, fileName, mimeType, content)) {
      sendJson(res, 400, { error: "Documento invalido. Processo SPED, Nota de Empenho e Nota Fiscal devem ser PDF valido." });
      return;
    }

    if (!canAttachDocument(current, documentKey)) {
      sendJson(res, 400, { error: "Este documento nao pode ser anexado neste momento." });
      return;
    }

    const replacedDocument = documentKey === "complementares" ? null : current.documentos?.[documentKey];
    const replacedDocumentPath = normalizeDocumentEntry(replacedDocument).path;
    if (replacedDocument && !canRemoveDocument(current, documentKey) && await storedAttachmentExists(replacedDocument)) {
      sendJson(res, 400, { error: "Este documento nao pode ser substituido nesta etapa do processo." });
      return;
    }

    const safeProcessId = safeName(documentMatch[1]);
    const safeFileName = `${crypto.randomUUID()}-${safeName(documentKey)}-${safeDocumentFileName(fileName)}`;
    const currentDocuments = documentEntries(current.documentos);
    const resultingCount = currentDocuments.length + (replacedDocument ? 0 : 1);
    const resultingBytes = await totalStoredAttachmentBytes(currentDocuments, MAX_PROCESS_UPLOAD_BYTES)
      - await storedAttachmentByteSize(replacedDocument)
      + content.length;
    if (resultingCount > MAX_PROCESS_DOCUMENTS) {
      sendJson(res, 413, { error: `Cada processo aceita no maximo ${MAX_PROCESS_DOCUMENTS} documentos.` });
      return;
    }
    if (resultingBytes > MAX_PROCESS_UPLOAD_BYTES) {
      sendJson(res, 413, { error: "O limite total de documentos deste processo foi atingido." });
      return;
    }
    const { path: storedPath, sizeBytes } = await putUploadFile(content, {
      fileName: safeFileName,
      mimeType,
      processId: safeProcessId,
      backend: UPLOAD_STORAGE_BACKEND,
      root: UPLOAD_ROOT
    });

    const documentInfo = {
      fileName,
      titulo: documentKey === "complementares" ? title : undefined,
      descricao: documentKey === "complementares" ? description : undefined,
      path: storedPath,
      mimeType: mimeType || contentTypeForPath(safeFileName),
      sizeBytes,
      uploadedAt: new Date().toISOString(),
      uploadedBy: usuario,
      uploadedByEmail: user.email,
      uploadedById: user.id
    };

    const documentos = { ...(current.documentos || {}) };
    if (documentKey === "complementares") {
      const currentComplementares = documentos.complementares
        ? (Array.isArray(documentos.complementares) ? documentos.complementares : [documentos.complementares])
        : [];
      documentos.complementares = [...currentComplementares, documentInfo];
    } else {
      documentos[documentKey] = documentInfo;
    }

    store.processos[index] = {
      ...current,
      documentos,
      atualizadoEm: new Date().toISOString(),
      versao: Number(current.versao || 0) + 1
    };
    store.auditoria.unshift(createAuditEntry({
      processoId: current.id,
      ...auditActor,
      acao: "Anexo de documento",
      detalhes: `Documento ${documentKey} anexado.`,
      documento: {
        chave: documentKey,
        nome: documentInfo.titulo || documentInfo.fileName,
        fileName: documentInfo.fileName,
        path: documentInfo.path,
        mimeType: documentInfo.mimeType
      }
    }));
    try {
      await writeStore(store);
    } catch (error) {
      await deleteUploadFile(storedPath, { root: UPLOAD_ROOT }).catch(() => null);
      throw error;
    }
    if (replacedDocumentPath && replacedDocumentPath !== documentInfo.path) {
      await removeUploadedFile(replacedDocumentPath).catch((error) => {
        logError("replaced_upload_cleanup_failed", { path: replacedDocumentPath, message: error.message });
      });
    }
    sendJson(res, 200, enrichProcess(store.processos[index]));
    return;
  }

  const documentItemMatch = url.pathname.match(/^\/api\/processes\/([^/]+)\/documents\/([^/]+)$/);
  if (documentItemMatch && req.method === "DELETE") {
    const index = store.processos.findIndex((processo) => processo.id === documentItemMatch[1]);
    if (index === -1) {
      sendJson(res, 404, { error: "Processo nao encontrado" });
      return;
    }

    const current = store.processos[index];
    if (!canEditProcess(current, role)) {
      sendJson(res, 403, { error: "Seu perfil nao pode remover documentos deste processo." });
      return;
    }
    const documentKey = decodeURIComponent(documentItemMatch[2]);
    if (!canRemoveDocument(current, documentKey)) {
      sendJson(res, 400, { error: "Este documento nao pode ser removido neste momento." });
      return;
    }

    const documentos = { ...(current.documentos || {}) };
    const complementaryMatch = documentKey.match(/^complementares:(\d+)$/);
    let removedDocument;
    if (complementaryMatch) {
      const items = Array.isArray(documentos.complementares)
        ? [...documentos.complementares]
        : (documentos.complementares ? [documentos.complementares] : []);
      const itemIndex = Number(complementaryMatch[1]);
      if (!items[itemIndex]) {
        sendJson(res, 404, { error: "Documento nao encontrado" });
        return;
      }
      removedDocument = items[itemIndex];
      items.splice(itemIndex, 1);
      if (items.length) documentos.complementares = items;
      else delete documentos.complementares;
    } else if (!documentos[documentKey]) {
      sendJson(res, 404, { error: "Documento nao encontrado" });
      return;
    } else {
      removedDocument = documentos[documentKey];
      delete documentos[documentKey];
    }

    store.processos[index] = {
      ...current,
      documentos,
      atualizadoEm: new Date().toISOString(),
      versao: Number(current.versao || 0) + 1
    };
    store.auditoria.unshift(createAuditEntry({
      processoId: current.id,
      ...auditActor,
      acao: "Remocao de documento",
      detalhes: `Documento ${documentKey} removido.`
    }));
    await writeStore(store);
    const removedDocumentPath = normalizeDocumentEntry(removedDocument).path;
    await removeUploadedFile(removedDocumentPath).catch((error) => {
      logError("removed_upload_cleanup_failed", { path: removedDocumentPath, message: error.message });
    });
    sendJson(res, 200, enrichProcess(store.processos[index]));
    return;
  }

  const completeDownloadMatch = url.pathname.match(/^\/api\/processes\/([^/]+)\/download$/);
  if (completeDownloadMatch && req.method === "GET") {
    const processo = store.processos.find((item) => item.id === completeDownloadMatch[1]);
    if (!processo) {
      sendJson(res, 404, { error: "Processo nao encontrado" });
      return;
    }
    if (activeCompiledDownloads >= MAX_CONCURRENT_COMPILED_DOWNLOADS) {
      sendJson(res, 429, { error: "Ha muitos downloads sendo compilados. Tente novamente em instantes." });
      return;
    }
    const payload = {
      geradoEm: new Date().toISOString(),
      processo: enrichProcess(processo),
      documentos: processo.documentos || {},
      observacoes: store.observacoes.filter((item) => item.processoId === processo.id),
      auditoria: store.auditoria.filter((item) => item.processoId === processo.id)
    };
    const fileName = safeName(processo.numeroProcesso || processo.id);
    const format = String(url.searchParams.get("format") || "zip").toLowerCase();
    activeCompiledDownloads += 1;
    try {
      if (format === "pdf") {
        const documents = await processDocumentEntries(processo);
        const pdf = await createCompiledPdf(documents, payload);
        res.writeHead(200, {
          "content-type": "application/pdf",
          "content-disposition": `attachment; filename="${fileName}-processo-compilado.pdf"`
        });
        res.end(pdf);
        return;
      }
      const entries = await processDownloadEntries(processo, payload);
      const zip = createZip(entries);
      res.writeHead(200, {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="${fileName}-processo-completo.zip"`
      });
      res.end(zip);
    } finally {
      activeCompiledDownloads -= 1;
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/suppliers") {
    if (!["admin", "almoxarifado"].includes(role)) {
      sendJson(res, 403, { error: "Seu perfil possui acesso somente para consulta." });
      return;
    }
    const body = await readJson(req);
    const razaoSocial = String(body.razaoSocial || "").trim();
    if (!razaoSocial) {
      sendJson(res, 400, { error: "Informe o nome do fornecedor." });
      return;
    }

    const index = store.fornecedores.findIndex((fornecedor) => normalizeText(fornecedor.razaoSocial) === normalizeText(razaoSocial));
    const current = index >= 0 ? store.fornecedores[index] : {};
    const updated = normalizeSupplier({
      ...current,
      id: current.id || crypto.randomUUID(),
      razaoSocial,
      emails: mergeList(current.emails || current.email, body.emails),
      telefones: mergeList(current.telefones || current.telefone, body.telefones),
      enderecos: mergeList(current.enderecos || current.endereco, body.enderecos),
      observacoes: mergeText(current.observacoes, body.observacoes),
      atualizadoEm: new Date().toISOString(),
      criadoEm: current.criadoEm || new Date().toISOString()
    });

    if (index >= 0) store.fornecedores[index] = updated;
    else store.fornecedores.push(updated);
    await writeStore(store, [transactionalSecurityEvent("supplier_upserted", {
      ...securityActor,
      metadata: { supplierId: updated.id, created: index < 0 }
    })]);
    sendJson(res, index >= 0 ? 200 : 201, updated);
    return;
  }

  sendJson(res, 404, { error: "Rota nao encontrada" });
}

export function requiresAdmin(method = "", pathname = "") {
  if (pathname === "/api/emails/run-due") return true;
  if (pathname === "/api/emails/status") return true;
  if (pathname.startsWith("/api/settings")) return true;
  if (pathname.startsWith("/api/admin/")) return true;
  if (pathname.endsWith("/timeline-items")) return true;
  return false;
}

export function roleCanMutate(role = "") {
  return ["admin", "almoxarifado"].includes(String(role).trim().toLowerCase());
}

function normalizeManagedRole(role = "") {
  const value = String(role).trim().toLowerCase();
  return ["admin", "almoxarifado", "auditor"].includes(value) ? value : "";
}

function requiresAuditAccess(method = "", pathname = "") {
  return String(method).toUpperCase() === "GET" && ["/api/audit", "/api/emails/history", "/api/security-audit"].includes(pathname);
}

async function reserveLoginAttempt(req, email = "") {
  const [accountAllowed, ipAllowed] = await Promise.all([
    consumeRateLimitAttempt(
      loginAccountKey(email),
      LOGIN_RATE_LIMIT_WINDOW_MS,
      LOGIN_RATE_LIMIT_MAX
    ),
    consumeRateLimitAttempt(
      loginIpKey(req),
      LOGIN_RATE_LIMIT_WINDOW_MS,
      Math.max(LOGIN_RATE_LIMIT_MAX * 10, LOGIN_RATE_LIMIT_MAX)
    )
  ]);
  return accountAllowed && ipAllowed;
}

async function clearSuccessfulLogin(req, email = "") {
  await Promise.all([
    clearRateLimit(loginAccountKey(email)),
    clearRateLimit(loginIpKey(req))
  ]);
}

function loginAccountKey(email = "") {
  const normalized = normalizeEmail(email) || "unknown";
  const digest = createHash("sha256").update(normalized).digest("hex");
  return `login:account:${digest}`;
}

function loginIpKey(req) {
  return `login:ip:${clientIp(req)}`;
}

function clientIp(req) {
  const forwardedFor = TRUST_PROXY ? String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() : "";
  return forwardedFor || req.socket?.remoteAddress || "unknown";
}

async function ensureUsers(store) {
  if (!Array.isArray(store.usuarios)) store.usuarios = [];
  if (localAdminBootstrapped || !LOCAL_ADMIN_EMAIL || !LOCAL_ADMIN_PASSWORD) return;
  if (!isValidPassword(LOCAL_ADMIN_PASSWORD)) {
    throw new Error(`LOCAL_ADMIN_PASSWORD invalida. ${passwordPolicyMessage()}`);
  }

  // Bootstrap local-only admin account from explicit environment variables.
  const existingAdmin = store.usuarios.find((user) => normalizeEmail(user.email) === LOCAL_ADMIN_EMAIL);
  if (existingAdmin) {
    localAdminBootstrapped = true;
    return;
  } else {
    const localAdmin = {
      id: `admin-${crypto.randomUUID()}`,
      nome: "Administrador Almoxarifado",
      email: LOCAL_ADMIN_EMAIL,
      origemCadastro: "local",
      senhaHash: await hashPassword(LOCAL_ADMIN_PASSWORD),
      precisaDefinirSenha: true,
      authVersion: 1,
      ativo: true,
      role: "admin",
      criadoEm: new Date().toISOString()
    };
    store.usuarios.push(localAdmin);
    await writeStore(store, [transactionalSecurityEvent("local_admin_bootstrapped", {
      actorEmail: LOCAL_ADMIN_EMAIL,
      targetUserId: localAdmin.id,
      metadata: { firstPasswordRequired: true }
    })]);
  }
  localAdminBootstrapped = true;
}

function createSession(user) {
  return createSessionRecord(user.id, SESSION_TIMEOUT_MS, positiveAuthVersion(user.authVersion));
}

async function sessionUser(req) {
  const token = bearerToken(req);
  if (!token) return null;
  return resolveSessionUser(token, SESSION_TIMEOUT_MS);
}

function bearerToken(req) {
  const header = String(req.headers.authorization || "");
  if (header.startsWith("Bearer ")) return header.slice(7);
  return sessionCookie(req);
}

function usesCookieSession(req) {
  return !String(req.headers.authorization || "").startsWith("Bearer ") && Boolean(sessionCookie(req));
}

function sessionCookie(req) {
  const cookies = String(req.headers.cookie || "").split(";");
  for (const cookie of cookies) {
    const separator = cookie.indexOf("=");
    if (separator < 0) continue;
    if (cookie.slice(0, separator).trim() === "almox_session") {
      try {
        return decodeURIComponent(cookie.slice(separator + 1).trim());
      } catch {
        return "";
      }
    }
  }
  return "";
}

function setSessionCookie(res, token) {
  const maxAge = Math.max(1, Math.floor(SESSION_COOKIE_MAX_AGE_MS / 1000));
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader("set-cookie", `almox_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`);
}

function clearSessionCookie(res) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader("set-cookie", `almox_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`);
}

function isSameOriginMutation(req) {
  const origin = String(req.headers.origin || "");
  const host = String(req.headers.host || "");
  if (!origin || !host) return false;
  try {
    const parsed = new URL(origin);
    const expectedProtocol = process.env.NODE_ENV === "production" ? "https:" : parsed.protocol;
    return parsed.host === host && parsed.protocol === expectedProtocol;
  } catch {
    return false;
  }
}

function publicUser(user) {
  return {
    nome: user.nome,
    email: user.email,
    foto: user.foto || "",
    role: resolveRole(user),
    precisaDefinirSenha: Boolean(user.precisaDefinirSenha)
  };
}

function normalizeProfilePhotoDataUrl(value = "") {
  const match = String(value).match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) return "";
  const [, imageType, encoded] = match;
  const buffer = Buffer.from(encoded, "base64");
  if (!buffer.length || buffer.length > PROFILE_PHOTO_MAX_BYTES) return "";
  const validSignature = imageType === "png"
    ? buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    : imageType === "jpeg"
      ? buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
      : buffer.length >= 12
        && buffer.subarray(0, 4).toString("ascii") === "RIFF"
        && buffer.subarray(8, 12).toString("ascii") === "WEBP";
  if (!validSignature) return "";
  return `data:image/${imageType};base64,${buffer.toString("base64")}`;
}

function normalizeEmail(email = "") {
  return String(email).trim().toLowerCase();
}

export function resolveEmailConfiguration(env = {}) {
  const authUser = String(env.SMTP_USER || env.GMAIL_USER || "").trim();
  const authPassword = String(env.SMTP_PASS || env.GMAIL_APP_PASSWORD || "");
  const fromAddress = normalizeEmail(env.EMAIL_FROM_ADDRESS || env.GMAIL_USER || "");
  return {
    authUser,
    authPassword,
    fromAddress,
    configured: Boolean(authUser && authPassword && isSafeEmailAddress(fromAddress))
  };
}

function resolveRole(user = {}) {
  const explicit = String(user.role || "").trim().toLowerCase();
  if (["admin", "almoxarifado", "auditor"].includes(explicit)) return explicit;
  return ADMIN_EMAILS.has(normalizeEmail(user.email || "")) ? "admin" : "almoxarifado";
}

function parseList(value = "") {
  return String(value)
    .split(",")
    .map((item) => normalizeEmail(item))
    .filter(Boolean);
}

function positiveRuntimeInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export { isValidPassword };

function passwordPolicyMessage() {
  return PASSWORD_POLICY_MESSAGE;
}

async function serveStatic(req, res, pathname) {
  const method = String(req.method || "GET").toUpperCase();
  if (!["GET", "HEAD"].includes(method)) {
    res.setHeader("allow", "GET, HEAD");
    sendJson(res, 405, { error: "Metodo nao permitido para arquivos publicos." });
    return;
  }
  const safePath = isSpaNavigationPath(pathname) ? "index.html" : pathname.replace(/^\/+/, "");
  const fullPath = normalize(join(ROOT, safePath));

  if (!isPathWithin(ROOT, fullPath)) {
    sendText(res, 403, "Acesso negado");
    return;
  }

  await serveFile(res, fullPath, {
    "cache-control": safePath === "index.html" ? "no-cache" : "public, max-age=60, must-revalidate",
    "cross-origin-opener-policy": "same-origin-allow-popups",
    "referrer-policy": "strict-origin-when-cross-origin"
  }, { request: req, etag: true, root: ROOT });
}

async function serveUpload(req, res, pathname) {
  if (!["GET", "HEAD"].includes(String(req.method || "GET").toUpperCase())) {
    res.setHeader("allow", "GET, HEAD");
    sendJson(res, 405, { error: "Metodo nao permitido para documentos." });
    return;
  }
  const user = await sessionUser(req);
  if (!user) {
    sendJson(res, 401, { error: "Faca login para acessar documentos." });
    return;
  }
  const reference = await resolveUploadReference(pathname);
  if (!reference) {
    sendJson(res, 404, { error: "Documento nao encontrado ou removido." });
    return;
  }
  if (reference.ambiguous) {
    sendJson(res, 409, { error: "Ha mais de uma referencia para este caminho de documento. Corrija os metadados antes de acessa-lo." });
    return;
  }
  if (reference.scope === "template" && resolveRole(user) !== "admin") {
    sendJson(res, 403, { error: "Acesso negado." });
    return;
  }
  await streamUploadTo(res, reference.path, {
    "cache-control": "private, no-store",
    "content-type": documentContentType(reference),
    "content-disposition": documentContentDisposition(documentDownloadFileName(reference))
  }, {
    request: req,
    root: UPLOAD_ROOT,
    mode: 0o600,
    notFoundStatus: 410,
    notFoundMessage: "O arquivo anexado nao esta disponivel no armazenamento. E necessario anexa-lo novamente."
  });
}

async function resolveUploadReference(pathname) {
  const requestedPath = comparableUploadPath(pathname);
  if (!requestedPath) return null;
  const revision = await readStoreRevision();
  if (uploadReferenceCache.references && uploadReferenceCache.revision === revision) {
    return uploadReferenceCache.references.get(requestedPath) || null;
  }
  if (uploadReferenceCache.pending?.revision === revision) {
    return (await uploadReferenceCache.pending.promise).get(requestedPath) || null;
  }

  const generation = uploadReferenceCache.generation;
  const promise = Promise.all([readProcessesStore(), readSettingsStore()]).then(([processStore, settingsStore]) => {
    const references = buildUploadReferenceMap({
      processos: processStore.processos,
      configuracoes: settingsStore.configuracoes
    });
    if (uploadReferenceCache.generation === generation) {
      uploadReferenceCache.revision = revision;
      uploadReferenceCache.references = references;
    }
    return references;
  });
  const pending = { revision, promise };
  uploadReferenceCache.pending = pending;
  try {
    return (await promise).get(requestedPath) || null;
  } finally {
    if (uploadReferenceCache.pending === pending) uploadReferenceCache.pending = null;
  }
}

function buildUploadReferenceMap(store) {
  const references = new Map();
  for (const processo of store.processos || []) {
    for (const attachment of documentEntries(processo.documentos)) {
      addUploadReference(references, attachment, "process");
    }
  }
  for (const template of Object.values(store.configuracoes?.emailTemplates || {})) {
    for (const attachment of template.anexos || []) {
      addUploadReference(references, attachment, "template");
    }
  }
  return references;
}

function addUploadReference(references, rawAttachment, scope) {
  const attachment = normalizeDocumentEntry(rawAttachment);
  const comparablePath = comparableUploadPath(attachment.path);
  if (!comparablePath) return;
  const candidate = { ...attachment, scope };
  const existing = references.get(comparablePath);
  if (!existing) {
    references.set(comparablePath, candidate);
    return;
  }
  if (existing.ambiguous || existing.path !== candidate.path) {
    references.set(comparablePath, {
      path: candidate.path,
      scope: existing.scope === "template" || scope === "template" ? "template" : "process",
      ambiguous: true
    });
    return;
  }
  if (existing.scope === "template" || scope === "template") {
    references.set(comparablePath, { ...(scope === "template" ? candidate : existing), scope: "template" });
  }
}

function comparableUploadPath(value = "") {
  const path = String(value || "");
  if (!path.startsWith("/uploads/") || path.includes("\0")) return "";
  try {
    return decodeURIComponent(path).normalize("NFC");
  } catch {
    return "";
  }
}

async function serveFavicon(req, res) {
  await serveFile(res, FAVICON_FILE, {
    "cache-control": "public, max-age=300, must-revalidate"
  }, { request: req, etag: true });
}

async function removeUploadedFile(uploadPath = "") {
  return deleteUploadFile(uploadPath, { root: UPLOAD_ROOT });
}

export async function serveFile(res, filePath, extraHeaders = {}, options = {}) {
  let opened;
  let responseStarted = false;
  try {
    opened = await openRegularFileNoFollow(filePath, {
      root: options.root,
      mode: options.mode
    });
    const metadata = opened.metadata;
    const responseHeaders = {
      "content-type": contentTypeForPath(filePath),
      ...extraHeaders
    };
    if (options.etag) {
      responseHeaders.etag = `W/"${metadata.size.toString(16)}-${Math.trunc(metadata.mtimeMs).toString(16)}"`;
      if (String(options.request?.headers?.["if-none-match"] || "") === responseHeaders.etag) {
        res.writeHead(304, responseHeaders);
        res.end();
        return;
      }
    }
    res.writeHead(200, {
      ...responseHeaders,
      "content-length": metadata.size
    });
    responseStarted = true;
    if (String(options.request?.method || "GET").toUpperCase() === "HEAD" || metadata.size === 0) {
      res.end();
      return;
    }
    const stream = opened.handle.createReadStream({
      autoClose: false,
      start: 0,
      end: metadata.size - 1
    });
    if (typeof res.write === "function" && typeof res.on === "function") {
      await pipeline(stream, res);
      return;
    }
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    res.end(Buffer.concat(chunks));
  } catch (error) {
    if (error.code === "ENOENT") {
      if (options.notFoundMessage) {
        sendJson(res, options.notFoundStatus || 404, { error: options.notFoundMessage });
      } else {
        sendText(res, 404, "Arquivo nao encontrado");
      }
      return;
    }
    if (error instanceof UnsafeFilePathError || error.code === "ELOOP") {
      sendText(res, 403, "Acesso negado");
      return;
    }
    if (responseStarted) {
      res.destroy?.(error);
      return;
    }
    throw error;
  } finally {
    await opened?.handle.close().catch(() => null);
  }
}

export function contentTypeForPath(pathname = "") {
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".pdf": "application/pdf",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xls": "application/vnd.ms-excel",
    ".csv": "text/csv; charset=utf-8",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".doc": "application/msword",
    ".odt": "application/vnd.oasis.opendocument.text",
    ".ods": "application/vnd.oasis.opendocument.spreadsheet",
    ".txt": "text/plain; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp"
  }[extname(pathname).toLowerCase()] || "application/octet-stream";
}

function documentContentType(reference = {}) {
  const storedMime = String(reference.mimeType || "").split(";", 1)[0].trim().toLowerCase();
  if (ALLOWED_STORED_DOCUMENT_MIMES.has(storedMime)) {
    return ["text/csv", "application/csv", "text/plain"].includes(storedMime) ? `${storedMime}; charset=utf-8` : storedMime;
  }
  const byName = contentTypeForPath(reference.fileName || "");
  if (byName !== "application/octet-stream") return byName;
  return contentTypeForPath(reference.path || "");
}

async function readJson(req, maxBytes = MAX_JSON_BODY_BYTES) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      const error = new Error("Payload muito grande.");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      const error = new Error("O corpo da requisicao deve ser um objeto JSON.");
      error.statusCode = 400;
      throw error;
    }
    return parsed;
  } catch (error) {
    if (error.statusCode) throw error;
    const invalidJson = new Error("JSON invalido.");
    invalidJson.statusCode = 400;
    throw invalidJson;
  }
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function sendText(res, statusCode, payload) {
  res.writeHead(statusCode, { "content-type": "text/plain; charset=utf-8" });
  res.end(payload);
}

function applySecurityHeaders(res) {
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("strict-transport-security", "max-age=31536000; includeSubDomains");
  res.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; frame-src blob:; connect-src 'self'; img-src 'self' blob: data: https:; style-src 'self' 'unsafe-inline'");
  res.setHeader("referrer-policy", "strict-origin-when-cross-origin");
  res.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=()");
}

function decodeUploadContent(contentBase64 = "") {
  if (typeof contentBase64 !== "string") {
    const error = new Error("Conteudo Base64 invalido.");
    error.statusCode = 400;
    throw error;
  }
  const encoded = contentBase64.trim();
  const maximumEncodedLength = Math.ceil(MAX_UPLOAD_BYTES / 3) * 4 + 4;
  if (encoded.length > maximumEncodedLength) {
    const error = new Error("Arquivo acima do limite permitido.");
    error.statusCode = 413;
    throw error;
  }
  if (!encoded || encoded.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    const error = new Error("Conteudo Base64 invalido.");
    error.statusCode = 400;
    throw error;
  }
  const content = Buffer.from(encoded, "base64");
  if (content.toString("base64") !== encoded) {
    const error = new Error("Conteudo Base64 invalido.");
    error.statusCode = 400;
    throw error;
  }
  if (content.length > MAX_UPLOAD_BYTES) {
    const error = new Error("Arquivo acima do limite permitido.");
    error.statusCode = 413;
    throw error;
  }
  return content;
}

function uploadMetadataError(body = {}, options = {}) {
  const fileName = String(body.fileName || "").trim();
  const mimeType = String(body.mimeType || "").trim();
  if (!fileName || fileName.length > MAX_UPLOAD_FILENAME_LENGTH) {
    return `O nome do arquivo deve ter entre 1 e ${MAX_UPLOAD_FILENAME_LENGTH} caracteres.`;
  }
  if (mimeType.length > MAX_UPLOAD_MIME_LENGTH) {
    return `O tipo MIME deve ter no maximo ${MAX_UPLOAD_MIME_LENGTH} caracteres.`;
  }
  if (options.complementary) {
    const title = String(body.titulo || "").trim();
    const description = String(body.descricao || "").trim();
    if (title.length > MAX_COMPLEMENT_TITLE_LENGTH) {
      return `O titulo deve ter no maximo ${MAX_COMPLEMENT_TITLE_LENGTH} caracteres.`;
    }
    if (description.length > MAX_COMPLEMENT_DESCRIPTION_LENGTH) {
      return `A descricao deve ter no maximo ${MAX_COMPLEMENT_DESCRIPTION_LENGTH} caracteres.`;
    }
  }
  return "";
}

async function handleHealth(res, pathname = "/health") {
  if (pathname === "/health/live") {
    sendJson(res, 200, publicHealthPayload("live"));
    return;
  }
  const storageBackend = databaseConfigured() ? "postgres" : "json";
  const uploadStartup = uploadStorageReadinessState();
  const uploadStartupReady = process.env.NODE_ENV !== "production" || uploadStartup.ready;
  const checks = {
    storage: storageBackend === "json" && process.env.NODE_ENV !== "production",
    storageBackend,
    uploads: {
      ok: process.env.NODE_ENV !== "production",
      ready: uploadStartupReady,
      stage: uploadStartup.stage,
      referenced: 0,
      available: 0,
      missing: 0
    },
    emailConfigured: EMAIL_CONFIGURATION.configured,
    schedulerRunning: emailSchedulerRunning,
    scheduler: emailSchedulerHealthStatus()
  };
  if (storageBackend === "postgres") {
    try {
      const result = await query("SELECT revision FROM app_state_revision WHERE id = true LIMIT 1");
      checks.storage = Boolean(result.rows[0]);
    } catch {
      checks.storage = false;
    }
  }
  if (process.env.NODE_ENV === "production" && checks.storage && uploadStartupReady) {
    checks.uploads = uploadIntegrityForHealth({ backend: UPLOAD_STORAGE_BACKEND, root: UPLOAD_ROOT });
  }
  const ok = pathname === "/health/ready"
    ? readinessChecksPass(checks, {
      nodeEnvironment: process.env.NODE_ENV,
      uploadStartupReady,
      applicationStartupComplete
    })
    : checks.storage && checks.uploads.ok && checks.emailConfigured && !checks.scheduler.degraded;
  // Keep dependency details in internal logs. Public probes only need a stable
  // status code and a deploy identifier to correlate an incident with a build.
  sendJson(res, ok ? 200 : 503, publicHealthPayload(
    ok ? (pathname === "/health/ready" ? "ready" : "ok") : "unavailable"
  ));
}

export function resolvePublicAppVersion(environment = {}) {
  const value = String(environment.APP_VERSION || environment.GIT_COMMIT_SHA || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{6,63}$/.test(value)) return null;
  return value.slice(0, 16);
}

export function publicHealthPayload(status, version = APP_VERSION) {
  return {
    status,
    ...(version ? { version } : {})
  };
}

export function uploadIntegrityForHealth(options = {}) {
  const state = options.integrityState || uploadIntegrityState(options);
  const production = (options.nodeEnvironment || process.env.NODE_ENV) === "production";
  if (production && state.stale) {
    const refresh = options.refresh || refreshUploadIntegrityInBackground;
    void refresh(options).catch((error) => {
      logError("upload_storage_integrity_refresh_failed", {
        message: safeStartupErrorMessage(error)
      });
    });
  }
  return state.result || { ok: false, referenced: 0, available: 0, missing: null };
}

export function readinessChecksPass(checks, options = {}) {
  const production = options.nodeEnvironment === "production";
  return Boolean(
    checks?.storage
    && checks?.uploads?.ok
    && options.uploadStartupReady !== false
    && options.applicationStartupComplete !== false
    && (!production || checks?.storageBackend === "postgres")
  );
}

function safeStartupErrorMessage(error) {
  return sanitizeLogValue(error?.message || "Erro desconhecido").slice(0, 500);
}

function logStartupFailure(error) {
  logError("application_startup_failed", {
    stage: error?.databaseState === "schema_incomplete"
      ? "database_schema"
      : (error?.databaseState === "unavailable" ? "database_connectivity" : "application"),
    statusCode: error?.statusCode || 500,
    message: safeStartupErrorMessage(error),
    ...(error?.databaseTarget ? { database: error.databaseTarget } : {}),
    ...(error?.schema ? { schema: error.schema } : {}),
    ...(Array.isArray(error?.missingObjects) && error.missingObjects.length ? { missingObjects: error.missingObjects } : {}),
    ...(error?.pendingMigration ? { pendingMigration: error.pendingMigration } : {}),
    ...(error?.suggestedAction ? { action: error.suggestedAction } : {})
  });
}

function logInfo(event, data = {}) {
  console.log(JSON.stringify({
    level: "info",
    event: sanitizeLogValue(event),
    at: new Date().toISOString(),
    ...sanitizeLogData(data)
  }));
}

export function logStartupReady(details = {}) {
  logInfo("application_started", {
    storageBackend: details.storeBackend,
    uploadBackend: details.uploadBackend,
    port: details.port,
    startupDurationMs: details.startupDurationMs
  });
}

function logFirstRequestCompleted(details = {}) {
  if (firstRequestCompletedLogged) return;
  firstRequestCompletedLogged = true;
  logInfo("first_request_completed", {
    method: details.method,
    path: details.path,
    statusCode: details.statusCode,
    durationMs: details.durationMs
  });
}

function logError(event, data = {}) {
  console.error(JSON.stringify({
    level: "error",
    event: sanitizeLogValue(event),
    at: new Date().toISOString(),
    ...sanitizeLogData(data)
  }));
}

const SENSITIVE_LOG_KEY = /password|passwd|secret|token|authorization|cookie|api[_-]?key|connection(?:[_-]?string)?|database[_-]?url|refresh/i;

export function sanitizeLogData(value, key = "") {
  if (SENSITIVE_LOG_KEY.test(key)) return "[redacted]";
  if (isOperationalRouteKey(key)) {
    const route = safeOperationalRoute(value);
    if (route) return route;
  }
  if (typeof value === "string") return sanitizeLogValue(value);
  if (value instanceof Error) return sanitizeLogValue(value.message);
  if (Array.isArray(value)) return value.map((entry) => sanitizeLogData(entry));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [
      entryKey,
      sanitizeLogData(entryValue, entryKey)
    ]));
  }
  return value;
}

export function sanitizeLogValue(value) {
  const withoutHeaders = String(value)
    .replace(/\b((?:proxy-)?authorization)\s*[:=]\s*(?:bearer|basic)\s+[^\s,;]+/gi, "$1=[redacted]")
    .replace(/\b((?:set-)?cookie)\s*:\s*[^\r\n]+/gi, "$1=[redacted]");
  return sanitizeQueryPairs(withoutHeaders)
    .replace(/postgres(?:ql)?:\/\/[^\s'"`<>]+/gi, "[database-url-redacted]")
    .replace(
      /\b(?:password|passwd|cookie|(?:client[_-]?)?secret|(?:[A-Za-z0-9]+[_-]?)?token|api[_-]?key|connection(?:[_-]?string)?|database[_-]?url)\s*[=:]\s*[^\s,;&]+/gi,
      (match) => `${match.split(/[=:]/, 1)[0]}=[redacted]`
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [redacted]")
    .replace(/\b(?:ya29\.|1\/\/)[A-Za-z0-9._-]+/g, "[token-redacted]")
    .replace(/(?<![:/])(?:file:\/\/)?\/(?:[^\s():]+\/)+[^\s():]+/g, "[path-redacted]")
    .slice(0, 4_000);
}

function sanitizeQueryPairs(value) {
  return value.replace(/(^|[?&])([^?&#=\s]+)=([^&#\s'"`<>]*)/g, (match, prefix, rawKey, rawValue) => (
    sensitiveQueryKey(rawKey) ? `${prefix}${rawKey}=[redacted]` : `${prefix}${rawKey}=${rawValue}`
  ));
}

function sensitiveQueryKey(rawKey) {
  let key = String(rawKey).replace(/\+/g, " ");
  try {
    key = decodeURIComponent(key);
  } catch {
    // Preserve malformed keys for logs; they cannot bypass the literal checks.
  }
  key = key.trim().toLowerCase();
  return [
    "client_secret", "clientsecret", "password", "passwd", "authorization",
    "cookie", "set-cookie", "api_key", "apikey", "code", "state"
  ].includes(key) || key.endsWith("_token") || key.endsWith("-token") || /(?:access|refresh|id|session|auth)token$/.test(key);
}

function isOperationalRouteKey(key) {
  return ["path", "route", "requestpath", "request_path", "pathname", "urlpath", "url_path"].includes(String(key).toLowerCase());
}

function safeOperationalRoute(value) {
  const route = String(value || "").split(/[?#]/, 1)[0];
  if (!route.startsWith("/") || route.startsWith("//") || route.includes("\\") || /(?:^|\/)\.\.?($|\/)/.test(route)) return null;
  if (/^\/(?:tmp|home|var|etc|data)(?:\/|$)/.test(route)) return null;
  return route;
}

async function recordSecurityEventSafely(eventType, event = {}) {
  try {
    return await recordSecurityEvent(eventType, event);
  } catch (error) {
    logError("security_audit_write_failed", { eventType, message: error.message });
    return null;
  }
}

export function errorResponsePayload(error) {
  if (error.statusCode) {
    return { error: error.message };
  }
  return { error: "Erro interno do servidor" };
}

function isMainModule() {
  return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
}

function resolveUploadRoot(pathText) {
  if (!pathText) return fileURLToPath(new URL("../uploads/", import.meta.url));
  if (pathText.startsWith("/")) return pathText;
  return fileURLToPath(new URL(pathText, `file://${process.cwd()}/`));
}

function isPathWithin(root, candidate) {
  let normalizedRoot = normalize(root);
  while (normalizedRoot.length > 1 && normalizedRoot.endsWith(sep)) normalizedRoot = normalizedRoot.slice(0, -1);
  const normalizedCandidate = normalize(candidate);
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${sep}`);
}

function emailStatusPayload() {
  return {
    enabled: EMAIL_CONFIGURATION.configured,
    host: SMTP_HOST,
    port: SMTP_PORT,
    user: EMAIL_FROM_ADDRESS,
    fromAddress: EMAIL_FROM_ADDRESS,
    fromName: EMAIL_FROM_NAME,
    simulationRecipient: EMAIL_TEST_RECIPIENT,
    mode: "producao",
    schedulerRunning: emailSchedulerRunning,
    scheduler: emailSchedulerHealthStatus()
  };
}

function startEmailScheduler() {
  if (emailSchedulerRunning) return;
  emailSchedulerRunning = true;
  emailSchedulerState.startedAt = new Date().toISOString();
  emailSchedulerTimeout = setTimeout(() => {
    runScheduledEmailNotifications().catch((error) => {
      logError("email_scheduler_failed", { message: error.message });
    });
  }, EMAIL_SCHEDULER_START_DELAY_MS);
  emailSchedulerInterval = setInterval(() => {
    runScheduledEmailNotifications().catch((error) => {
      logError("email_scheduler_failed", { message: error.message });
    });
  }, EMAIL_CHECK_INTERVAL_MS);
}

function runScheduledEmailNotifications() {
  if (emailSchedulerPromise) return emailSchedulerPromise;
  emailSchedulerState.lastRunStartedAt = new Date().toISOString();
  emailSchedulerPromise = runDueEmailNotifications()
    .then((result) => {
      const finishedAt = new Date().toISOString();
      if (result.ok) {
        emailSchedulerState.lastSuccessAt = finishedAt;
        emailSchedulerState.consecutiveErrors = 0;
      } else {
        emailSchedulerState.lastErrorAt = finishedAt;
        emailSchedulerState.consecutiveErrors += 1;
      }
      return result;
    }, (error) => {
      emailSchedulerState.lastErrorAt = new Date().toISOString();
      emailSchedulerState.consecutiveErrors += 1;
      throw error;
    })
    .finally(() => {
      emailSchedulerPromise = undefined;
    });
  return emailSchedulerPromise;
}

export function emailSchedulerHealthStatus(state = emailSchedulerState, now = Date.now(), running = emailSchedulerRunning) {
  const schedulerAgeMs = ageInMilliseconds(state.startedAt, now);
  const lastRunAgeMs = ageInMilliseconds(state.lastRunStartedAt, now);
  const lastSuccessAgeMs = ageInMilliseconds(state.lastSuccessAt, now);
  const lastErrorAgeMs = ageInMilliseconds(state.lastErrorAt, now);
  const startupGraceExpired = running
    && lastRunAgeMs === null
    && schedulerAgeMs !== null
    && schedulerAgeMs > EMAIL_SCHEDULER_GRACE_PERIOD_MS;
  const stale = running
    && lastRunAgeMs !== null
    && lastRunAgeMs > EMAIL_SCHEDULER_STALE_AFTER_MS;
  const errorAfterLastSuccess = lastErrorAgeMs !== null && (
    lastSuccessAgeMs === null || Date.parse(state.lastErrorAt) > Date.parse(state.lastSuccessAt)
  );
  const persistentError = errorAfterLastSuccess && (
    Number(state.consecutiveErrors || 0) >= EMAIL_SCHEDULER_PERSISTENT_ERROR_COUNT
      || lastErrorAgeMs > EMAIL_SCHEDULER_GRACE_PERIOD_MS
  );
  const degraded = !running || startupGraceExpired || stale || persistentError;
  let status = "starting";
  if (!running) status = "stopped";
  else if (degraded) status = "degraded";
  else if (errorAfterLastSuccess) status = "warning";
  else if (state.lastRunStartedAt) status = "healthy";
  return {
    running,
    status,
    degraded,
    startedAt: state.startedAt || null,
    lastRunStartedAt: state.lastRunStartedAt || null,
    lastSuccessAt: state.lastSuccessAt || null,
    lastErrorAt: state.lastErrorAt || null,
    schedulerAgeMs,
    lastRunAgeMs,
    lastSuccessAgeMs,
    lastErrorAgeMs,
    consecutiveErrors: Number(state.consecutiveErrors || 0)
  };
}

function ageInMilliseconds(timestamp, now = Date.now()) {
  if (!timestamp) return null;
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, now - parsed);
}

function startMaintenance() {
  cleanupExpiredSessions().catch((error) => logError("session_cleanup_failed", { message: error.message }));
  cleanupRateLimits().catch((error) => logError("rate_limit_cleanup_failed", { message: error.message }));
  maintenanceInterval = setInterval(() => {
    cleanupExpiredSessions().catch((error) => logError("session_cleanup_failed", { message: error.message }));
    cleanupRateLimits().catch((error) => logError("rate_limit_cleanup_failed", { message: error.message }));
  }, 24 * 60 * 60 * 1000);
  maintenanceInterval.unref();
}

async function gracefulShutdown(signal) {
  logInfo("shutdown_started", { signal });
  emailSchedulerRunning = false;
  clearTimeout(emailSchedulerTimeout);
  clearInterval(emailSchedulerInterval);
  clearInterval(maintenanceInterval);
  const forceExit = setTimeout(() => process.exit(1), 10_000);
  forceExit.unref();
  server.close(async () => {
    if (emailSchedulerPromise) {
      await emailSchedulerPromise.catch((error) => logError("email_shutdown_wait_failed", { message: error.message }));
    }
    await closePool().catch((error) => logError("database_close_failed", { message: error.message }));
    clearTimeout(forceExit);
    process.exit(0);
  });
}

async function runDueEmailNotifications(options = {}) {
  const store = await readStore();
  const settings = ensureSettings(store);
  const history = ensureEmailHistory(store);
  const today = dateKeyInTimeZone(new Date(), APP_TIME_ZONE);
  const testRecipient = normalizeEmail(options.testRecipient || "");
  const candidates = dueEmailCandidates(store, settings, today, {
    force: options.force,
    processId: options.processId,
    tipo: options.tipo
  });
  const result = {
    ok: true,
    enabled: EMAIL_CONFIGURATION.configured,
    redirectRecipient: testRecipient,
    checkedAt: new Date().toISOString(),
    candidates: candidates.length,
    sent: [],
    skipped: [],
    failed: []
  };

  if (!EMAIL_CONFIGURATION.configured) {
    result.ok = false;
    result.error = "Configure credenciais SMTP e EMAIL_FROM_ADDRESS para enviar e-mails.";
    return result;
  }

  for (const candidate of candidates) {
    const dedupeKey = emailDedupeKey(candidate, today, testRecipient);
    if (!options.force && history.some((entry) => entry.dedupeKey === dedupeKey && entry.status === "enviado")) {
      result.skipped.push({ processoId: candidate.processo.id, tipo: candidate.tipo, motivo: "ja enviado hoje" });
      continue;
    }

    const recipients = testRecipient ? [testRecipient] : candidate.recipients;
    if (!recipients.length) {
      result.skipped.push({ processoId: candidate.processo.id, tipo: candidate.tipo, motivo: "sem destinatario" });
      continue;
    }

    const claimToken = await claimEmailDispatch(dedupeKey, {
      processoId: candidate.processo.id,
      tipo: candidate.tipo,
      destinatarios: recipients,
      modoTeste: Boolean(testRecipient)
    }, Boolean(options.force));
    if (!claimToken) {
      result.skipped.push({ processoId: candidate.processo.id, tipo: candidate.tipo, motivo: "envio ja reservado ou concluido" });
      continue;
    }

    let email;
    try {
      email = await buildNotificationEmail(candidate, recipients, testRecipient);
      const sendResult = await sendSmtpMailWithRetry(email);
      await completeEmailDispatch(dedupeKey, claimToken, { attempts: sendResult.attempts });
      const entry = {
        id: crypto.randomUUID(),
        dedupeKey,
        processoId: candidate.processo.id,
        numeroProcesso: candidate.processo.numeroProcesso || "",
        numeroEmpenho: candidate.processo.numeroEmpenho || "",
        tipo: candidate.tipo,
        destinatariosOriginais: candidate.recipients,
        destinatarios: recipients,
        assunto: email?.subject || "",
        status: "enviado",
        tentativas: sendResult.attempts,
        modoTeste: Boolean(testRecipient),
        enviadoEm: new Date().toISOString(),
        criadoEm: new Date().toISOString()
      };
      upsertEmailHistory(history, entry);
      result.sent.push(entry);
      logInfo("email_sent", {
        processoId: candidate.processo.id,
        tipo: candidate.tipo,
        destinatarios: recipients.length,
        tentativas: sendResult.attempts
      });
    } catch (error) {
      await failEmailDispatch(dedupeKey, claimToken, error).catch((claimError) => {
        logError("email_claim_update_failed", { dedupeKey, message: claimError.message });
      });
      const entry = {
        id: crypto.randomUUID(),
        dedupeKey,
        processoId: candidate.processo.id,
        numeroProcesso: candidate.processo.numeroProcesso || "",
        numeroEmpenho: candidate.processo.numeroEmpenho || "",
        tipo: candidate.tipo,
        destinatariosOriginais: candidate.recipients,
        destinatarios: recipients,
        assunto: email?.subject || "",
        status: "erro",
        tentativas: error.attempts || 1,
        erro: error.message,
        ultimoErro: error.message,
        modoTeste: Boolean(testRecipient),
        criadoEm: new Date().toISOString()
      };
      upsertEmailHistory(history, entry);
      result.failed.push(entry);
      logError("email_failed", {
        processoId: candidate.processo.id,
        tipo: candidate.tipo,
        destinatarios: recipients.length,
        tentativas: entry.tentativas,
        message: error.message
      });
    }
  }

  await persistEmailHistory([...result.sent, ...result.failed]);
  result.ok = result.failed.length === 0;
  return result;
}

async function persistEmailHistory(entries = [], maximumAttempts = 3) {
  if (!entries.length) return;
  let lastError;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    const latestStore = await readStore();
    const latestHistory = ensureEmailHistory(latestStore);
    for (const entry of entries) upsertEmailHistory(latestHistory, entry);
    latestStore.emailHistorico = latestHistory
      .sort((left, right) => String(right.enviadoEm || right.criadoEm || "").localeCompare(String(left.enviadoEm || left.criadoEm || "")))
      .slice(0, 500);
    try {
      await writeStore(latestStore);
      return;
    } catch (error) {
      lastError = error;
      if (error.statusCode !== 409 || attempt === maximumAttempts) throw error;
    }
  }
  throw lastError;
}

function dueEmailCandidates(store, settings, today, options = {}) {
  const rules = settings.notificationRules;
  const fornecedores = Array.isArray(store.fornecedores) ? store.fornecedores : [];
  const active = (store.processos || [])
    .map((processo) => enrichProcess(processo))
    .filter((processo) => processUsesDelivery(processo) && !processo.inativo && processo.status !== "Anulado" && !hasProcessReachedDelivery(processo))
    .filter((processo) => !options.processId || processo.id === options.processId);
  const candidates = [];

  for (const processo of active) {
    const dias = Number(processo.diasDecorridos || 0);
    const supplier = fornecedorForProcess(fornecedores, processo);
    if (rules.diasAvisoInterno.includes(dias)) {
      candidates.push({
        tipo: "avisoPrazos",
        processo,
        recipients: internalNotificationRecipients(settings),
        template: settings.emailTemplates.avisoPrazos
      });
    }
    if (dias === Number(rules.diaOficioFornecedor || 30)) {
      candidates.push({
        tipo: "oficioFornecedor",
        processo,
        recipients: supplierRecipients(supplier),
        template: settings.emailTemplates.oficioFornecedor
      });
    }
  }

  if (options.force && options.processId && active.length && options.tipo === "oficioFornecedor") {
    const processo = active[0];
    const supplier = fornecedorForProcess(fornecedores, processo);
    return [{
      tipo: "oficioFornecedor",
      processo,
      recipients: supplierRecipients(supplier),
      template: settings.emailTemplates.oficioFornecedor,
      forceTest: true,
      scheduledDate: today,
      deadlineDate: processDeadlineDate(processo)
    }];
  }

  if (!candidates.length && options.force && active.length) {
    const processo = active[0];
    candidates.push({
      tipo: "avisoPrazos",
      processo,
      recipients: internalNotificationRecipients(settings),
      template: settings.emailTemplates.avisoPrazos,
      forceTest: true
    });
  }

  return candidates.map((candidate) => ({
    ...candidate,
    scheduledDate: today,
    deadlineDate: processDeadlineDate(candidate.processo)
  }));
}

function internalNotificationRecipients(settings) {
  const responsaveis = (settings.responsaveis || [])
    .filter((item) => item.ativo !== false)
    .flatMap((item) => item.email);
  return uniqueEmails([...responsaveis, ...ADMIN_EMAILS]);
}

function supplierRecipients(supplier = {}) {
  return uniqueEmails([supplier.email, ...(supplier.emails || [])]);
}

function fornecedorForProcess(fornecedores = [], processo = {}) {
  return fornecedores.find((fornecedor) => normalizeText(fornecedor.razaoSocial) === normalizeText(processo.fornecedor)) || {};
}

function uniqueEmails(values = []) {
  return [...new Set(values.map(normalizeEmail).filter(Boolean))];
}

function emailDedupeKey(candidate, today, testRecipient = "") {
  const mode = testRecipient ? `test:${testRecipient}` : "production";
  return `${today}:${candidate.tipo}:${candidate.processo.id}:${candidate.processo.diasDecorridos}:${mode}`;
}

async function buildNotificationEmail(candidate, recipients, testRecipient = "") {
  const processo = candidate.processo;
  const variables = {
    numeroProcesso: processo.numeroProcesso || "",
    numeroEmpenho: processo.numeroEmpenho || "",
    fornecedor: processo.fornecedor || "",
    dias: processo.diasDecorridos || 0
  };
  const subject = fillTemplate(candidate.template.assunto, variables);
  const body = [
    testRecipient ? "[MODO TESTE] Este e-mail foi redirecionado para teste." : "",
    candidate.forceTest ? "[TESTE FORCADO] Nao havia empenho exatamente no prazo de disparo; foi usado o primeiro empenho ativo." : "",
    fillTemplate(candidate.template.corpo, variables),
    "",
    `Processo: ${processo.numeroProcesso || "-"}`,
    `Empenho: ${processo.numeroEmpenho || "-"}`,
    `Fornecedor: ${processo.fornecedor || "-"}`,
    `Data de referencia: ${processDeadlineDate(processo) || "-"}`,
    `Dias decorridos: ${processo.diasDecorridos || 0}`
  ].filter((line, index) => line || index > 1).join("\n");
  return {
    from: EMAIL_FROM_ADDRESS,
    fromName: EMAIL_FROM_NAME,
    to: recipients,
    subject,
    text: body,
    attachments: await emailTemplateAttachments(candidate.template)
  };
}

function fillTemplate(template = "", variables = {}) {
  return String(template).replace(/\{(\w+)\}/g, (_, key) => String(variables[key] ?? ""));
}

async function emailTemplateAttachments(template = {}) {
  const attachments = [];
  for (const attachment of template.anexos || []) {
    const uploadPath = String(attachment.path || "");
    if (!uploadPath.startsWith("/uploads/")) continue;
    try {
      attachments.push({
        fileName: attachment.fileName || "anexo",
        mimeType: attachment.mimeType || contentTypeForPath(uploadPath),
        content: await getUploadBuffer(uploadPath, MAX_UPLOAD_BYTES, { root: UPLOAD_ROOT })
      });
    } catch {
      // Missing attachments should not block the notification itself.
    }
  }
  return attachments;
}

function ensureEmailHistory(store) {
  if (!Array.isArray(store.emailHistorico)) store.emailHistorico = [];
  return store.emailHistorico;
}

function upsertEmailHistory(history, entry) {
  const existingIndex = history.findIndex((item) => item.dedupeKey === entry.dedupeKey);
  if (existingIndex >= 0) history.splice(existingIndex, 1);
  history.unshift(entry);
}

async function sendSmtpMail(message) {
  validateEmailMessage(message);
  const client = await SmtpClient.connect({
    host: SMTP_HOST,
    port: SMTP_PORT,
    user: SMTP_AUTH_USER,
    pass: SMTP_AUTH_PASSWORD,
    connectTimeoutMs: SMTP_CONNECT_TIMEOUT_MS,
    commandTimeoutMs: SMTP_COMMAND_TIMEOUT_MS
  });
  try {
    await client.send(message);
  } finally {
    await client.quit().catch(() => null);
  }
}

function validateEmailMessage(message = {}) {
  if (!isSafeEmailAddress(message.from)) {
    throw new ValueError("Remetente de e-mail invalido.");
  }
  const recipients = Array.isArray(message.to) ? message.to : [];
  if (!recipients.length || recipients.some((recipient) => !isSafeEmailAddress(recipient))) {
    throw new ValueError("Destinatario de e-mail invalido.");
  }
}

class ValueError extends Error {}

async function sendSmtpMailWithRetry(message, maxAttempts = 3) {
  let lastError;
  let attempts = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    attempts = attempt;
    try {
      await sendSmtpMail(message);
      return { attempts: attempt };
    } catch (error) {
      lastError = error;
      if (!isTransientEmailError(error) || attempt === maxAttempts) break;
      await delay(1000 * attempt * attempt);
    }
  }
  lastError.attempts = lastError.attempts || attempts;
  throw lastError;
}

function isTransientEmailError(error = {}) {
  const message = String(error.message || "");
  if (/SMTP (53[045]|55[0-9])/.test(message)) return false;
  if (/Application-specific password required|InvalidSecondFactor|Authentication/i.test(message)) return false;
  return /SMTP (4\d\d|421|450|451|452)|timeout|disconnected|encerrada|ECONNRESET|ETIMEDOUT/i.test(message);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class SmtpClient {
  constructor(socket, credentials) {
    this.socket = socket;
    this.credentials = credentials;
    this.buffer = "";
    this.pending = [];
    this.commandTimeoutMs = credentials.commandTimeoutMs;
    this.socket.setEncoding("utf8");
    this.socket.on("data", (chunk) => this.receive(chunk));
    this.socket.on("error", (error) => this.rejectPending(error));
    this.socket.on("close", () => this.rejectPending(new Error("Conexao SMTP encerrada.")));
  }

  static connect(credentials) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const socket = connectTls({
        host: credentials.host,
        port: credentials.port,
        servername: credentials.host
      }, async () => {
        clearTimeout(connectTimeout);
        socket.off("error", rejectConnection);
        const client = new SmtpClient(socket, credentials);
        try {
          await client.readReply([220]);
          await client.command(`EHLO ${smtpLocalName()}`, [250]);
          await client.command("AUTH LOGIN", [334]);
          await client.command(Buffer.from(credentials.user).toString("base64"), [334]);
          await client.command(Buffer.from(credentials.pass).toString("base64"), [235]);
          settled = true;
          resolve(client);
        } catch (error) {
          settled = true;
          socket.destroy();
          reject(error);
        }
      });
      const rejectConnection = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimeout);
        reject(error);
      };
      const connectTimeout = setTimeout(() => {
        const error = new Error("Timeout ao conectar ao servidor SMTP.");
        error.code = "ETIMEDOUT";
        socket.destroy(error);
        rejectConnection(error);
      }, credentials.connectTimeoutMs);
      connectTimeout.unref?.();
      socket.once("error", rejectConnection);
    });
  }

  receive(chunk) {
    this.buffer += chunk;
    while (true) {
      const lineEnd = this.buffer.indexOf("\n");
      if (lineEnd === -1) return;
      const line = this.buffer.slice(0, lineEnd + 1);
      this.buffer = this.buffer.slice(lineEnd + 1);
      const pending = this.pending[0];
      if (!pending) continue;
      pending.lines.push(line.trimEnd());
      if (/^\d{3} /.test(line)) {
        this.pending.shift();
        clearTimeout(pending.timer);
        const code = Number(line.slice(0, 3));
        if (pending.expected.includes(code)) pending.resolve({ code, lines: pending.lines });
        else pending.reject(new Error(`SMTP ${code}: ${pending.lines.join(" | ")}`));
      }
    }
  }

  readReply(expected) {
    return new Promise((resolve, reject) => {
      const pending = { expected, resolve, reject, lines: [], timer: undefined };
      pending.timer = setTimeout(() => {
        const index = this.pending.indexOf(pending);
        if (index >= 0) this.pending.splice(index, 1);
        const error = new Error("Timeout aguardando resposta SMTP.");
        error.code = "ETIMEDOUT";
        reject(error);
        this.socket.destroy(error);
      }, this.commandTimeoutMs);
      pending.timer.unref?.();
      this.pending.push(pending);
    });
  }

  async command(command, expected) {
    const reply = this.readReply(expected);
    this.socket.write(`${command}\r\n`);
    return reply;
  }

  async send(message) {
    await this.command(`MAIL FROM:<${smtpAddress(message.from)}>`, [250]);
    for (const recipient of message.to) {
      await this.command(`RCPT TO:<${smtpAddress(recipient)}>`, [250, 251]);
    }
    await this.command("DATA", [354]);
    this.socket.write(`${dotStuff(buildMimeMessage(message))}\r\n.\r\n`);
    await this.readReply([250]);
  }

  async quit() {
    if (this.socket.destroyed) return;
    await this.command("QUIT", [221]);
    this.socket.end();
  }

  rejectPending(error) {
    while (this.pending.length) {
      const pending = this.pending.shift();
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }
}

function buildMimeMessage(message) {
  const boundary = `almox-${randomBytes(12).toString("hex")}`;
  const headers = [
    `From: ${encodedMailbox(message.fromName, message.from)}`,
    `To: ${message.to.map((email) => `<${email}>`).join(", ")}`,
    `Subject: ${encodeHeader(message.subject)}`,
    "MIME-Version: 1.0",
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${randomBytes(16).toString("hex")}@almoxarifado.local>`
  ];

  if (!message.attachments?.length) {
    return [
      ...headers,
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: base64",
      "",
      wrapBase64(Buffer.from(message.text || "", "utf8").toString("base64"))
    ].join("\r\n");
  }

  const parts = [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrapBase64(Buffer.from(message.text || "", "utf8").toString("base64"))
  ];

  for (const attachment of message.attachments) {
    parts.push(
      `--${boundary}`,
      `Content-Type: ${attachment.mimeType || "application/octet-stream"}; name="${escapeHeaderParam(attachment.fileName)}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${escapeHeaderParam(attachment.fileName)}"`,
      "",
      wrapBase64(Buffer.from(attachment.content).toString("base64"))
    );
  }
  parts.push(`--${boundary}--`);
  return parts.join("\r\n");
}

function encodedMailbox(name = "", email = "") {
  return `${encodeHeader(name)} <${email}>`;
}

function encodeHeader(value = "") {
  const text = String(value || "");
  if (/^[\x20-\x7e]*$/.test(text)) return text.replace(/[\r\n]+/g, " ");
  return `=?UTF-8?B?${Buffer.from(text, "utf8").toString("base64")}?=`;
}

function escapeHeaderParam(value = "") {
  return String(value || "anexo").replace(/["\r\n]/g, "_");
}

function wrapBase64(value = "") {
  return String(value).replace(/.{1,76}/g, "$&\r\n").trimEnd();
}

function dotStuff(message = "") {
  return String(message).replace(/^\./, "..").replace(/\r?\n\./g, "\r\n..");
}

function smtpAddress(value = "") {
  return String(value).replace(/[<>\r\n]/g, "").trim();
}

function isSafeEmailAddress(value = "") {
  const text = String(value || "").trim();
  if (!text || text.length > 254 || /[\r\n<>]/.test(text)) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text);
}

function smtpLocalName() {
  return "localhost";
}

function settingsPayload(store) {
  const settings = ensureSettings(store);
  return {
    ...settings,
    status: STATUS,
    filtrosRapidos: QUICK_FILTERS,
    usuarios: (store.usuarios || []).filter((user) => user.origemCadastro !== "excluido").map((user) => ({
      id: user.id,
      nome: user.nome,
      email: user.email,
      ativo: user.ativo !== false,
      role: resolveRole(user),
      origemCadastro: user.origemCadastro || "local",
      justificativaAcesso: user.justificativaAcesso || "",
      solicitadoEm: user.solicitadoEm || "",
      precisaDefinirSenha: Boolean(user.precisaDefinirSenha)
    }))
  };
}

function ensureSettings(store) {
  if (!store.configuracoes) store.configuracoes = {};
  store.configuracoes.emailTemplates = sanitizeEmailTemplates(store.configuracoes.emailTemplates || {});
  store.configuracoes.notificationRules = sanitizeNotificationRules(store.configuracoes.notificationRules || {});
  store.configuracoes.responsaveis = Array.isArray(store.configuracoes.responsaveis)
    ? store.configuracoes.responsaveis.map((item) => ({
      id: String(item.id || stableLegacyId("responsavel", normalizeEmail(item.email), item.nome, item.funcao)),
      nome: String(item.nome || "").trim(),
      email: normalizeEmail(item.email),
      funcao: String(item.funcao || "").trim(),
      ativo: item.ativo !== false,
      criadoEm: String(item.criadoEm || "")
    })).filter((item) => item.nome && item.email)
    : [];
  return store.configuracoes;
}

function sanitizeEmailTemplates(input = {}) {
  return Object.fromEntries(Object.entries(DEFAULT_SETTINGS.emailTemplates).map(([key, fallback]) => {
    const template = input[key] || legacyEmailTemplate(input, key) || {};
    return [key, {
      assunto: String(template.assunto || fallback.assunto).trim(),
      corpo: String(template.corpo || fallback.corpo).trim(),
      anexos: sanitizeTemplateAttachments(template.anexos)
    }];
  }));
}

function emailTemplatesValidationError(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "Templates de e-mail invalidos.";
  for (const key of Object.keys(DEFAULT_SETTINGS.emailTemplates)) {
    const template = input[key] || legacyEmailTemplate(input, key);
    if (!template) continue;
    if (!template || typeof template !== "object" || Array.isArray(template)) return "Template de e-mail invalido.";
    if (String(template.assunto || "").length > 200) return "O assunto do template deve ter no maximo 200 caracteres.";
    if (String(template.corpo || "").length > 10_000) return "O corpo do template deve ter no maximo 10000 caracteres.";
  }
  return "";
}

function legacyEmailTemplate(input = {}, key = "") {
  if (key === "avisoPrazos") return input.notificacaoInterna;
  if (key === "oficioFornecedor") return input.notificacaoFornecedor;
  return null;
}

function sanitizeTemplateAttachments(input = []) {
  return (Array.isArray(input) ? input : [])
    .map((attachment) => ({
      id: String(attachment.id || stableLegacyId("anexo-template", attachment.path, attachment.fileName)),
      fileName: String(attachment.fileName || "").trim(),
      path: String(attachment.path || "").trim(),
      mimeType: String(attachment.mimeType || "").trim(),
      sizeBytes: attachmentByteSize(attachment),
      uploadedAt: String(attachment.uploadedAt || "").trim(),
      uploadedBy: String(attachment.uploadedBy || "").trim(),
      uploadedByEmail: normalizeEmail(attachment.uploadedByEmail),
      uploadedById: String(attachment.uploadedById || "").trim()
    }))
    .filter((attachment) => attachment.fileName && attachment.path);
}

function documentEntries(documents = {}) {
  return Object.values(documents || {}).flatMap((value) => (
    (Array.isArray(value) ? value : [value])
      .map(normalizeDocumentEntry)
      .filter((attachment) => attachment.path)
  ));
}

function normalizeDocumentEntry(value) {
  if (!value) return {};
  if (typeof value === "string") {
    return value.startsWith("/uploads/")
      ? { path: value, fileName: uploadPathFileName(value) }
      : { path: "", fileName: value };
  }
  if (typeof value !== "object" || Array.isArray(value)) return {};
  return {
    ...value,
    path: String(value.path || "").trim(),
    fileName: String(value.fileName || value.nome || uploadPathFileName(value.path) || "Documento anexado").trim()
  };
}

function uploadPathFileName(value = "") {
  const lastSegment = String(value || "").split("/").pop() || "";
  try {
    return decodeURIComponent(lastSegment);
  } catch {
    return lastSegment;
  }
}

function attachmentByteSize(attachment) {
  const value = Number(attachment?.sizeBytes || 0);
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

export async function totalStoredAttachmentBytes(attachments = [], maximumBytes = Number.MAX_SAFE_INTEGER) {
  let total = 0;
  for (const attachment of attachments || []) {
    total += await storedAttachmentByteSize(attachment);
    if (!Number.isSafeInteger(total) || total > maximumBytes) {
      const error = new Error("Os anexos excedem o limite agregado permitido.");
      error.statusCode = 413;
      throw error;
    }
  }
  return total;
}

async function storedAttachmentByteSize(attachment) {
  if (!attachment) return 0;
  const normalizedAttachment = normalizeDocumentEntry(attachment);
  const declaredSize = attachmentByteSize(normalizedAttachment);
  const metadata = await getUploadMetadata(normalizedAttachment.path, { root: UPLOAD_ROOT });
  // A legacy record can reference a removed upload. Preserve its declared
  // size so inconsistent metadata cannot be used to bypass quotas.
  return metadata?.sizeBytes ?? declaredSize;
}

async function storedAttachmentExists(attachment) {
  return Boolean(await getUploadMetadata(normalizeDocumentEntry(attachment).path, { root: UPLOAD_ROOT }));
}

async function processHasAvailableLiquidationDocument(processo = {}) {
  for (const key of LIQUIDATION_DOCUMENT_KEYS) {
    if (processo.documentos?.[key] && await storedAttachmentExists(processo.documentos[key])) return true;
  }
  return false;
}

export function stableLegacyId(prefix, ...parts) {
  const hash = createHash("sha256")
    .update(parts.map((part) => String(part || "").trim()).join("\u0000"))
    .digest("hex")
    .slice(0, 24);
  return `${safeName(prefix)}-${hash}`;
}

function sanitizeNotificationRules(input = {}) {
  const diasAvisoInterno = (Array.isArray(input.diasAvisoInterno) ? input.diasAvisoInterno : String(input.diasAvisoInterno || "").split(/[\n,; ]+/))
    .map((day) => Number(day))
    .filter((day) => Number.isInteger(day) && day > 0 && day <= 3_650)
    .sort((a, b) => a - b);
  const diaOficioFornecedor = Number(input.diaOficioFornecedor || DEFAULT_SETTINGS.notificationRules.diaOficioFornecedor);
  return {
    diasAvisoInterno: diasAvisoInterno.length ? [...new Set(diasAvisoInterno)].slice(0, 64) : DEFAULT_SETTINGS.notificationRules.diasAvisoInterno,
    diaOficioFornecedor: Number.isInteger(diaOficioFornecedor) && diaOficioFornecedor > 0 && diaOficioFornecedor <= 3_650
      ? diaOficioFornecedor
      : DEFAULT_SETTINGS.notificationRules.diaOficioFornecedor
  };
}

function sanitizeMaterials(input, currentMaterials = []) {
  const items = Array.isArray(input) ? input : legacyMaterials(input);
  const currentById = new Map((Array.isArray(currentMaterials) ? currentMaterials : [])
    .filter((item) => item?.id)
    .map((item) => [String(item.id), item]));
  const currentByDescription = new Map();
  for (const material of Array.isArray(currentMaterials) ? currentMaterials : []) {
    const description = String(material?.descricao || "").trim();
    if (!description) continue;
    currentByDescription.set(description, [...(currentByDescription.get(description) || []), material]);
  }
  const usedIds = new Set();
  return items
    .map((item, index) => {
      const requestedId = normalizeMaterialId(item?.id);
      const currentAtIndex = currentMaterials[index] || {};
      const description = String(item?.descricao || "").trim();
      const descriptionMatches = currentByDescription.get(description) || [];
      const uniqueDescriptionMatch = descriptionMatches.length === 1 ? descriptionMatches[0] : null;
      const existing = currentById.get(requestedId)
        || (!requestedId && uniqueDescriptionMatch && !usedIds.has(String(uniqueDescriptionMatch.id || "")) ? uniqueDescriptionMatch : null)
        || (!requestedId && !usedIds.has(String(currentAtIndex.id || "")) ? currentAtIndex : {});
      const id = requestedId || normalizeMaterialId(existing?.id) || crypto.randomUUID();
      usedIds.add(id);
      return {
        id,
        descricao: description.slice(0, 100),
        valorUnitario: nonNegativeNumber(item?.valorUnitario),
        quantidade: nonNegativeNumber(item?.quantidade)
      };
    })
    .filter((item) => item.descricao);
}

function sanitizeProcessInput(input = {}, current = {}) {
  const value = (key) => Object.prototype.hasOwnProperty.call(input, key) ? input[key] : current[key];
  const tipoObjeto = PROCESS_OBJECT_TYPES.includes(String(value("tipoObjeto") || "").trim())
    ? String(value("tipoObjeto")).trim()
    : processObjectType(current);
  const requestedTracking = String(value("acompanhamentoServico") || "").trim();
  const result = {
    numeroProcesso: String(value("numeroProcesso") || "").trim().slice(0, 20),
    numeroEmpenho: String(value("numeroEmpenho") || "").trim().slice(0, 20),
    fornecedor: String(value("fornecedor") || "").trim().slice(0, 100),
    cnpj: String(value("cnpj") || "").trim().slice(0, 18),
    criadoPor: String(value("criadoPor") || "").trim().slice(0, 100),
    tipoObjeto,
    acompanhamentoServico: tipoObjeto === "servico" && SERVICE_TRACKING_MODES.includes(requestedTracking)
      ? requestedTracking
      : (tipoObjeto === "servico" ? "continuado" : "entrega"),
    materiais: sanitizeMaterials(value("materiais") || input, current.materiais || []),
    dataProcesso: safeDate(value("dataProcesso")),
    dataEnvioSalc: safeDate(value("dataEnvioSalc")),
    dataEnvioEmpenho: safeDate(value("dataEnvioEmpenho")),
    dataEnvioFornecedor: safeDate(value("dataEnvioFornecedor")),
    dataEntrega: safeDate(value("dataEntrega")),
    dataEnvioLiquidacao: safeDate(value("dataEnvioLiquidacao")),
    dataLiquidacao: safeDate(value("dataLiquidacao")),
    dataPagamento: safeDate(value("dataPagamento"))
  };
  if (tipoObjeto === "servico") {
    result.dataInicioServico = safeDate(value("dataInicioServico"));
    result.dataFimServico = safeDate(value("dataFimServico"));
  } else {
    result.dataInicioServico = "";
    result.dataFimServico = "";
  }
  if (input.status && STATUS.includes(input.status)) result.status = input.status;
  return result;
}

export function validateProcessBody(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "O corpo do processo deve ser um objeto JSON.";
  if (!String(input.numeroProcesso || "").trim() && !String(input.numeroEmpenho || "").trim()) {
    return "Informe o numero do processo, o numero do empenho ou ambos.";
  }
  if (String(input.numeroProcesso || "").trim().length > 20) return "O numero do processo deve ter no maximo 20 caracteres.";
  if (String(input.numeroEmpenho || "").trim().length > 20) return "O numero do empenho deve ter no maximo 20 caracteres.";
  if (String(input.fornecedor || "").trim().length > 100) return "O fornecedor deve ter no maximo 100 caracteres.";
  if (String(input.cnpj || "").trim().length > 18) return "O CNPJ deve ter no maximo 18 caracteres.";
  if (String(input.criadoPor || "").trim().length > 100) return "O nome de quem criou o processo deve ter no maximo 100 caracteres.";
  if (Object.prototype.hasOwnProperty.call(input, "tipoObjeto") && !PROCESS_OBJECT_TYPES.includes(String(input.tipoObjeto || "").trim())) {
    return "Selecione se o empenho e de material ou servico.";
  }
  if (String(input.tipoObjeto || "") === "servico"
      && !SERVICE_TRACKING_MODES.includes(String(input.acompanhamentoServico || "").trim())) {
    return "Selecione como o servico sera acompanhado.";
  }
  if (input.numeroProcesso && !normalizeProcessIdentifier(input.numeroProcesso)) return "Informe uma numeracao de processo com letras ou numeros.";
  if (input.numeroEmpenho && !normalizeProcessIdentifier(input.numeroEmpenho)) return "Informe um numero de empenho com letras ou numeros.";
  if (Object.prototype.hasOwnProperty.call(input, "materiais") && !Array.isArray(input.materiais)) {
    return "Materiais deve ser uma lista.";
  }
  const dateFields = ["dataProcesso", "dataEnvioSalc", "dataEnvioEmpenho", "dataEnvioFornecedor", "dataEntrega", "dataEnvioLiquidacao", "dataLiquidacao", "dataPagamento", "dataInicioServico", "dataFimServico"];
  for (const field of dateFields) {
    if (input[field] && !safeDate(input[field])) return `Data invalida no campo ${field}.`;
  }
  const chronologyError = validateProcessChronology(input);
  if (chronologyError) return chronologyError;
  if (input.status && !STATUS.includes(input.status)) return "Status invalido.";
  if (Array.isArray(input.materiais)) {
    if (input.materiais.length > MAX_PROCESS_MATERIALS) return `Cada processo aceita no maximo ${MAX_PROCESS_MATERIALS} materiais.`;
    const ids = new Set();
    for (const material of input.materiais) {
      if (!material || typeof material !== "object" || Array.isArray(material)) return "Cada material deve ser um objeto valido.";
      if (String(material.descricao || "").trim().length > 100) return "A descricao do material deve ter no maximo 100 caracteres.";
      if (material.id) {
        const id = normalizeMaterialId(material.id);
        if (!id || ids.has(id)) return "Os materiais devem possuir identificadores validos e unicos.";
        ids.add(id);
      }
      const price = Number(material.valorUnitario || 0);
      const quantity = Number(material.quantidade || 0);
      if (!Number.isFinite(price) || price < 0 || !Number.isFinite(quantity) || quantity < 0) {
        return "Valores e quantidades dos materiais devem ser numeros nao negativos.";
      }
      if (!hasAtMostDecimalPlaces(price, 4)) {
        return "O valor unitario deve ter no maximo quatro casas decimais.";
      }
      const lineCents = Math.round((Math.round(price * 10_000) * quantity) / 100);
      if (!Number.isSafeInteger(lineCents) || lineCents > MAX_MATERIAL_LINE_CENTS) {
        return "O valor total de cada material deve ser finito e estar dentro do limite financeiro permitido.";
      }
    }
  }
  if (String(input.tipoObjeto || "") === "servico"
      && Array.isArray(input.materiais)
      && !input.materiais.some((item) => String(item?.descricao || "").trim())) {
    return "Informe pelo menos um servico no empenho.";
  }
  const serviceStart = safeDate(input.dataInicioServico);
  const serviceEnd = safeDate(input.dataFimServico);
  if (serviceStart && serviceEnd && serviceEnd < serviceStart) {
    return "A data final da vigencia nao pode ser anterior a data inicial.";
  }
  return "";
}

function validateProcessForStatus(processo = {}) {
  if (["Empenho enviado ao fornecedor", "Em execução", "Serviço concluído", "Aguardando entrega", "Entrega parcial", "Entregue", "Aguardando envio para liquidacao", "Enviado para liquidacao", "Liquidado", "Pago"].includes(processo.status)
      && !processDeadlineDate(processo)) {
    return "Informe a data de envio do empenho ao fornecedor antes de avancar.";
  }
  if (processUsesDelivery(processo) && hasProcessReachedDelivery(processo)
      && !processo.dataEntrega) {
    return "Registre o recebimento antes de avancar.";
  }
  if (!processUsesDelivery(processo)
      && ["Serviço concluído", "Enviado para liquidacao", "Liquidado", "Pago"].includes(processo.status)
      && serviceProgressTotal(processo) < 100) {
    return "Registre 100% da execucao antes de concluir o servico.";
  }
  if (["Enviado para liquidacao", "Liquidado", "Pago"].includes(processo.status)
      && !processHasRequiredDocuments(processo)) {
    return "Anexe pelo menos o Processo SPED ou a Nota de Empenho em PDF antes da liquidacao.";
  }
  if (["Enviado para liquidacao", "Liquidado", "Pago"].includes(processo.status) && !processo.dataEnvioLiquidacao) {
    return "Informe a data de envio para liquidacao antes de avancar.";
  }
  if (["Liquidado", "Pago"].includes(processo.status) && !processo.dataLiquidacao) {
    return "Informe a data de liquidacao antes de avancar.";
  }
  if (processo.status === "Pago" && !processo.dataPagamento) {
    return "Informe a data de pagamento antes de concluir o processo.";
  }
  const chronologyError = validateProcessChronology(processo);
  if (chronologyError) return chronologyError;
  return "";
}

function validateProcessChronology(processo = {}) {
  const datedEvents = [
    ["dataProcesso", safeDate(processo.dataProcesso), "data do processo"],
    ["dataEnvioSalc", safeDate(processo.dataEnvioSalc), "envio para SALC"],
    ["dataEnvioFornecedor", processDeadlineDate(processo), "envio ao fornecedor"],
    ["dataEntrega", safeDate(processo.dataEntrega), "entrega"],
    ["dataEnvioLiquidacao", safeDate(processo.dataEnvioLiquidacao), "envio para liquidacao"],
    ["dataLiquidacao", safeDate(processo.dataLiquidacao), "liquidacao"],
    ["dataPagamento", safeDate(processo.dataPagamento), "pagamento"]
  ].filter(([, value]) => value);
  const today = dateKeyInTimeZone(new Date(), APP_TIME_ZONE);
  const future = datedEvents.find(([, value]) => value > today);
  if (future) return `A data de ${future[2]} (${formatDateForMessage(future[1])}) nao pode estar no futuro.`;
  for (let index = 1; index < datedEvents.length; index += 1) {
    if (datedEvents[index][1] < datedEvents[index - 1][1]) {
      return `A data de ${datedEvents[index][2]} (${formatDateForMessage(datedEvents[index][1])}) nao pode ser anterior a ${datedEvents[index - 1][2]} de ${formatDateForMessage(datedEvents[index - 1][1])}.`;
    }
  }
  return "";
}

function validateDeliveryDate(processo = {}, deliveryDate = "", previousDeliveries = []) {
  const today = dateKeyInTimeZone(new Date(), APP_TIME_ZONE);
  if (deliveryDate > today) return `A data de entrega (${formatDateForMessage(deliveryDate)}) nao pode estar no futuro.`;
  const sentDate = processDeadlineDate(processo);
  if (sentDate && deliveryDate < sentDate) {
    return `A data de entrega (${formatDateForMessage(deliveryDate)}) nao pode ser anterior ao envio ao fornecedor de ${formatDateForMessage(sentDate)}.`;
  }
  const latestDelivery = previousDeliveries
    .map((delivery) => safeDate(delivery.data))
    .filter(Boolean)
    .sort()
    .at(-1);
  if (latestDelivery && deliveryDate < latestDelivery) {
    return `A nova entrega (${formatDateForMessage(deliveryDate)}) nao pode ser anterior a entrega ja registrada em ${formatDateForMessage(latestDelivery)}.`;
  }
  return "";
}

function formatDateForMessage(value = "") {
  const date = safeDate(value);
  if (!date) return String(value || "");
  const [year, month, day] = date.split("-");
  return `${day}/${month}/${year}`;
}

function safeDate(value = "") {
  let text = String(value || "").trim();
  if (!text) return "";
  const brazilianDate = text.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (brazilianDate) text = `${brazilianDate[3]}-${brazilianDate[2]}-${brazilianDate[1]}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return "";
  const parsed = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) return "";
  return text;
}

function resolveDashboardYear(value, availableYears = []) {
  const requested = String(value || "").trim();
  if (/^\d{4}$/.test(requested)) {
    const year = Number(requested);
    if (year >= 1900 && year <= 9999) return year;
  }
  return availableYears[0] || new Date().getFullYear();
}

function activeAdminCount(users = []) {
  return users.filter((user) => user.ativo !== false && resolveRole(user) === "admin").length;
}

function observationBelongsToUser(observation = {}, user = {}) {
  if (observation.usuarioId) return Boolean(user.id) && observation.usuarioId === user.id;
  return Boolean(user.email) && normalizeEmail(observation.usuarioEmail) === normalizeEmail(user.email);
}

function nonNegativeNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function sanitizeDeliveryItems(input, materials) {
  if (!Array.isArray(input)) return [];
  return input.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const materialIndex = Number(item.materialIndex);
    return {
      materialIndex,
      materialId: String(materials[materialIndex]?.id || ""),
      descricao: String(materials[materialIndex]?.descricao || "").trim(),
      quantidade: nonNegativeNumber(item.quantidade)
    };
  }).filter((item) => item && Number.isInteger(item.materialIndex) && item.materialId && item.descricao && item.quantidade > 0);
}

function deliveredTotals(deliveries = [], materials = []) {
  const totals = new Map();
  for (const delivery of deliveries) {
    for (const item of delivery.itens || []) {
      const materialId = deliveryMaterialId(item, materials);
      if (!materialId) continue;
      totals.set(materialId, (totals.get(materialId) || 0) + Number(item.quantidade || 0));
    }
  }
  return totals;
}

function remainingDeliveryItems(deliveries = [], materials = []) {
  const totals = deliveredTotals(deliveries, materials);
  return materials.map((material, materialIndex) => ({
    materialIndex,
    materialId: String(material.id || ""),
    descricao: String(material.descricao || "").trim(),
    quantidade: Math.max(0, Number(material.quantidade || 0) - (totals.get(String(material.id || "")) || 0))
  })).filter((item) => item.materialId && item.descricao && item.quantidade > 0);
}

function deliveryExceedsOrdered(previous, nextItems, materials) {
  const totals = deliveredTotals([...previous, { itens: nextItems }], materials);
  const materialsById = new Map(materials.map((material) => [String(material.id || ""), material]));
  return [...totals.entries()].some(([materialId, delivered]) => (
    !materialsById.has(materialId) || delivered > Number(materialsById.get(materialId).quantidade || 0)
  ));
}

function deliveryIsComplete(deliveries, materials) {
  const totals = deliveredTotals(deliveries, materials);
  return materials.length > 0 && materials.every((material) => (
    (totals.get(String(material.id || "")) || 0) >= Number(material.quantidade || 0)
  ));
}

function deliveryMaterialId(item = {}, materials = []) {
  if (item.materialId && materials.some((material) => String(material.id || "") === String(item.materialId))) {
    return String(item.materialId);
  }
  const descriptionMatches = materials.filter((material) => (
    String(material.descricao || "").trim() === String(item.descricao || "").trim()
  ));
  if (descriptionMatches.length === 1) return String(descriptionMatches[0].id || "");
  return String(materials[Number(item.materialIndex)]?.id || "");
}

function normalizeMaterialId(value = "") {
  const id = String(value || "").trim();
  return id && id.length <= 120 && /^[a-zA-Z0-9._:-]+$/.test(id) ? id : "";
}

function processChanges(before = {}, after = {}) {
  const ignored = new Set(["atualizadoEm", "versao"]);
  return Object.fromEntries(Object.keys(after).filter((key) => (
    !ignored.has(key) && JSON.stringify(before[key]) !== JSON.stringify(after[key])
  )).map((key) => [key, { anterior: before[key] ?? null, novo: after[key] ?? null }]));
}

function sendProcessesExport(res, processos = [], format = "csv") {
  const rows = processos.map(processExportRow);
  const stamp = new Date().toISOString().slice(0, 10);

  if (format === "pdf") {
    const pdf = createProcessesReportPdf(rows);
    res.writeHead(200, {
      "content-type": "application/pdf",
      "content-disposition": `attachment; filename="processos-${stamp}.pdf"`
    });
    res.end(pdf);
    return;
  }

  if (format === "excel" || format === "xls") {
    const excel = createProcessesExcel(rows);
    res.writeHead(200, {
      "content-type": "application/vnd.ms-excel; charset=utf-8",
      "content-disposition": `attachment; filename="processos-${stamp}.xls"`
    });
    res.end(excel);
    return;
  }

  const csv = createProcessesCsv(rows);
  res.writeHead(200, {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="processos-${stamp}.csv"`
  });
  res.end(csv);
}

function processExportRow(processo = {}) {
  return {
    processo: processo.numeroProcesso || "",
    empenho: processo.numeroEmpenho || "",
    fornecedor: processo.fornecedor || "",
    materiais: summarizeMaterials(processo.materiais || []),
    tipo: processObjectType(processo) === "servico" ? "Serviço" : "Material",
    valorTotal: Number(processo.valorTotal || 0),
    envioFornecedor: processo.dataEnvioFornecedor || processo.dataEnvioEmpenho || "",
    dias: processo.diasDecorridos || 0,
    acompanhamento: processObjectType(processo) === "servico"
      ? ({ continuado: "Contínuo/mensal", sob_demanda: "Sob demanda", entrega: "Com entrega física" }[processo.acompanhamentoServico] || "Contínuo/mensal")
      : "Entrega física",
    progresso: processObjectType(processo) === "servico" && !processUsesDelivery(processo) ? `${serviceProgressTotal(processo)}%` : "",
    dataEntrega: processUsesDelivery(processo) ? (processo.dataEntrega || "") : "Não se aplica",
    envioLiquidacao: processo.dataEnvioLiquidacao || "",
    status: processo.status || ""
  };
}

function exportColumns() {
  return [
    ["processo", "Processo"],
    ["empenho", "Empenho"],
    ["fornecedor", "Fornecedor"],
    ["materiais", "Materiais"],
    ["tipo", "Tipo"],
    ["valorTotal", "Valor total"],
    ["envioFornecedor", "Envio fornecedor"],
    ["dias", "Dias"],
    ["acompanhamento", "Acompanhamento"],
    ["progresso", "Execução concluída"],
    ["dataEntrega", "Data entrega"],
    ["envioLiquidacao", "Envio liquidacao"],
    ["status", "Status"]
  ];
}

function createProcessesCsv(rows = []) {
  const columns = exportColumns();
  const lines = [
    columns.map(([, label]) => csvCell(label)).join(";"),
    ...rows.map((row) => columns.map(([key]) => csvCell(row[key])).join(";"))
  ];
  return `\uFEFF${lines.join("\n")}`;
}

function csvCell(value = "") {
  const text = spreadsheetSafeText(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function createProcessesExcel(rows = []) {
  const columns = exportColumns();
  return `<!doctype html>
<html>
  <head><meta charset="utf-8"></head>
  <body>
    <table>
      <thead><tr>${columns.map(([, label]) => `<th>${escapeHtmlText(label)}</th>`).join("")}</tr></thead>
      <tbody>
        ${rows.map((row) => `<tr>${columns.map(([key]) => `<td style="mso-number-format:'\\@'">${escapeHtmlText(spreadsheetSafeText(row[key]))}</td>`).join("")}</tr>`).join("")}
      </tbody>
    </table>
  </body>
</html>`;
}

function createProcessesReportPdf(rows = []) {
  const lines = [
    "Relatorio de processos",
    `Gerado em: ${new Date().toLocaleString("pt-BR")}`,
    `Total de processos: ${rows.length}`,
    "",
    ...rows.flatMap((row) => [
      `${row.processo || "-"} | ${row.empenho || "-"} | ${row.status || "-"}`,
      `${row.fornecedor || "-"} | ${formatCurrency(row.valorTotal)}`,
      ""
    ])
  ];
  const pageLines = chunkList(lines, 34);
  const pageObjects = [];
  pageLines.forEach((chunk, index) => {
    const pageId = 4 + (index * 2);
    const contentId = pageId + 1;
    const escapedLines = chunk.map((line, lineIndex) => `BT /F1 ${index === 0 && lineIndex === 0 ? 18 : 9} Tf 40 ${790 - (lineIndex * 22)} Td (${escapePdfText(line)}) Tj ET`).join("\n");
    const stream = Buffer.from(escapedLines, "latin1");
    pageObjects.push(
      { id: pageId, body: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>` },
      { id: contentId, body: `<< /Length ${stream.length} >>\nstream\n${stream.toString("latin1")}\nendstream` }
    );
  });
  const kids = pageLines.map((_, index) => `${4 + (index * 2)} 0 R`).join(" ");
  return writePdfObjects([
    { id: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" },
    { id: 2, body: `<< /Type /Pages /Kids [${kids}] /Count ${pageLines.length} >>` },
    { id: 3, body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>" },
    ...pageObjects
  ]);
}

function chunkList(items = [], size = 1) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks.length ? chunks : [[]];
}

function formatCurrency(value = 0) {
  return Number(value || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function escapeHtmlText(value = "") {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function spreadsheetSafeText(value = "") {
  const text = String(value ?? "");
  return /^[\s\u0000-\u001f]*[=+\-@]/u.test(text) ? `'${text}` : text;
}

function duplicateProcessFields(processos = [], candidate = {}, ignoreId = "") {
  const numeroEmpenho = normalizeProcessIdentifier(candidate.numeroEmpenho);
  const duplicateProcess = processos
    .filter((processo) => !processo.inativo && processo.id !== ignoreId)
    .find((processo) => numeroEmpenho && normalizeProcessIdentifier(processo.numeroEmpenho) === numeroEmpenho);

  if (!duplicateProcess) return "";
  return `O empenho ${candidate.numeroEmpenho} ja esta cadastrado no registro ${duplicateProcess.id}${duplicateProcess.numeroProcesso ? `, vinculado ao processo ${duplicateProcess.numeroProcesso}` : ", sem processo vinculado"}.`;
}

function normalizeProcessIdentifier(value = "") {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toUpperCase();
}

export function normalizeProcessNumber(value = "") {
  const text = String(value || "").trim().toUpperCase().replace(/\s+/g, " ");
  if (!text) return "";
  const digits = text.replace(/\D/g, "");
  if (digits.length === 17) {
    return `${digits.slice(0, 5)}.${digits.slice(5, 11)}/${digits.slice(11, 15)}-${digits.slice(15)}`;
  }
  return text;
}

function hasAtMostDecimalPlaces(value, places) {
  const scale = 10 ** places;
  const scaled = Number(value) * scale;
  return Number.isFinite(scaled) && Math.abs(scaled - Math.round(scaled)) < 1e-7;
}

function normalizeNewProcessCommitmentNumber(value = "") {
  const match = String(value || "").trim().toUpperCase().match(/^(\d{4})NE000([1-9]\d{0,10})$/);
  return match ? `${match[1]}NE000${match[2]}` : "";
}

function legacyMaterials(input = {}) {
  if (!input.material && !input.valorUnitario && !input.quantidade) return [];
  return [{
    descricao: input.material,
    valorUnitario: input.valorUnitario,
    quantidade: input.quantidade
  }];
}

function normalizeSupplier(fornecedor = {}) {
  const emails = mergeList(fornecedor.email, fornecedor.emails);
  const telefones = mergeList(fornecedor.telefone, fornecedor.telefones);
  const enderecos = mergeList(fornecedor.endereco, fornecedor.enderecos);
  return {
    ...fornecedor,
    razaoSocial: String(fornecedor.razaoSocial || fornecedor.nome || "").trim(),
    emails,
    telefones,
    enderecos,
    email: emails[0] || "",
    telefone: telefones[0] || "",
    endereco: enderecos[0] || "",
    observacoes: String(fornecedor.observacoes || "").trim()
  };
}

function mergeList(...values) {
  return [...new Set(values.flatMap((value) => {
    if (Array.isArray(value)) return value;
    return String(value || "").split(/[\n,;]+/);
  }).map((value) => String(value || "").trim()).filter(Boolean))];
}

function mergeText(current = "", next = "") {
  const items = mergeList(String(current || "").split("\n"), String(next || "").split("\n"));
  return items.join("\n");
}

function normalizeText(value = "") {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function safeName(value = "") {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || "arquivo";
}

function safeDocumentFileName(value = "documento") {
  const normalized = String(value || "documento")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  const originalExtension = extname(normalized).toLowerCase();
  const extension = originalExtension
    .replace(/[^a-zA-Z0-9.]+/g, "")
    .slice(0, 20);
  const originalStem = extension ? normalized.slice(0, -originalExtension.length) : normalized;
  const stem = originalStem
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "documento";
  return `${stem.slice(0, Math.max(1, 180 - extension.length))}${extension}`;
}

function documentContentDisposition(value = "documento") {
  const original = String(value || "documento")
    .replace(/[\0\r\n]/g, "-")
    .trim()
    .slice(0, MAX_UPLOAD_FILENAME_LENGTH) || "documento";
  const encoded = encodeURIComponent(original).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${safeDocumentFileName(original)}"; filename*=UTF-8''${encoded}`;
}

function documentDownloadFileName(reference = {}) {
  const fileName = String(reference.fileName || "documento").trim() || "documento";
  if (contentTypeForPath(fileName) !== "application/octet-stream") return fileName;
  let decodedPath = String(reference.path || "");
  try {
    decodedPath = decodeURIComponent(decodedPath);
  } catch {
    // Keep the stored path as a safe extension fallback.
  }
  const extension = extname(decodedPath).toLowerCase();
  return extension && contentTypeForPath(`documento${extension}`) !== "application/octet-stream"
    ? `${fileName}${extension}`
    : fileName;
}

async function processDownloadEntries(processo, payload) {
  const entries = [{
    name: "processo.json",
    data: Buffer.from(JSON.stringify(payload, null, 2), "utf8")
  }];
  enforceAggregateDownloadLimit(entries);

  entries.push(...await processDocumentEntries(processo));
  enforceAggregateDownloadLimit(entries);
  return entries;
}

async function processDocumentEntries(processo) {
  const entries = [];
  const unavailable = [];

  for (const [key, value] of Object.entries(processo.documentos || {})) {
    const items = Array.isArray(value) ? value : [value];
    for (const [index, rawItem] of items.entries()) {
      if (!rawItem) continue;
      const item = normalizeDocumentEntry(rawItem);
      const referencedPath = typeof rawItem === "string" ? rawItem : rawItem?.path;
      if (!String(referencedPath || "").startsWith("/uploads/")) continue;
      const fileName = documentDownloadFileName(item) || `${safeName(key)}-${index + 1}`;
      try {
        const data = await getUploadBuffer(item.path, MAX_UPLOAD_BYTES, { root: UPLOAD_ROOT });
        enforceAggregateDownloadLimit(entries, data);
        entries.push({
          name: `documentos/${safeName(key)}${items.length > 1 ? `-${index + 1}` : ""}-${safeDocumentFileName(fileName)}`,
          data
        });
      } catch (error) {
        if (error.code === "UNSAFE_FILE_PATH") {
          unavailable.push(fileName);
          continue;
        }
        if (error.statusCode) throw error;
        if (error.code !== "ENOENT") throw error;
        unavailable.push(fileName);
      }
    }
  }

  if (unavailable.length) {
    const listed = unavailable.slice(0, 5).map((name) => safeDocumentFileName(name)).join(", ");
    const remaining = unavailable.length > 5 ? ` e mais ${unavailable.length - 5}` : "";
    const error = new Error(`Nao foi possivel gerar o arquivo completo porque ha documentos indisponiveis: ${listed}${remaining}. Anexe-os novamente.`);
    error.statusCode = 409;
    throw error;
  }
  return entries;
}

async function createCompiledPdf(documentEntries, payload) {
  enforceAggregateDownloadLimit(documentEntries);
  const pdfEntries = documentEntries.filter((entry) => isPdfBuffer(entry.data));
  const united = await unitePdfDocuments(pdfEntries.map((entry) => entry.data));
  if (united) return united;
  const merged = mergePdfDocuments(pdfEntries.map((entry) => entry.data));
  if (merged) {
    enforceAggregateDownloadLimit([], merged);
    return merged;
  }
  const summary = createSummaryPdf(payload, pdfEntries.length
    ? "Nao foi possivel compilar os PDFs anexados neste navegador."
    : "Nao ha documentos PDF anexados para compilacao.");
  enforceAggregateDownloadLimit([], summary);
  return summary;
}

function isPdfBuffer(buffer) {
  return Buffer.isBuffer(buffer) && buffer.subarray(0, 5).toString("latin1") === "%PDF-";
}

async function unitePdfDocuments(pdfBuffers) {
  if (!pdfBuffers.length) return null;
  const directory = await mkdtemp(join(tmpdir(), "almox-pdf-"));
  try {
    const inputPaths = [];
    for (const [index, pdfBuffer] of pdfBuffers.entries()) {
      const inputPath = join(directory, `${index + 1}.pdf`);
      await writeFile(inputPath, pdfBuffer);
      inputPaths.push(inputPath);
    }
    const outputPath = join(directory, "compilado.pdf");
    const exitCode = await runCommand("pdfunite", [...inputPaths, outputPath], PDF_COMMAND_TIMEOUT_MS);
    if (exitCode !== 0) return null;
    const output = await readFile(outputPath);
    enforceAggregateDownloadLimit([], output);
    return isPdfBuffer(output) ? output : null;
  } catch (error) {
    if (error.statusCode) throw error;
    return null;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function runCommand(command, args, timeoutMs = 10_000) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore" });
    let settled = false;
    let forceKill;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(forceKill);
      resolve(code);
    };
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      forceKill = setTimeout(() => {
        child.kill("SIGKILL");
        finish(-2);
      }, 1_000);
      forceKill.unref?.();
    }, timeoutMs);
    timeout.unref?.();
    child.on("error", () => finish(-1));
    child.on("close", (code) => finish(code ?? -1));
  });
}

function mergePdfDocuments(pdfBuffers) {
  const copiedObjects = [];
  const pageIds = [];
  let nextId = 3;

  for (const pdfBuffer of pdfBuffers) {
    const parsed = parsePdfObjects(pdfBuffer);
    if (!parsed.objects.length || !parsed.pageKeys.length) return null;
    const idMap = new Map();
    const excluded = new Set(parsed.catalogKeys);

    for (const object of parsed.objects) {
      if (excluded.has(object.key)) continue;
      idMap.set(object.key, nextId);
      nextId += 1;
    }

    for (const object of parsed.objects) {
      if (excluded.has(object.key)) continue;
      const newId = idMap.get(object.key);
      let body = object.body.replace(/(\d+)\s+(\d+)\s+R/g, (match, id, generation) => {
        const mapped = idMap.get(`${id}:${generation}`);
        return mapped ? `${mapped} 0 R` : match;
      });

      if (parsed.pageKeys.includes(object.key)) {
        body = body.replace(/\/Parent\s+\d+\s+\d+\s+R/g, "/Parent 2 0 R");
        pageIds.push(newId);
      }

      copiedObjects.push({ id: newId, body });
    }
  }

  if (!pageIds.length) return null;
  const pageKids = pageIds.map((id) => `${id} 0 R`).join(" ");
  const objects = [
    { id: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" },
    { id: 2, body: `<< /Type /Pages /Kids [${pageKids}] /Count ${pageIds.length} >>` },
    ...copiedObjects.sort((a, b) => a.id - b.id)
  ];
  return writePdfObjects(objects);
}

function parsePdfObjects(pdfBuffer) {
  const content = pdfBuffer.toString("latin1");
  const objects = [];
  const objectPattern = /(\d+)\s+(\d+)\s+obj([\s\S]*?)endobj/g;
  let match;
  while ((match = objectPattern.exec(content))) {
    const [, id, generation, body] = match;
    const key = `${id}:${generation}`;
    objects.push({ id: Number(id), generation: Number(generation), key, body: body.trim() });
  }

  const catalogKeys = objects
    .filter((object) => /\/Type\s*\/Catalog\b/.test(object.body))
    .map((object) => object.key);
  const pageKeys = objects
    .filter((object) => /\/Type\s*\/Page\b/.test(object.body) && !/\/Type\s*\/Pages\b/.test(object.body))
    .map((object) => object.key);
  return { objects, catalogKeys, pageKeys };
}

function writePdfObjects(objects) {
  const parts = [Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n", "binary")];
  const offsets = [0];
  let offset = parts[0].length;

  for (const object of objects) {
    offsets[object.id] = offset;
    const chunk = Buffer.from(`${object.id} 0 obj\n${object.body}\nendobj\n`, "latin1");
    parts.push(chunk);
    offset += chunk.length;
  }

  const xrefOffset = offset;
  const maxId = Math.max(...objects.map((object) => object.id));
  let xref = `xref\n0 ${maxId + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= maxId; id += 1) {
    xref += `${String(offsets[id] || 0).padStart(10, "0")} 00000 n \n`;
  }
  xref += `trailer\n<< /Size ${maxId + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  parts.push(Buffer.from(xref, "latin1"));
  return Buffer.concat(parts);
}

function createSummaryPdf(payload, message) {
  const processo = payload?.processo || {};
  const lines = [
    "Processo completo",
    `Processo: ${processo.numeroProcesso || processo.id || "-"}`,
    `Empenho: ${processo.numeroEmpenho || "-"}`,
    `Fornecedor: ${processo.fornecedor || "-"}`,
    "",
    message
  ];
  const escapedLines = lines.map((line, index) => `BT /F1 ${index === 0 ? 18 : 11} Tf 50 ${780 - (index * 24)} Td (${escapePdfText(line)}) Tj ET`).join("\n");
  const stream = Buffer.from(escapedLines, "latin1");
  return writePdfObjects([
    { id: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" },
    { id: 2, body: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" },
    { id: 3, body: "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>" },
    { id: 4, body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>" },
    { id: 5, body: `<< /Length ${stream.length} >>\nstream\n${stream.toString("latin1")}\nendstream` }
  ]);
}

function escapePdfText(value = "") {
  return String(value).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function createZip(entries) {
  enforceAggregateDownloadLimit(entries);
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const crc = crc32(data);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    localParts.push(local, data);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centralParts.push(central);

    offset += local.length + data.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, end]);
}

function enforceAggregateDownloadLimit(entries = [], additionalData) {
  const currentBytes = entries.reduce((total, entry) => total + Buffer.byteLength(entry.data || ""), 0);
  const totalBytes = currentBytes + (additionalData ? Buffer.byteLength(additionalData) : 0);
  if (totalBytes > MAX_COMPILED_DOWNLOAD_BYTES) {
    const error = new Error("Os documentos excedem o limite permitido para compilacao.");
    error.statusCode = 413;
    throw error;
  }
  return totalBytes;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function loadLocalEnv() {
  if (process.env.NODE_ENV === "test") return;
  try {
    const envFile = process.env.NODE_ENV === "production" ? "../.env.production" : "../.env";
    const envPath = fileURLToPath(new URL(envFile, import.meta.url));
    const content = readFileSync(envPath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
      const [key, ...valueParts] = trimmed.split("=");
      if (!process.env[key]) process.env[key] = valueParts.join("=").trim().replace(/^["']|["']$/g, "");
    }
  } catch {
    // .env is optional; production can use real environment variables.
  }
}
