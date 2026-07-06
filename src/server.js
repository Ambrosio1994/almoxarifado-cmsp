import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createPublicKey, randomBytes, scryptSync, timingSafeEqual, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
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
  isAllowedDocument,
  isPdfDocument,
  isPublicConsultation,
  mutationRequiresAuthenticatedUser,
  QUICK_FILTERS,
  summarizeMaterials,
  STATUS
} from "./domain/processos.js";
import { readStore, writeStore } from "./storage.js";

loadLocalEnv();

const PORT = Number(process.env.PORT || 3000);
const ROOT = fileURLToPath(new URL("../public/", import.meta.url));
const UPLOAD_ROOT = fileURLToPath(new URL("../uploads/", import.meta.url));
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const ADMIN_EMAILS = new Set(parseList(process.env.ADMIN_EMAILS));
const LOCAL_ADMIN_EMAIL = normalizeEmail(process.env.LOCAL_ADMIN_EMAIL);
const LOCAL_ADMIN_PASSWORD = process.env.LOCAL_ADMIN_PASSWORD || "";
const sessions = new Map();
let googleKeysCache = { expiresAt: 0, keys: [] };

const DEFAULT_SETTINGS = {
  emailTemplates: {
    notificacaoInterna: {
      assunto: "Processo {numeroProcesso} com {dias} dias",
      corpo: "O processo {numeroProcesso} do fornecedor {fornecedor} esta com {dias} dias desde o envio do empenho."
    },
    notificacaoFornecedor: {
      assunto: "Pendencia de entrega - Empenho {numeroEmpenho}",
      corpo: "Prezado fornecedor, solicitamos atualizacao sobre a entrega vinculada ao empenho {numeroEmpenho}."
    },
    reenvioManual: {
      assunto: "Reenvio de notificacao - Processo {numeroProcesso}",
      corpo: "Segue reenvio da notificacao referente ao processo {numeroProcesso}."
    }
  },
  notificationRules: {
    diasAvisoInterno: [7, 14, 21, 31],
    diaOficioFornecedor: 30
  },
  responsaveis: []
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname.startsWith("/auth/")) {
      await handleAuth(req, res, url);
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }

    if (url.pathname.startsWith("/uploads/")) {
      await serveUpload(res, url.pathname);
      return;
    }

    await serveStatic(res, url.pathname);
  } catch (error) {
    sendJson(res, 500, { error: "Erro interno do servidor", details: error.message });
  }
});

server.listen(PORT, () => {
  console.log(`Almoxarifado CMSP em http://localhost:${PORT}`);
});

