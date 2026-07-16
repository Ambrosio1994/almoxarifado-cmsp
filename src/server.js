import { createServer } from "node:http";
import { connect as connectTls } from "node:tls";
import { spawn } from "node:child_process";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyQuickFilter,
  canAttachDocument,
  canCancelProcess,
  canEditProcess,
  createAuditEntry,
  dashboardMetrics,
  dashboardMonthlyExecution,
  dashboardStatusDistribution,
  enrichProcess,
  filterProcesses,
  isPdfDocument,
  isPublicConsultation,
  mutationRequiresAuthenticatedUser,
  processDeadlineDate,
  processHasRequiredDocuments,
  QUICK_FILTERS,
  summarizeMaterials,
  STATUS,
  validateDocumentUpload,
  validateProcessDocumentUpload
} from "./domain/processos.js";
import { detectStoreBackend, readProcessesStore, readSettingsStore, readStore, readUsersStore, writeStore } from "./storage.js";
import { cleanupExpiredSessions, createSession as createSessionRecord, resolveSession, revokeSession, revokeUserSessions } from "./repositories/sessions.js";
import { claimEmailDispatch, completeEmailDispatch, failEmailDispatch } from "./repositories/email-dispatches.js";
import { closePool } from "./db/postgres.js";
import { cleanupRateLimits, clearRateLimit, isRateLimited, recordRateLimitFailure } from "./repositories/rate-limits.js";
import { listSecurityEvents, recordSecurityEvent } from "./repositories/security-audit.js";

loadLocalEnv();

const PORT = Number(process.env.PORT || 3000);
const ROOT = fileURLToPath(new URL("../public/", import.meta.url));
const FAVICON_FILE = fileURLToPath(new URL("../my-fav.webp", import.meta.url));
const UPLOAD_ROOT = process.env.UPLOAD_STORAGE_ROOT
  ? resolveUploadRoot(process.env.UPLOAD_STORAGE_ROOT)
  : fileURLToPath(new URL("../uploads/", import.meta.url));
const ADMIN_EMAILS = new Set(parseList(process.env.ADMIN_EMAILS));
const LOCAL_ADMIN_EMAIL = normalizeEmail(process.env.LOCAL_ADMIN_EMAIL);
const LOCAL_ADMIN_PASSWORD = process.env.LOCAL_ADMIN_PASSWORD || "";
const SMTP_HOST = process.env.SMTP_HOST || "smtp.gmail.com";
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
const EMAIL_TEST_RECIPIENT = normalizeEmail(process.env.EMAIL_TEST_RECIPIENT || "");
const EMAIL_CONFIGURATION = resolveEmailConfiguration(process.env);
const SMTP_AUTH_USER = EMAIL_CONFIGURATION.authUser;
const SMTP_AUTH_PASSWORD = EMAIL_CONFIGURATION.authPassword;
const EMAIL_FROM_ADDRESS = EMAIL_CONFIGURATION.fromAddress;
const EMAIL_FROM_NAME = process.env.EMAIL_FROM_NAME || "Almoxarifado CMSP";
const EMAIL_CHECK_INTERVAL_MS = Number(process.env.EMAIL_CHECK_INTERVAL_MS || 60 * 60 * 1000);
const SESSION_TIMEOUT_MS = Number(process.env.SESSION_TIMEOUT_MS || 30 * 60 * 1000);
const LOGIN_RATE_LIMIT_WINDOW_MS = Number(process.env.LOGIN_RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000);
const LOGIN_RATE_LIMIT_MAX = Number(process.env.LOGIN_RATE_LIMIT_MAX || 5);
const TRUST_PROXY = process.env.TRUST_PROXY === "true";
const MAX_JSON_BODY_BYTES = Number(process.env.MAX_JSON_BODY_BYTES || 24 * 1024 * 1024);
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 15 * 1024 * 1024);
let emailSchedulerRunning = false;
let emailSchedulerTimeout;
let emailSchedulerInterval;
let maintenanceInterval;
let localAdminBootstrapped = false;

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

export async function requestHandler(req, res) {
  const startedAt = Date.now();
  const requestId = randomBytes(8).toString("hex");
  try {
    applySecurityHeaders(res);
    res.setHeader("x-request-id", requestId);
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname.startsWith("/auth/")) {
      await handleAuth(req, res, url);
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }

    if (["/health", "/health/live", "/health/ready"].includes(url.pathname)) {
      await handleHealth(res, url.pathname);
      return;
    }

    if (url.pathname.startsWith("/uploads/")) {
      await serveUpload(req, res, url.pathname);
      return;
    }

    if (url.pathname === "/favicon.svg" || url.pathname === "/favicon.ico" || url.pathname === "/my-fav.webp") {
      await serveFavicon(res);
      return;
    }

    await serveStatic(res, url.pathname);
  } catch (error) {
    logError("request_error", { requestId, method: req.method, path: req.url, message: error.message, stack: error.stack });
    sendJson(res, error.statusCode || 500, errorResponsePayload(error));
  } finally {
    if (req.url !== "/health/live") {
      logInfo("request_completed", {
        requestId,
        method: req.method,
        path: String(req.url || "").split("?")[0],
        statusCode: res.statusCode,
        durationMs: Date.now() - startedAt
      });
    }
  }
}

const server = createServer(requestHandler);

if (isMainModule()) {
  const storeBackend = await detectStoreBackend();
  if (process.env.NODE_ENV === "production" && storeBackend !== "postgres") {
    throw new Error("A aplicacao exige PostgreSQL migrado em producao.");
  }
  console.log(`Storage backend ativo: ${storeBackend}`);
  console.log(`Upload root ativo: ${UPLOAD_ROOT}`);
  server.listen(PORT, () => {
    console.log(`Almoxarifado CMSP em http://localhost:${PORT}`);
    startEmailScheduler();
    startMaintenance();
  });
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.once(signal, () => gracefulShutdown(signal));
  }
}

