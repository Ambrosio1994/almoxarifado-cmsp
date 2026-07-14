import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  claimEmailDispatch,
  completeEmailDispatch,
  failEmailDispatch
} from "../src/repositories/email-dispatches.js";

describe("idempotencia de disparos de e-mail", () => {
  it("permite apenas uma reserva ativa por chave", async () => {
    await withoutDatabase(async () => {
      const key = `claim-${crypto.randomUUID()}`;
      assert.equal(await claimEmailDispatch(key, { processId: "p1" }), true);
      assert.equal(await claimEmailDispatch(key, { processId: "p1" }), false);
      await completeEmailDispatch(key, { attempts: 1 });
      assert.equal(await claimEmailDispatch(key, { processId: "p1" }, true), false);
    });
  });

  it("so reprocessa falha quando um administrador forca nova tentativa", async () => {
    await withoutDatabase(async () => {
      const key = `failed-${crypto.randomUUID()}`;
      assert.equal(await claimEmailDispatch(key), true);
      await failEmailDispatch(key, new Error("SMTP indisponivel"));
      assert.equal(await claimEmailDispatch(key), false);
      assert.equal(await claimEmailDispatch(key, {}, true), true);
    });
  });
});

async function withoutDatabase(callback) {
  const previous = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    await callback();
  } finally {
    if (previous !== undefined) process.env.DATABASE_URL = previous;
  }
}
