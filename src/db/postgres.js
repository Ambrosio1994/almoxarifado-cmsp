import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";

loadLocalEnv();

const SLOW_QUERY_THRESHOLD_MS = envInteger("DB_SLOW_QUERY_MS", 1000, 1);
let pool;

export function databaseConfigured() {
  return Boolean(runtimeDatabaseUrl());
}

export function getPool() {
  const connectionString = runtimeDatabaseUrl();
  if (!connectionString) {
    throw new Error("DATABASE_URL nao configurada.");
  }
  if (!pool) {
    pool = new pg.Pool(createPoolConfig(connectionString));
    pool.on("error", (error) => {
      console.error(JSON.stringify({
        event: "postgres_pool_error",
        code: String(error?.code || "UNKNOWN").slice(0, 40),
        message: safeErrorMessage(error)
      }));
    });
  }
  return pool;
}

export async function query(text, params = []) {
  return measuredQuery(getPool(), text, params);
}

export async function transaction(callback) {
  return withTransaction("BEGIN", callback);
}

export async function readTransaction(callback) {
  return withTransaction("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY", callback);
}

async function withTransaction(beginSql, callback) {
  const client = await getPool().connect();
  try {
    await measuredQuery(client, beginSql);
    const measuredClient = new Proxy(client, {
      get(target, property, receiver) {
        if (property === "query") {
          return (text, params = []) => measuredQuery(target, text, params);
        }
        return Reflect.get(target, property, receiver);
      }
    });
    const result = await callback(measuredClient);
    await measuredQuery(client, "COMMIT");
    return result;
  } catch (error) {
    await measuredQuery(client, "ROLLBACK").catch(() => null);
    throw error;
  } finally {
    client.release();
  }
}

async function measuredQuery(target, text, params = []) {
  const startedAt = performance.now();
  try {
    return await target.query(text, params);
  } finally {
    const durationMs = performance.now() - startedAt;
    if (durationMs >= SLOW_QUERY_THRESHOLD_MS) {
      console.warn(JSON.stringify({
        event: "postgres_slow_query",
        durationMs: Math.round(durationMs),
        statement: safeSqlSummary(text),
        parameterCount: Array.isArray(params) ? params.length : 0
      }));
    }
  }
}

function safeSqlSummary(value) {
  return String(value || "")
    .replace(/'(?:''|[^'])*'/g, "?")
    .replace(/\$\d+/g, "?")
    .replace(/\b\d+(?:\.\d+)?\b/g, "?")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function safeErrorMessage(error) {
  return String(error?.message || "Erro de conexao PostgreSQL")
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[database-url-redacted]")
    .slice(0, 300);
}

export async function closePool() {
  if (!pool) return;
  await pool.end();
  pool = undefined;
}

export function createPoolConfig(connectionString = process.env.DATABASE_URL) {
  const sslEnabled = process.env.DB_SSL === "true";
  if (process.env.NODE_ENV === "production" && !sslEnabled) {
    throw new Error("DB_SSL=true e obrigatorio em producao.");
  }
  if (process.env.NODE_ENV === "production") {
    assertSecureDatabaseUrl(connectionString);
  }

  const ssl = sslEnabled ? buildSslConfig() : undefined;

  return {
    // node-postgres lets SSL query parameters override the explicit `ssl`
    // object. Remove only those parameters after validating the original URL
    // so a configured CA and rejectUnauthorized cannot be silently discarded.
    connectionString: sslEnabled ? withoutSslQueryParameters(connectionString) : connectionString,
    ssl,
    min: envInteger("DB_POOL_MIN", 0, 0),
    max: envInteger("DB_POOL_MAX", 10, 1),
    connectionTimeoutMillis: envInteger("DB_CONNECTION_TIMEOUT_MS", 5000, 1),
    idleTimeoutMillis: envInteger("DB_IDLE_TIMEOUT_MS", 30000, 1),
    query_timeout: envInteger("DB_QUERY_TIMEOUT_MS", 30000, 1),
    statement_timeout: envInteger("DB_STATEMENT_TIMEOUT_MS", 30000, 1)
  };
}

