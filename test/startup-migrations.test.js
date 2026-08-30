import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");

describe("startup de producao", () => {
  it("executa migrations antes do servidor no caminho usado pelo Render", () => {
    assert.equal(packageJson.scripts.prestart, "NODE_ENV=production node scripts/db-migrate.js");
    assert.equal(packageJson.scripts.start, "NODE_ENV=production node src/server.js");
    assert.match(dockerfile, /CMD \["npm", "start"\]/);
  });
});
