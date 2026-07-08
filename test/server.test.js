import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { requestHandler, contentTypeForPath, errorResponsePayload } from "../src/server.js";
import { createSession } from "../src/repositories/sessions.js";
import { closePool } from "../src/db/postgres.js";
import { readStore } from "../src/storage.js";

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

  it("exige autenticacao para o alias de download", async () => {
    const response = await invokeRequest({ method: "GET", path: "/api/processes/download" });

    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.json(), { error: "Faca login para continuar." });
  });

  it("serve o alias de download com autenticacao", async () => {
    await withEnv({ DATABASE_URL: undefined }, async () => {
      await closePool();
      const store = await readStore();
      const token = await createSession(store.usuarios[0].id);
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
});

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