function buildSslConfig() {
  const caCertPath = process.env.DB_CA_CERT_PATH;
  return {
    ...(caCertPath ? { ca: readFileSync(caCertPath, "utf8") } : {}),
    rejectUnauthorized: true
  };
}

export function isTestRuntime() {
  return process.env.NODE_ENV === "test" || Boolean(process.env.NODE_TEST_CONTEXT);
}

export function assertSafeTestDatabaseUrl(connectionString = process.env.TEST_DATABASE_URL) {
  if (!connectionString) {
    throw new Error("TEST_DATABASE_URL nao configurada.");
  }

  const testTarget = databaseTarget(connectionString, "TEST_DATABASE_URL");
  if (!/(?:^|[_-])test(?:$|[_-])|test/i.test(testTarget.database)) {
    throw new Error("TEST_DATABASE_URL deve apontar para um database identificado como teste.");
  }

  for (const [name, candidate] of [
    ["DATABASE_URL", process.env.DATABASE_URL],
    ["DATABASE_URL_MIGRATION", process.env.DATABASE_URL_MIGRATION]
  ]) {
    if (!candidate) continue;
    const candidateTarget = databaseTarget(candidate, name);
    if (sameDatabaseTarget(testTarget, candidateTarget)) {
      throw new Error(`TEST_DATABASE_URL nao pode apontar para o mesmo banco de ${name}.`);
    }
  }

  return connectionString;
}

function runtimeDatabaseUrl() {
  if (!isTestRuntime()) return process.env.DATABASE_URL || "";
  if (!process.env.TEST_DATABASE_URL) return "";
  return assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL);
}

function assertSecureDatabaseUrl(connectionString) {
  const target = databaseTarget(connectionString, "DATABASE_URL");
  if (!["require", "verify-full"].includes(target.sslmode)) {
    throw new Error("DATABASE_URL deve incluir sslmode=require ou sslmode=verify-full em producao.");
  }
}

function withoutSslQueryParameters(connectionString) {
  const url = new URL(connectionString);
  for (const parameter of ["ssl", "sslmode", "sslcert", "sslkey", "sslrootcert", "sslpassword"]) {
    url.searchParams.delete(parameter);
  }
  return url.toString();
}

function databaseTarget(connectionString, name) {
  let url;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error(`${name} deve ser uma URL PostgreSQL valida.`);
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || !url.pathname.slice(1)) {
    throw new Error(`${name} deve ser uma URL PostgreSQL valida com host e database.`);
  }
  return {
    host: url.hostname.toLowerCase(),
    port: url.port || "5432",
    database: decodeURIComponent(url.pathname.slice(1)).toLowerCase(),
    sslmode: url.searchParams.get("sslmode") || ""
  };
}

function sameDatabaseTarget(first, second) {
  return first.host === second.host && first.port === second.port && first.database === second.database;
}

function envInteger(name, fallback, minValue) {
  const rawValue = process.env[name];
  if (!rawValue) return fallback;
  if (!/^\d+$/.test(rawValue)) {
    throw new Error(`${name} deve ser um numero inteiro.`);
  }
  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value < minValue) {
    throw new Error(`${name} deve ser maior ou igual a ${minValue}.`);
  }
  return value;
}

function loadLocalEnv() {
  // Test workers must never inherit a production/local DATABASE_URL from a
  // repository env file. They may only use an explicit TEST_DATABASE_URL.
  if (isTestRuntime()) return;
  try {
    const envFile = process.env.NODE_ENV === "production" ? "../../.env.production" : "../../.env";
    const envPath = fileURLToPath(new URL(envFile, import.meta.url));
    const content = readFileSync(envPath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const [key, ...valueParts] = trimmed.split("=");
      if (!key || process.env[key]) continue;
      process.env[key] = valueParts.join("=").trim();
    }
  } catch {
    // .env is optional in production.
  }
}
