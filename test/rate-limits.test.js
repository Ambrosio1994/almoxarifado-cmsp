import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { clearRateLimit, isRateLimited, recordRateLimitFailure } from "../src/repositories/rate-limits.js";

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
