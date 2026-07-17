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
      const claimToken = await claimEmailDispatch(key, { processId: "p1" });
      assert.equal(typeof claimToken, "string");
      assert.equal(await claimEmailDispatch(key, { processId: "p1" }), null);
      assert.equal(await completeEmailDispatch(key, "", { attempts: 1 }), false);
      assert.equal(await failEmailDispatch(key, "", new Error("sem lease")), false);
      assert.equal(await completeEmailDispatch(key, claimToken, { attempts: 1 }), true);
      assert.equal(await claimEmailDispatch(key, { processId: "p1" }, true), null);
    });
  });

  it("so reprocessa falha quando um administrador forca nova tentativa", async () => {
    await withoutDatabase(async () => {
      const key = `failed-${crypto.randomUUID()}`;
      const claimToken = await claimEmailDispatch(key);
      assert.equal(await failEmailDispatch(key, claimToken, new Error("SMTP indisponivel")), true);
      assert.equal(await claimEmailDispatch(key), null);
      assert.equal(typeof await claimEmailDispatch(key, {}, true), "string");
    });
  });

  it("recupera lease abandonado e impede conclusao pelo worker antigo", async () => {
    await withoutDatabase(async () => {
      const key = `lease-${crypto.randomUUID()}`;
      const oldToken = await claimEmailDispatch(key);
      const newToken = await claimEmailDispatch(key, {}, false, 0);
      assert.notEqual(newToken, oldToken);
      assert.equal(await completeEmailDispatch(key, oldToken, { attempts: 1 }), false);
      assert.equal(await completeEmailDispatch(key, newToken, { attempts: 1 }), true);
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
