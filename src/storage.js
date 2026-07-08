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

  try {
    const raw = await readFile(STORE_PATH, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return emptyStore();
  }
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
    emailHistory
  ] = await Promise.all([
    query(`
      SELECT id, nome, email, foto_url, google_sub, origem_cadastro, senha_hash,
             precisa_definir_senha, ativo, criado_em, atualizado_em
      FROM app_users
      ORDER BY criado_em ASC, id ASC
    `),
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
    `)
  ]);

  return {
    processos: processes.rows.map(deserializeRecord),
    fornecedores: suppliers.rows.map(deserializeRecord),
    auditoria: audit.rows.map(deserializeRecord),
    observacoes: observations.rows.map(deserializeRecord),
    emailHistorico: emailHistory.rows.map(deserializeRecord),
    usuarios: users.rows.map(deserializeUser),
    configuracoes: settings.rows[0]?.value || {}
  };
}

async function writeDatabaseStore(store) {
  await transaction(async (client) => {
    await upsertUsers(client, store.usuarios || []);
    await upsertSettings(client, store.configuracoes || {});

    await client.query("DELETE FROM app_email_history");
    await client.query("DELETE FROM app_process_audit");
    await client.query("DELETE FROM app_process_observations");
    await client.query("DELETE FROM app_processes");
    await client.query("DELETE FROM app_suppliers");

    await insertRecords(client, "app_processes", store.processos || [], ["criadoEm", "atualizadoEm"]);
    await insertRecords(client, "app_suppliers", store.fornecedores || [], ["criadoEm", "atualizadoEm"]);
    await insertRecords(client, "app_process_observations", store.observacoes || [], ["criadoEm", "atualizadoEm"], {
      processIdKey: "processoId"
    });
    await insertRecords(client, "app_process_audit", store.auditoria || [], ["criadoEm"], {
      processIdKey: "processoId"
    });
    await insertRecords(client, "app_email_history", store.emailHistorico || [], ["criadoEm", "enviadoEm", "updatedAt"], {
      processIdKey: "processoId",
      dedupeKey: "dedupeKey"
    });
  });
}

async function upsertUsers(client, users) {
  for (const user of users) {
    await client.query(`
      INSERT INTO app_users (
        id, nome, email, foto_url, google_sub, origem_cadastro, senha_hash,
        precisa_definir_senha, ativo, criado_em, atualizado_em
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10::timestamptz, now()), COALESCE($11::timestamptz, now()))
      ON CONFLICT (id) DO UPDATE SET
        nome = EXCLUDED.nome,
        email = EXCLUDED.email,
        foto_url = EXCLUDED.foto_url,
        google_sub = EXCLUDED.google_sub,
        origem_cadastro = EXCLUDED.origem_cadastro,
        senha_hash = EXCLUDED.senha_hash,
        precisa_definir_senha = EXCLUDED.precisa_definir_senha,
        ativo = EXCLUDED.ativo,
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
    const columns = ["id", "data", "created_at", "updated_at"];
    const values = [
      textId(record.id),
      JSON.stringify(record),
      createdAt,
      updatedAt
    ];

    if (options.processIdKey) {
      columns.push("processo_id");
      values.push(text(record[options.processIdKey]));
    }

    if (options.dedupeKey) {
      columns.push("dedupe_key");
      values.push(nullableText(record[options.dedupeKey]));
    }

    await client.query(
      `INSERT INTO ${table} (${columns.join(", ")})
       VALUES (${columns.map((_, index) => `$${index + 1}`).join(", ")})
       ON CONFLICT (id) DO UPDATE SET
         data = EXCLUDED.data,
         created_at = EXCLUDED.created_at,
         updated_at = EXCLUDED.updated_at${options.processIdKey ? ",\n         processo_id = EXCLUDED.processo_id" : ""}${options.dedupeKey ? ",\n         dedupe_key = EXCLUDED.dedupe_key" : ""}`,
      values
    );
  }
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
        to_regclass('public.app_email_history') IS NOT NULL AS email_history_ready
    `);
    const row = result.rows[0] || {};
    return Boolean(
      row.processes_ready &&
      row.observations_ready &&
      row.audit_ready &&
      row.suppliers_ready &&
      row.email_history_ready
    );
  } catch {
    return false;
  }
}

export async function detectStoreBackend() {
  if (await databaseStateReady()) return "postgres";
  return "json";
}

function deserializeRecord(value = {}) {
  return cloneJson(value);
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
