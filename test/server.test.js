import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { requestHandler, contentTypeForPath, errorResponsePayload } from "../src/server.js";
import { createSession } from "../src/repositories/sessions.js";
import { closePool } from "../src/db/postgres.js";
import { readStore, writeStore } from "../src/storage.js";

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

  it("identifica corretamente o tipo do favicon webp", () => {
    assert.equal(contentTypeForPath("my-fav.webp"), "image/webp");
  });

  it("identifica corretamente js e css", () => {
    assert.equal(contentTypeForPath("app.js"), "text/javascript; charset=utf-8");
    assert.equal(contentTypeForPath("styles.css"), "text/css; charset=utf-8");
  });
});

describe("rotas http", () => {
  it("serve a pagina inicial com o favicon novo", async () => {
    const response = await invokeRequest({ method: "GET", path: "/" });
    const body = response.text();

    assert.equal(response.statusCode, 200);
    assert.match(response.headers["content-type"] || "", /text\/html/);
    assert.match(body, /\/my-fav\.webp/);
  });

  it("serve o favicon em webp via rota nova e alias legado", async () => {
    const response = await invokeRequest({ method: "GET", path: "/favicon.ico" });

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["content-type"], "image/webp");
    assert.ok(response.body.length > 0);
  });

  it("retorna 404 para arquivo estatico inexistente", async () => {
    const response = await invokeRequest({ method: "GET", path: "/arquivo-que-nao-existe.txt" });

    assert.equal(response.statusCode, 404);
    assert.equal(response.headers["content-type"], "text/plain; charset=utf-8");
    assert.match(response.text(), /Arquivo nao encontrado/);
  });

  it("mantem exportacao publica em csv", async () => {
    const response = await invokeRequest({ method: "GET", path: "/api/processes/export" });

    assert.equal(response.statusCode, 200);
    assert.match(response.headers["content-type"] || "", /text\/csv/);
    assert.match(response.text(), /"Processo";"Empenho";"Fornecedor";"Materiais"/);
  });

  it("gera relatorios publicos em PDF e Excel", async () => {
    const pdf = await invokeRequest({ method: "GET", path: "/api/processes/export?format=pdf" });
    assert.equal(pdf.statusCode, 200);
    assert.equal(pdf.headers["content-type"], "application/pdf");
    assert.equal(pdf.body.subarray(0, 4).toString(), "%PDF");

    const excel = await invokeRequest({ method: "GET", path: "/api/processes/export?format=excel" });
    assert.equal(excel.statusCode, 200);
    assert.match(excel.headers["content-type"] || "", /application\/vnd\.ms-excel/);
    assert.match(excel.text(), /<table>/);
  });

  it("remove caminhos de documentos e autoria da consulta publica", async () => {
    const store = await readStore();
    const process = {
      id: crypto.randomUUID(), numeroProcesso: `PUBLIC-${crypto.randomUUID()}`,
      status: "Enviado para SALC", materiais: [], criadoPor: "Interno",
      criadoPorEmail: "interno@example.com", documentos: { notaEmpenho: { path: "/uploads/segredo.pdf" } },
      criadoEm: new Date().toISOString(), atualizadoEm: new Date().toISOString()
    };
    store.processos.push(process);
    await writeStore(store);
    const response = await invokeRequest({ method: "GET", path: `/api/processes?q=${encodeURIComponent(process.numeroProcesso)}` });
    assert.equal(response.statusCode, 200);
    const [publicProcess] = response.json();
    assert.equal(Object.hasOwn(publicProcess, "documentos"), false);
    assert.equal(Object.hasOwn(publicProcess, "criadoPorEmail"), false);
    assert.deepEqual(publicProcess.documentosDisponiveis, ["notaEmpenho"]);
  });

  it("exige autenticacao para o alias de download", async () => {
    const response = await invokeRequest({ method: "GET", path: "/api/processes/download" });

    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.json(), { error: "Faca login para continuar." });
  });

  it("serve o alias de download com autenticacao", async () => {
    await withEnv({ DATABASE_URL: undefined }, async () => {
      await closePool();
      const store = await readStore();

      if (!Array.isArray(store.usuarios)) {
        store.usuarios = [];
      }

      const user = store.usuarios[0] || {
        id: "test-user",
        nome: "Usuario Teste",
        email: "teste@cmsp.local",
        senhaHash: "",
        precisaDefinirSenha: false,
        ativo: true,
        role: "admin",
        criadoEm: new Date().toISOString()
      };

      if (!store.usuarios.some((item) => item.id === user.id)) {
        store.usuarios.push(user);
        await writeStore(store);
      }

      const token = await createSession(user.id);
      const response = await invokeRequest({
        method: "GET",
        path: "/api/processes/download?format=csv",
        headers: {
          authorization: `Bearer ${token}`
        }
      });

      assert.equal(response.statusCode, 200);
      assert.match(response.headers["content-type"] || "", /text\/csv/);
      assert.match(response.text(), /"Processo";"Empenho";"Fornecedor";"Materiais"/);
    });
  });

  it("remove o cadastro local que permitia falsificar identidade Google", async () => {
    const response = await invokeRequest({
      method: "POST",
      path: "/auth/google/signup-local",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nome: "Invasor", email: "admin@example.com", googleSub: "forjado" })
    });
    assert.equal(response.statusCode, 410);
  });

  it("registra solicitacao de acesso como conta inativa e sem privilegio", async () => {
    const email = `solicitante-${crypto.randomUUID()}@example.com`;
    const response = await invokeRequest({
      method: "POST",
      path: "/auth/request-access",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nome: "Solicitante", email, justificativa: "Atuacao no almoxarifado" })
    });
    assert.equal(response.statusCode, 202);
    const store = await readStore();
    const requested = store.usuarios.find((item) => item.email === email);
    assert.equal(requested.ativo, false);
    assert.equal(requested.role, "almoxarifado");
    assert.equal(requested.senhaHash, "");
  });

  it("impede usuario comum de alterar configuracoes", async () => {
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

  it("rejeita status e datas invalidas recebidas pela API", async () => {
    const { token } = await authenticatedAs("almoxarifado");
    const invalidStatus = await invokeRequest({
      method: "POST",
      path: "/api/processes",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ status: "Status inventado" })
    });
    assert.equal(invalidStatus.statusCode, 400);

    const invalidDate = await invokeRequest({
      method: "POST",
      path: "/api/processes",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ dataEnvioEmpenho: "2026-02-31" })
    });
    assert.equal(invalidDate.statusCode, 400);
  });

  it("protege arquivos de upload contra acesso anonimo", async () => {
    const response = await invokeRequest({ method: "GET", path: "/uploads/processo/nota.pdf" });
    assert.equal(response.statusCode, 401);
    assert.match(response.text(), /login para acessar documentos/i);
  });
});

async function authenticatedAs(role) {
  await closePool();
  const store = await readStore();
  const user = {
    id: `test-${role}`,
    nome: `Teste ${role}`,
    email: `teste-${role}@cmsp.local`,
    senhaHash: "",
    precisaDefinirSenha: false,
    ativo: true,
    role,
    criadoEm: new Date().toISOString()
  };
  const index = (store.usuarios || []).findIndex((item) => item.id === user.id);
  if (!Array.isArray(store.usuarios)) store.usuarios = [];
  if (index >= 0) store.usuarios[index] = user;
  else store.usuarios.push(user);
  await writeStore(store);
  return { user, token: await createSession(user.id) };
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

async function withEnv(values, callback) {
  const previous = {};
  for (const key of Object.keys(values)) {
    previous[key] = process.env[key];
    if (values[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = values[key];
    }
  }

  try {
    return await callback();
  } finally {
    for (const key of Object.keys(values)) {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key];
      }
    }
  }
}
