import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  requestHandler,
  contentTypeForPath,
  createWorkLimiter,
  emailSchedulerHealthStatus,
  errorResponsePayload,
  isValidPassword,
  logStartupReady,
  readinessChecksPass,
  publicHealthPayload,
  requiresAdmin,
  resolveEmailConfiguration,
  roleCanMutate,
  resolvePublicAppVersion,
  sanitizeLogData,
  sanitizeLogValue,
  normalizeProcessNumber,
  uploadIntegrityForHealth,
  validateProcessBody
} from "../src/server.js";
import { createSession } from "../src/repositories/sessions.js";
import { hashPassword, verifyPassword } from "../src/security/password-policy.js";
import { readStore, writeStore } from "../src/storage.js";
import { refreshUploadIntegrityInBackground } from "../src/uploads/upload-storage.js";

describe("respostas de erro do servidor", () => {
  it("nao expoe detalhes internos em erro 500", () => {
    const payload = errorResponsePayload(new Error("relation app_users does not exist"));

    assert.deepEqual(payload, { error: "Erro interno do servidor" });
    assert.equal(Object.hasOwn(payload, "details"), false);
  });

  it("mantem mensagem controlada para erro operacional", () => {
    const error = new Error("Processo nao encontrado");
    error.statusCode = 404;

    assert.deepEqual(errorResponsePayload(error), { error: "Processo nao encontrado" });
  });

  it("identifica corretamente o tipo do favicon png", () => {
    assert.equal(contentTypeForPath("new_favicon.png"), "image/png");
  });

  it("identifica corretamente js e css", () => {
    assert.equal(contentTypeForPath("app.js"), "text/javascript; charset=utf-8");
    assert.equal(contentTypeForPath("styles.css"), "text/css; charset=utf-8");
  });

  it("remove segredos por chave e por conteudo antes de registrar logs", () => {
    const sanitized = sanitizeLogData({
      password: "nao-imprimir",
      nested: { authorization: "Bearer segredo" },
      message: "falha em postgresql://user:senha@db.example/app?token=segredo",
      stack: "Error: cookie=sessao-secreta"
    });
    assert.equal(sanitized.password, "[redacted]");
    assert.equal(sanitized.nested.authorization, "[redacted]");
    assert.doesNotMatch(sanitized.message, /senha|segredo|postgresql:\/\//);
    assert.doesNotMatch(sanitized.stack, /sessao-secreta/);
    assert.equal(sanitizeLogValue("Bearer abc.def-ghi"), "Bearer [redacted]");
    for (const value of [
      "Authorization: Bearer super-secret-token",
      "authorization=basic dXNlcjpzZWNyZXQ=",
      "Cookie: session=super-secret-cookie; other=value",
      "refreshToken=super-secret-refresh"
    ]) {
      assert.doesNotMatch(sanitizeLogValue(value), /super-secret|dXNlcjpzZWNyZXQ/);
    }
    for (const { input, secrets, safe } of [
      {
        input: "safe_before=visible&client_secret=client-secret&safe_after=visible",
        secrets: /client-secret/,
        safe: /safe_before=visible&client_secret=\[redacted\]&safe_after=visible/
      },
      {
        input: "cookie=query-cookie&safe=visible",
        secrets: /query-cookie/,
        safe: /cookie=\[redacted\]&safe=visible/
      },
      {
        input: "https://oauth.example/callback?safe_before=visible&google_access_token=google-token&oauth_refresh_token=refresh-token&safe_after=visible",
        secrets: /google-token|refresh-token/,
        safe: /safe_before=visible&google_access_token=\[redacted\]&oauth_refresh_token=\[redacted\]&safe_after=visible/
      },
      {
        input: "safe_before=visible&session_token=session-token&auth_token=auth-token&code=oauth-code&state=oauth-state&safe_after=visible",
        secrets: /session-token|auth-token|oauth-code|oauth-state/,
        safe: /safe_before=visible&session_token=\[redacted\]&auth_token=\[redacted\]&code=\[redacted\]&state=\[redacted\]&safe_after=visible/
      }
    ]) {
      const query = sanitizeLogValue(input);
      assert.doesNotMatch(query, secrets);
      assert.match(query, safe);
    }
    assert.equal(sanitizeLogData({ route: "/api/processes/123?token=ignored" }).route, "/api/processes/123");
  });

  it("registra a inicializacao sem expor o caminho local de uploads", () => {
    const messages = [];
    const originalLog = console.log;
    console.log = (message) => messages.push(message);
    try {
      logStartupReady({
        storeBackend: "postgres",
        uploadBackend: "local",
        port: 3000,
        startupDurationMs: 123,
        uploadRoot: "/segredo/volumes/uploads"
      });
    } finally {
      console.log = originalLog;
    }
    assert.equal(messages.length, 1);
    assert.match(messages[0], /application_started/);
    assert.doesNotMatch(messages[0], /segredo|volumes|uploads/);
    assert.equal(JSON.parse(messages[0]).startupDurationMs, 123);
  });

  it("registra somente a primeira requisicao concluida sem query string ou segredo", async () => {
    const messages = [];
    const originalLog = console.log;
    console.log = (message) => messages.push(message);
    try {
      const first = await invokeRequest({
        method: "GET",
        path: "/health/live?access_token=segredo-da-primeira-requisicao"
      });
      const second = await invokeRequest({
        method: "GET",
        path: "/health/live?refresh_token=segredo-da-segunda-requisicao"
      });
      assert.equal(first.statusCode, 200);
      assert.equal(second.statusCode, 200);
    } finally {
      console.log = originalLog;
    }

    const events = messages.map((message) => JSON.parse(message));
    const firstRequests = events.filter((event) => event.event === "first_request_completed");
    assert.equal(firstRequests.length, 1);
    assert.deepEqual(firstRequests[0].method, "GET");
    assert.equal(firstRequests[0].path, "/health/live");
    assert.equal(firstRequests[0].statusCode, 200);
    assert.equal(Number.isInteger(firstRequests[0].durationMs), true);
    assert.doesNotMatch(messages.join("\n"), /segredo-da-(?:primeira|segunda)-requisicao/);
  });

  it("aceita somente identificadores de build publicos e limitados", () => {
    assert.equal(resolvePublicAppVersion({ GIT_COMMIT_SHA: "a1b2c3d4e5f6a7b8c9" }), "a1b2c3d4e5f6a7b8");
    assert.equal(resolvePublicAppVersion({ APP_VERSION: "https://secret.example" }), null);
    assert.deepEqual(publicHealthPayload("ok", "a1b2c3d"), { status: "ok", version: "a1b2c3d" });
  });
});

describe("readiness da inicializacao de uploads", () => {
  const healthyChecks = {
    storage: true,
    storageBackend: "postgres",
    uploads: { ok: true }
  };

  it("mantem /health/ready indisponivel enquanto o armazenamento inicializa", () => {
    assert.equal(readinessChecksPass(healthyChecks, {
      nodeEnvironment: "production",
      uploadStartupReady: false,
      applicationStartupComplete: false
    }), false);
  });

  it("libera /health/ready depois de banco, identidade e integridade estarem prontos", () => {
    assert.equal(readinessChecksPass(healthyChecks, {
      nodeEnvironment: "production",
      uploadStartupReady: true,
      applicationStartupComplete: true
    }), true);
  });

  it("responde usando a ultima integridade e atualiza cache expirado sem aguardar Drive", async () => {
    let resolveRefresh;
    const refresh = new Promise((resolve) => {
      resolveRefresh = resolve;
    });
    let refreshCalls = 0;
    const result = uploadIntegrityForHealth({
      integrityState: {
        result: { ok: true, referenced: 3, available: 3, missing: 0 },
        stale: true
      },
      nodeEnvironment: "production",
      refresh: () => {
        refreshCalls += 1;
        return refresh;
      }
    });

    assert.deepEqual(result, { ok: true, referenced: 3, available: 3, missing: 0 });
    assert.equal(refreshCalls, 1);
    resolveRefresh();
    await refresh;
  });

  it("mantem readiness de uploads indisponivel sem resultado de integridade", () => {
    assert.deepEqual(uploadIntegrityForHealth({
      integrityState: { result: null, stale: false },
      refresh: async () => null
    }), { ok: false, referenced: 0, available: 0, missing: null });
  });

  it("nao altera readiness nem aciona refresh fora de producao", () => {
    let refreshCalls = 0;
    const result = uploadIntegrityForHealth({
      nodeEnvironment: "test",
      integrityState: { result: { ok: true, referenced: 1, available: 1, missing: 0 }, stale: true },
      refresh: async () => { refreshCalls += 1; }
    });
    assert.equal(result.ok, true);
    assert.equal(refreshCalls, 0);
  });

  it("compartilha uma unica atualizacao de integridade em segundo plano", async () => {
    const first = refreshUploadIntegrityInBackground({ backend: "local", references: [] });
    const second = refreshUploadIntegrityInBackground({ backend: "local", references: [] });
    assert.equal(first, second);
    await first;
  });
});

describe("politica de senhas", () => {
  it("aceita senha com oito caracteres, maiuscula, numero e especial", () => {
    assert.equal(isValidPassword("Almox@12"), true);
  });

  it("rejeita senha que nao atende cada requisito", () => {
    assert.equal(isValidPassword("Ab@123"), false, "menos de oito caracteres");
    assert.equal(isValidPassword("almox@123"), false, "sem maiuscula");
    assert.equal(isValidPassword("Almox@abc"), false, "sem numero");
    assert.equal(isValidPassword("Almox123"), false, "sem caractere especial");
  });

  it("aceita maiusculas Unicode, mas nao considera espaco um caractere especial", () => {
    assert.equal(isValidPassword("Álmox@12"), true);
    assert.equal(isValidPassword("Álmox 12"), false);
  });
});

describe("limite de trabalho criptografico", () => {
  it("limita concorrencia e rejeita excedente da fila", async () => {
    const limiter = createWorkLimiter(1, 1);
    let releaseFirst;
    const first = limiter.run(() => new Promise((resolve) => {
      releaseFirst = resolve;
    }));
    await new Promise((resolve) => setImmediate(resolve));
    const second = limiter.run(() => "segunda");

    await assert.rejects(() => limiter.run(() => "terceira"), (error) => error.code === "WORK_QUEUE_FULL");
    assert.deepEqual(limiter.stats(), { active: 1, queued: 1, concurrency: 1, queueLimit: 1 });
    releaseFirst("primeira");
    assert.deepEqual(await Promise.all([first, second]), ["primeira", "segunda"]);
  });
});

describe("configuracao SMTP", () => {
  it("separa usuario SMTP do endereco remetente no Resend", () => {
    const configuration = resolveEmailConfiguration({
      SMTP_USER: "resend",
      SMTP_PASS: "re_fake_key",
      EMAIL_FROM_ADDRESS: "NOREPLY@APP.EXAMPLE.COM"
    });

    assert.equal(configuration.authUser, "resend");
    assert.equal(configuration.fromAddress, "noreply@app.example.com");
    assert.equal(configuration.configured, true);
  });

  it("mantem compatibilidade com credenciais Gmail", () => {
    const configuration = resolveEmailConfiguration({
      GMAIL_USER: "Equipe@Example.com",
      GMAIL_APP_PASSWORD: "senha-de-app"
    });

    assert.equal(configuration.authUser, "Equipe@Example.com");
    assert.equal(configuration.fromAddress, "equipe@example.com");
    assert.equal(configuration.configured, true);
  });

  it("rejeita configuracao sem remetente valido", () => {
    const configuration = resolveEmailConfiguration({ SMTP_USER: "resend", SMTP_PASS: "re_fake_key" });
    assert.equal(configuration.configured, false);
  });
});

describe("rotas http", () => {
  it("serve a pagina inicial com o favicon novo", async () => {
    const response = await invokeRequest({ method: "GET", path: "/" });
    const body = response.text();

    assert.equal(response.statusCode, 200);
    assert.match(response.headers["content-type"] || "", /text\/html/);
    assert.match(body, /\/new_favicon\.png/);
    assert.doesNotMatch(body, /Olá, Administrador|id="sidebarUserRole">admin/);
    assert.match(body, /data-section="settings"[^>]*hidden|class="[^"]*hidden[^"]*" data-section="settings"/);
    assert.match(body, /id="mobileMenuToggle"/);
    assert.match(body, /class="process-table"/);
    assert.match(body, /class="sidebar-header">[\s\S]*class="brand"[\s\S]*id="sidebarToggle"/);
  });

  it("permite carregar o login antes de existir um usuario no frontend", () => {
    const appSource = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
    const apiSource = appSource.slice(appSource.indexOf("async function api("), appSource.indexOf("function documentCell("));
    assert.match(apiSource, /credentials:\s*"same-origin"/);
    assert.doesNotMatch(apiSource, /"x-user-email"|"x-user-name"/);
  });

  it("mantem a busca como componente unico nos temas claro e escuro", () => {
    const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
    assert.match(styles, /\.search-box input \{[\s\S]*?background: transparent;/);
    assert.match(styles, /\.search-box:focus-within/);
    assert.match(styles, /\.search-box input:-webkit-autofill/);
    assert.match(styles, /data-theme="dark"\] \.search-box input[\s\S]*?background: transparent;/);
  });

  it("serve o favicon em png via rota principal e alias legado", async () => {
    const primary = await invokeRequest({ method: "GET", path: "/new_favicon.png" });
    const response = await invokeRequest({ method: "GET", path: "/favicon.ico" });

    assert.equal(primary.statusCode, 200);
    assert.equal(primary.headers["content-type"], "image/png");
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["content-type"], "image/png");
    assert.ok(response.body.length > 0);
  });

  it("revalida assets estaticos por ETag sem cachear indefinidamente o HTML", async () => {
    const asset = await invokeRequest({ method: "GET", path: "/app.js" });
    assert.equal(asset.statusCode, 200);
    assert.match(asset.headers["cache-control"] || "", /public, max-age=60, must-revalidate/);
    assert.ok(asset.headers.etag);

    const revalidated = await invokeRequest({
      method: "GET",
      path: "/app.js",
      headers: { "if-none-match": asset.headers.etag }
    });
    assert.equal(revalidated.statusCode, 304);
    assert.equal(revalidated.body.length, 0);

    const index = await invokeRequest({ method: "GET", path: "/" });
    assert.equal(index.headers["cache-control"], "no-cache");
    assert.ok(index.headers.etag);
  });

  it("serve rotas limpas da SPA e preserva HEAD, cache e 404 de assets", async () => {
    const index = await invokeRequest({ method: "GET", path: "/" });
    for (const path of [
      "/graficos",
      "/empenhos",
      "/quadro",
      "/fornecedores",
      "/configuracoes",
      "/auditoria",
      "/usuarios",
      "/empenhos/processo-1/documentos",
      "/pagina-inexistente"
    ]) {
      const response = await invokeRequest({ method: "GET", path });
      assert.equal(response.statusCode, 200, path);
      assert.match(response.headers["content-type"] || "", /text\/html/, path);
      assert.equal(response.headers["cache-control"], "no-cache", path);
      assert.equal(response.headers.etag, index.headers.etag, path);
      assert.deepEqual(response.body, index.body, path);
    }

    const head = await invokeRequest({ method: "HEAD", path: "/empenhos/processo-1/observacoes" });
    assert.equal(head.statusCode, 200);
    assert.equal(head.body.length, 0);
    assert.equal(Number(head.headers["content-length"]), index.body.length);
    assert.equal(head.headers["cache-control"], "no-cache");

    const unsupported = await invokeRequest({ method: "POST", path: "/empenhos" });
    assert.equal(unsupported.statusCode, 405);
    assert.equal(unsupported.headers.allow, "GET, HEAD");

    const missingAsset = await invokeRequest({ method: "GET", path: "/asset-inexistente.js" });
    assert.equal(missingAsset.statusCode, 404);
    assert.match(missingAsset.text(), /Arquivo nao encontrado/);
  });

  it("serve o modulo JavaScript do quadro", async () => {
    const response = await invokeRequest({ method: "GET", path: "/kanban-board.js" });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["content-type"], "text/javascript; charset=utf-8");
    assert.match(response.text(), /export function groupProcessesByStatus/);
  });

  it("expoe readiness publica minima sem detalhes operacionais", async () => {
    const response = await invokeRequest({ method: "GET", path: "/health/ready" });
    const payload = response.json();

    assert.equal(response.statusCode, 200);
    assert.deepEqual(Object.keys(payload), ["status"]);
    assert.equal(payload.status, "ready");
    assert.equal(Object.hasOwn(payload, "checks"), false);

    const health = await invokeRequest({ method: "GET", path: "/health" });
    assert.equal(health.statusCode, 503);
    assert.deepEqual(health.json(), { status: "unavailable" });
  });

  it("marca scheduler parado, atrasado e com erro persistente como degradado", () => {
    const now = Date.parse("2026-07-16T12:00:00.000Z");
    assert.equal(emailSchedulerHealthStatus({}, now, false).degraded, true);
    assert.equal(emailSchedulerHealthStatus({
      startedAt: "2026-07-16T10:00:00.000Z",
      lastRunStartedAt: null,
      consecutiveErrors: 0
    }, now, true).status, "degraded");
    assert.equal(emailSchedulerHealthStatus({
      startedAt: "2026-07-16T10:00:00.000Z",
      lastRunStartedAt: "2026-07-16T11:59:30.000Z",
      lastErrorAt: "2026-07-16T11:58:00.000Z",
      consecutiveErrors: 1
    }, now, true).status, "degraded");
  });

  it("retorna 404 para arquivo estatico inexistente", async () => {
    const response = await invokeRequest({ method: "GET", path: "/arquivo-que-nao-existe.txt" });

    assert.equal(response.statusCode, 404);
    assert.equal(response.headers["content-type"], "text/plain; charset=utf-8");
    assert.match(response.text(), /Arquivo nao encontrado/);
  });

  it("exige autenticacao para consultar ou baixar empenhos", async () => {
    for (const path of ["/api/meta", "/api/dashboard", "/api/processes", "/api/processes/processo-inexistente", "/api/processes/download"]) {
      const anonymous = await invokeRequest({ method: "GET", path });
      assert.equal(anonymous.statusCode, 401, path);
      assert.deepEqual(anonymous.json(), { error: "Faca login para continuar." });
    }

    const { token } = await authenticatedAs("almoxarifado");
    const response = await invokeRequest({
      method: "GET",
      path: "/api/processes/download",
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.headers["content-type"] || "", /text\/csv/);
    assert.match(response.text(), /"Processo";"Empenho";"Fornecedor";"Materiais"/);
  });

  it("consulta um empenho por ID com dados enriquecidos e oculta inativos", async () => {
    const { token } = await authenticatedAs("almoxarifado");
    const created = await postJson("/api/processes", token, {
      numeroProcesso: `DETALHE-${crypto.randomUUID().slice(0, 8)}`,
      numeroEmpenho: testCommitmentNumber(),
      materiais: [{ descricao: "Material consultado", quantidade: 3, valorUnitario: 12.5 }]
    });
    assert.equal(created.statusCode, 201);
    const processId = created.json().id;
    const headers = { authorization: `Bearer ${token}` };

    const response = await invokeRequest({
      method: "GET",
      path: `/api/processes/${processId}`,
      headers
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["cache-control"], "private, no-store");
    assert.equal(response.json().id, processId);
    assert.equal(response.json().valorTotal, 37.5);
    assert.equal(response.json().materiais[0].descricao, "Material consultado");

    const missing = await invokeRequest({
      method: "GET",
      path: `/api/processes/${crypto.randomUUID()}`,
      headers
    });
    assert.equal(missing.statusCode, 404);
    assert.deepEqual(missing.json(), { error: "Processo nao encontrado" });

    const store = await readStore();
    const original = store.processos.find((processo) => processo.id === processId);
    store.processos.push({ ...original, id: "processo 42", numeroProcesso: `LEGADO-${crypto.randomUUID().slice(0, 8)}` });
    await writeStore(store);
    const encodedId = await invokeRequest({
      method: "GET",
      path: "/api/processes/processo%2042",
      headers
    });
    assert.equal(encodedId.statusCode, 200);
    assert.equal(encodedId.json().id, "processo 42");

    store.processos = store.processos.filter((processo) => processo.id !== "processo 42");
    store.processos.find((processo) => processo.id === processId).inativo = true;
    await writeStore(store);
    const inactive = await invokeRequest({
      method: "GET",
      path: `/api/processes/${processId}`,
      headers
    });
    assert.equal(inactive.statusCode, 404);
    assert.deepEqual(inactive.json(), { error: "Processo nao encontrado" });
  });

  it("pagina empenhos no servidor sem alterar o contrato legado da lista", async () => {
    const { token } = await authenticatedAs("almoxarifado");
    const marker = `PAGINACAO-${Date.now()}`;
    const ids = [1, 2, 3].map((index) => `${marker}-${index}`);
    const store = await readStore();
    store.processos.push(...ids.map((id, index) => ({
      id,
      numeroProcesso: id,
      numeroEmpenho: testCommitmentNumber(),
      fornecedor: index === 1 ? "Fornecedor alvo" : "Outro fornecedor",
      status: index === 2 ? "Pago" : "Enviado para SALC",
      materiais: [{ descricao: index === 0 ? "Material alvo" : "Material comum", quantidade: 1, valorUnitario: 1 }]
    })));
    await writeStore(store);
    const headers = { authorization: `Bearer ${token}` };

    try {
      const firstPage = await invokeRequest({
        method: "GET",
        path: `/api/processes?page=1&limit=1&q=${encodeURIComponent(marker)}`,
        headers
      });
      assert.equal(firstPage.statusCode, 200);
      assert.equal(Array.isArray(firstPage.json()), false);
      assert.equal(firstPage.json().total, 3);
      assert.equal(firstPage.json().data.length, 1);
      assert.equal(firstPage.json().page, 1);
      assert.equal(firstPage.json().limit, 1);
      assert.equal(firstPage.json().totalPages, 3);

      const filtered = await invokeRequest({
        method: "GET",
        path: `/api/processes?page=9&limit=500&q=${encodeURIComponent(marker)}&filtroRapido=Pago`,
        headers
      });
      assert.equal(filtered.statusCode, 200);
      assert.equal(filtered.json().limit, 100);
      assert.equal(filtered.json().page, 1);
      assert.deepEqual(filtered.json().data.map((processo) => processo.id), [ids[2]]);

      const search = await invokeRequest({
        method: "GET",
        path: "/api/processes?page=1&limit=25&q=material%20alvo",
        headers
      });
      assert.equal(search.statusCode, 200);
      assert.ok(search.json().data.some((processo) => processo.id === ids[0]));

      const legacy = await invokeRequest({ method: "GET", path: `/api/processes?q=${encodeURIComponent(marker)}`, headers });
      assert.equal(legacy.statusCode, 200);
      assert.equal(Array.isArray(legacy.json()), true);

      const invalid = await invokeRequest({ method: "GET", path: "/api/processes?page=zero", headers });
      assert.equal(invalid.statusCode, 400);
      assert.match(invalid.json().error, /page.*inteiro positivo/i);
    } finally {
      const cleanupStore = await readStore();
      cleanupStore.processos = cleanupStore.processos.filter((processo) => !ids.includes(processo.id));
      await writeStore(cleanupStore);
    }
  });

  it("calcula filtros de prazo da paginação no fallback antes de aplicar o filtro rápido", async () => {
    const { token } = await authenticatedAs("almoxarifado");
    const marker = `PRAZO-PAGINACAO-${Date.now()}`;
    const ids = ["atrasado", "trinta", "entregue", "anulado"].map((suffix) => `${marker}-${suffix}`);
    const store = await readStore();
    store.processos.push(
      {
        id: ids[0], numeroProcesso: ids[0], numeroEmpenho: testCommitmentNumber(), fornecedor: "Fornecedor prazo",
        status: "Aguardando entrega", dataEnvioFornecedor: brazilianDateDaysAgo(31), materiais: []
      },
      {
        id: ids[1], numeroProcesso: ids[1], numeroEmpenho: testCommitmentNumber(), fornecedor: "Fornecedor prazo",
        status: "Aguardando entrega", dataEnvioFornecedor: brazilianDateDaysAgo(30), materiais: []
      },
      {
        id: ids[2], numeroProcesso: ids[2], numeroEmpenho: testCommitmentNumber(), fornecedor: "Fornecedor prazo",
        status: "Entregue", dataEnvioFornecedor: brazilianDateDaysAgo(31), materiais: []
      },
      {
        id: ids[3], numeroProcesso: ids[3], numeroEmpenho: testCommitmentNumber(), fornecedor: "Fornecedor prazo",
        status: "Anulado", dataEnvioFornecedor: brazilianDateDaysAgo(31), materiais: []
      }
    );
    await writeStore(store);
    const headers = { authorization: `Bearer ${token}` };

    try {
      for (const quickFilter of ["Em atraso", "Mais de 30 dias"]) {
        const response = await invokeRequest({
          method: "GET",
          path: `/api/processes?page=1&limit=25&q=${encodeURIComponent(marker)}&filtroRapido=${encodeURIComponent(quickFilter)}`,
          headers
        });
        assert.equal(response.statusCode, 200);
        assert.equal(response.json().total, 1);
        assert.deepEqual(response.json().data.map((processo) => processo.id), [ids[0]]);
        assert.ok(response.json().data[0].diasDecorridos > 30);
      }
    } finally {
      const cleanupStore = await readStore();
      cleanupStore.processos = cleanupStore.processos.filter((processo) => !ids.includes(processo.id));
      await writeStore(cleanupStore);
    }
  });

  it("mantem o alias de download protegido por autenticacao", async () => {
    const anonymous = await invokeRequest({ method: "GET", path: "/api/processes/download" });
    assert.equal(anonymous.statusCode, 401);

    const { token } = await authenticatedAs("almoxarifado");
    const authenticated = await invokeRequest({
      method: "GET",
      path: "/api/processes/download",
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(authenticated.statusCode, 200);
    assert.match(authenticated.headers["content-type"] || "", /text\/csv/);
  });

  it("gera relatorios autenticados em PDF e Excel", async () => {
    const { token } = await authenticatedAs("almoxarifado");
    const headers = { authorization: `Bearer ${token}` };
    const pdf = await invokeRequest({ method: "GET", path: "/api/processes/download?format=pdf", headers });
    assert.equal(pdf.statusCode, 200);
    assert.equal(pdf.headers["content-type"], "application/pdf");
    assert.equal(pdf.body.subarray(0, 4).toString(), "%PDF");

    const excel = await invokeRequest({ method: "GET", path: "/api/processes/download?format=excel", headers });
    assert.equal(excel.statusCode, 200);
    assert.match(excel.headers["content-type"] || "", /application\/vnd\.ms-excel/);
    assert.match(excel.text(), /<table>/);
  });

  it("aplica varios filtros rapidos ao mesmo download", async () => {
    const { token } = await authenticatedAs("almoxarifado");
    const marker = `MULTIFILTRO-${Date.now()}`;
    const ids = ["liquidado", "pago", "anulado"].map((status) => `${marker}-${status}`);
    const store = await readStore();
    store.processos.push(
      {
        id: ids[0],
        numeroProcesso: `${marker}-LIQUIDADO`,
        numeroEmpenho: testCommitmentNumber(),
        fornecedor: "Fornecedor Liquidado",
        status: "Liquidado",
        materiais: []
      },
      {
        id: ids[1],
        numeroProcesso: `${marker}-PAGO`,
        numeroEmpenho: testCommitmentNumber(),
        fornecedor: "Fornecedor Pago",
        status: "Pago",
        materiais: []
      },
      {
        id: ids[2],
        numeroProcesso: `${marker}-ANULADO`,
        numeroEmpenho: testCommitmentNumber(),
        fornecedor: "Fornecedor Anulado",
        status: "Anulado",
        materiais: []
      }
    );
    await writeStore(store);

    try {
      const params = new URLSearchParams({
        format: "csv",
        q: marker
      });
      params.append("filtroRapido", "Liquidado");
      params.append("filtroRapido", "Pago");
      const response = await invokeRequest({
        method: "GET",
        path: `/api/processes/download?${params}`,
        headers: { authorization: `Bearer ${token}` }
      });

      assert.equal(response.statusCode, 200);
      assert.match(response.text(), new RegExp(`${marker}-LIQUIDADO`));
      assert.match(response.text(), new RegExp(`${marker}-PAGO`));
      assert.doesNotMatch(response.text(), new RegExp(`${marker}-ANULADO`));
    } finally {
      const cleanupStore = await readStore();
      cleanupStore.processos = cleanupStore.processos.filter((processo) => !ids.includes(processo.id));
      await writeStore(cleanupStore);
    }
  });

  it("neutraliza formulas nas exportacoes CSV e Excel", async () => {
    const { token } = await authenticatedAs("almoxarifado");
    const suffix = Date.now().toString().slice(-6);
    const dangerousValues = {
      numeroProcesso: `=1+${suffix}`,
      numeroEmpenho: `+1+${suffix}`,
      fornecedor: `-1+${suffix}`,
      material: `@SUM(${suffix})`
    };
    const created = await postJson("/api/processes", token, {
      numeroProcesso: dangerousValues.numeroProcesso,
      numeroEmpenho: testCommitmentNumber(),
      fornecedor: dangerousValues.fornecedor,
      materiais: [{ descricao: dangerousValues.material, valorUnitario: 1, quantidade: 1 }]
    });
    assert.equal(created.statusCode, 201);
    const dangerousStore = await readStore();
    dangerousStore.processos.find((processo) => processo.id === created.json().id).numeroEmpenho = dangerousValues.numeroEmpenho;
    await writeStore(dangerousStore);

    const headers = { authorization: `Bearer ${token}` };
    const csv = await invokeRequest({ method: "GET", path: "/api/processes/download", headers });
    assert.equal(csv.statusCode, 200);
    const excel = await invokeRequest({ method: "GET", path: "/api/processes/download?format=excel", headers });
    assert.equal(excel.statusCode, 200);

    for (const value of Object.values(dangerousValues)) {
      assert.match(csv.text(), new RegExp(`"'${escapeRegExp(value)}"`));
      assert.doesNotMatch(csv.text(), new RegExp(`"${escapeRegExp(value)}"`));
      assert.match(excel.text(), new RegExp(`>'${escapeRegExp(value)}<`));
      assert.doesNotMatch(excel.text(), new RegExp(`>${escapeRegExp(value)}<`));
    }
    assert.match(excel.text(), /mso-number-format/);
  });

  it("entrega metricas, graficos, anos e ano do painel em uma unica resposta", async () => {
    const store = await readStore();
    store.processos.push(
      {
        id: crypto.randomUUID(), numeroProcesso: "DASH-2040", status: "Liquidado",
        dataEnvioEmpenho: "2040-03-10", dataLiquidacao: "2040-05-10",
        materiais: [{ descricao: "Papel", valorUnitario: 10, quantidade: 2 }]
      },
      {
        id: crypto.randomUUID(), numeroProcesso: "DASH-2041", status: "Pago",
        dataEnvioEmpenho: "2041-04-10", dataLiquidacao: "2041-05-10", dataPagamento: "2041-06-10",
        materiais: [{ descricao: "Caneta", valorUnitario: 5, quantidade: 3 }]
      }
    );
    await writeStore(store);

    const { token } = await authenticatedAs("almoxarifado");
    const response = await invokeRequest({
      method: "GET",
      path: "/api/dashboard?ano=2040",
      headers: { authorization: `Bearer ${token}` }
    });
    const payload = response.json();
    assert.equal(response.statusCode, 200);
    assert.equal(payload.ano, 2040);
    assert.deepEqual(payload.anos.slice(0, 2), [2041, 2040]);
    assert.equal(payload.charts.execucaoMensal.length, 12);
    assert.deepEqual(payload.charts.distribuicaoStatus, [{ status: "Liquidado", quantidade: 1 }]);
    assert.equal(payload.metrics.processosAtivos, 1);
    assert.equal(payload.metrics.valorEmpenhado, 20);
    assert.equal(payload.metrics.valorLiquidado, 20);
    assert.equal(payload.metrics.valorPago, 0);

    const paidYear = await invokeRequest({
      method: "GET",
      path: "/api/dashboard?ano=2041",
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(paidYear.statusCode, 200);
    assert.equal(paidYear.json().metrics.valorLiquidado, 15);
    assert.equal(paidYear.json().metrics.valorPago, 15);
  });

  it("invalida imediatamente o cache do painel depois de uma mutacao", async () => {
    const { token } = await authenticatedAs("almoxarifado");
    const currentYear = new Date().getFullYear();
    const headers = { authorization: `Bearer ${token}` };
    const before = await invokeRequest({ method: "GET", path: `/api/dashboard?ano=${currentYear}`, headers });
    assert.equal(before.statusCode, 200);
    const selectedYear = before.json().ano;

    const created = await postJson("/api/processes", token, {
      numeroProcesso: `CACHE-${crypto.randomUUID().slice(0, 12)}`,
      numeroEmpenho: testCommitmentNumber(),
      dataEnvioEmpenho: `${selectedYear}-01-10`
    });
    assert.equal(created.statusCode, 201);

    const after = await invokeRequest({ method: "GET", path: `/api/dashboard?ano=${currentYear}`, headers });
    assert.equal(after.statusCode, 200);
    assert.equal(after.json().metrics.processosAtivos, before.json().metrics.processosAtivos + 1);
  });

  it("serve o alias de download com autenticacao", async () => {
    const { token } = await authenticatedAs("almoxarifado");
    const response = await invokeRequest({
      method: "GET",
      path: "/api/processes/download?format=csv",
      headers: { authorization: `Bearer ${token}` }
    });

    assert.equal(response.statusCode, 200);
    assert.match(response.headers["content-type"] || "", /text\/csv/);
    assert.match(response.text(), /"Processo";"Empenho";"Fornecedor";"Materiais"/);
  });

  it("nao oferece login Google nem solicitacao publica de acesso", async () => {
    const google = await invokeRequest({ method: "GET", path: "/auth/google/config" });
    const response = await invokeRequest({
      method: "POST",
      path: "/auth/request-access",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nome: "Solicitante", email: "solicitante@example.com" })
    });
    assert.equal(google.statusCode, 404);
    assert.equal(response.statusCode, 404);
  });

  it("reserva configuracoes ao admin e impede mutacoes do auditor", () => {
    assert.equal(requiresAdmin("PUT", "/api/settings/notifications"), true);
    assert.equal(requiresAdmin("GET", "/api/security-audit"), false);
    assert.equal(roleCanMutate("admin"), true);
    assert.equal(roleCanMutate("almoxarifado"), true);
    assert.equal(roleCanMutate("auditor"), false);
    assert.equal(requiresAdmin("DELETE", "/api/processes/process-1/timeline-items"), true);
  });

  it("impede usuario comum de alterar configuracoes e ler auditoria de seguranca", async () => {
    const { token } = await authenticatedAs("almoxarifado");
    const response = await invokeRequest({
      method: "PUT",
      path: "/api/settings/notifications",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ diasAvisoInterno: [7], diaOficioFornecedor: 30 })
    });
    assert.equal(response.statusCode, 403);

    const auditResponse = await invokeRequest({
      method: "GET",
      path: "/api/security-audit",
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(auditResponse.statusCode, 403);
  });

  it("permite Almoxarifado consultar a auditoria do processo para a linha do tempo", async () => {
    const { token } = await authenticatedAs("almoxarifado");
    const created = await postJson("/api/processes", token, {
      numeroProcesso: `AT-${crypto.randomUUID().slice(0, 8)}`,
      numeroEmpenho: testCommitmentNumber()
    });
    assert.equal(created.statusCode, 201);

    const response = await invokeRequest({
      method: "GET",
      path: `/api/processes/${created.json().id}/audit`,
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(response.statusCode, 200);
    assert.ok(response.json().some((entry) => entry.acao === "Criacao de processo"));

    const globalAudit = await invokeRequest({
      method: "GET",
      path: "/api/audit",
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(globalAudit.statusCode, 403);
  });

  it("permite somente ao admin excluir um dado da linha do tempo sem apagar a auditoria", async () => {
    const { token: warehouseToken } = await authenticatedAs("almoxarifado");
    const created = await postJson("/api/processes", warehouseToken, {
      numeroProcesso: `TIMELINE-${crypto.randomUUID().slice(0, 8)}`,
      numeroEmpenho: testCommitmentNumber()
    });
    assert.equal(created.statusCode, 201);

    const store = await readStore();
    const target = store.auditoria.find((entry) => entry.processoId === created.json().id
      && entry.acao === "Criacao de processo");
    const requestDeletion = (token, motivo) => invokeRequest({
      method: "DELETE",
      path: `/api/processes/${created.json().id}/timeline-items`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ tipo: "auditoria", id: target.id, motivo })
    });

    assert.equal((await requestDeletion(warehouseToken, "Correcao visual")).statusCode, 403);

    const { token: adminToken } = await authenticatedAs("admin");
    assert.equal((await requestDeletion(adminToken, "x".repeat(1001))).statusCode, 400);
    assert.equal((await requestDeletion(adminToken, " ")).statusCode, 200);

    const persisted = await readStore();
    assert.ok(persisted.auditoria.some((entry) => entry.id === target.id), "o evento original deve permanecer imutavel");
    const deletion = persisted.auditoria.find((entry) => entry.processoId === created.json().id
      && entry.acao === "Exclusao de dado da linha do tempo");
    assert.equal(deletion.alteracoes.linhaDoTempo.novo, `auditoria:${target.id}`);
    assert.equal(deletion.alteracoes.motivo.novo, null);
    assert.doesNotMatch(deletion.detalhes, /Motivo:/);
    assert.equal((await requestDeletion(adminToken, "Repeticao")).statusCode, 409);
  });

  it("exige empenho padronizado e mantem o numero do processo opcional", async () => {
    const { token } = await authenticatedAs("almoxarifado");
    const suffix = crypto.randomUUID().slice(0, 8);
    const withoutCommitment = await postJson("/api/processes", token, { numeroProcesso: `P-${suffix}` });
    assert.equal(withoutCommitment.statusCode, 400);
    assert.match(withoutCommitment.json().error, /ano.*numero sequencial do empenho/i);

    const invalidFormat = await postJson("/api/processes", token, {
      numeroProcesso: `PI-${suffix}`,
      numeroEmpenho: "2026NE0010"
    });
    assert.equal(invalidFormat.statusCode, 400);
    assert.match(invalidFormat.json().error, /formato AAAANE000NUMERO/i);

    const cases = [
      { numeroEmpenho: "2026ne00010", expectedCommitment: "2026NE00010" },
      { numeroProcesso: `PB-${suffix}`, numeroEmpenho: testCommitmentNumber() }
    ];

    for (const body of cases) {
      const response = await postJson("/api/processes", token, body);
      assert.equal(response.statusCode, 201);
      assert.equal(response.json().numeroProcesso, normalizeProcessNumber(body.numeroProcesso || ""));
      assert.equal(response.json().numeroEmpenho, body.expectedCommitment || body.numeroEmpenho);
    }

    const persisted = await readStore();
    for (const body of cases) {
      assert.ok(persisted.processos.some((processo) => (
        processo.numeroProcesso === normalizeProcessNumber(body.numeroProcesso || "")
          && processo.numeroEmpenho === (body.expectedCommitment || body.numeroEmpenho)
      )));
    }
  });

  it("permite varias notas no mesmo processo e normaliza a numeracao antes de validar", async () => {
    const { token } = await authenticatedAs("almoxarifado");
    const formattedProcessNumber = "12345.123456/2026-78";
    const firstCommitment = testCommitmentNumber();
    const secondCommitment = testCommitmentNumber();
    const first = await postJson("/api/processes", token, {
      numeroProcesso: formattedProcessNumber,
      numeroEmpenho: firstCommitment,
      materiais: [{ descricao: "Item A", valorUnitario: 0.7326, quantidade: 10 }]
    });
    const second = await postJson("/api/processes", token, {
      numeroProcesso: "12345123456202678",
      numeroEmpenho: secondCommitment,
      materiais: [{ descricao: "Item B", valorUnitario: 47.475, quantidade: 2 }]
    });

    assert.equal(first.statusCode, 201);
    assert.equal(second.statusCode, 201);
    assert.equal(first.json().numeroProcesso, formattedProcessNumber);
    assert.equal(second.json().numeroProcesso, formattedProcessNumber);
    assert.equal(first.json().valorTotal, 7.33);
    assert.equal(second.json().valorTotal, 94.95);

    const duplicateCommitment = await postJson("/api/processes", token, {
      numeroProcesso: formattedProcessNumber,
      numeroEmpenho: firstCommitment
    });
    assert.equal(duplicateCommitment.statusCode, 409);
    assert.match(duplicateCommitment.json().error, new RegExp(firstCommitment));
    assert.match(duplicateCommitment.json().error, /registro/i);
  });

  it("protege anulacao liquidada, exige motivo e impede inativar pagamento", async () => {
    const { token } = await authenticatedAs("almoxarifado");
    const created = await postJson("/api/processes", token, {
      numeroProcesso: `LOCK-${crypto.randomUUID().slice(0, 8)}`,
      numeroEmpenho: testCommitmentNumber()
    });
    assert.equal(created.statusCode, 201);

    const noReason = await postJson(`/api/processes/${created.json().id}/cancel`, token, { motivo: " " });
    assert.equal(noReason.statusCode, 400);

    const store = await readStore();
    const process = store.processos.find((item) => item.id === created.json().id);
    process.status = "Liquidado";
    await writeStore(store);
    const commonCancellation = await postJson(`/api/processes/${process.id}/cancel`, token, { motivo: "Tentativa" });
    assert.equal(commonCancellation.statusCode, 403);

    const { token: adminToken } = await authenticatedAs("admin");
    const paidStore = await readStore();
    const paid = paidStore.processos.find((item) => item.id === process.id);
    paid.status = "Pago";
    await writeStore(paidStore);
    const inactivation = await postJson(`/api/processes/${paid.id}/inactivate`, adminToken, {});
    assert.equal(inactivation.statusCode, 403);
  });

  it("permite somente ao administrador retroceder status e registra a correcao", async () => {
    const store = await readStore();
    const process = {
      id: crypto.randomUUID(),
      numeroProcesso: `ROLLBACK-${crypto.randomUUID().slice(0, 8)}`,
      status: "Pago",
      dataEnvioFornecedor: "2024-01-10",
      dataEntrega: "2024-01-15",
      dataEnvioLiquidacao: "2024-01-16",
      dataLiquidacao: "2024-01-17",
      dataPagamento: "2024-01-18",
      materiais: [], documentos: {}, versao: 4, inativo: false
    };
    store.processos.push(process);
    await writeStore(store);

    const { token: warehouseToken } = await authenticatedAs("almoxarifado");
    const forbidden = await postJson(`/api/processes/${process.id}/rollback-status`, warehouseToken, {
      status: "Entregue", motivo: "Correcao", versao: 4
    });
    assert.equal(forbidden.statusCode, 403);

    const { token: adminToken } = await authenticatedAs("admin");
    const invalid = await postJson(`/api/processes/${process.id}/rollback-status`, adminToken, {
      status: "Anulado", motivo: "Correcao", versao: 4
    });
    assert.equal(invalid.statusCode, 400);

    const response = await postJson(`/api/processes/${process.id}/rollback-status`, adminToken, {
      status: "Entregue", motivo: "Liquidacao registrada por engano", versao: 4
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().status, "Entregue");
    assert.equal(response.json().versao, 5);
    assert.equal(response.json().dataEntrega, "2024-01-15");
    assert.equal(response.json().dataEnvioLiquidacao, "");
    assert.equal(response.json().dataLiquidacao, "");
    assert.equal(response.json().dataPagamento, "");

    const persisted = await readStore();
    const audit = persisted.auditoria.find((entry) => entry.processoId === process.id
      && entry.acao === "Retrocesso administrativo de status");
    assert.equal(audit.alteracoes.status.anterior, "Pago");
    assert.equal(audit.alteracoes.status.novo, "Entregue");
    assert.equal(audit.alteracoes.motivo.novo, "Liquidacao registrada por engano");

    const stale = await postJson(`/api/processes/${process.id}/rollback-status`, adminToken, {
      status: "Aguardando entrega", motivo: "Outra correcao", versao: 4
    });
    assert.equal(stale.statusCode, 409);
  });

  it("registra todo o saldo pendente quando a entrega informa somente a data", async () => {
    const store = await readStore();
    const process = {
      id: crypto.randomUUID(),
      numeroProcesso: `ENTREGA-${crypto.randomUUID().slice(0, 8)}`,
      status: "Entrega parcial",
      dataEnvioFornecedor: "2024-01-10",
      materiais: [
        { id: "material-papel", descricao: "Papel", valorUnitario: 10, quantidade: 5 },
        { id: "material-caneta", descricao: "Caneta", valorUnitario: 2, quantidade: 3 }
      ],
      entregas: [{
        id: crypto.randomUUID(),
        data: "2024-01-11",
        itens: [{ materialId: "material-papel", materialIndex: 0, descricao: "Papel", quantidade: 2 }]
      }],
      documentos: {}, versao: 1, inativo: false
    };
    store.processos.push(process);
    await writeStore(store);

    const { token } = await authenticatedAs("almoxarifado");
    const response = await postJson(`/api/processes/${process.id}/deliveries`, token, {
      data: "2024-01-12"
    });

    assert.equal(response.statusCode, 201);
    assert.equal(response.json().status, "Entregue");
    assert.deepEqual(response.json().entregas.at(-1).itens.map((item) => ({
      materialId: item.materialId,
      quantidade: item.quantidade
    })), [
      { materialId: "material-papel", quantidade: 3 },
      { materialId: "material-caneta", quantidade: 3 }
    ]);
  });

  it("acompanha servico continuado por competencia e percentual sem exigir entrega", async () => {
    const { token } = await authenticatedAs("almoxarifado");
    const today = currentBrazilianDate();
    const competence = today.slice(0, 7);
    const created = await postJson("/api/processes", token, {
      numeroProcesso: `SERV-${crypto.randomUUID().slice(0, 8)}`,
      numeroEmpenho: testCommitmentNumber(),
      tipoObjeto: "servico",
      acompanhamentoServico: "continuado",
      dataInicioServico: today,
      materiais: [{ descricao: "Manutencao continuada", quantidade: 12, valorUnitario: 1000 }]
    });
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().tipoObjeto, "servico");
    assert.equal(created.json().percentualConcluido, 0);

    const sent = await putJson(`/api/processes/${created.json().id}`, token, {
      numeroProcesso: created.json().numeroProcesso,
      numeroEmpenho: created.json().numeroEmpenho,
      tipoObjeto: "servico",
      acompanhamentoServico: "continuado",
      dataInicioServico: today,
      dataEnvioFornecedor: today,
      materiais: created.json().materiais,
      status: "Empenho enviado ao fornecedor",
      versao: created.json().versao
    });
    assert.equal(sent.statusCode, 200);

    const first = await postJson(`/api/processes/${created.json().id}/service-executions`, token, {
      data: today,
      competencia: competence,
      percentualExecutado: 40,
      valorExecutado: 4000,
      descricao: "Primeira medicao"
    });
    assert.equal(first.statusCode, 201);
    assert.equal(first.json().status, "Em execução");
    assert.equal(first.json().percentualConcluido, 40);
    assert.equal(first.json().dataEntrega, "");

    const delivery = await postJson(`/api/processes/${created.json().id}/deliveries`, token, { data: today });
    assert.equal(delivery.statusCode, 400);
    assert.match(delivery.json().error, /sem entrega fisica|registros de execucao/i);

    const completed = await postJson(`/api/processes/${created.json().id}/service-executions`, token, {
      data: today,
      competencia: competence,
      percentualExecutado: 60,
      valorExecutado: 8000,
      descricao: "Medicao final"
    });
    assert.equal(completed.statusCode, 201);
    assert.equal(completed.json().status, "Serviço concluído");
    assert.equal(completed.json().percentualConcluido, 100);
    assert.equal(completed.json().execucoesServico.length, 2);

    const persisted = await readStore();
    assert.ok(persisted.auditoria.some((entry) => (
      entry.processoId === created.json().id && entry.acao === "Registro de execucao de servico"
    )));
  });

  it("envia o processo entregue diretamente para liquidacao e reconcilia saldo ao editar materiais", async () => {
    const { token } = await authenticatedAs("almoxarifado");
    const store = await readStore();
    const base = {
      numeroProcesso: `FLOW-${crypto.randomUUID().slice(0, 8)}`,
      status: "Entregue",
      dataEnvioFornecedor: "2024-01-10",
      dataEntrega: "2024-01-15",
      materiais: [{ id: "material-1", descricao: "Papel", valorUnitario: 10, quantidade: 10 }],
      entregas: [{
        id: crypto.randomUUID(), data: "2024-01-15",
        itens: [{ materialId: "material-1", materialIndex: 0, descricao: "Papel", quantidade: 10 }]
      }],
      documentos: {
        notaEmpenho: { fileName: "empenho.pdf" }
      },
      versao: 1, inativo: false
    };
    const workflowProcess = { ...structuredClone(base), id: crypto.randomUUID() };
    const balanceProcess = { ...structuredClone(base), id: crypto.randomUUID(), numeroProcesso: `${base.numeroProcesso}-BAL` };
    store.processos.push(workflowProcess, balanceProcess);
    await writeStore(store);

    const payload = (process, overrides = {}) => ({
      numeroProcesso: process.numeroProcesso,
      numeroEmpenho: "",
      fornecedor: "",
      materiais: process.materiais,
      dataEnvioFornecedor: process.dataEnvioFornecedor,
      dataEntrega: process.dataEntrega,
      status: process.status,
      versao: process.versao,
      ...overrides
    });
    const missingDate = await putJson(`/api/processes/${workflowProcess.id}`, token, payload(workflowProcess, {
      status: "Enviado para liquidacao",
    }));
    assert.equal(missingDate.statusCode, 400);
    assert.match(missingDate.json().error, /data de envio para liquidacao/i);

    const reconciled = await putJson(`/api/processes/${balanceProcess.id}`, token, payload(balanceProcess, {
      materiais: [{ id: "material-1", descricao: "Papel", valorUnitario: 10, quantidade: 20 }]
    }));
    assert.equal(reconciled.statusCode, 200);
    assert.equal(reconciled.json().status, "Entrega parcial");
  });

  it("rejeita identificadores vazios e limites excedidos", async () => {
    const { token } = await authenticatedAs("almoxarifado");
    const cases = [
      { body: { numeroProcesso: " ", numeroEmpenho: "" }, expected: /processo.*empenho|empenho.*processo/i },
      { body: { numeroProcesso: "P".repeat(21) }, expected: /20 caracteres/i },
      { body: { numeroEmpenho: "E".repeat(21) }, expected: /20 caracteres/i },
      { body: { numeroProcesso: `FORN-${crypto.randomUUID().slice(0, 6)}`, fornecedor: "F".repeat(101) }, expected: /100 caracteres/i },
      {
        body: {
          numeroProcesso: `MAT-${crypto.randomUUID().slice(0, 6)}`,
          materiais: [{ descricao: "M".repeat(101), valorUnitario: 1, quantidade: 1 }]
        },
        expected: /100 caracteres/i
      }
    ];

    for (const entry of cases) {
      const response = await postJson("/api/processes", token, entry.body);
      assert.equal(response.statusCode, 400);
      assert.match(response.json().error, entry.expected);
    }
  });

  it("rejeita data DD-MM-AAAA invalida e persiste data valida em ISO", async () => {
    const { token } = await authenticatedAs("almoxarifado");
    const invalid = await postJson("/api/processes", token, {
      numeroProcesso: `DATA-INV-${crypto.randomUUID().slice(0, 5)}`,
      dataProcesso: "31-02-2024"
    });
    assert.equal(invalid.statusCode, 400);
    assert.match(invalid.json().error, /Data invalida/);

    const processNumber = `DATA-OK-${crypto.randomUUID().slice(0, 5)}`;
    const valid = await postJson("/api/processes", token, {
      numeroProcesso: processNumber,
      numeroEmpenho: testCommitmentNumber(),
      dataProcesso: "29-02-2024"
    });
    assert.equal(valid.statusCode, 201);
    assert.equal(valid.json().dataProcesso, "2024-02-29");
    const persisted = await readStore();
    assert.equal(
      persisted.processos.find((processo) => processo.numeroProcesso === normalizeProcessNumber(processNumber))?.dataProcesso,
      "2024-02-29"
    );
  });

  it("considera o processo enviado para SALC no momento da criacao", async () => {
    const { token } = await authenticatedAs("almoxarifado");
    const meta = await invokeRequest({
      method: "GET",
      path: "/api/meta",
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(meta.statusCode, 200);
    assert.equal(meta.json().status.includes("Criado"), false);
    assert.equal(meta.json().status.includes("Aguardando entrega"), false);
    assert.equal(meta.json().transicoes.Criado, "Enviado para SALC");
    assert.equal(meta.json().transicoes["Empenho enviado ao fornecedor"], "Entrega parcial");
    assert.equal(meta.json().transicoes["Aguardando entrega"], "Entrega parcial");

    const processNumber = `INICIAL-${crypto.randomUUID().slice(0, 6)}`;
    const bypass = await postJson("/api/processes", token, {
      numeroProcesso: `${processNumber}-B`,
      numeroEmpenho: testCommitmentNumber(),
      status: "Criado"
    });
    assert.equal(bypass.statusCode, 400);
    assert.match(bypass.json().error, /deve iniciar em Enviado para SALC/i);

    const commitmentNumber = testCommitmentNumber();
    const created = await postJson("/api/processes", token, {
      numeroProcesso: processNumber,
      numeroEmpenho: commitmentNumber,
      criadoPor: "Responsavel informado",
      cnpj: "12.345.678/0001-90",
      materiais: [{ descricao: "Equipamento", quantidade: 2, valorUnitario: 1234.56 }]
    });
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().status, "Enviado para SALC");
    assert.equal(created.json().criadoPor, "Responsavel informado");
    assert.equal(created.json().cnpj, "12.345.678/0001-90");
    assert.equal(created.json().valorTotal, 2469.12);

    const renamedCreator = await putJson(`/api/processes/${created.json().id}`, token, {
      numeroProcesso: processNumber,
      numeroEmpenho: commitmentNumber,
      criadoPor: "Responsavel corrigido",
      status: "Enviado para SALC",
      versao: created.json().versao
    });
    assert.equal(renamedCreator.statusCode, 200);
    assert.equal(renamedCreator.json().criadoPor, "Responsavel corrigido");

    const persisted = await readStore();
    const creationAudit = persisted.auditoria.find((entry) => (
      entry.processoId === created.json().id && entry.acao === "Criacao de processo"
    ));
    assert.equal(creationAudit?.alteracoes?.status?.novo, "Enviado para SALC");
    assert.match(creationAudit?.detalhes || "", /criado e enviado para SALC/i);
  });

  it("valida observacoes entre 1 e 350 caracteres", async () => {
    const { token } = await authenticatedAs("almoxarifado");
    const processResponse = await postJson("/api/processes", token, {
      numeroProcesso: `OBS-${crypto.randomUUID().slice(0, 8)}`,
      numeroEmpenho: testCommitmentNumber()
    });
    assert.equal(processResponse.statusCode, 201);
    const processId = processResponse.json().id;

    const empty = await postJson(`/api/processes/${processId}/observations`, token, { conteudo: " " });
    assert.equal(empty.statusCode, 400);
    const tooLong = await postJson(`/api/processes/${processId}/observations`, token, { conteudo: "O".repeat(351) });
    assert.equal(tooLong.statusCode, 400);

    const content = "O".repeat(350);
    const valid = await postJson(`/api/processes/${processId}/observations`, token, { conteudo: content });
    assert.equal(valid.statusCode, 201);
    assert.equal(valid.json().conteudo, content);
    const persisted = await readStore();
    assert.ok(persisted.observacoes.some((observacao) => observacao.id === valid.json().id && observacao.conteudo === content));
  });

  it("rejeita status e datas invalidas sem tocar no armazenamento", () => {
    assert.match(validateProcessBody({ numeroProcesso: "P-1", status: "Status inventado" }), /Status invalido/);
    assert.match(validateProcessBody({ numeroProcesso: "P-1", dataEnvioEmpenho: "2026-02-31" }), /Data invalida/);
  });

  it("rejeita materiais malformados, totais nao finitos e cronologia impossivel", () => {
    assert.match(validateProcessBody({ numeroProcesso: "---" }), /letras ou numeros/i);
    assert.match(validateProcessBody({ numeroProcesso: "P-1", materiais: {} }), /lista/i);
    assert.match(validateProcessBody({ numeroProcesso: "P-1", materiais: [null] }), /objeto valido/i);
    assert.match(validateProcessBody({
      numeroProcesso: "P-1",
      materiais: [{ descricao: "Item", valorUnitario: "Infinity", quantidade: 2 }]
    }), /numeros nao negativos/i);
    assert.match(validateProcessBody({ numeroProcesso: "P-1", dataProcesso: "2999-01-01" }), /futuro/i);
    assert.match(validateProcessBody({
      numeroProcesso: "P-1",
      dataEnvioFornecedor: "2026-02-10",
      dataEntrega: "2026-02-09"
    }), /anterior/i);
  });

  it("rejeita status e datas invalidas recebidas pela API", async () => {
    const { token } = await authenticatedAs("almoxarifado");
    const invalidStatus = await invokeRequest({
      method: "POST",
      path: "/api/processes",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ numeroProcesso: "P-1", status: "Status inventado" })
    });
    assert.equal(invalidStatus.statusCode, 400);

    const invalidDate = await invokeRequest({
      method: "POST",
      path: "/api/processes",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ numeroProcesso: "P-1", dataEnvioEmpenho: "2026-02-31" })
    });
    assert.equal(invalidDate.statusCode, 400);
  });

  it("retorna 400 para JSON malformado sem registrar a query string", async () => {
    const { token } = await authenticatedAs("almoxarifado");
    const originalConsoleError = console.error;
    const errorLogs = [];
    console.error = (...parts) => errorLogs.push(parts.join(" "));
    let response;
    try {
      response = await invokeRequest({
        method: "POST",
        path: "/api/processes?segredo=nao-deve-ir-ao-log",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: "{json-incompleto"
      });
    } finally {
      console.error = originalConsoleError;
    }

    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.json(), { error: "JSON invalido." });
    assert.match(errorLogs.join("\n"), /"path":"\/api\/processes"/);
    assert.doesNotMatch(errorLogs.join("\n"), /segredo=|nao-deve-ir-ao-log/);
  });

  it("rejeita tipo, metadados e Base64 invalidos em uploads", async () => {
    const { token } = await authenticatedAs("almoxarifado");
    const created = await postJson("/api/processes", token, {
      numeroProcesso: `UP-${crypto.randomUUID().slice(0, 12)}`,
      numeroEmpenho: testCommitmentNumber()
    });
    assert.equal(created.statusCode, 201);
    const processId = created.json().id;

    const invalidType = await postJson(`/api/processes/${processId}/documents`, token, {
      documentKey: "naoPermitido",
      fileName: "nota.pdf",
      mimeType: "application/pdf",
      contentBase64: Buffer.from("%PDF-1.4\n").toString("base64")
    });
    assert.equal(invalidType.statusCode, 400);
    assert.match(invalidType.json().error, /tipo de documento/i);

    const invalidBase64 = await postJson(`/api/processes/${processId}/documents`, token, {
      documentKey: "processoSped",
      fileName: "nota.pdf",
      mimeType: "application/pdf",
      contentBase64: "!!!!"
    });
    assert.equal(invalidBase64.statusCode, 400);
    assert.match(invalidBase64.json().error, /Base64/i);

    const truncatedPdf = await postJson(`/api/processes/${processId}/documents`, token, {
      documentKey: "processoSped",
      fileName: "truncado.pdf",
      mimeType: "application/pdf",
      contentBase64: Buffer.from("%PDF-1.4\n").toString("base64")
    });
    assert.equal(truncatedPdf.statusCode, 400);
    assert.match(truncatedPdf.json().error, /Documento invalido/i);

    const malformedPdf = await postJson(`/api/processes/${processId}/documents`, token, {
      documentKey: "processoSped",
      fileName: "estrutura-invalida.pdf",
      mimeType: "application/pdf",
      contentBase64: Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF").toString("base64")
    });
    assert.equal(malformedPdf.statusCode, 400);
    assert.match(malformedPdf.json().error, /corrompido|estrutura renderizavel/i);

    const longName = await postJson(`/api/processes/${processId}/documents`, token, {
      documentKey: "complementares",
      titulo: "Complemento",
      fileName: `${"a".repeat(256)}.pdf`,
      mimeType: "application/pdf",
      contentBase64: Buffer.from("%PDF-1.4\n").toString("base64")
    });
    assert.equal(longName.statusCode, 400);
    assert.match(longName.json().error, /nome do arquivo/i);
  });

  it("recusa o PDF e remove o arquivo quando o validador esta indisponivel", async () => {
    const { token } = await authenticatedAs("almoxarifado");
    const created = await postJson("/api/processes", token, {
      numeroProcesso: `PDFV-${crypto.randomUUID().slice(0, 8)}`,
      numeroEmpenho: testCommitmentNumber()
    });
    assert.equal(created.statusCode, 201);
    const processId = created.json().id;
    const previousPath = process.env.PATH;
    let response;

    try {
      process.env.PATH = "/diretorio-inexistente-sem-pdfinfo";
      response = await postJson(`/api/processes/${processId}/documents`, token, {
        documentKey: "processoSped",
        fileName: "processo-sped.pdf",
        mimeType: "application/pdf",
        contentBase64: validPdfBuffer().toString("base64")
      });
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }

    assert.equal(response.statusCode, 503);
    assert.match(response.json().error, /validacao de PDF esta indisponivel/i);
    assert.deepEqual(await readdir(join(process.env.UPLOAD_STORAGE_ROOT, processId)), []);
  });

  it("mantem PDF anexado protegido para a previa autenticada via Blob", async () => {
    const { token } = await authenticatedAs("almoxarifado");
    const created = await postJson("/api/processes", token, {
      numeroProcesso: `PREVIEW-${crypto.randomUUID().slice(0, 8)}`,
      numeroEmpenho: testCommitmentNumber()
    });
    assert.equal(created.statusCode, 201);

    const attached = await postJson(`/api/processes/${created.json().id}/documents`, token, {
      documentKey: "processoSped",
      fileName: "processo-sped.pdf",
      mimeType: "application/pdf",
      contentBase64: validPdfBuffer().toString("base64")
    });
    assert.equal(attached.statusCode, 200);
    const path = attached.json().documentos.processoSped.path;

    const preview = await invokeRequest({
      method: "GET",
      path,
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(preview.statusCode, 200);
    assert.match(preview.headers["content-disposition"], /^attachment;/);
    assert.equal(preview.headers["x-frame-options"], "DENY");
    assert.equal(preview.headers["content-type"], "application/pdf");
    assert.match(preview.headers["content-security-policy"], /frame-src blob:/);
  });

  it("serve caminhos legados codificados e responde HEAD sem transferir o arquivo", async () => {
    const { token } = await authenticatedAs("almoxarifado");
    const processId = crypto.randomUUID();
    const fileName = "nota fiscal á.pdf";
    const publicPath = `/uploads/${processId}/${fileName}`;
    const extensionFallbackPath = `/uploads/${processId}/relatorio.pdf`;
    const content = validPdfBuffer();
    await mkdir(join(process.env.UPLOAD_STORAGE_ROOT, processId), { recursive: true });
    await writeFile(join(process.env.UPLOAD_STORAGE_ROOT, processId, fileName), content, { mode: 0o600 });
    await writeFile(join(process.env.UPLOAD_STORAGE_ROOT, processId, "relatorio.pdf"), content, { mode: 0o600 });
    const store = await readStore();
    store.processos.push({
      id: processId,
      numeroProcesso: `LEGACY-${processId.slice(0, 8)}`,
      status: "Enviado para liquidacao",
      materiais: [],
      documentos: {
        notaEmpenho: { fileName, path: publicPath, mimeType: "application/pdf" },
        processoSped: { fileName: "Relatorio", path: extensionFallbackPath, mimeType: "application/pdf" }
      }
    });
    await writeStore(store);
    const encodedPath = encodeURI(publicPath);

    const downloaded = await invokeRequest({
      method: "GET",
      path: encodedPath,
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(downloaded.statusCode, 200);
    assert.deepEqual(downloaded.body, content);
    assert.equal(downloaded.headers["content-type"], "application/pdf");
    assert.match(downloaded.headers["content-disposition"], /filename\*=UTF-8''nota%20fiscal%20%C3%A1\.pdf/);

    const head = await invokeRequest({
      method: "HEAD",
      path: encodedPath,
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(head.statusCode, 200);
    assert.equal(head.body.length, 0);
    assert.equal(Number(head.headers["content-length"]), content.length);

    const extensionFallback = await invokeRequest({
      method: "GET",
      path: extensionFallbackPath,
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(extensionFallback.statusCode, 200);
    assert.equal(extensionFallback.headers["content-type"], "application/pdf");
    assert.equal(
      decodeURIComponent(extensionFallback.headers["content-disposition"].split("filename*=UTF-8''")[1]),
      "Relatorio.pdf"
    );

    const replacement = await postJson(`/api/processes/${processId}/documents`, token, {
      documentKey: "notaEmpenho",
      fileName: "substituto.pdf",
      mimeType: "application/pdf",
      contentBase64: content.toString("base64")
    });
    assert.equal(replacement.statusCode, 400);
    assert.match(replacement.json().error, /nao pode ser substituido/i);
  });

  it("diferencia arquivo perdido e impede download completo silenciosamente incompleto", async () => {
    const { token } = await authenticatedAs("almoxarifado");
    const processId = crypto.randomUUID();
    const missingPath = `/uploads/${processId}/documento-perdido.pdf`;
    const store = await readStore();
    store.processos.push({
      id: processId,
      numeroProcesso: `MISSING-${processId.slice(0, 8)}`,
      status: "Enviado para liquidacao",
      materiais: [],
      documentos: {
        processoSped: { fileName: "documento-perdido.pdf", path: missingPath, mimeType: "application/pdf" }
      }
    });
    await writeStore(store);

    const missing = await invokeRequest({
      method: "GET",
      path: missingPath,
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(missing.statusCode, 410);
    assert.match(missing.json().error, /nao esta disponivel no armazenamento/i);

    const complete = await invokeRequest({
      method: "GET",
      path: `/api/processes/${processId}/download?format=zip`,
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(complete.statusCode, 409);
    assert.match(complete.json().error, /documentos indisponiveis/i);

    const repaired = await postJson(`/api/processes/${processId}/documents`, token, {
      documentKey: "processoSped",
      fileName: "documento-restaurado.pdf",
      mimeType: "application/pdf",
      contentBase64: validPdfBuffer().toString("base64")
    });
    assert.equal(repaired.statusCode, 200);
    assert.notEqual(repaired.json().documentos.processoSped.path, missingPath);

    const repairedStore = await readStore();
    const repairedProcess = repairedStore.processos.find((item) => item.id === processId);
    repairedProcess.documentos.complementares = [{ fileName: "registro-antigo-sem-caminho.pdf" }];
    await writeStore(repairedStore);
    const completeAfterRepair = await invokeRequest({
      method: "GET",
      path: `/api/processes/${processId}/download?format=zip`,
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(completeAfterRepair.statusCode, 200);
  });

  it("mantem a restricao administrativa quando processo e template referenciam o mesmo caminho", async () => {
    const { token } = await authenticatedAs("almoxarifado");
    const { token: adminToken } = await authenticatedAs("admin");
    const processId = crypto.randomUUID();
    const publicPath = `/uploads/${processId}/compartilhado.pdf`;
    const ambiguousEncodedPath = `/uploads/${processId}/nome%20duplicado.pdf`;
    const ambiguousLiteralPath = `/uploads/${processId}/nome duplicado.pdf`;
    const content = validPdfBuffer();
    await mkdir(join(process.env.UPLOAD_STORAGE_ROOT, processId), { recursive: true });
    await writeFile(join(process.env.UPLOAD_STORAGE_ROOT, processId, "compartilhado.pdf"), content, { mode: 0o600 });
    const store = await readStore();
    store.processos.push({
      id: processId,
      numeroProcesso: `SCOPE-${processId.slice(0, 8)}`,
      status: "Enviado para SALC",
      materiais: [],
      documentos: {
        processoSped: { fileName: "processo.pdf", path: publicPath, mimeType: "application/pdf" },
        complementares: [
          { fileName: "codificado.pdf", path: ambiguousEncodedPath, mimeType: "application/pdf" },
          { fileName: "literal.pdf", path: ambiguousLiteralPath, mimeType: "application/pdf" }
        ]
      }
    });
    store.configuracoes ||= {};
    store.configuracoes.emailTemplates ||= {};
    store.configuracoes.emailTemplates.testeColisao = {
      assunto: "Teste",
      corpo: "Teste",
      anexos: [{ id: crypto.randomUUID(), fileName: "template.pdf", path: publicPath, mimeType: "application/pdf" }]
    };
    await writeStore(store);

    const restricted = await invokeRequest({
      method: "GET",
      path: publicPath,
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(restricted.statusCode, 403);
    const allowed = await invokeRequest({
      method: "GET",
      path: publicPath,
      headers: { authorization: `Bearer ${adminToken}` }
    });
    assert.equal(allowed.statusCode, 200);
    assert.deepEqual(allowed.body, content);

    const ambiguous = await invokeRequest({
      method: "GET",
      path: ambiguousEncodedPath,
      headers: { authorization: `Bearer ${adminToken}` }
    });
    assert.equal(ambiguous.statusCode, 409);
    assert.match(ambiguous.json().error, /mais de uma referencia/i);
  });

  it("aceita liquidacao com Nota de Empenho disponivel e bloqueia referencia sem arquivo", async () => {
    const { token } = await authenticatedAs("almoxarifado");
    const processId = crypto.randomUUID();
    const store = await readStore();
    store.processos.push({
      id: processId,
      numeroProcesso: `LIQUID-${processId.slice(0, 8)}`,
      numeroEmpenho: "",
      fornecedor: "",
      status: "Aguardando envio para liquidacao",
      dataEnvioFornecedor: "2024-01-10",
      dataEntrega: "2024-01-11",
      materiais: [],
      documentos: {},
      versao: 1,
      inativo: false
    });
    await writeStore(store);
    const pdf = validPdfBuffer();
    const attached = await postJson(`/api/processes/${processId}/documents`, token, {
      documentKey: "notaEmpenho",
      fileName: "nota-empenho.pdf",
      mimeType: "application/pdf",
      contentBase64: pdf.toString("base64")
    });
    assert.equal(attached.statusCode, 200);

    const advancePayload = {
      numeroProcesso: attached.json().numeroProcesso,
      numeroEmpenho: attached.json().numeroEmpenho,
      fornecedor: attached.json().fornecedor,
      materiais: attached.json().materiais,
      dataEnvioFornecedor: attached.json().dataEnvioFornecedor,
      dataEntrega: attached.json().dataEntrega,
      dataEnvioLiquidacao: "2024-01-12",
      status: "Enviado para liquidacao",
      versao: attached.json().versao
    };
    const advanced = await putJson(`/api/processes/${processId}`, token, advancePayload);
    assert.equal(advanced.statusCode, 200);

    const relativePath = advanced.json().documentos.notaEmpenho.path.replace(/^\/uploads\/+/, "");
    await rm(join(process.env.UPLOAD_STORAGE_ROOT, relativePath));
    const unavailable = await putJson(`/api/processes/${processId}`, token, {
      ...advancePayload,
      versao: advanced.json().versao
    });
    assert.equal(unavailable.statusCode, 400);
    assert.match(unavailable.json().error, /nao esta disponivel no armazenamento/i);
  });

  it("preserva extensao e nome original de documentos com nome longo", async () => {
    const { token } = await authenticatedAs("almoxarifado");
    const created = await postJson("/api/processes", token, {
      numeroProcesso: `LONG-${crypto.randomUUID().slice(0, 8)}`,
      numeroEmpenho: testCommitmentNumber()
    });
    const fileName = `${"arquivo-muito-longo-".repeat(11)}á.pdf`.slice(0, 250 - 4) + ".pdf";
    const pdf = validPdfBuffer();
    const attached = await postJson(`/api/processes/${created.json().id}/documents`, token, {
      documentKey: "processoSped",
      fileName,
      mimeType: "application/pdf",
      contentBase64: pdf.toString("base64")
    });
    assert.equal(attached.statusCode, 200);
    const path = attached.json().documentos.processoSped.path;
    assert.match(path, /\.pdf$/i);

    const response = await invokeRequest({ method: "GET", path, headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["content-type"], "application/pdf");
    assert.match(response.headers["content-disposition"], /filename\*=UTF-8''/);
    assert.equal(decodeURIComponent(response.headers["content-disposition"].split("filename*=UTF-8''")[1]), fileName);
  });

  it("impede auditor de criar processos", async () => {
    const { token } = await authenticatedAs("auditor");
    const response = await invokeRequest({
      method: "POST",
      path: "/api/processes",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ numeroProcesso: "AUDITOR-1" })
    });
    assert.equal(response.statusCode, 403);
    assert.match(response.json().error, /somente para consulta/i);
  });

  it("bloqueia mutacoes ate a troca da senha temporaria", async () => {
    const { token } = await authenticatedAs("almoxarifado", { precisaDefinirSenha: true });
    const response = await invokeRequest({
      method: "POST",
      path: "/api/processes",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ numeroProcesso: "TEMP-1" })
    });
    assert.equal(response.statusCode, 403);
    assert.match(response.json().error, /senha temporaria/i);
  });

  it("migra Bearer para cookie e exige origem em mutacoes por cookie", async () => {
    const { token } = await authenticatedAs("admin");
    const session = await invokeRequest({
      method: "GET",
      path: "/auth/session",
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(session.statusCode, 200);
    assert.match(session.headers["set-cookie"] || "", /almox_session=.*HttpOnly.*SameSite=Strict/);
    const cookie = String(session.headers["set-cookie"]).split(";")[0];

    const reloadedSession = await invokeRequest({
      method: "GET",
      path: "/auth/session",
      headers: { cookie }
    });
    assert.equal(reloadedSession.statusCode, 200);
    assert.equal(reloadedSession.json().email, "teste-admin@example.test");
    assert.match(reloadedSession.headers["set-cookie"] || "", /almox_session=.*HttpOnly/);

    const blocked = await invokeRequest({
      method: "PUT",
      path: "/api/settings/notifications",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ diasAvisoInterno: [7], diaOficioFornecedor: 30 })
    });
    assert.equal(blocked.statusCode, 403);
    assert.match(blocked.json().error, /Origem/);

    const allowed = await invokeRequest({
      method: "PUT",
      path: "/api/settings/notifications",
      headers: { cookie, origin: "http://localhost", "content-type": "application/json" },
      body: JSON.stringify({ diasAvisoInterno: [7], diaOficioFornecedor: 30 })
    });
    assert.equal(allowed.statusCode, 200);
  });

  it("mantem tokens de sessao somente no cookie HttpOnly", async () => {
    const password = "Atual@123";
    const { token } = await authenticatedAs("almoxarifado", { password });
    const login = await invokeRequest({
      method: "POST",
      path: "/auth/login",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "teste-almoxarifado@example.test", senha: password })
    });
    assert.equal(login.statusCode, 200);
    assertSensitiveCredentialsAbsent(login.json(), password);
    assert.match(login.headers["set-cookie"] || "", /almox_session=.*HttpOnly.*SameSite=Strict/);
    const maxAge = Number(String(login.headers["set-cookie"]).match(/Max-Age=(\d+)/)?.[1]);
    assert.ok(maxAge > 30 * 60);

    const changed = await invokeRequest({
      method: "POST",
      path: "/auth/change-password",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ senhaAtual: password, novaSenha: "Nova@456", confirmacao: "Nova@456" })
    });
    assert.equal(changed.statusCode, 200);
    assertSensitiveCredentialsAbsent(changed.json(), "Nova@456");
    assert.match(changed.headers["set-cookie"] || "", /almox_session=.*HttpOnly/);

    const oldSession = await invokeRequest({
      method: "GET",
      path: "/auth/session",
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(oldSession.statusCode, 401);
  });

  it("permite ao usuario autenticado atualizar a propria foto de perfil", async () => {
    const { token } = await authenticatedAs("almoxarifado");
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlXl9sAAAAASUVORK5CYII=";
    const changed = await invokeRequest({
      method: "PUT",
      path: "/auth/profile-photo",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ foto: png })
    });

    assert.equal(changed.statusCode, 200);
    assert.equal(changed.json().user.foto, png);

    const session = await invokeRequest({
      method: "GET",
      path: "/auth/session",
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(session.statusCode, 200);
    assert.equal(session.json().foto, png);

    const invalid = await invokeRequest({
      method: "PUT",
      path: "/auth/profile-photo",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ foto: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" })
    });
    assert.equal(invalid.statusCode, 400);
    assert.match(invalid.json().error, /PNG, JPEG ou WebP/);
  });

  it("permite ao usuario autenticado atualizar o proprio nome", async () => {
    const { token } = await authenticatedAs("almoxarifado");
    const changed = await invokeRequest({
      method: "PUT",
      path: "/auth/profile",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ nome: "  Novo Nome  " })
    });

    assert.equal(changed.statusCode, 200);
    assert.equal(changed.json().user.nome, "Novo Nome");

    const session = await invokeRequest({
      method: "GET",
      path: "/auth/session",
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(session.statusCode, 200);
    assert.equal(session.json().nome, "Novo Nome");

    const invalid = await invokeRequest({
      method: "PUT",
      path: "/auth/profile",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ nome: " " })
    });
    assert.equal(invalid.statusCode, 400);
    assert.match(invalid.json().error, /nome de ate 100 caracteres/);
  });

  it("rejeita corpo de login grande antes da verificacao de senha", async () => {
    const response = await invokeRequest({
      method: "POST",
      path: "/auth/login",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "teste@example.com", senha: `A1@${"x".repeat(5_000)}` })
    });
    assert.equal(response.statusCode, 413);
    assert.deepEqual(response.json(), { error: "Payload muito grande." });
  });

  it("invalida sessao pela versao persistida sem depender da lista de revogacao", async () => {
    const { user, token } = await authenticatedAs("auditor");
    const store = await readStore();
    const persistedUser = store.usuarios.find((item) => item.id === user.id);
    persistedUser.authVersion = 2;
    await writeStore(store);

    const response = await invokeRequest({
      method: "GET",
      path: "/auth/session",
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(response.statusCode, 401);
  });

  it("nao ecoa senha, hash nem token na redefinicao administrativa", async () => {
    const { token } = await authenticatedAs("admin");
    const { user, token: oldUserToken } = await authenticatedAs("almoxarifado");
    const newPassword = "Redef@789";
    const response = await invokeRequest({
      method: "PATCH",
      path: `/api/admin/users/${user.id}`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ senha: newPassword })
    });
    assert.equal(response.statusCode, 200);
    assertSensitiveCredentialsAbsent(response.json(), newPassword);
    const invalidated = await invokeRequest({
      method: "GET",
      path: "/auth/session",
      headers: { authorization: `Bearer ${oldUserToken}` }
    });
    assert.equal(invalidated.statusCode, 401);
    const persisted = await readStore();
    assert.equal(persisted.usuarios.find((item) => item.id === user.id).authVersion, 2);
  });

  it("rejeita booleanos ambiguos na administracao de usuarios", async () => {
    const { token } = await authenticatedAs("admin");
    const { user } = await authenticatedAs("auditor");
    const response = await invokeRequest({
      method: "PATCH",
      path: `/api/admin/users/${user.id}`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ ativo: "false", revogarSessoes: "true" })
    });
    assert.equal(response.statusCode, 400);
    assert.match(response.json().error, /booleanos/i);
  });

  it("permite ao admin alterar perfil e senha, excluir usuario e remove-lo das configuracoes", async () => {
    const { token } = await authenticatedAs("admin");
    const suffix = crypto.randomUUID().slice(0, 8);
    const email = `gerenciado-${suffix}@example.test`;
    const created = await postJson("/api/admin/users", token, {
      nome: "Usuario Gerenciado",
      email,
      role: "almoxarifado",
      senhaTemporaria: "Inicial@123"
    });
    assert.equal(created.statusCode, 201);

    const initialSettings = await invokeRequest({
      method: "GET",
      path: "/api/settings",
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(initialSettings.statusCode, 200);
    const target = initialSettings.json().usuarios.find((user) => user.email === email);
    assert.ok(target?.id);

    const newPassword = "Alterada@456";
    const updated = await invokeRequest({
      method: "PATCH",
      path: `/api/admin/users/${target.id}`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ role: "auditor", senha: newPassword })
    });
    assert.equal(updated.statusCode, 200);
    assert.equal(updated.json().role, "auditor");
    assert.equal(updated.json().precisaDefinirSenha, true);
    assertSensitiveCredentialsAbsent(updated.json(), newPassword);
    const persisted = await readStore();
    const persistedUser = persisted.usuarios.find((user) => user.id === target.id);
    assert.equal(persistedUser.role, "auditor");
    assert.equal(await verifyPassword(newPassword, persistedUser.senhaHash), true);

    const deleted = await invokeRequest({
      method: "DELETE",
      path: `/api/admin/users/${target.id}`,
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(deleted.statusCode, 200);

    const refreshedSettings = await invokeRequest({
      method: "GET",
      path: "/api/settings",
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(refreshedSettings.statusCode, 200);
    assert.equal(refreshedSettings.json().usuarios.some((user) => user.id === target.id), false);
  });

  it("impede desativacao, perda de perfil e exclusao do ultimo administrador ativo", async () => {
    const { user, token } = await authenticatedAs("admin", { onlyActiveAdmin: true });
    const deactivate = await invokeRequest({
      method: "PATCH",
      path: `/api/admin/users/${user.id}`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ ativo: false })
    });
    assert.equal(deactivate.statusCode, 400);
    assert.match(deactivate.json().error, /ultimo administrador/i);

    const demote = await invokeRequest({
      method: "PATCH",
      path: `/api/admin/users/${user.id}`,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ role: "almoxarifado" })
    });
    assert.equal(demote.statusCode, 400);
    assert.match(demote.json().error, /ultimo administrador/i);

    const remove = await invokeRequest({
      method: "DELETE",
      path: `/api/admin/users/${user.id}`,
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(remove.statusCode, 400);
    assert.match(remove.json().error, /ultimo administrador/i);
  });

  it("protege arquivos de upload contra acesso anonimo", async () => {
    const response = await invokeRequest({ method: "GET", path: "/uploads/processo/nota.pdf" });
    assert.equal(response.statusCode, 401);
    assert.match(response.text(), /login para acessar documentos/i);
  });
});

function validPdfBuffer() {
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> /Contents 4 0 R >>\nendobj\n",
    "4 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n"
  ];
  const chunks = [Buffer.from("%PDF-1.4\n", "ascii")];
  const offsets = [];
  let length = chunks[0].length;
  for (const object of objects) {
    offsets.push(length);
    const chunk = Buffer.from(object, "ascii");
    chunks.push(chunk);
    length += chunk.length;
  }
  const xrefOffset = length;
  const xref = [
    `xref\n0 ${objects.length + 1}\n`,
    "0000000000 65535 f \n",
    ...offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`),
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  ].join("");
  chunks.push(Buffer.from(xref, "ascii"));
  return Buffer.concat(chunks);
}

async function authenticatedAs(role, options = {}) {
  const store = await readStore();
  if (!Array.isArray(store.usuarios)) store.usuarios = [];
  if (options.onlyActiveAdmin) {
    for (const existing of store.usuarios) {
      if (existing.role === "admin") existing.ativo = false;
    }
  }
  const user = {
    id: `test-${role}`,
    nome: `Teste ${role}`,
    email: `teste-${role}@example.test`,
    senhaHash: options.password ? await hashPassword(options.password) : "",
    precisaDefinirSenha: Boolean(options.precisaDefinirSenha),
    authVersion: 1,
    ativo: true,
    role,
    criadoEm: new Date().toISOString()
  };
  const index = store.usuarios.findIndex((item) => item.id === user.id);
  if (index >= 0) store.usuarios[index] = user;
  else store.usuarios.push(user);
  await writeStore(store);
  return { user, token: await createSession(user.id) };
}

function assertSensitiveCredentialsAbsent(payload, plainPassword) {
  for (const field of ["token", "senha", "senhaHash", "senhaTemporaria", "novaSenha", "confirmacao"]) {
    assert.equal(Object.hasOwn(payload, field), false, `${field} nao deve ser retornado`);
  }
  assert.doesNotMatch(JSON.stringify(payload), new RegExp(escapeRegExp(plainPassword)));
}

function escapeRegExp(value = "") {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

let testCommitmentSequence = 1000;

function currentBrazilianDate() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function brazilianDateDaysAgo(days) {
  const date = new Date(`${currentBrazilianDate()}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function testCommitmentNumber(year = 2026) {
  testCommitmentSequence += 1;
  return `${year}NE000${testCommitmentSequence}`;
}

function postJson(path, token, body) {
  return invokeRequest({
    method: "POST",
    path,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

function putJson(path, token, body) {
  return invokeRequest({
    method: "PUT",
    path,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

async function invokeRequest({ method = "GET", path = "/", headers = {}, body = "" }) {
  const req = Readable.from(body ? [body] : []);
  req.method = method;
  req.url = path;
  req.headers = {
    host: "localhost",
    ...headers
  };
  req.socket = { remoteAddress: "127.0.0.1" };

  const response = createResponseRecorder();
  await requestHandler(req, response);
  return response;
}

function createResponseRecorder() {
  const chunks = [];
  const headers = {};
  return {
    statusCode: 0,
    headers,
    body: Buffer.alloc(0),
    setHeader(name, value) {
      headers[String(name).toLowerCase()] = value;
    },
    writeHead(statusCode, responseHeaders = {}) {
      this.statusCode = statusCode;
      for (const [name, value] of Object.entries(responseHeaders)) {
        headers[String(name).toLowerCase()] = value;
      }
    },
    end(chunk) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      this.body = Buffer.concat(chunks);
    },
    text() {
      return this.body.toString("utf8");
    },
    json() {
      return JSON.parse(this.text());
    }
  };
}
