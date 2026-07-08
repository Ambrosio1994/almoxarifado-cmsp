import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPoolConfig } from "../../src/db/postgres.js";

describe("configuracao PostgreSQL", () => {
  it("exige SSL em producao", () => {
    withEnv({
      DATABASE_URL: "postgres://user:pass@db.example.com:5432/app",
      NODE_ENV: "production",
      DB_SSL: "false"
    }, () => {
      assert.throws(() => createPoolConfig(), /DB_SSL=true/);
    });
  });

  it("exige CA quando SSL esta habilitado", () => {
    withEnv({
      DATABASE_URL: "postgres://user:pass@db.example.com:5432/app",
      NODE_ENV: "production",
      DB_SSL: "true",
      DB_CA_CERT_PATH: ""
    }, () => {
      assert.throws(() => createPoolConfig(), /DB_CA_CERT_PATH/);
    });
  });

  it("valida certificado do servidor e aplica limites do pool", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "almoxarifado-db-"));
    const caPath = join(tempDir, "ca.crt");
    writeFileSync(caPath, "-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n");

    try {
      withEnv({
        DATABASE_URL: "postgres://user:pass@db.example.com:5432/app",
        NODE_ENV: "production",
        DB_SSL: "true",
        DB_CA_CERT_PATH: caPath,
        DB_POOL_MIN: "1",
        DB_POOL_MAX: "4",
        DB_CONNECTION_TIMEOUT_MS: "2000",
        DB_IDLE_TIMEOUT_MS: "10000",
        DB_QUERY_TIMEOUT_MS: "15000",
        DB_STATEMENT_TIMEOUT_MS: "15000"
      }, () => {
        const config = createPoolConfig();
        assert.equal(config.ssl.rejectUnauthorized, true);
        assert.equal(config.ssl.ca.includes("BEGIN CERTIFICATE"), true);
        assert.equal(config.min, 1);
        assert.equal(config.max, 4);
        assert.equal(config.connectionTimeoutMillis, 2000);
        assert.equal(config.idleTimeoutMillis, 10000);
        assert.equal(config.query_timeout, 15000);
        assert.equal(config.statement_timeout, 15000);
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rejeita limites invalidos de pool e timeout", () => {
    withEnv({
      DATABASE_URL: "postgres://user:pass@localhost:5432/app",
      NODE_ENV: "development",
      DB_SSL: "false",
      DB_POOL_MAX: "0"
    }, () => {
      assert.throws(() => createPoolConfig(), /DB_POOL_MAX/);
    });

    withEnv({
      DATABASE_URL: "postgres://user:pass@localhost:5432/app",
      NODE_ENV: "development",
      DB_SSL: "false",
      DB_QUERY_TIMEOUT_MS: "10abc"
    }, () => {
      assert.throws(() => createPoolConfig(), /DB_QUERY_TIMEOUT_MS/);
    });
  });
});

function withEnv(values, callback) {
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
    return callback();
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
