import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";

loadLocalEnv();

let pool;

export function databaseConfigured() {
  return Boolean(process.env.DATABASE_URL);
}

export function getPool() {
  if (!databaseConfigured()) {
    throw new Error("DATABASE_URL nao configurada.");
  }
  if (!pool) {
    pool = new pg.Pool(createPoolConfig());
  }
  return pool;
}

export async function query(text, params = []) {
  return getPool().query(text, params);
}

export async function transaction(callback) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => null);
    throw error;
  } finally {
    client.release();
  }
}

export async function closePool() {
  if (!pool) return;
  await pool.end();
  pool = undefined;
}

export function createPoolConfig() {
  const sslEnabled = process.env.DB_SSL === "true";
  if (process.env.NODE_ENV === "production" && !sslEnabled) {
    throw new Error("DB_SSL=true e obrigatorio em producao.");
  }

  return {
    connectionString: process.env.DATABASE_URL,
    ssl: sslEnabled ? buildSslConfig() : undefined,
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
  if (!caCertPath) {
    throw new Error("DB_CA_CERT_PATH e obrigatorio quando DB_SSL=true.");
  }

  return {
    ca: readFileSync(caCertPath, "utf8"),
    rejectUnauthorized: true
  };
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
  try {
    const envPath = fileURLToPath(new URL("../../.env", import.meta.url));
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