async function handleAuth(req, res, url) {
  const readOnlySessionRoute = (req.method === "GET" && url.pathname === "/auth/session")
    || (req.method === "POST" && url.pathname === "/auth/logout");
  const store = readOnlySessionRoute ? await readUsersStore() : await readStore();
  if (!readOnlySessionRoute) await ensureUsers(store);

  if (req.method === "GET" && url.pathname === "/auth/session") {
    const user = await sessionUser(req, store);
    if (!user) {
      sendJson(res, 401, { error: "Sessao nao encontrada" });
      return;
    }
    sendJson(res, 200, publicUser(user));
    return;
  }

  if (req.method === "POST" && url.pathname === "/auth/login") {
    const body = await readJson(req);
    const email = normalizeEmail(body.email);
    if (await isLoginRateLimited(req, email)) {
      sendJson(res, 429, { error: "Muitas tentativas de login. Tente novamente em alguns minutos." });
      return;
    }
    const user = store.usuarios.find((item) => item.email === email && item.ativo !== false);
    if (!user || !user.senhaHash || !verifyPassword(body.senha || "", user.senhaHash)) {
      await recordFailedLogin(req, email);
      await recordSecurityEvent("login_failed", { actorEmail: email, metadata: { ip: clientIp(req) } });
      sendJson(res, 401, { error: "E-mail ou senha invalidos." });
      return;
    }
    await clearFailedLogin(req, email);
    await recordSecurityEvent("login_succeeded", { actorUserId: user.id, actorEmail: user.email, metadata: { ip: clientIp(req) } });
    const token = await createSession(user);
    sendJson(res, 200, { token, user: publicUser(user) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/auth/change-password") {
    const user = await sessionUser(req, store);
    if (!user) {
      sendJson(res, 401, { error: "Faca login para alterar a senha." });
      return;
    }
    const body = await readJson(req);
    const newPassword = String(body.novaSenha || "");
    if (!user.senhaHash || !verifyPassword(body.senhaAtual || "", user.senhaHash)) {
      sendJson(res, 401, { error: "Senha atual invalida." });
      return;
    }
    if (newPassword !== body.confirmacao) {
      sendJson(res, 400, { error: "A confirmacao da nova senha deve ser identica." });
      return;
    }
    if (!isValidPassword(newPassword)) {
      sendJson(res, 400, { error: passwordPolicyMessage() });
      return;
    }
    user.senhaHash = hashPassword(newPassword);
    user.precisaDefinirSenha = false;
    user.atualizadoEm = new Date().toISOString();
    await writeStore(store);
    await revokeUserSessions(user.id);
    await recordSecurityEvent("password_changed", { actorUserId: user.id, actorEmail: user.email, targetUserId: user.id });
    const token = await createSession(user);
    sendJson(res, 200, { token, user: publicUser(user) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/auth/logout") {
    const token = bearerToken(req);
    const user = token ? await sessionUser(req, store) : null;
    if (token) await revokeSession(token);
    if (user) await recordSecurityEvent("logout", { actorUserId: user.id, actorEmail: user.email, targetUserId: user.id });
    sendJson(res, 200, { ok: true });
    return;
  }

  sendJson(res, 404, { error: "Rota de autenticacao nao encontrada" });
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/meta") {
    sendJson(res, 200, { status: STATUS, filtrosRapidos: QUICK_FILTERS });
    return;
  }

  let store = req.method === "GET" && url.pathname === "/api/settings"
    ? await readSettingsStore()
    : await readUsersStore();
  const authenticatedUser = await sessionUser(req, store);
  if (mutationRequiresAuthenticatedUser(req.method) && !authenticatedUser) {
    sendJson(res, 401, { error: "Faca login para continuar." });
    return;
  }
  if (!authenticatedUser && !isPublicConsultation(req.method, url.pathname)) {
    sendJson(res, 401, { error: "Faca login para continuar." });
    return;
  }
  const user = await currentUser(req, store);
  const role = user.role;
  const usuario = user.name;

  if (requiresAdmin(req.method, url.pathname) && role !== "admin") {
    sendJson(res, 403, { error: "Esta operacao exige perfil de administrador." });
    return;
  }
  if (requiresAuditAccess(req.method, url.pathname) && !["admin", "auditor"].includes(role)) {
    sendJson(res, 403, { error: "Esta operacao exige perfil de auditor ou administrador." });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/security-audit") {
    sendJson(res, 200, await listSecurityEvents(url.searchParams.get("limit")));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/settings") {
    sendJson(res, 200, settingsPayload(store));
    return;
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/dashboard")) {
    store = await readProcessesStore();
    const processos = store.processos.map((processo) => enrichProcess(processo));
    const year = Number(url.searchParams.get("ano") || new Date().getFullYear());
    if (url.pathname === "/api/dashboard") sendJson(res, 200, dashboardMetrics(processos));
    else if (url.pathname === "/api/dashboard/execucao-mensal") sendJson(res, 200, dashboardMonthlyExecution(processos, year));
    else if (url.pathname === "/api/dashboard/distribuicao-status") sendJson(res, 200, dashboardStatusDistribution(processos, year));
    else if (url.pathname === "/api/dashboard/charts") {
      sendJson(res, 200, {
        execucaoMensal: dashboardMonthlyExecution(processos, year),
        distribuicaoStatus: dashboardStatusDistribution(processos, year)
      });
    } else sendJson(res, 404, { error: "Rota nao encontrada" });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/processes") {
    store = await readProcessesStore();
    const filtered = filterProcesses(store.processos, Object.fromEntries(url.searchParams));
    const enriched = filtered.map((processo) => enrichProcess(processo));
    const result = applyQuickFilter(enriched, url.searchParams.get("filtroRapido"));
    sendJson(res, 200, authenticatedUser ? result : result.map(publicProcess));
    return;
  }

  store = await readStore();
  await ensureUsers(store);

  if (req.method === "POST" && url.pathname === "/api/admin/users") {
    const body = await readJson(req);
    const email = normalizeEmail(body.email);
    const nome = String(body.nome || "").trim();
    const password = String(body.senhaTemporaria || "");
    const newRole = normalizeManagedRole(body.role);
    if (!nome || !isSafeEmailAddress(email) || !newRole) {
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
      origemCadastro: "admin", senhaHash: hashPassword(password), precisaDefinirSenha: false,
      criadoEm: deletedUser?.criadoEm || new Date().toISOString(), atualizadoEm: new Date().toISOString()
    };
    if (deletedUser) store.usuarios[store.usuarios.indexOf(deletedUser)] = managedUser;
    else store.usuarios.push(managedUser);
    await writeStore(store);
    await recordSecurityEvent("user_created", { actorUserId: authenticatedUser.id, actorEmail: authenticatedUser.email, targetUserId: managedUser.id, metadata: { role: newRole } });
    sendJson(res, 201, publicUser(managedUser));
    return;
  }

  const adminUserMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
  if (adminUserMatch && req.method === "PATCH") {
    const body = await readJson(req);
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
    if (Object.prototype.hasOwnProperty.call(body, "senha")) {
      const newPassword = String(body.senha || "");
      if (!isValidPassword(newPassword)) {
        sendJson(res, 400, { error: passwordPolicyMessage() });
        return;
      }
      managedUser.senhaHash = hashPassword(newPassword);
      managedUser.precisaDefinirSenha = false;
      body.revogarSessoes = true;
    }
    if (Object.prototype.hasOwnProperty.call(body, "ativo")) managedUser.ativo = body.ativo === true;
    managedUser.atualizadoEm = new Date().toISOString();
    await writeStore(store);
    if (managedUser.ativo === false || body.revogarSessoes === true) await revokeUserSessions(managedUser.id);
    await recordSecurityEvent("user_updated", {
      actorUserId: authenticatedUser.id, actorEmail: authenticatedUser.email, targetUserId: managedUser.id,
      metadata: { role: managedUser.role, ativo: managedUser.ativo, sessoesRevogadas: body.revogarSessoes === true }
    });
    sendJson(res, 200, publicUser(managedUser));
    return;
  }

  if (adminUserMatch && req.method === "DELETE") {
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
    managedUser.atualizadoEm = new Date().toISOString();
    await writeStore(store);
    await revokeUserSessions(managedUser.id);
    await recordSecurityEvent("user_deleted", {
      actorUserId: authenticatedUser.id, actorEmail: authenticatedUser.email, targetUserId: managedUser.id
    });
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/emails/status") {
    sendJson(res, 200, emailStatusPayload());
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/emails/history") {
    sendJson(res, 200, ensureEmailHistory(store).slice(0, 100));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/emails/run-due") {
    const body = await readJson(req);
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
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "PUT" && url.pathname === "/api/settings/email-templates") {
    const body = await readJson(req);
    const settings = ensureSettings(store);
    settings.emailTemplates = sanitizeEmailTemplates(body.emailTemplates || body);
    await writeStore(store);
    sendJson(res, 200, settingsPayload(store));
    return;
  }

  const templateAttachmentMatch = url.pathname.match(/^\/api\/settings\/email-templates\/([^/]+)\/attachments$/);
  if (templateAttachmentMatch && req.method === "POST") {
    const templateKey = decodeURIComponent(templateAttachmentMatch[1]);
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

    const content = decodeUploadContent(body.contentBase64);
    if (!validateDocumentUpload(body.fileName, body.mimeType, content)) {
      sendJson(res, 400, { error: "Formato de documento nao aceito. Use PDF, Excel, CSV, Word, texto ou imagem." });
      return;
    }

    const safeTemplateKey = safeName(templateKey);
    const attachmentId = crypto.randomUUID();
    const safeFileName = `${attachmentId}-${safeName(body.fileName)}`;
    const dir = join(UPLOAD_ROOT, "email-templates", safeTemplateKey);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, safeFileName), content);

    const attachment = {
      id: attachmentId,
      fileName: body.fileName,
      path: `/uploads/email-templates/${safeTemplateKey}/${safeFileName}`,
      mimeType: body.mimeType || contentTypeForPath(safeFileName),
      uploadedAt: new Date().toISOString(),
      uploadedBy: usuario
    };
    template.anexos = [...(Array.isArray(template.anexos) ? template.anexos : []), attachment];
    await writeStore(store);
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
    await writeStore(store);
    await removeUploadedFile(removedAttachment?.path);
    sendJson(res, 200, settingsPayload(store));
    return;
  }

  if (req.method === "PUT" && url.pathname === "/api/settings/notifications") {
    const body = await readJson(req);
    const settings = ensureSettings(store);
    settings.notificationRules = sanitizeNotificationRules(body.notificationRules || body);
    await writeStore(store);
    sendJson(res, 200, settingsPayload(store));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/settings/users") {
    const body = await readJson(req);
    const settings = ensureSettings(store);
    const nome = String(body.nome || "").trim();
    const email = normalizeEmail(body.email);
    if (!nome || !email) {
      sendJson(res, 400, { error: "Nome e e-mail sao obrigatorios." });
      return;
    }
    const existing = settings.responsaveis.find((responsavel) => responsavel.email === email);
    if (existing) {
      existing.nome = nome;
      existing.funcao = String(body.funcao || existing.funcao || "").trim();
      existing.ativo = body.ativo !== false;
    } else {
      settings.responsaveis.push({
        id: crypto.randomUUID(),
        nome,
        email,
        funcao: String(body.funcao || "").trim(),
        ativo: true,
        criadoEm: new Date().toISOString()
      });
    }
    await writeStore(store);
    sendJson(res, 200, settingsPayload(store));
    return;
  }

  const settingsUserMatch = url.pathname.match(/^\/api\/settings\/users\/([^/]+)$/);
  if (settingsUserMatch && req.method === "PATCH") {
    const body = await readJson(req);
    const settings = ensureSettings(store);
    const responsavel = settings.responsaveis.find((item) => item.id === settingsUserMatch[1]);
    if (!responsavel) {
      sendJson(res, 404, { error: "Usuario responsavel nao encontrado." });
      return;
    }
    responsavel.ativo = body.ativo !== false;
    await writeStore(store);
    sendJson(res, 200, settingsPayload(store));
    return;
  }

  if (req.method === "GET" && ["/api/processes/export", "/api/processes/export/", "/api/processes/download", "/api/processes/download/"].includes(url.pathname)) {
    const format = String(url.searchParams.get("format") || "csv").toLowerCase();
    const filtered = filterProcesses(store.processos, Object.fromEntries(url.searchParams));
    const enriched = applyQuickFilter(filtered.map((processo) => enrichProcess(processo)), url.searchParams.get("filtroRapido"));
    sendProcessesExport(res, enriched, format);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/processes") {
    const body = await readJson(req);
    const validationError = validateProcessBody(body);
    if (validationError) {
      sendJson(res, 400, { error: validationError });
      return;
    }
    if (body.status && body.status !== STATUS[0]) {
      sendJson(res, 400, { error: `Um processo novo deve iniciar em ${STATUS[0]}.` });
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
      status: STATUS[0],
      documentos: {},
      criadoEm: new Date().toISOString(),
      atualizadoEm: new Date().toISOString(),
      criadoPor: usuario,
      criadoPorEmail: user.email,
      versao: 1,
      inativo: false
    };

    store.processos.unshift(processo);
    store.auditoria.unshift(createAuditEntry({
      processoId: processo.id,
      usuario,
      acao: "Criacao de processo",
      detalhes: `Processo ${processo.numeroProcesso || "sem numero"} criado.`
    }));
    await writeStore(store);
    sendJson(res, 201, enrichProcess(processo));
    return;
  }

  const processMatch = url.pathname.match(/^\/api\/processes\/([^/]+)$/);
  if (processMatch && req.method === "PUT") {
    const body = await readJson(req);
    const validationError = validateProcessBody(body);
    if (validationError) {
      sendJson(res, 400, { error: validationError });
      return;
    }
    const index = store.processos.findIndex((processo) => processo.id === processMatch[1]);
    if (index === -1) {
      sendJson(res, 404, { error: "Processo nao encontrado" });
      return;
    }

    const current = store.processos[index];
    if (!canEditProcess(current, role, body.status)) {
      sendJson(res, 403, { error: "Este processo nao pode ser alterado neste status." });
      return;
    }

    if (body.versao && Number(body.versao) !== Number(current.versao)) {
      sendJson(res, 409, { error: "O processo foi alterado por outro usuario. Atualize a tela antes de salvar." });
      return;
    }

    if (body.status && !isValidStatusTransition(current.status, body.status)) {
      sendJson(res, 400, { error: "Transicao de status invalida. Avance o processo pela proxima etapa prevista." });
      return;
    }

    const duplicate = duplicateProcessFields(store.processos, body, current.id);
    if (duplicate) {
      sendJson(res, 409, { error: duplicate });
      return;
    }

    const updated = {
      ...current,
      ...sanitizeProcessInput(body, current),
      id: current.id,
      materiais: sanitizeMaterials(body.materiais || current.materiais || current),
      numeroNotaFiscal: current.numeroNotaFiscal,
      versao: current.versao + 1,
      atualizadoEm: new Date().toISOString()
    };

    const statusError = validateProcessForStatus(updated);
    if (statusError) {
      sendJson(res, 400, { error: statusError });
      return;
    }
    if (deliveryExceedsOrdered(updated.entregas || [], [], updated.materiais || [])) {
      sendJson(res, 400, { error: "Os materiais nao podem ficar abaixo das quantidades ja recebidas." });
      return;
    }

    store.processos[index] = updated;
    store.auditoria.unshift(createAuditEntry({
      processoId: updated.id,
      usuario,
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
      motivoAnulacao: body.motivo || "Nao informado",
      anuladoEm: new Date().toISOString(),
      anuladoPor: usuario,
      versao: Number(current.versao || 0) + 1,
      atualizadoEm: new Date().toISOString()
    };

    store.processos[index] = updated;
    store.auditoria.unshift(createAuditEntry({
      processoId: updated.id,
      usuario,
      acao: "Anulacao de empenho",
      detalhes: `Motivo: ${updated.motivoAnulacao}.`
    }));
    await writeStore(store);
    sendJson(res, 200, enrichProcess(updated));
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
    if (!["Empenho enviado ao fornecedor", "Aguardando entrega", "Entrega parcial"].includes(processo.status)) {
      sendJson(res, 400, { error: "A entrega so pode ser registrada depois do envio do empenho ao fornecedor." });
      return;
    }
    if (!processDeadlineDate(processo)) {
      sendJson(res, 400, { error: "Informe a data de envio do empenho ao fornecedor antes de registrar entrega." });
      return;
    }
    const data = safeDate(body.data);
    const items = sanitizeDeliveryItems(body.itens, processo.materiais || []);
    if (!data || !items.length) {
      sendJson(res, 400, { error: "Informe data valida e ao menos uma quantidade entregue." });
      return;
    }
    const previousDeliveries = Array.isArray(processo.entregas) ? processo.entregas : [];
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
      processoId: processo.id, usuario, acao: "Registro de entrega",
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
    processo.inativo = true;
    processo.inativadoEm = new Date().toISOString();
    processo.inativadoPor = usuario;
    processo.versao = Number(processo.versao || 0) + 1;
    store.auditoria.unshift(createAuditEntry({
      processoId: processo.id, usuario, acao: "Inativacao de processo", detalhes: "Processo marcado como inativo."
    }));
    await writeStore(store);
    sendJson(res, 200, enrichProcess(processo));
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
      usuario,
      usuarioEmail: user.email,
      conteudo: content,
      criadoEm: new Date().toISOString()
    };
    store.observacoes.unshift(observacao);
    store.auditoria.unshift(createAuditEntry({
      processoId: observacao.processoId,
      usuario,
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
    if (role !== "admin" && observacao.usuarioEmail !== user.email) {
      sendJson(res, 403, { error: "Somente o autor ou administrador pode alterar esta observacao." });
      return;
    }
    observacao.conteudo = content;
    observacao.atualizadoEm = new Date().toISOString();
    store.auditoria.unshift(createAuditEntry({
      processoId: obsItemMatch[1],
      usuario,
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
    if (role !== "admin" && targetObservation.usuarioEmail !== user.email) {
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
      usuario,
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

    if (body.documentKey === "complementares" && !String(body.titulo || "").trim()) {
      sendJson(res, 400, { error: "O nome do documento complementar e obrigatorio" });
      return;
    }

    const current = store.processos[index];
    if (!canEditProcess(current, role)) {
      sendJson(res, 403, { error: "Seu perfil nao pode alterar documentos deste processo." });
      return;
    }
    const content = decodeUploadContent(body.contentBase64);
    if (!validateProcessDocumentUpload(body.documentKey, body.fileName, body.mimeType, content)) {
      sendJson(res, 400, { error: "Documento invalido. Processo SPED, Nota de Empenho e Nota Fiscal devem ser PDF valido." });
      return;
    }

    if (!canAttachDocument(current, body.documentKey)) {
      sendJson(res, 400, { error: "Este documento nao pode ser anexado neste momento." });
      return;
    }

    const safeProcessId = safeName(documentMatch[1]);
    const safeFileName = `${safeName(body.documentKey)}-${safeName(body.fileName)}`;
    const dir = join(UPLOAD_ROOT, safeProcessId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, safeFileName), content);

    const documentInfo = {
      fileName: body.fileName,
      titulo: body.documentKey === "complementares" ? String(body.titulo || "").trim() : undefined,
      descricao: body.documentKey === "complementares" ? String(body.descricao || "").trim() : undefined,
      path: `/uploads/${safeProcessId}/${safeFileName}`,
      mimeType: body.mimeType || contentTypeForPath(safeFileName),
      uploadedAt: new Date().toISOString(),
      uploadedBy: usuario
    };

    const documentos = { ...(current.documentos || {}) };
    if (body.documentKey === "complementares") {
      const currentComplementares = documentos.complementares
        ? (Array.isArray(documentos.complementares) ? documentos.complementares : [documentos.complementares])
        : [];
      documentos.complementares = [...currentComplementares, documentInfo];
    } else {
      documentos[body.documentKey] = documentInfo;
    }

    store.processos[index] = {
      ...current,
      documentos,
      atualizadoEm: new Date().toISOString(),
      versao: Number(current.versao || 0) + 1
    };
    store.auditoria.unshift(createAuditEntry({
      processoId: current.id,
      usuario,
      acao: "Anexo de documento",
      detalhes: `Documento ${body.documentKey} anexado.`,
      documento: {
        chave: body.documentKey,
        nome: documentInfo.titulo || documentInfo.fileName,
        fileName: documentInfo.fileName,
        path: documentInfo.path,
        mimeType: documentInfo.mimeType
      }
    }));
    await writeStore(store);
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
    if (!canAttachDocument(current, documentKey)) {
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
      usuario,
      acao: "Remocao de documento",
      detalhes: `Documento ${documentKey} removido.`
    }));
    await writeStore(store);
    await removeUploadedFile(removedDocument?.path);
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
    const payload = {
      geradoEm: new Date().toISOString(),
      processo: enrichProcess(processo),
      documentos: processo.documentos || {},
      observacoes: store.observacoes.filter((item) => item.processoId === processo.id),
      auditoria: store.auditoria.filter((item) => item.processoId === processo.id)
    };
    const fileName = safeName(processo.numeroProcesso || processo.id);
    const format = String(url.searchParams.get("format") || "zip").toLowerCase();
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
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/suppliers") {
    sendJson(res, 200, store.fornecedores);
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
    await writeStore(store);
    sendJson(res, index >= 0 ? 200 : 201, updated);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/audit") {
    sendJson(res, 200, store.auditoria);
    return;
  }

  sendJson(res, 404, { error: "Rota nao encontrada" });
}

async function currentUser(req, store) {
  const authenticated = await sessionUser(req, store);
  if (authenticated) {
    return {
      email: authenticated.email,
      name: authenticated.nome,
      role: resolveRole(authenticated)
    };
  }
  const email = "publico@consulta.local";
  const name = "Consulta publica";
  return {
    email,
    name,
    role: resolveRole({ email })
  };
}

function requiresAdmin(method = "", pathname = "") {
  if (pathname === "/api/emails/run-due") return true;
  if (pathname === "/api/emails/status") return true;
  if (pathname.startsWith("/api/settings")) return true;
  if (pathname.startsWith("/api/admin/")) return true;
  return false;
}

function normalizeManagedRole(role = "") {
  const value = String(role).trim().toLowerCase();
  return ["admin", "almoxarifado", "auditor"].includes(value) ? value : "";
}

function requiresAuditAccess(method = "", pathname = "") {
  return String(method).toUpperCase() === "GET" && ["/api/audit", "/api/emails/history", "/api/security-audit"].includes(pathname);
}

function isLoginRateLimited(req, email = "") {
  return isRateLimited(loginAttemptKey(req, email), LOGIN_RATE_LIMIT_WINDOW_MS, LOGIN_RATE_LIMIT_MAX);
}

function recordFailedLogin(req, email = "") {
  return recordRateLimitFailure(loginAttemptKey(req, email), LOGIN_RATE_LIMIT_WINDOW_MS);
}

function clearFailedLogin(req, email = "") {
  return clearRateLimit(loginAttemptKey(req, email));
}

function loginAttemptKey(req, email = "") {
  return `${clientIp(req)}:${normalizeEmail(email) || "unknown"}`;
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
    existingAdmin.senhaHash = hashPassword(LOCAL_ADMIN_PASSWORD);
    existingAdmin.ativo = true;
    existingAdmin.role = "admin";
    existingAdmin.origemCadastro = existingAdmin.origemCadastro || "local";
    existingAdmin.precisaDefinirSenha = false;
    existingAdmin.atualizadoEm = new Date().toISOString();
  } else {
    store.usuarios.push({
      id: `admin-${crypto.randomUUID()}`,
      nome: "Administrador Almoxarifado",
      email: LOCAL_ADMIN_EMAIL,
      origemCadastro: "local",
      senhaHash: hashPassword(LOCAL_ADMIN_PASSWORD),
      precisaDefinirSenha: false,
      ativo: true,
      role: "admin",
      criadoEm: new Date().toISOString()
    });
  }
  await writeStore(store);
  localAdminBootstrapped = true;
}

function publicProcess(processo = {}) {
  const {
    documentos,
    criadoPor,
    criadoPorEmail,
    motivoAnulacao,
    anuladoPor,
    ...safe
  } = processo;
  return {
    ...safe,
    documentosDisponiveis: Object.keys(documentos || {}).filter((key) => Boolean(documentos[key]))
  };
}

function createSession(user) {
  return createSessionRecord(user.id, SESSION_TIMEOUT_MS);
}

async function sessionUser(req, store) {
  const token = bearerToken(req);
  if (!token) return null;
  const userId = await resolveSession(token, SESSION_TIMEOUT_MS);
  if (!userId) return null;
  return store.usuarios.find((user) => user.id === userId && user.ativo !== false) || null;
}

function bearerToken(req) {
  const header = String(req.headers.authorization || "");
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

function publicUser(user) {
  return {
    nome: user.nome,
    email: user.email,
    foto: user.foto || "",
    role: resolveRole(user)
  };
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

function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(String(password), salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function isValidPassword(password = "") {
  const value = String(password);
  return value.length >= 8
    && /\p{Lu}/u.test(value)
    && /\p{N}/u.test(value)
    && /[^\p{L}\p{N}]/u.test(value);
}

function passwordPolicyMessage() {
  return "A senha deve ter no minimo 8 caracteres, incluindo uma letra maiuscula, um numero e um caractere especial.";
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || "").split(":");
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, "hex");
  const actual = scryptSync(String(password), salt, 64);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

async function serveStatic(res, pathname) {
  const safePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const fullPath = normalize(join(ROOT, safePath));

  if (!isPathWithin(ROOT, fullPath)) {
    sendText(res, 403, "Acesso negado");
    return;
  }

  await serveFile(res, fullPath, {
    "cache-control": "no-store",
    "cross-origin-opener-policy": "same-origin-allow-popups",
    "referrer-policy": "strict-origin-when-cross-origin"
  });
}

async function serveUpload(req, res, pathname) {
  const store = await readStore();
  const user = await sessionUser(req, store);
  if (!user) {
    sendJson(res, 401, { error: "Faca login para acessar documentos." });
    return;
  }
  const safePath = pathname.replace(/^\/uploads\/+/, "");
  const fullPath = normalize(join(UPLOAD_ROOT, safePath));

  if (!isPathWithin(UPLOAD_ROOT, fullPath)) {
    sendText(res, 403, "Acesso negado");
    return;
  }

  await serveFile(res, fullPath, {
    "cache-control": "private, no-store",
    "content-disposition": `attachment; filename="${safeName(fullPath.split("/").pop() || "documento")}"`
  });
}

async function serveFavicon(res) {
  await serveFile(res, FAVICON_FILE, {
    "cache-control": "public, max-age=86400"
  });
}

async function removeUploadedFile(uploadPath = "") {
  if (!String(uploadPath).startsWith("/uploads/")) return;
  const relativePath = String(uploadPath).replace(/^\/uploads\/+/, "");
  const fullPath = normalize(join(UPLOAD_ROOT, relativePath));
  if (!isPathWithin(UPLOAD_ROOT, fullPath)) return;
  await rm(fullPath, { force: true });
}

async function serveFile(res, filePath, extraHeaders = {}) {
  try {
    const content = await readFile(filePath);
    res.writeHead(200, {
      "content-type": contentTypeForPath(filePath),
      ...extraHeaders
    });
    res.end(content);
  } catch (error) {
    if (error.code === "ENOENT") {
      sendText(res, 404, "Arquivo nao encontrado");
      return;
    }
    throw error;
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

async function readJson(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_JSON_BODY_BYTES) {
      const error = new Error("Payload muito grande.");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
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
  res.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; frame-src 'none'; connect-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'");
  res.setHeader("referrer-policy", "strict-origin-when-cross-origin");
  res.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=()");
}

function decodeUploadContent(contentBase64 = "") {
  const content = Buffer.from(String(contentBase64 || ""), "base64");
  if (content.length > MAX_UPLOAD_BYTES) {
    const error = new Error("Arquivo acima do limite permitido.");
    error.statusCode = 413;
    throw error;
  }
  return content;
}

async function handleHealth(res, pathname = "/health") {
  if (pathname === "/health/live") {
    sendJson(res, 200, { ok: true, checkedAt: new Date().toISOString() });
    return;
  }
  const storageBackend = await detectStoreBackend();
  const checks = {
    storage: false,
    storageBackend,
    emailConfigured: EMAIL_CONFIGURATION.configured,
    schedulerRunning: emailSchedulerRunning
  };
  try {
    const store = await readStore();
    checks.storage = Boolean(store && typeof store === "object");
  } catch (error) {
    checks.storageError = error.message;
  }
  const ok = pathname === "/health/ready"
    ? checks.storage && (process.env.NODE_ENV !== "production" || storageBackend === "postgres")
    : checks.storage && checks.emailConfigured && checks.schedulerRunning;
  sendJson(res, ok ? 200 : 503, {
    ok,
    checks,
    checkedAt: new Date().toISOString()
  });
}

function logInfo(event, data = {}) {
  console.log(JSON.stringify({ level: "info", event, at: new Date().toISOString(), ...data }));
}

function logError(event, data = {}) {
  console.error(JSON.stringify({ level: "error", event, at: new Date().toISOString(), ...data }));
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
    schedulerRunning: emailSchedulerRunning
  };
}

function startEmailScheduler() {
  if (emailSchedulerRunning) return;
  emailSchedulerRunning = true;
  emailSchedulerTimeout = setTimeout(() => {
    runDueEmailNotifications().catch((error) => {
      logError("email_scheduler_failed", { message: error.message });
    });
  }, 10_000);
  emailSchedulerInterval = setInterval(() => {
    runDueEmailNotifications().catch((error) => {
      logError("email_scheduler_failed", { message: error.message });
    });
  }, EMAIL_CHECK_INTERVAL_MS);
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
    await closePool().catch((error) => logError("database_close_failed", { message: error.message }));
    clearTimeout(forceExit);
    process.exit(0);
  });
}

async function runDueEmailNotifications(options = {}) {
  const store = await readStore();
  const settings = ensureSettings(store);
  const history = ensureEmailHistory(store);
  const today = new Date().toISOString().slice(0, 10);
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

    const claimed = await claimEmailDispatch(dedupeKey, {
      processoId: candidate.processo.id,
      tipo: candidate.tipo,
      destinatarios: recipients,
      modoTeste: Boolean(testRecipient)
    }, Boolean(options.force));
    if (!claimed) {
      result.skipped.push({ processoId: candidate.processo.id, tipo: candidate.tipo, motivo: "envio ja reservado ou concluido" });
      continue;
    }

    let email;
    try {
      email = await buildNotificationEmail(candidate, recipients, testRecipient);
      const sendResult = await sendSmtpMailWithRetry(email);
      await completeEmailDispatch(dedupeKey, { attempts: sendResult.attempts });
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
      await failEmailDispatch(dedupeKey, error).catch((claimError) => {
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

  store.emailHistorico = history.slice(0, 500);
  await writeStore(store);
  result.ok = result.failed.length === 0;
  return result;
}

function dueEmailCandidates(store, settings, today, options = {}) {
  const rules = settings.notificationRules;
  const fornecedores = Array.isArray(store.fornecedores) ? store.fornecedores : [];
  const active = (store.processos || [])
    .map((processo) => enrichProcess(processo))
    .filter((processo) => !processo.inativo && !["Entregue", "Liquidado", "Pago", "Anulado"].includes(processo.status))
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
    const relativePath = uploadPath.replace(/^\/uploads\/+/, "");
    const fullPath = normalize(join(UPLOAD_ROOT, relativePath));
    if (!isPathWithin(UPLOAD_ROOT, fullPath)) continue;
    try {
      attachments.push({
        fileName: attachment.fileName || "anexo",
        mimeType: attachment.mimeType || contentTypeForPath(fullPath),
        content: await readFile(fullPath)
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
    pass: SMTP_AUTH_PASSWORD
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
    this.socket.setEncoding("utf8");
    this.socket.on("data", (chunk) => this.receive(chunk));
    this.socket.on("error", (error) => this.rejectPending(error));
    this.socket.on("close", () => this.rejectPending(new Error("Conexao SMTP encerrada.")));
  }

  static connect(credentials) {
    return new Promise((resolve, reject) => {
      const socket = connectTls({
        host: credentials.host,
        port: credentials.port,
        servername: credentials.host
      }, async () => {
        const client = new SmtpClient(socket, credentials);
        try {
          await client.readReply([220]);
          await client.command(`EHLO ${smtpLocalName()}`, [250]);
          await client.command("AUTH LOGIN", [334]);
          await client.command(Buffer.from(credentials.user).toString("base64"), [334]);
          await client.command(Buffer.from(credentials.pass).toString("base64"), [235]);
          resolve(client);
        } catch (error) {
          socket.destroy();
          reject(error);
        }
      });
      socket.once("error", reject);
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
        const code = Number(line.slice(0, 3));
        if (pending.expected.includes(code)) pending.resolve({ code, lines: pending.lines });
        else pending.reject(new Error(`SMTP ${code}: ${pending.lines.join(" | ")}`));
      }
    }
  }

  readReply(expected) {
    return new Promise((resolve, reject) => {
      this.pending.push({ expected, resolve, reject, lines: [] });
    });
  }

  async command(command, expected) {
    this.socket.write(`${command}\r\n`);
    return this.readReply(expected);
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
    while (this.pending.length) this.pending.shift().reject(error);
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
    `Message-ID: <${randomBytes(16).toString("hex")}@almoxarifado-cmsp.local>`
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
  if (!text || /[\r\n<>]/.test(text)) return false;
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
      id: item.id || crypto.randomUUID(),
      nome: String(item.nome || "").trim(),
      email: normalizeEmail(item.email),
      funcao: String(item.funcao || "").trim(),
      ativo: item.ativo !== false,
      criadoEm: item.criadoEm || new Date().toISOString()
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

function legacyEmailTemplate(input = {}, key = "") {
  if (key === "avisoPrazos") return input.notificacaoInterna;
  if (key === "oficioFornecedor") return input.notificacaoFornecedor;
  return null;
}

function sanitizeTemplateAttachments(input = []) {
  return (Array.isArray(input) ? input : [])
    .map((attachment) => ({
      id: String(attachment.id || crypto.randomUUID()),
      fileName: String(attachment.fileName || "").trim(),
      path: String(attachment.path || "").trim(),
      mimeType: String(attachment.mimeType || "").trim(),
      uploadedAt: String(attachment.uploadedAt || "").trim(),
      uploadedBy: String(attachment.uploadedBy || "").trim()
    }))
    .filter((attachment) => attachment.fileName && attachment.path);
}

function sanitizeNotificationRules(input = {}) {
  const diasAvisoInterno = (Array.isArray(input.diasAvisoInterno) ? input.diasAvisoInterno : String(input.diasAvisoInterno || "").split(/[\n,; ]+/))
    .map((day) => Number(day))
    .filter((day) => Number.isInteger(day) && day > 0)
    .sort((a, b) => a - b);
  const diaOficioFornecedor = Number(input.diaOficioFornecedor || DEFAULT_SETTINGS.notificationRules.diaOficioFornecedor);
  return {
    diasAvisoInterno: diasAvisoInterno.length ? [...new Set(diasAvisoInterno)] : DEFAULT_SETTINGS.notificationRules.diasAvisoInterno,
    diaOficioFornecedor: Number.isInteger(diaOficioFornecedor) && diaOficioFornecedor > 0
      ? diaOficioFornecedor
      : DEFAULT_SETTINGS.notificationRules.diaOficioFornecedor
  };
}

function sanitizeMaterials(input) {
  const items = Array.isArray(input) ? input : legacyMaterials(input);
  return items
    .map((item) => ({
      descricao: String(item.descricao || "").trim().slice(0, 100),
      valorUnitario: nonNegativeNumber(item.valorUnitario),
      quantidade: nonNegativeNumber(item.quantidade)
    }))
    .filter((item) => item.descricao);
}

function sanitizeProcessInput(input = {}, current = {}) {
  const value = (key) => Object.prototype.hasOwnProperty.call(input, key) ? input[key] : current[key];
  const result = {
    numeroProcesso: String(value("numeroProcesso") || "").trim().slice(0, 20),
    numeroEmpenho: String(value("numeroEmpenho") || "").trim().slice(0, 20),
    fornecedor: String(value("fornecedor") || "").trim().slice(0, 100),
    materiais: sanitizeMaterials(value("materiais") || input),
    dataEnvioEmpenho: safeDate(value("dataEnvioEmpenho")),
    dataEnvioFornecedor: safeDate(value("dataEnvioFornecedor")),
    dataEntrega: safeDate(value("dataEntrega")),
    dataEnvioLiquidacao: safeDate(value("dataEnvioLiquidacao")),
    dataLiquidacao: safeDate(value("dataLiquidacao")),
    dataPagamento: safeDate(value("dataPagamento"))
  };
  if (input.status && STATUS.includes(input.status)) result.status = input.status;
  return result;
}

function validateProcessBody(input = {}) {
  if (!String(input.numeroProcesso || "").trim() && !String(input.numeroEmpenho || "").trim()) {
    return "Informe o numero do processo, o numero do empenho ou ambos.";
  }
  if (String(input.numeroProcesso || "").trim().length > 20) return "O numero do processo deve ter no maximo 20 caracteres.";
  if (String(input.numeroEmpenho || "").trim().length > 20) return "O numero do empenho deve ter no maximo 20 caracteres.";
  if (String(input.fornecedor || "").trim().length > 100) return "O fornecedor deve ter no maximo 100 caracteres.";
  if (Array.isArray(input.materiais) && input.materiais.some((item) => String(item.descricao || "").trim().length > 100)) {
    return "A descricao do material deve ter no maximo 100 caracteres.";
  }
  const dateFields = ["dataEnvioEmpenho", "dataEnvioFornecedor", "dataEntrega", "dataEnvioLiquidacao", "dataLiquidacao", "dataPagamento"];
  for (const field of dateFields) {
    if (input[field] && !safeDate(input[field])) return `Data invalida no campo ${field}.`;
  }
  if (input.status && !STATUS.includes(input.status)) return "Status invalido.";
  if (Array.isArray(input.materiais)) {
    for (const material of input.materiais) {
      const price = Number(material.valorUnitario || 0);
      const quantity = Number(material.quantidade || 0);
      if (!Number.isFinite(price) || price < 0 || !Number.isFinite(quantity) || quantity < 0) {
        return "Valores e quantidades dos materiais devem ser numeros nao negativos.";
      }
    }
  }
  return "";
}

function validateProcessForStatus(processo = {}) {
  if (["Empenho enviado ao fornecedor", "Aguardando entrega", "Entrega parcial", "Entregue", "Aguardando envio para liquidacao", "Enviado para liquidacao", "Liquidado", "Pago"].includes(processo.status)
      && !processDeadlineDate(processo)) {
    return "Informe a data de envio do empenho ao fornecedor antes de avancar.";
  }
  if (["Entregue", "Aguardando envio para liquidacao", "Enviado para liquidacao", "Liquidado", "Pago"].includes(processo.status)
      && !processo.dataEntrega) {
    return "Registre o recebimento antes de avancar.";
  }
  if (["Enviado para liquidacao", "Liquidado", "Pago"].includes(processo.status)
      && !processHasRequiredDocuments(processo)) {
    return "Anexe Processo SPED, Nota de Empenho e Nota Fiscal em PDF antes da liquidacao.";
  }
  if (["Liquidado", "Pago"].includes(processo.status) && !processo.dataEnvioLiquidacao) {
    return "Informe a data de envio para liquidacao antes de avancar.";
  }
  return "";
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

function activeAdminCount(users = []) {
  return users.filter((user) => user.ativo !== false && resolveRole(user) === "admin").length;
}

function nonNegativeNumber(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function isValidStatusTransition(currentStatus, nextStatus) {
  if (currentStatus === nextStatus) return true;
  if (["Entrega parcial", "Entregue"].includes(nextStatus)) return false;
  const workflow = STATUS.filter((status) => status !== "Anulado");
  const currentIndex = workflow.indexOf(currentStatus);
  return currentIndex >= 0 && workflow[currentIndex + 1] === nextStatus;
}

function sanitizeDeliveryItems(input, materials) {
  if (!Array.isArray(input)) return [];
  return input.map((item) => {
    const materialIndex = Number(item.materialIndex);
    return {
      materialIndex,
      descricao: String(materials[materialIndex]?.descricao || "").trim(),
      quantidade: nonNegativeNumber(item.quantidade)
    };
  }).filter((item) => Number.isInteger(item.materialIndex) && item.descricao && item.quantidade > 0);
}

function deliveredTotals(deliveries = []) {
  const totals = new Map();
  for (const delivery of deliveries) {
    for (const item of delivery.itens || []) {
      totals.set(item.materialIndex, (totals.get(item.materialIndex) || 0) + Number(item.quantidade || 0));
    }
  }
  return totals;
}

function deliveryExceedsOrdered(previous, nextItems, materials) {
  const totals = deliveredTotals([...previous, { itens: nextItems }]);
  return [...totals.entries()].some(([index, delivered]) => (
    !materials[index] || delivered > Number(materials[index].quantidade || 0)
  ));
}

function deliveryIsComplete(deliveries, materials) {
  const totals = deliveredTotals(deliveries);
  return materials.length > 0 && materials.every((material, index) => (
    (totals.get(index) || 0) >= Number(material.quantidade || 0)
  ));
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
    valorTotal: Number(processo.valorTotal || 0),
    envioFornecedor: processo.dataEnvioFornecedor || processo.dataEnvioEmpenho || "",
    dias: processo.diasDecorridos || 0,
    dataEntrega: processo.dataEntrega || "",
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
    ["valorTotal", "Valor total"],
    ["envioFornecedor", "Envio fornecedor"],
    ["dias", "Dias"],
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
  const text = String(value ?? "");
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
        ${rows.map((row) => `<tr>${columns.map(([key]) => `<td>${escapeHtmlText(row[key])}</td>`).join("")}</tr>`).join("")}
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

function duplicateProcessFields(processos = [], candidate = {}, ignoreId = "") {
  const numeroProcesso = normalizeProcessIdentifier(candidate.numeroProcesso);
  const numeroEmpenho = normalizeProcessIdentifier(candidate.numeroEmpenho);
  const duplicateProcess = processos
    .filter((processo) => !processo.inativo && processo.id !== ignoreId)
    .find((processo) => (
      (numeroProcesso && normalizeProcessIdentifier(processo.numeroProcesso) === numeroProcesso)
      || (numeroEmpenho && normalizeProcessIdentifier(processo.numeroEmpenho) === numeroEmpenho)
    ));

  if (!duplicateProcess) return "";
  if (numeroProcesso && normalizeProcessIdentifier(duplicateProcess.numeroProcesso) === numeroProcesso) {
    return `Ja existe um processo cadastrado com a numeracao ${candidate.numeroProcesso}: ${duplicateProcess.numeroProcesso || duplicateProcess.id}.`;
  }
  return `Ja existe um processo cadastrado com o numero de empenho ${candidate.numeroEmpenho}: ${duplicateProcess.numeroProcesso || duplicateProcess.id}.`;
}

function normalizeProcessIdentifier(value = "") {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toUpperCase();
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

async function processDownloadEntries(processo, payload) {
  const entries = [{
    name: "processo.json",
    data: Buffer.from(JSON.stringify(payload, null, 2), "utf8")
  }];

  entries.push(...await processDocumentEntries(processo));
  return entries;
}

async function processDocumentEntries(processo) {
  const entries = [];

  for (const [key, value] of Object.entries(processo.documentos || {})) {
    if (Array.isArray(value)) {
      for (const [index, item] of value.entries()) {
        const relative = item?.path?.replace(/^\/uploads\/+/, "");
        if (!relative) continue;
        const fullPath = normalize(join(UPLOAD_ROOT, relative));
        if (!isPathWithin(UPLOAD_ROOT, fullPath)) continue;
        try {
          entries.push({
            name: `documentos/${safeName(key)}-${index + 1}-${safeName(item.fileName || "documento.pdf")}`,
            data: await readFile(fullPath)
          });
        } catch {
          // Missing files remain listed in processo.json.
        }
      }
      continue;
    }
    if (!value || typeof value === "string" || !value.path) continue;
    const relative = value.path.replace(/^\/uploads\/+/, "");
    const fullPath = normalize(join(UPLOAD_ROOT, relative));
    if (!isPathWithin(UPLOAD_ROOT, fullPath)) continue;
    try {
      entries.push({
        name: `documentos/${safeName(key)}-${safeName(value.fileName || "documento.pdf")}`,
        data: await readFile(fullPath)
      });
    } catch {
      // Missing files remain listed in processo.json.
    }
  }

  return entries;
}

async function createCompiledPdf(documentEntries, payload) {
  const pdfEntries = documentEntries.filter((entry) => isPdfBuffer(entry.data));
  const united = await unitePdfDocuments(pdfEntries.map((entry) => entry.data));
  if (united) return united;
  const merged = mergePdfDocuments(pdfEntries.map((entry) => entry.data));
  if (merged) return merged;
  return createSummaryPdf(payload, pdfEntries.length
    ? "Nao foi possivel compilar os PDFs anexados neste navegador."
    : "Nao ha documentos PDF anexados para compilacao.");
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
    const exitCode = await runCommand("pdfunite", [...inputPaths, outputPath]);
    if (exitCode !== 0) return null;
    const output = await readFile(outputPath);
    return isPdfBuffer(output) ? output : null;
  } catch {
    return null;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function runCommand(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.on("error", () => resolve(-1));
    child.on("close", (code) => resolve(code ?? -1));
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
