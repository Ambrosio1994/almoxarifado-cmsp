import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { clearRateLimit, consumeRateLimitAttempt, isRateLimited, recordRateLimitFailure } from "../src/repositories/rate-limits.js";

describe("rate limit compartilhavel", () => {
  it("bloqueia no limite e libera depois da limpeza", async () => {
    await withoutDatabase(async () => {
      const key = `login:${crypto.randomUUID()}`;
      assert.equal(await isRateLimited(key, 60_000, 2), false);
      await recordRateLimitFailure(key, 60_000);
      assert.equal(await isRateLimited(key, 60_000, 2), false);
      await recordRateLimitFailure(key, 60_000);
      assert.equal(await isRateLimited(key, 60_000, 2), true);
      await clearRateLimit(key);
      assert.equal(await isRateLimited(key, 60_000, 2), false);
    });
  });

  it("reserva tentativas atomicamente antes da autenticacao", async () => {
    await withoutDatabase(async () => {
      const key = `consume:${crypto.randomUUID()}`;
      assert.equal(await consumeRateLimitAttempt(key, 60_000, 2), true);
      assert.equal(await consumeRateLimitAttempt(key, 60_000, 2), true);
      assert.equal(await consumeRateLimitAttempt(key, 60_000, 2), false);
      await clearRateLimit(key);
      assert.equal(await consumeRateLimitAttempt(key, 60_000, 2), true);
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
