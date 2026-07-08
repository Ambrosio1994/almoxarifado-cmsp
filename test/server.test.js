import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { errorResponsePayload } from "../src/server.js";

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
});