async function handleAuth(req, res, url) {
  const store = await readStore();
  ensureUsers(store);

  if (req.method === "GET" && url.pathname === "/auth/session") {
    const user = sessionUser(req, store);
    if (!user) {
      sendJson(res, 401, { error: "Sessao nao encontrada" });
      return;
    }
    sendJson(res, 200, publicUser(user));
    return;
  }

  if (req.method === "GET" && url.pathname === "/auth/google/config") {
    sendJson(res, 200, {
      enabled: Boolean(GOOGLE_CLIENT_ID),
      clientId: GOOGLE_CLIENT_ID
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/auth/login") {
    const body = await readJson(req);
    const email = normalizeEmail(body.email);
    const user = store.usuarios.find((item) => item.email === email && item.ativo !== false);
    if (!user || !user.senhaHash || !verifyPassword(body.senha || "", user.senhaHash)) {
      sendJson(res, 401, { error: "E-mail ou senha invalidos." });
      return;
    }
    const token = createSession(user);
    sendJson(res, 200, { token, user: publicUser(user) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/auth/google/callback") {
    if (!GOOGLE_CLIENT_ID) {
      sendJson(res, 503, { error: "Login Google ainda nao configurado. Defina GOOGLE_CLIENT_ID." });
      return;
    }
    const body = await readJson(req);
    let profile;
    try {
      profile = await verifyGoogleCredential(body.credential);
    } catch (error) {
      sendJson(res, 401, { error: error.message || "Credencial Google invalida." });
      return;
    }
    let user = store.usuarios.find((item) => item.email === profile.email && item.ativo !== false);
    if (!user) {
      user = {
        id: crypto.randomUUID(),
        nome: profile.name || profile.email.split("@")[0],
        email: profile.email,
        foto: profile.picture || "",
        googleSub: profile.sub,
        origemCadastro: "google",
        senhaHash: "",
        precisaDefinirSenha: false,
        ativo: true,
        criadoEm: new Date().toISOString()
      };
      store.usuarios.push(user);
    } else {
      user.nome = user.nome || profile.name || user.email.split("@")[0];
      user.foto = profile.picture || user.foto || "";
      user.googleSub = profile.sub || user.googleSub || "";
      user.atualizadoEm = new Date().toISOString();
    }
    await writeStore(store);
    const token = createSession(user);
    sendJson(res, 200, { token, user: publicUser(user) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/auth/google/signup-local") {
    const body = await readJson(req);
    const email = normalizeEmail(body.email);
    if (!email || !body.nome) {
      sendJson(res, 400, { error: "Nome e e-mail do Google sao obrigatorios." });
      return;
    }
    if (store.usuarios.some((item) => item.email === email)) {
      sendJson(res, 409, { error: "Este e-mail ja possui cadastro. Faca login com sua senha." });
      return;
    }
    const user = {
      id: crypto.randomUUID(),
      nome: String(body.nome).trim(),
      email,
      foto: body.foto || "",
      googleSub: body.googleSub || `local-${crypto.randomUUID()}`,
      origemCadastro: "google",
      senhaHash: "",
      precisaDefinirSenha: true,
      ativo: true,
      criadoEm: new Date().toISOString()
    };
    store.usuarios.push(user);
    await writeStore(store);
    sendJson(res, 201, { pendingUserId: user.id, email: user.email, nome: user.nome });
    return;
  }

  if (req.method === "POST" && url.pathname === "/auth/set-password") {
    const body = await readJson(req);
    const user = store.usuarios.find((item) => item.id === body.pendingUserId && item.precisaDefinirSenha);
    if (!user) {
      sendJson(res, 404, { error: "Cadastro pendente nao encontrado." });
      return;
    }
    if (!body.senha || String(body.senha).length < 6 || body.senha !== body.confirmacao) {
      sendJson(res, 400, { error: "Informe uma senha com ao menos 6 caracteres e confirme corretamente." });
      return;
    }
    user.senhaHash = hashPassword(body.senha);
    user.precisaDefinirSenha = false;
    user.atualizadoEm = new Date().toISOString();
    await writeStore(store);
    const token = createSession(user);
    sendJson(res, 200, { token, user: publicUser(user) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/auth/logout") {
    const token = bearerToken(req);
    if (token) sessions.delete(token);
    sendJson(res, 200, { ok: true });
    return;
  }

  sendJson(res, 404, { error: "Rota de autenticacao nao encontrada" });
}

async function handleApi(req, res, url) {
  const store = await readStore();
  ensureUsers(store);
  const authenticatedUser = sessionUser(req, store);
  if (mutationRequiresAuthenticatedUser(req.method) && !authenticatedUser) {
    sendJson(res, 401, { error: "Faca login para continuar." });
    return;
  }
  if (!authenticatedUser && !isPublicConsultation(req.method, url.pathname)) {
    sendJson(res, 401, { error: "Faca login para continuar." });
    return;
  }
  const user = currentUser(req, store);
  const role = user.role;
  const usuario = user.name;

  if (req.method === "GET" && url.pathname === "/api/meta") {
    sendJson(res, 200, { status: STATUS, filtrosRapidos: QUICK_FILTERS });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/settings") {
    sendJson(res, 200, settingsPayload(store));
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

  if (req.method === "GET" && url.pathname === "/api/dashboard") {
    const processos = store.processos.map((processo) => enrichProcess(processo));
    sendJson(res, 200, dashboardMetrics(processos));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/dashboard/execucao-mensal") {
    const year = Number(url.searchParams.get("ano") || new Date().getFullYear());
    const processos = store.processos.map((processo) => enrichProcess(processo));
    sendJson(res, 200, dashboardMonthlyExecution(processos, year));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/dashboard/distribuicao-status") {
    const year = Number(url.searchParams.get("ano") || new Date().getFullYear());
    const processos = store.processos.map((processo) => enrichProcess(processo));
    sendJson(res, 200, dashboardStatusDistribution(processos, year));
    return;
  }

  if (req.method === "GET" && ["/api/processes/export", "/api/processes/export/", "/api/processes/download", "/api/processes/download/"].includes(url.pathname)) {
    const format = String(url.searchParams.get("format") || "csv").toLowerCase();
    const filtered = filterProcesses(store.processos, Object.fromEntries(url.searchParams));
    const enriched = applyQuickFilter(filtered.map((processo) => enrichProcess(processo)), url.searchParams.get("filtroRapido"));
    sendProcessesExport(res, enriched, format);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/processes") {
    const filtered = filterProcesses(store.processos, Object.fromEntries(url.searchParams));
    const enriched = filtered.map((processo) => enrichProcess(processo));
    sendJson(res, 200, applyQuickFilter(enriched, url.searchParams.get("filtroRapido")));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/processes") {
    const body = await readJson(req);
    const duplicate = duplicateProcessFields(store.processos, body);
    if (duplicate) {
      sendJson(res, 409, { error: duplicate });
      return;
    }

    const processo = {
      id: crypto.randomUUID(),
      numeroProcesso: body.numeroProcesso || "",
      numeroEmpenho: body.numeroEmpenho || "",
      fornecedor: body.fornecedor || "",
      materiais: sanitizeMaterials(body.materiais),
      dataEnvioEmpenho: body.dataEnvioEmpenho || "",
      dataEnvioFornecedor: body.dataEnvioFornecedor || body.dataEnvioEmpenho || "",
      dataEntrega: body.dataEntrega || "",
      dataEnvioLiquidacao: body.dataEnvioLiquidacao || "",
      status: body.status || "Enviado para SALC",
      documentos: body.documentos || {},
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

    const duplicate = duplicateProcessFields(store.processos, body, current.id);
    if (duplicate) {
      sendJson(res, 409, { error: duplicate });
      return;
    }

    const updated = {
      ...current,
      ...body,
      id: current.id,
      materiais: sanitizeMaterials(body.materiais || current.materiais || current),
      numeroNotaFiscal: current.numeroNotaFiscal,
      versao: current.versao + 1,
      atualizadoEm: new Date().toISOString()
    };

    store.processos[index] = updated;
    store.auditoria.unshift(createAuditEntry({
      processoId: updated.id,
      usuario,
      acao: "Alteracao de processo",
      detalhes: `Status atual: ${updated.status}.`
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
      conteudo: body.conteudo || "",
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
    observacao.conteudo = body.conteudo || observacao.conteudo;
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
    if (!isAllowedDocument(body.fileName, body.mimeType)) {
      sendJson(res, 400, { error: "Formato de documento nao aceito. Use PDF, Excel, CSV, Word, texto ou imagem." });
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
    await writeFile(join(dir, safeFileName), Buffer.from(body.contentBase64, "base64"));

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
    const documentKey = decodeURIComponent(documentItemMatch[2]);
    if (!canAttachDocument(current, documentKey)) {
      sendJson(res, 400, { error: "Este documento nao pode ser removido neste momento." });
      return;
    }

    const documentos = { ...(current.documentos || {}) };
    const complementaryMatch = documentKey.match(/^complementares:(\d+)$/);
    if (complementaryMatch) {
      const items = Array.isArray(documentos.complementares)
        ? [...documentos.complementares]
        : (documentos.complementares ? [documentos.complementares] : []);
      const itemIndex = Number(complementaryMatch[1]);
      if (!items[itemIndex]) {
        sendJson(res, 404, { error: "Documento nao encontrado" });
        return;
      }
      items.splice(itemIndex, 1);
      if (items.length) documentos.complementares = items;
      else delete documentos.complementares;
    } else if (!documentos[documentKey]) {
      sendJson(res, 404, { error: "Documento nao encontrado" });
      return;
    } else {
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

function currentUser(req, store) {
  const authenticated = sessionUser(req, store);
  if (authenticated) {
    return {
      email: authenticated.email,
      name: authenticated.nome,
      role: ADMIN_EMAILS.has(authenticated.email) ? "admin" : "almoxarifado"
    };
  }
  const email = String(req.headers["x-user-email"] || "admin@cmsp.local").toLowerCase();
  const name = String(req.headers["x-user-name"] || email.split("@")[0] || "Usuario local");
  return {
    email,
    name,
    role: ADMIN_EMAILS.has(email) ? "admin" : "almoxarifado"
  };
}

function ensureUsers(store) {
  if (!Array.isArray(store.usuarios)) store.usuarios = [];
  if (LOCAL_ADMIN_EMAIL && LOCAL_ADMIN_PASSWORD && !store.usuarios.some((user) => user.email === LOCAL_ADMIN_EMAIL)) {
    store.usuarios.push({
      id: `admin-${crypto.randomUUID()}`,
      nome: "Administrador Almoxarifado",
      email: LOCAL_ADMIN_EMAIL,
      origemCadastro: "local",
      senhaHash: hashPassword(LOCAL_ADMIN_PASSWORD),
      precisaDefinirSenha: false,
      ativo: true,
      criadoEm: new Date().toISOString()
    });
  }
}

function createSession(user) {
  const token = randomBytes(32).toString("hex");
  sessions.set(token, { userId: user.id, createdAt: Date.now() });
  return token;
}

function sessionUser(req, store) {
  const token = bearerToken(req);
  const session = token ? sessions.get(token) : null;
  if (!session) return null;
  return store.usuarios.find((user) => user.id === session.userId && user.ativo !== false) || null;
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
    role: ADMIN_EMAILS.has(user.email) ? "admin" : "almoxarifado"
  };
}

function normalizeEmail(email = "") {
  return String(email).trim().toLowerCase();
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

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || "").split(":");
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, "hex");
  const actual = scryptSync(String(password), salt, 64);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

async function verifyGoogleCredential(credential = "") {
  const parts = String(credential || "").split(".");
  if (parts.length !== 3) throw new Error("Credencial Google invalida.");
  const [headerText, payloadText, signatureText] = parts;
  const header = JSON.parse(base64UrlDecode(headerText).toString("utf8"));
  const payload = JSON.parse(base64UrlDecode(payloadText).toString("utf8"));
  if (header.alg !== "RS256" || !header.kid) throw new Error("Assinatura Google invalida.");

  const key = (await googlePublicKeys()).find((item) => item.kid === header.kid);
  if (!key) throw new Error("Chave publica Google nao encontrada.");

  const publicKey = createPublicKey({ key, format: "jwk" });
  const valid = verify("RSA-SHA256", Buffer.from(`${headerText}.${payloadText}`), publicKey, base64UrlDecode(signatureText));
  if (!valid) throw new Error("Assinatura Google nao confere.");
  if (payload.aud !== GOOGLE_CLIENT_ID) throw new Error("Client ID Google nao confere.");
  if (!["accounts.google.com", "https://accounts.google.com"].includes(payload.iss)) throw new Error("Emissor Google invalido.");
  if (Number(payload.exp || 0) * 1000 < Date.now()) throw new Error("Credencial Google expirada.");
  if (!payload.email) throw new Error("Conta Google sem e-mail.");

  return {
    sub: String(payload.sub || ""),
    email: normalizeEmail(payload.email),
    name: String(payload.name || payload.email || ""),
    picture: String(payload.picture || "")
  };
}

async function googlePublicKeys() {
  if (googleKeysCache.expiresAt > Date.now() && googleKeysCache.keys.length) return googleKeysCache.keys;
  const response = await fetch("https://www.googleapis.com/oauth2/v3/certs");
  if (!response.ok) throw new Error("Nao foi possivel obter chaves publicas do Google.");
  const payload = await response.json();
  const maxAge = String(response.headers.get("cache-control") || "").match(/max-age=(\d+)/);
  googleKeysCache = {
    expiresAt: Date.now() + Number(maxAge?.[1] || 3600) * 1000,
    keys: Array.isArray(payload.keys) ? payload.keys : []
  };
  return googleKeysCache.keys;
}

function base64UrlDecode(value = "") {
  const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="), "base64");
}

async function serveStatic(res, pathname) {
  const safePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const fullPath = normalize(join(ROOT, safePath));

  if (!fullPath.startsWith(ROOT)) {
    sendText(res, 403, "Acesso negado");
    return;
  }

  const content = await readFile(fullPath);
  const contentType = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8"
  }[extname(fullPath)] || "application/octet-stream";

  res.writeHead(200, {
    "content-type": contentType,
    "cache-control": "no-store",
    "cross-origin-opener-policy": "same-origin-allow-popups",
    "referrer-policy": "no-referrer-when-downgrade"
  });
  res.end(content);
}

async function serveUpload(res, pathname) {
  const safePath = pathname.replace(/^\/uploads\/+/, "");
  const fullPath = normalize(join(UPLOAD_ROOT, safePath));

  if (!fullPath.startsWith(UPLOAD_ROOT)) {
    sendText(res, 403, "Acesso negado");
    return;
  }

  const content = await readFile(fullPath);
  res.writeHead(200, { "content-type": contentTypeForPath(fullPath) });
  res.end(content);
}

function contentTypeForPath(pathname = "") {
  return {
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
    ".jpeg": "image/jpeg"
  }[extname(pathname).toLowerCase()] || "application/octet-stream";
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
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

function settingsPayload(store) {
  const settings = ensureSettings(store);
  return {
    ...settings,
    status: STATUS,
    filtrosRapidos: QUICK_FILTERS,
    usuarios: (store.usuarios || []).map((user) => ({
      id: user.id,
      nome: user.nome,
      email: user.email,
      ativo: user.ativo !== false,
      role: ADMIN_EMAILS.has(user.email) ? "admin" : "almoxarifado",
      origemCadastro: user.origemCadastro || "local",
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
    const template = input[key] || {};
    return [key, {
      assunto: String(template.assunto || fallback.assunto).trim(),
      corpo: String(template.corpo || fallback.corpo).trim()
    }];
  }));
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
      descricao: String(item.descricao || "").trim(),
      valorUnitario: Number(item.valorUnitario || 0),
      quantidade: Number(item.quantidade || 0)
    }))
    .filter((item) => item.descricao);
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
        if (!fullPath.startsWith(UPLOAD_ROOT)) continue;
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
    if (!fullPath.startsWith(UPLOAD_ROOT)) continue;
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
    const envPath = fileURLToPath(new URL("../.env", import.meta.url));
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
