import crypto from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { databaseConfigured, query, transaction } from "./db/postgres.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STORE_PATH = new URL("../data/store.json", `file://${__dirname}/`);
const STORE_FILE = fileURLToPath(STORE_PATH);
let writeQueue = Promise.resolve();

export async function readStore() {
  if (await databaseStateReady()) {
    return readDatabaseStore();
  }

  if (databaseConfigured() && process.env.NODE_ENV === "production") {
    throw new Error("PostgreSQL configurado, mas o schema da aplicacao nao esta pronto.");
  }

  try {
    const raw = await readFile(STORE_PATH, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return emptyStore();
  }
}

export async function readUsersStore() {
  if (!(await databaseStateReady())) return readStore();
  const users = await query(usersSelectSql());
  return { ...emptyStore(), usuarios: users.rows.map(deserializeUser) };
}

export async function readSettingsStore() {
  if (!(await databaseStateReady())) return readStore();
  const [users, settings] = await Promise.all([
    query(usersSelectSql()),
    query("SELECT value FROM app_settings WHERE key = 'configuracoes' LIMIT 1")
  ]);
  return {
    ...emptyStore(),
    usuarios: users.rows.map(deserializeUser),
    configuracoes: settings.rows[0]?.value || {}
  };
}

export async function readProcessesStore() {
  if (!(await databaseStateReady())) return readStore();
  const processes = await query(`
    SELECT data
    FROM app_processes
    ORDER BY COALESCE(updated_at, created_at) DESC, id DESC
  `);
  return { ...emptyStore(), processos: processes.rows.map(deserializeRecord) };
}

function usersSelectSql() {
  return `
    SELECT id, nome, email, foto_url, google_sub, origem_cadastro, senha_hash,
           precisa_definir_senha, ativo, role, access_justification, access_requested_at,
           criado_em, atualizado_em
    FROM app_users
    ORDER BY criado_em ASC, id ASC
  `;
}

export async function writeStore(store) {
  writeQueue = writeQueue.then(() => persistStore(store), () => persistStore(store));
  return writeQueue;
}

async function persistStore(store) {
  if (await databaseStateReady()) {
    await writeDatabaseStore(store);
    return;
  }

  if (databaseConfigured() && process.env.NODE_ENV === "production") {
    throw new Error("PostgreSQL configurado, mas o schema da aplicacao nao esta pronto.");
  }

  await atomicWriteStore(store);
}

async function atomicWriteStore(store) {
  const dir = dirname(STORE_FILE);
  const tempPath = join(dir, `.store.${process.pid}.${Date.now()}.tmp`);
  await mkdir(dir, { recursive: true });
  await writeFile(tempPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  await rename(tempPath, STORE_FILE);
}

async function readDatabaseStore() {
  const [
    users,
    settings,
    processes,
    suppliers,
    observations,
    audit,
    emailHistory,
    revision
  ] = await Promise.all([
    query(usersSelectSql()),
    query(`
      SELECT value
      FROM app_settings
      WHERE key = 'configuracoes'
      LIMIT 1
    `),
    query(`
      SELECT data
      FROM app_processes
      ORDER BY COALESCE(updated_at, created_at) DESC, id DESC
    `),
    query(`
      SELECT data
      FROM app_suppliers
      ORDER BY COALESCE(updated_at, created_at) DESC, id DESC
    `),
    query(`
      SELECT data
      FROM app_process_observations
      ORDER BY COALESCE(updated_at, created_at) DESC, id DESC
    `),
    query(`
      SELECT data
      FROM app_process_audit
      ORDER BY created_at DESC, id DESC
    `),
    query(`
      SELECT data
      FROM app_email_history
      ORDER BY COALESCE(updated_at, created_at) DESC, id DESC
    `),
    query("SELECT revision FROM app_state_revision WHERE id = true")
  ]);

  return {
    processos: processes.rows.map(deserializeRecord),
    fornecedores: suppliers.rows.map(deserializeRecord),
    auditoria: audit.rows.map(deserializeRecord),
    observacoes: observations.rows.map(deserializeRecord),
    emailHistorico: emailHistory.rows.map(deserializeRecord),
    usuarios: users.rows.map(deserializeUser),
    configuracoes: settings.rows[0]?.value || {},
    __revision: Number(revision.rows[0]?.revision || 0)
  };
}

async function writeDatabaseStore(store) {
  await transaction(async (client) => {
    const expectedRevision = Number.isInteger(store.__revision) ? store.__revision : null;
    const revisionResult = expectedRevision === null
      ? await client.query("UPDATE app_state_revision SET revision = revision + 1 WHERE id = true RETURNING revision")
      : await client.query(
        "UPDATE app_state_revision SET revision = revision + 1 WHERE id = true AND revision = $1 RETURNING revision",
        [expectedRevision]
      );
    if (!revisionResult.rowCount) {
      const error = new Error("Os dados foram alterados por outro usuario. Atualize a tela e tente novamente.");
      error.statusCode = 409;
      throw error;
    }
    await upsertUsers(client, store.usuarios || []);
    await upsertSettings(client, store.configuracoes || {});

    await insertRecords(client, "app_processes", store.processos || [], ["criadoEm", "atualizadoEm"]);
    await insertRecords(client, "app_suppliers", store.fornecedores || [], ["criadoEm", "atualizadoEm"]);
    await insertRecords(client, "app_process_observations", store.observacoes || [], ["criadoEm", "atualizadoEm"], {
      processIdKey: "processoId"
    });
    await insertRecords(client, "app_process_audit", store.auditoria || [], ["criadoEm"], {
      processIdKey: "processoId",
      immutable: true
    });
    await insertRecords(client, "app_email_history", store.emailHistorico || [], ["criadoEm", "enviadoEm", "updatedAt"], {
      processIdKey: "processoId",
      dedupeKey: "dedupeKey"
    });
    await deleteMissingRecords(client, "app_process_observations", store.observacoes || []);
    await deleteMissingRecords(client, "app_email_history", store.emailHistorico || []);
    store.__revision = Number(revisionResult.rows[0].revision);
  });
}

async function upsertUsers(client, users) {
  for (const user of users) {
    await client.query(`
      INSERT INTO app_users (
        id, nome, email, foto_url, google_sub, origem_cadastro, senha_hash,
        precisa_definir_senha, ativo, role, access_justification, access_requested_at,
        criado_em, atualizado_em
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::timestamptz, COALESCE($13::timestamptz, now()), COALESCE($14::timestamptz, now()))
      ON CONFLICT (id) DO UPDATE SET
        nome = EXCLUDED.nome,
        email = EXCLUDED.email,
        foto_url = EXCLUDED.foto_url,
        google_sub = EXCLUDED.google_sub,
        origem_cadastro = EXCLUDED.origem_cadastro,
        senha_hash = EXCLUDED.senha_hash,
        precisa_definir_senha = EXCLUDED.precisa_definir_senha,
        ativo = EXCLUDED.ativo,
        role = EXCLUDED.role,
        access_justification = EXCLUDED.access_justification,
        access_requested_at = EXCLUDED.access_requested_at,
        atualizado_em = EXCLUDED.atualizado_em
    `, [
      textId(user.id),
      text(user.nome || user.name || user.email || "Usuario"),
      normalizeEmail(user.email),
      text(user.foto || user.fotoUrl),
      nullableText(user.googleSub),
      text(user.origemCadastro || "local"),
      text(user.senhaHash),
      Boolean(user.precisaDefinirSenha),
      user.ativo !== false,
      normalizeRole(user.role, user.email),
      text(user.justificativaAcesso),
      timestamp(user.solicitadoEm || (user.origemCadastro === "solicitacao" ? user.criadoEm : "")),
      timestamp(user.criadoEm),
      timestamp(user.atualizadoEm)
    ]);
  }
}

async function upsertSettings(client, settings) {
  await client.query(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES ('configuracoes', $1::jsonb, now())
    ON CONFLICT (key) DO UPDATE SET
      value = EXCLUDED.value,
      updated_at = EXCLUDED.updated_at
  `, [JSON.stringify(settings)]);
}

async function insertRecords(client, table, records, timestampKeys = [], options = {}) {
  for (const record of records) {
    const createdAt = firstTimestamp(record, timestampKeys);
    const updatedAt = firstTimestamp(record, ["atualizadoEm", "updatedAt", ...timestampKeys.filter((key) => key !== "atualizadoEm")]);
    const columns = options.immutable
      ? ["id", "data", "created_at"]
      : ["id", "data", "created_at", "updated_at"];
    const values = options.immutable
      ? [textId(record.id), JSON.stringify(record), createdAt]
      : [textId(record.id), JSON.stringify(record), createdAt, updatedAt];

    if (options.processIdKey) {
      columns.push("processo_id");
      values.push(text(record[options.processIdKey]));
    }

    if (options.dedupeKey) {
      columns.push("dedupe_key");
      values.push(nullableText(record[options.dedupeKey]));
    }

    const conflictClause = options.immutable
      ? "DO NOTHING"
      : `DO UPDATE SET
         data = EXCLUDED.data,
         updated_at = EXCLUDED.updated_at${options.processIdKey ? ",\n         processo_id = EXCLUDED.processo_id" : ""}${options.dedupeKey ? ",\n         dedupe_key = EXCLUDED.dedupe_key" : ""}`;
    const placeholders = columns.map((column, index) =>
      ["created_at", "updated_at"].includes(column)
        ? `COALESCE($${index + 1}::timestamptz, now())`
        : `$${index + 1}`
    );
    await client.query(
      `INSERT INTO ${table} (${columns.join(", ")})
       VALUES (${placeholders.join(", ")})
       ON CONFLICT (id) ${conflictClause}`,
      values
    );
  }
}

async function deleteMissingRecords(client, table, records) {
  const ids = records.map((record) => textId(record.id));
  if (!ids.length) {
    await client.query(`DELETE FROM ${table}`);
    return;
  }
  await client.query(`DELETE FROM ${table} WHERE NOT (id = ANY($1::text[]))`, [ids]);
}

async function databaseStateReady() {
  if (!databaseConfigured()) return false;
  try {
    const result = await query(`
      SELECT
        to_regclass('public.app_processes') IS NOT NULL AS processes_ready,
        to_regclass('public.app_process_observations') IS NOT NULL AS observations_ready,
        to_regclass('public.app_process_audit') IS NOT NULL AS audit_ready,
        to_regclass('public.app_suppliers') IS NOT NULL AS suppliers_ready,
        to_regclass('public.app_email_history') IS NOT NULL AS email_history_ready,
        to_regclass('public.app_state_revision') IS NOT NULL AS revision_ready,
        to_regclass('public.app_email_dispatch_claims') IS NOT NULL AS email_claims_ready,
        to_regclass('public.auth_rate_limits') IS NOT NULL AS rate_limits_ready,
        to_regclass('public.app_security_audit') IS NOT NULL AS security_audit_ready,
        EXISTS (
          SELECT 1 FROM app_schema_migrations WHERE version = '009_security_audit'
        ) AS schema_current
    `);
    const row = result.rows[0] || {};
    return Boolean(
      row.processes_ready &&
      row.observations_ready &&
      row.audit_ready &&
      row.suppliers_ready &&
      row.email_history_ready &&
      row.revision_ready &&
      row.email_claims_ready &&
      row.rate_limits_ready &&
      row.security_audit_ready &&
      row.schema_current
    );
  } catch {
    return false;
  }
}

export async function detectStoreBackend() {
  if (await databaseStateReady()) return "postgres";
  return "json";
}

function deserializeRecord(row = {}) {
  return cloneJson(Object.prototype.hasOwnProperty.call(row, "data") ? row.data : row);
}

function deserializeUser(row = {}) {
  return {
    id: row.id,
    nome: row.nome,
    email: row.email,
    foto: row.foto_url || "",
    googleSub: row.google_sub || "",
    origemCadastro: row.origem_cadastro || "local",
    senhaHash: row.senha_hash || "",
    precisaDefinirSenha: Boolean(row.precisa_definir_senha),
    ativo: row.ativo !== false,
    role: row.role || "",
    justificativaAcesso: row.access_justification || "",
    solicitadoEm: toIsoString(row.access_requested_at),
    criadoEm: toIsoString(row.criado_em),
    atualizadoEm: toIsoString(row.atualizado_em)
  };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value ?? {}));
}

function toIsoString(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function firstTimestamp(record = {}, keys = []) {
  for (const key of keys) {
    const value = record?.[key];
    const normalized = timestamp(value);
    if (normalized) return normalized;
  }
  return null;
}

function emptyStore() {
  return {
    processos: [],
    fornecedores: [],
    auditoria: [],
    observacoes: [],
    emailHistorico: [],
    usuarios: [],
    configuracoes: {}
  };
}

function text(value = "") {
  return String(value ?? "").trim();
}

function nullableText(value = "") {
  const result = text(value);
  return result || null;
}

function textId(value = "") {
  return text(value) || crypto.randomUUID();
}

function normalizeEmail(value = "") {
  return String(value).trim().toLowerCase();
}

function timestamp(value = "") {
  const result = text(value);
  if (!result) return null;
  const parsed = new Date(result);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function normalizeRole(role, email = "") {
  const value = String(role || "").trim().toLowerCase();
  if (["admin", "almoxarifado", "auditor"].includes(value)) return value;
  return normalizeEmail(email) === normalizeEmail(process.env.LOCAL_ADMIN_EMAIL || "") ? "admin" : "almoxarifado";
}
