import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPoolConfig } from "../../src/db/postgres.js";
import { runMigrations } from "../../scripts/db-migrate.js";

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

  it("falha explicitamente quando o caminho do CA nao existe", () => {
    withEnv({
      DATABASE_URL: "postgres://user:pass@db.example.com:5432/app",
      NODE_ENV: "production",
      DB_SSL: "true",
      DB_CA_CERT_PATH: "/tmp/almoxarifado-ca-inexistente.crt"
    }, () => {
      assert.throws(() => createPoolConfig(), /ENOENT/);
    });
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

describe("runner de migracoes PostgreSQL", () => {
  it("nao reaplica migracoes ja registradas", async () => {
    const tempDir = createMigrationsDir({
      "001_initial_schema.sql": "CREATE TABLE example (id text PRIMARY KEY);"
    });
    const fakeDatabase = createFakeDatabase();

    try {
      const firstRun = await runMigrations({
        databaseUrl: "postgres://user:pass@localhost:5432/app",
        migrationsDir: tempDir,
        createClient: fakeDatabase.createClient,
        logger: silentLogger
      });
      const secondRun = await runMigrations({
        databaseUrl: "postgres://user:pass@localhost:5432/app",
        migrationsDir: tempDir,
        createClient: fakeDatabase.createClient,
        logger: silentLogger
      });

      assert.deepEqual(firstRun.applied, ["001_initial_schema"]);
      assert.deepEqual(firstRun.skipped, []);
      assert.deepEqual(secondRun.applied, []);
      assert.deepEqual(secondRun.skipped, ["001_initial_schema"]);
      assert.equal(fakeDatabase.appliedSql.length, 1);
      assert.deepEqual([...fakeDatabase.appliedVersions], ["001_initial_schema"]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("nao registra migracao que falha", async () => {
    const tempDir = createMigrationsDir({
      "001_initial_schema.sql": "CREATE TABLE example (id text PRIMARY KEY);"
    });
    const fakeDatabase = createFakeDatabase({ failOnSql: /CREATE TABLE example/ });

    try {
      await assert.rejects(() => runMigrations({
        databaseUrl: "postgres://user:pass@localhost:5432/app",
        migrationsDir: tempDir,
        createClient: fakeDatabase.createClient,
        logger: silentLogger
      }), /Falha ao aplicar 001_initial_schema.sql/);

      assert.equal(fakeDatabase.appliedSql.length, 1);
      assert.equal(fakeDatabase.appliedVersions.size, 0);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("aplica migracoes em ordem deterministica", async () => {
    const tempDir = createMigrationsDir({
      "003_third.sql": "SELECT 3;",
      "001_first.sql": "SELECT 1;",
      "002_second.sql": "SELECT 2;"
    });
    const fakeDatabase = createFakeDatabase();

    try {
      const result = await runMigrations({
        databaseUrl: "postgres://user:pass@localhost:5432/app",
        migrationsDir: tempDir,
        createClient: fakeDatabase.createClient,
        logger: silentLogger
      });

      assert.deepEqual(result.applied, ["001_first", "002_second", "003_third"]);
      assert.deepEqual(fakeDatabase.appliedSql, ["SELECT 1;", "SELECT 2;", "SELECT 3;"]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("para na primeira migracao com erro e nao aplica posteriores", async () => {
    const tempDir = createMigrationsDir({
      "001_first.sql": "SELECT invalid;",
      "002_second.sql": "SELECT 2;"
    });
    const fakeDatabase = createFakeDatabase({ failOnSql: /SELECT invalid/ });

    try {
      await assert.rejects(() => runMigrations({
        databaseUrl: "postgres://user:pass@localhost:5432/app",
        migrationsDir: tempDir,
        createClient: fakeDatabase.createClient,
        logger: silentLogger
      }), /Falha ao aplicar 001_first.sql/);

      assert.deepEqual(fakeDatabase.appliedSql, ["SELECT invalid;"]);
      assert.equal(fakeDatabase.appliedVersions.size, 0);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

const silentLogger = {
  log() {}
};

function createMigrationsDir(files) {
  const tempDir = mkdtempSync(join(tmpdir(), "almoxarifado-migrations-"));
  for (const [fileName, content] of Object.entries(files)) {
    writeFileSync(join(tempDir, fileName), content);
  }
  return tempDir;
}

function createFakeDatabase(options = {}) {
  const appliedVersions = new Set();
  const appliedSql = [];
  const failOnSql = options.failOnSql;

  return {
    appliedVersions,
    appliedSql,
    createClient() {
      return {
        async connect() {},
        async end() {},
        async query(sql, params = []) {
          if (/SELECT version FROM app_schema_migrations/.test(sql)) {
            return { rows: [...appliedVersions].map((version) => ({ version })) };
          }
          if (/INSERT INTO app_schema_migrations/.test(sql)) {
            appliedVersions.add(params[0]);
            return { rows: [] };
          }
          appliedSql.push(sql);
          if (failOnSql?.test(sql)) {
            throw new Error("migration failed");
          }
          return { rows: [] };
        }
      }
    }
  };
}

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
