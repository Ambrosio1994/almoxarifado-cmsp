import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSafeTestDatabaseUrl, createPoolConfig } from "../../src/db/postgres.js";
import { resolveMigrationDatabaseUrl, runMigrations } from "../../scripts/db-migrate.js";

describe("configuracao PostgreSQL", () => {
  it("inclui versao de autenticacao em usuarios e sessoes", () => {
    const migration = readFileSync(new URL("../../db/migrations/010_auth_session_version.sql", import.meta.url), "utf8");
    assert.match(migration, /ALTER TABLE app_users[\s\S]*auth_version/i);
    assert.match(migration, /ALTER TABLE user_sessions[\s\S]*auth_version/i);
    assert.match(migration, /UPDATE user_sessions[\s\S]*users\.auth_version/i);
  });

  it("exige SSL em producao", () => {
    withEnv({
      DATABASE_URL: "postgres://user:pass@db.example.com:5432/app",
      NODE_ENV: "production",
      DB_SSL: "false"
    }, () => {
      assert.throws(() => createPoolConfig(), /DB_SSL=true/);
    });
  });

  it("mantem verificacao do certificado sem CA customizada", () => {
    withEnv({
      DATABASE_URL: "postgresql://user:pass@db.example.com:5432/app?sslmode=verify-full&ssl=false&channel_binding=require",
      NODE_ENV: "production",
      DB_SSL: "true",
      DB_CA_CERT_PATH: ""
    }, () => {
      const config = createPoolConfig();
      assert.deepEqual(config.ssl, { rejectUnauthorized: true });
      assert.doesNotMatch(config.connectionString, /sslmode=/);
      assert.doesNotMatch(config.connectionString, /ssl=false/);
      assert.match(config.connectionString, /channel_binding=require/);
    });
  });

  it("aceita connection string explicita para migracoes", () => {
    withEnv({
      DATABASE_URL: "postgres://user:pass@app.example.com:5432/app",
      NODE_ENV: "production",
      DB_SSL: "true"
    }, () => {
      const config = createPoolConfig("postgres://user:pass@migration.example.com:5432/app?sslmode=require");
      assert.equal(new URL(config.connectionString).hostname, "migration.example.com");
      assert.equal(new URL(config.connectionString).searchParams.has("sslmode"), false);
    });
  });

  it("valida certificado do servidor e aplica limites do pool", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "almoxarifado-db-"));
    const caPath = join(tempDir, "ca.crt");
    writeFileSync(caPath, "-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n");

    try {
      withEnv({
      DATABASE_URL: "postgres://user:pass@db.example.com:5432/app?sslmode=verify-full",
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

  it("continua carregando CA quando o caminho e informado", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "almoxarifado-db-"));
    const caPath = join(tempDir, "ca.crt");
    writeFileSync(caPath, "-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n");

    try {
      withEnv({
        DATABASE_URL: "postgresql://user:pass@db.example.com:5432/app?sslmode=verify-full&channel_binding=require",
        NODE_ENV: "production",
        DB_SSL: "true",
        DB_CA_CERT_PATH: caPath
      }, () => {
        const config = createPoolConfig();
        assert.equal(config.ssl?.rejectUnauthorized, true);
        assert.equal(config.ssl?.ca.includes("BEGIN CERTIFICATE"), true);
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

  it("impede que o banco de teste seja o banco de producao", () => {
    withEnv({
      DATABASE_URL: "postgres://user:pass@db.example.com/app_test?sslmode=require",
      DATABASE_URL_MIGRATION: "",
      TEST_DATABASE_URL: "postgres://test:pass@db.example.com/app_test?sslmode=require"
    }, () => {
      assert.throws(() => assertSafeTestDatabaseUrl(), /mesmo banco de DATABASE_URL/);
    });

    withEnv({
      DATABASE_URL: "postgres://user:pass@db.example.com/app?sslmode=require",
      DATABASE_URL_MIGRATION: "",
      TEST_DATABASE_URL: "postgres://test:pass@db.example.com/app_test?sslmode=require"
    }, () => {
      assert.equal(assertSafeTestDatabaseUrl(), process.env.TEST_DATABASE_URL);
    });
  });
});

describe("runner de migracoes PostgreSQL", () => {
  it("exige URL direta quando o runtime Neon usa pooler e aceita fallback direto", () => {
    assert.throws(() => resolveMigrationDatabaseUrl({
      DATABASE_URL: "postgresql://user:secret@ep-blue-123-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require"
    }), /DATABASE_URL_MIGRATION.*URL direta/);

    assert.deepEqual(resolveMigrationDatabaseUrl({
      DATABASE_URL: "postgresql://user:secret@ep-blue-123.us-east-2.aws.neon.tech/neondb?sslmode=require"
    }), {
      databaseUrl: "postgresql://user:secret@ep-blue-123.us-east-2.aws.neon.tech/neondb?sslmode=require",
      source: "DATABASE_URL"
    });

    assert.deepEqual(resolveMigrationDatabaseUrl({
      DATABASE_URL: "postgresql://user:secret@ep-blue-123-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require",
      DATABASE_URL_MIGRATION: "postgresql://migration:secret@ep-blue-123.us-east-2.aws.neon.tech/neondb?sslmode=require"
    }), {
      databaseUrl: "postgresql://migration:secret@ep-blue-123.us-east-2.aws.neon.tech/neondb?sslmode=require",
      source: "DATABASE_URL_MIGRATION"
    });
  });

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
      assert.equal(fakeDatabase.controlSql.filter((sql) => /pg_advisory_lock/.test(sql)).length, 2);
      assert.equal(fakeDatabase.controlSql.filter((sql) => /pg_advisory_unlock/.test(sql)).length, 2);
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

  it("reverte a migracao se o registro da versao falhar", async () => {
    const tempDir = createMigrationsDir({
      "001_initial_schema.sql": "BEGIN;\nCREATE TABLE example (id text PRIMARY KEY);\nCOMMIT;"
    });
    const fakeDatabase = createFakeDatabase({ failRecordOnce: true });

    try {
      await assert.rejects(() => runMigrations({
        databaseUrl: "postgres://user:pass@localhost:5432/app",
        migrationsDir: tempDir,
        createClient: fakeDatabase.createClient,
        logger: silentLogger
      }), /Falha ao aplicar 001_initial_schema.sql/);

      assert.equal(fakeDatabase.appliedVersions.size, 0);
      assert.equal(fakeDatabase.controlSql.includes("ROLLBACK"), true);

      const retry = await runMigrations({
        databaseUrl: "postgres://user:pass@localhost:5432/app",
        migrationsDir: tempDir,
        createClient: fakeDatabase.createClient,
        logger: silentLogger
      });
      assert.deepEqual(retry.applied, ["001_initial_schema"]);
      assert.deepEqual([...fakeDatabase.appliedVersions], ["001_initial_schema"]);
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

  it("registra o alvo da migracao sem expor credenciais", async () => {
    const tempDir = createMigrationsDir({
      "001_initial_schema.sql": "SELECT 1;"
    });
    const fakeDatabase = createFakeDatabase();
    const logs = [];

    try {
      await runMigrations({
        databaseUrl: "postgres://user:secret@localhost:5432/app?sslmode=verify-full",
        databaseUrlSource: "DATABASE_URL_MIGRATION",
        migrationsDir: tempDir,
        createClient: fakeDatabase.createClient,
        logger: {
          log(message) {
            logs.push(message);
          }
        }
      });

      const targetLog = logs.find((message) => message.includes("Banco alvo da migracao"));
      assert.match(targetLog, /source=DATABASE_URL_MIGRATION/);
      assert.match(targetLog, /host=localhost:5432/);
      assert.match(targetLog, /sslmode=verify-full/);
      assert.doesNotMatch(targetLog, /secret/);
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

  it("fecha o client e registra falha de conexao sem expor URL", async () => {
    const tempDir = createMigrationsDir({ "001_connection.sql": "SELECT 1;" });
    const logs = [];
    let closed = 0;
    try {
      await assert.rejects(() => runMigrations({
        databaseUrl: "postgres://user:secret@localhost:5432/app",
        migrationsDir: tempDir,
        logger: captureLogger(logs),
        createClient: () => ({
          async connect() {
            throw new Error("connect postgres://user:secret@localhost:5432/app refused");
          },
          async end() { closed += 1; },
          async query() { throw new Error("nao deveria consultar"); }
        })
      }), /connect postgres/);
      assert.equal(closed, 1);
      assert.ok(logEvents(logs).some((event) => event.event === "migration_runner_failed" && event.error.includes("[database-url-redacted]")));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  for (const phase of ["connection", "lock", "migration"]) {
    it(`interrompe por SIGTERM durante ${phase}, limpa a sessao e nao conclui`, async () => {
      const tempDir = createMigrationsDir({ "001_interrupt.sql": "CREATE TABLE example (id text PRIMARY KEY);" });
      const signals = new EventEmitter();
      const logs = [];
      const fake = createInterruptibleClient(phase);
      try {
        const run = runMigrations({
          databaseUrl: "postgres://user:pass@localhost:5432/app",
          migrationsDir: tempDir,
          createClient: () => fake.client,
          logger: captureLogger(logs),
          signalSource: signals
        });
        await fake.waitForInterruptionPoint();
        signals.emit("SIGTERM");
        await assert.rejects(() => run, (error) => error.code === "MIGRATION_INTERRUPTED" && error.exitCode === 143);
        assert.equal(fake.closed, 1);
        assert.equal(fake.lockReleased, true);
        const events = logEvents(logs);
        assert.ok(events.some((event) => event.event === "migration_signal_received" && event.signal === "SIGTERM"));
        assert.ok(events.some((event) => event.event === "migration_runner_interrupted"));
        assert.equal(events.some((event) => event.event === "migration_runner_complete"), false);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  }

  for (const signal of ["SIGTERM", "SIGINT"]) {
    for (const phase of ["unlock", "end"]) {
      it(`interrompe por ${signal} durante ${phase} sem concluir com sucesso`, async () => {
        const tempDir = createMigrationsDir({ "001_cleanup_interrupt.sql": "CREATE TABLE cleanup_example (id text PRIMARY KEY);" });
        const signals = new EventEmitter();
        const logs = [];
        const fake = createCleanupInterruptClient(phase);
        try {
          const run = runMigrations({
            databaseUrl: "postgres://user:pass@localhost:5432/app",
            migrationsDir: tempDir,
            createClient: () => fake.client,
            logger: captureLogger(logs),
            signalSource: signals
          });
          await fake.waitForInterruptionPoint();
          signals.emit(signal);
          fake.release();
          await assert.rejects(() => run, (error) => error.code === "MIGRATION_INTERRUPTED"
            && error.exitCode === (signal === "SIGTERM" ? 143 : 130));
          assert.equal(fake.closed, 1);
          const events = logEvents(logs);
          assert.equal(events.filter((event) => event.event === "migration_signal_received" && event.signal === signal).length, 1);
          assert.equal(events.filter((event) => event.event === "migration_runner_interrupted" && event.signal === signal).length, 1);
          assert.equal(events.some((event) => event.event === "migration_runner_complete"), false);
        } finally {
          rmSync(tempDir, { recursive: true, force: true });
        }
      });
    }
  }
});

const silentLogger = {
  log() {}
};

function captureLogger(logs) {
  return { log(message) { logs.push(message); } };
}

function logEvents(logs) {
  return logs.flatMap((message) => {
    try {
      return [JSON.parse(message)];
    } catch {
      return [];
    }
  });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createInterruptibleClient(phase) {
  const reached = deferred();
  const pending = deferred();
  let closed = 0;
  let lockHeld = false;
  const client = {
    async connect() {
      if (phase === "connection") {
        reached.resolve();
        return pending.promise;
      }
    },
    async end() {
      closed += 1;
      lockHeld = false;
      pending.resolve();
    },
    async query(sql) {
      if (sql === "SET search_path TO public") return { rows: [] };
      if (/pg_advisory_lock/.test(sql)) {
        if (phase === "lock") {
          reached.resolve();
          return pending.promise;
        }
        lockHeld = true;
        return { rows: [] };
      }
      if (/SELECT version FROM public\.app_schema_migrations/.test(sql)) return { rows: [] };
      if (sql === "BEGIN") return { rows: [] };
      if (/CREATE TABLE example/.test(sql)) {
        reached.resolve();
        return pending.promise;
      }
      if (/pg_advisory_unlock/.test(sql)) {
        lockHeld = false;
        return { rows: [] };
      }
      return { rows: [] };
    }
  };
  return {
    client,
    get closed() { return closed; },
    get lockReleased() { return !lockHeld; },
    waitForInterruptionPoint: () => reached.promise
  };
}

function createCleanupInterruptClient(phase) {
  const reached = deferred();
  const pending = deferred();
  let closed = 0;
  let lockHeld = false;
  const client = {
    async connect() {},
    async end() {
      if (phase === "end") {
        reached.resolve();
        await pending.promise;
      }
      closed += 1;
      lockHeld = false;
    },
    async query(sql) {
      if (sql === "SET search_path TO public") return { rows: [] };
      if (/pg_advisory_lock/.test(sql)) {
        lockHeld = true;
        return { rows: [] };
      }
      if (/SELECT version FROM public\.app_schema_migrations/.test(sql)) return { rows: [] };
      if (["BEGIN", "COMMIT"].includes(sql) || /CREATE TABLE cleanup_example/.test(sql) || /INSERT INTO public\.app_schema_migrations/.test(sql)) return { rows: [] };
      if (/pg_advisory_unlock/.test(sql)) {
        if (phase === "unlock") {
          reached.resolve();
          await pending.promise;
        }
        lockHeld = false;
        return { rows: [] };
      }
      throw new Error(`Consulta inesperada: ${sql}`);
    }
  };
  return {
    client,
    get closed() { return closed; },
    waitForInterruptionPoint: () => reached.promise,
    release: () => pending.resolve(),
    get lockReleased() { return !lockHeld; }
  };
}

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
  const controlSql = [];
  const failOnSql = options.failOnSql;
  let failRecordOnce = Boolean(options.failRecordOnce);
  let pendingVersions = [];

  return {
    appliedVersions,
    appliedSql,
    controlSql,
    createClient() {
      return {
        async connect() {},
        async end() {},
        async query(sql, params = []) {
          if (sql === "SET search_path TO public") {
            controlSql.push(sql);
            return { rows: [] };
          }
          if (/pg_advisory_(?:un)?lock/.test(sql)) {
            controlSql.push(sql);
            return { rows: [] };
          }
          if (sql === "BEGIN") {
            controlSql.push(sql);
            pendingVersions = [];
            return { rows: [] };
          }
          if (sql === "COMMIT") {
            controlSql.push(sql);
            pendingVersions.forEach((version) => appliedVersions.add(version));
            pendingVersions = [];
            return { rows: [] };
          }
          if (sql === "ROLLBACK") {
            controlSql.push(sql);
            pendingVersions = [];
            return { rows: [] };
          }
          if (/SELECT version FROM (?:public\.)?app_schema_migrations/.test(sql)) {
            return { rows: [...appliedVersions].map((version) => ({ version })) };
          }
          if (/INSERT INTO (?:public\.)?app_schema_migrations/.test(sql)) {
            if (failRecordOnce) {
              failRecordOnce = false;
              throw new Error("migration record failed");
            }
            pendingVersions.push(params[0]);
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
