import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ensurePrivateDirectory,
  openDirectoryNoFollow,
  openRegularFileNoFollow,
  readRegularFileLimited
} from "./security/private-files.js";
import {
  databaseConfigured,
  isTestRuntime,
  query,
  readTransaction,
  transaction
} from "./db/postgres.js";
import { recordSecurityEvent } from "./repositories/security-audit.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_STORE_FILE = fileURLToPath(new URL("../data/store.json", `file://${__dirname}/`));
const EXPECTED_SCHEMA_MIGRATION = "010_auth_session_version";
const STORE_FILE = resolveStoreFilePath();
let writeQueue = Promise.resolve();
let databaseReadyConfirmed = false;
let localStoreRevision = 0;

export async function readStore() {
  if (await requireConfiguredDatabase()) {
    return readDatabaseStore();
  }

  try {
    const directory = dirname(STORE_FILE);
    await ensurePrivateDirectory(directory);
    const { content } = await readRegularFileLimited(STORE_FILE, {
      root: directory,
      mode: 0o600
    });
    const store = JSON.parse(content.toString("utf8"));
    const storedRevision = Number(store.__revision);
    if (Number.isSafeInteger(storedRevision) && storedRevision >= 0) localStoreRevision = Math.max(localStoreRevision, storedRevision);
    store.__revision = localStoreRevision;
    return store;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { ...emptyStore(), __revision: localStoreRevision };
  }
}

export async function readUsersStore() {
  if (!(await requireConfiguredDatabase())) return readStore();
  const users = await query(usersSelectSql());
  return { ...emptyStore(), usuarios: users.rows.map(deserializeUser) };
}

export async function readUserById(userId, options = {}) {
  if (!userId) return null;
  if (!(await requireConfiguredDatabase())) {
    const store = await readStore();
    return store.usuarios.find((user) => user.id === userId) || null;
  }
  const result = await query(`${usersSelectSql({
    includePassword: options.includePassword === true,
    orderBy: false
  })} WHERE id = $1 LIMIT 1`, [userId]);
  return result.rows[0] ? deserializeUser(result.rows[0]) : null;
}

export async function readUserByEmail(email) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return null;
  if (!(await requireConfiguredDatabase())) {
    const store = await readStore();
    return store.usuarios.find((user) => normalizeEmail(user.email) === normalizedEmail) || null;
  }
  const result = await query(`${usersSelectSql({ includePassword: true, orderBy: false })} WHERE email = $1 LIMIT 1`, [normalizedEmail]);
  return result.rows[0] ? deserializeUser(result.rows[0]) : null;
}

export async function readSettingsStore() {
  if (!(await requireConfiguredDatabase())) return readStore();
  const [users, settings] = await Promise.all([
    query(usersSelectSql({ includePassword: false })),
    query("SELECT value FROM app_settings WHERE key = 'configuracoes' LIMIT 1")
  ]);
  return {
    ...emptyStore(),
    usuarios: users.rows.map(deserializeUser),
    configuracoes: settings.rows[0]?.value || {}
  };
}

export async function readProcessesStore() {
  if (!(await requireConfiguredDatabase())) return readStore();
  const processes = await query(`
    SELECT data
    FROM app_processes
    ORDER BY COALESCE(updated_at, created_at) DESC, id DESC
  `);
  return { ...emptyStore(), processos: processes.rows.map(deserializeRecord) };
}

export async function readProcessById(processId) {
  const id = String(processId || "");
  if (!id) return null;
  if (!(await requireConfiguredDatabase())) {
    const store = await readStore();
    return (store.processos || []).find((processo) => processo.id === id) || null;
  }
  const result = await query(`
    SELECT data
    FROM app_processes
    WHERE id = $1
    LIMIT 1
  `, [id]);
  return result.rows[0] ? deserializeRecord(result.rows[0]) : null;
}

export async function readSuppliersStore() {
  if (!(await requireConfiguredDatabase())) return readStore();
  const suppliers = await query(`
    SELECT data
    FROM app_suppliers
    ORDER BY COALESCE(updated_at, created_at) DESC, id DESC
  `);
  return { ...emptyStore(), fornecedores: suppliers.rows.map(deserializeRecord) };
}

export async function readAuditStore() {
  if (!(await requireConfiguredDatabase())) return readStore();
  const audit = await query(`
    SELECT data
    FROM app_process_audit
    ORDER BY created_at DESC, id DESC
  `);
  return { ...emptyStore(), auditoria: audit.rows.map(deserializeRecord) };
}

export async function readStoreRevision() {
  if (!(await requireConfiguredDatabase())) return localStoreRevision;
  const result = await query("SELECT revision FROM app_state_revision WHERE id = true LIMIT 1");
  return Number(result.rows[0]?.revision || 0);
}

export async function readProcessesSnapshot() {
  if (!(await requireConfiguredDatabase())) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const revisionBefore = localStoreRevision;
      const store = await readStore();
      if (revisionBefore === localStoreRevision) {
        return { processos: store.processos, revision: revisionBefore };
      }
    }
    const store = await readStore();
    return { processos: store.processos, revision: localStoreRevision };
  }
  return readTransaction(async (client) => {
    const processes = await client.query(`
      SELECT data
      FROM app_processes
      ORDER BY COALESCE(updated_at, created_at) DESC, id DESC
    `);
    const revision = await client.query("SELECT revision FROM app_state_revision WHERE id = true LIMIT 1");
    return {
      processos: processes.rows.map(deserializeRecord),
      revision: Number(revision.rows[0]?.revision || 0)
    };
  });
}

function usersSelectSql(options = {}) {
  const passwordColumn = options.includePassword === false ? "''::text AS senha_hash" : "senha_hash";
  return `
    SELECT id, nome, email, foto_url, google_sub, origem_cadastro, ${passwordColumn},
           precisa_definir_senha, ativo, role, access_justification, access_requested_at,
           auth_version, criado_em, atualizado_em
    FROM app_users${options.orderBy === false ? "" : "\n    ORDER BY criado_em ASC, id ASC"}
  `;
}

export async function writeStore(store, options = {}) {
  const preparedStore = prepareStoreForPersistence(store);
  const securityEvents = prepareSecurityEvents(options);
  writeQueue = writeQueue.then(
    () => persistStore(preparedStore, securityEvents),
    () => persistStore(preparedStore, securityEvents)
  );
  return writeQueue;
}

async function persistStore(store, securityEvents) {
  if (await requireConfiguredDatabase()) {
    await writeDatabaseStore(store, securityEvents);
    localStoreRevision += 1;
    return;
  }

  const expectedRevision = Number.isSafeInteger(store.__revision) ? store.__revision : localStoreRevision;
  if (expectedRevision !== localStoreRevision) {
    const error = new Error("Os dados foram alterados por outro usuario. Atualize a tela e tente novamente.");
    error.statusCode = 409;
    throw error;
  }
  const committedRevision = localStoreRevision + 1;
  store.__revision = committedRevision;
  await atomicWriteStore(store);
  localStoreRevision = committedRevision;
  for (const event of securityEvents) {
    await recordSecurityEvent(event.eventType, event);
  }
}

async function atomicWriteStore(store) {
  const dir = dirname(STORE_FILE);
  const tempPath = join(dir, `.store.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`);
  await ensurePrivateDirectory(dir);

  let handle;
  try {
    handle = await open(
      tempPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600
    );
    await handle.writeFile(`${JSON.stringify(store, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(tempPath, STORE_FILE);
    const storedFile = await openRegularFileNoFollow(STORE_FILE, { root: dir, mode: 0o600 });
    await storedFile.handle.close();

    // Persist the directory entry as well as file contents before reporting a
    // successful atomic replacement.
    const { handle: directoryHandle } = await openDirectoryNoFollow(dir, { mode: 0o700 });
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    await handle?.close().catch(() => null);
    await rm(tempPath, { force: true }).catch(() => null);
    throw error;
  }
}

async function readDatabaseStore() {
  return readTransaction(async (client) => {
    // All collections and the revision now come from the same PostgreSQL
    // snapshot. Mixing pool clients here could return a revision newer than
    // some collections and make a stale full-state write look valid.
    // node-postgres does not support concurrent query() calls on one client.
    // Explicit sequencing keeps every read in this snapshot and is compatible
    // with pg 9, which removes the old implicit queueing behavior.
    const users = await client.query(usersSelectSql());
    const settings = await client.query(`
      SELECT value
      FROM app_settings
      WHERE key = 'configuracoes'
      LIMIT 1
    `);
    const processes = await client.query(`
      SELECT data
      FROM app_processes
      ORDER BY COALESCE(updated_at, created_at) DESC, id DESC
    `);
    const suppliers = await client.query(`
      SELECT data
      FROM app_suppliers
      ORDER BY COALESCE(updated_at, created_at) DESC, id DESC
    `);
    const observations = await client.query(`
      SELECT data
      FROM app_process_observations
      ORDER BY COALESCE(updated_at, created_at) DESC, id DESC
    `);
    const audit = await client.query(`
      SELECT data
      FROM app_process_audit
      ORDER BY created_at DESC, id DESC
    `);
    const emailHistory = await client.query(`
      SELECT data
      FROM app_email_history
      ORDER BY COALESCE(updated_at, created_at) DESC, id DESC
    `);
    const revision = await client.query("SELECT revision FROM app_state_revision WHERE id = true");

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
  });
}

async function writeDatabaseStore(store, securityEvents) {
  const committedRevision = await transaction(async (client) => {
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
    for (const event of securityEvents) {
      await recordSecurityEvent(event.eventType, event, { client });
    }
    return Number(revisionResult.rows[0].revision);
  });
  store.__revision = committedRevision;
}

async function upsertUsers(client, users) {
  if (!users.length) return;
  const rows = users.map((user) => ({
    id: textId(user.id),
    nome: text(user.nome || user.name || user.email || "Usuario"),
    email: normalizeEmail(user.email),
    foto_url: text(user.foto || user.fotoUrl),
    google_sub: nullableText(user.googleSub),
    origem_cadastro: text(user.origemCadastro || "local"),
    senha_hash: text(user.senhaHash),
    precisa_definir_senha: Boolean(user.precisaDefinirSenha),
    auth_version: positiveAuthVersion(user.authVersion),
    ativo: user.ativo !== false,
    role: normalizeRole(user.role, user.email),
    access_justification: text(user.justificativaAcesso),
    access_requested_at: timestamp(user.solicitadoEm || (user.origemCadastro === "solicitacao" ? user.criadoEm : "")),
    criado_em: timestamp(user.criadoEm),
    atualizado_em: timestamp(user.atualizadoEm)
  }));
  await client.query(`
    INSERT INTO app_users (
      id, nome, email, foto_url, google_sub, origem_cadastro, senha_hash,
      precisa_definir_senha, ativo, role, access_justification, access_requested_at, auth_version,
      criado_em, atualizado_em
    )
    SELECT
      x.id, x.nome, x.email, x.foto_url, x.google_sub, x.origem_cadastro, x.senha_hash,
      x.precisa_definir_senha, x.ativo, x.role, x.access_justification,
      x.access_requested_at::timestamptz, x.auth_version,
      COALESCE(x.criado_em::timestamptz, now()),
      COALESCE(x.atualizado_em::timestamptz, now())
    FROM jsonb_to_recordset($1::jsonb) AS x(
      id text, nome text, email text, foto_url text, google_sub text,
      origem_cadastro text, senha_hash text, precisa_definir_senha boolean,
      ativo boolean, role text, access_justification text,
      access_requested_at text, auth_version bigint, criado_em text, atualizado_em text
    )
    WHERE true
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
      auth_version = EXCLUDED.auth_version,
      atualizado_em = EXCLUDED.atualizado_em
    WHERE app_users.nome IS DISTINCT FROM EXCLUDED.nome
       OR app_users.email IS DISTINCT FROM EXCLUDED.email
       OR app_users.foto_url IS DISTINCT FROM EXCLUDED.foto_url
       OR app_users.google_sub IS DISTINCT FROM EXCLUDED.google_sub
       OR app_users.origem_cadastro IS DISTINCT FROM EXCLUDED.origem_cadastro
       OR app_users.senha_hash IS DISTINCT FROM EXCLUDED.senha_hash
       OR app_users.precisa_definir_senha IS DISTINCT FROM EXCLUDED.precisa_definir_senha
       OR app_users.ativo IS DISTINCT FROM EXCLUDED.ativo
       OR app_users.role IS DISTINCT FROM EXCLUDED.role
       OR app_users.access_justification IS DISTINCT FROM EXCLUDED.access_justification
       OR app_users.access_requested_at IS DISTINCT FROM EXCLUDED.access_requested_at
       OR app_users.auth_version IS DISTINCT FROM EXCLUDED.auth_version
  `, [JSON.stringify(rows)]);
}

async function upsertSettings(client, settings) {
  await client.query(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES ('configuracoes', $1::jsonb, now())
    ON CONFLICT (key) DO UPDATE SET
      value = EXCLUDED.value,
      updated_at = EXCLUDED.updated_at
    WHERE app_settings.value IS DISTINCT FROM EXCLUDED.value
  `, [JSON.stringify(settings)]);
}

async function insertRecords(client, table, records, timestampKeys = [], options = {}) {
  if (!records.length) return;
  const rows = records.map((record) => ({
    id: textId(record.id),
    data: record,
    created_at: firstTimestamp(record, timestampKeys),
    updated_at: firstTimestamp(record, [
      "atualizadoEm",
      "updatedAt",
      ...timestampKeys.filter((key) => key !== "atualizadoEm")
    ]),
    processo_id: options.processIdKey ? text(record[options.processIdKey]) : null,
    dedupe_key: options.dedupeKey ? nullableText(record[options.dedupeKey]) : null
  }));
  const columns = options.immutable
    ? ["id", "data", "created_at"]
    : ["id", "data", "created_at", "updated_at"];
  const selectColumns = options.immutable
    ? ["x.id", "x.data", "COALESCE(x.created_at::timestamptz, now())"]
    : [
        "x.id",
        "x.data",
        "COALESCE(x.created_at::timestamptz, now())",
        "COALESCE(x.updated_at::timestamptz, now())"
      ];
  if (options.processIdKey) {
    columns.push("processo_id");
    selectColumns.push("x.processo_id");
  }
  if (options.dedupeKey) {
    columns.push("dedupe_key");
    selectColumns.push("x.dedupe_key");
  }
  const conflictClause = options.immutable
    ? "DO NOTHING"
    : `DO UPDATE SET
       data = EXCLUDED.data,
       updated_at = EXCLUDED.updated_at${options.processIdKey ? ",\n       processo_id = EXCLUDED.processo_id" : ""}${options.dedupeKey ? ",\n       dedupe_key = EXCLUDED.dedupe_key" : ""}`;
  const updatePredicate = options.immutable
    ? ""
    : ` WHERE ${table}.data IS DISTINCT FROM EXCLUDED.data${options.processIdKey ? ` OR ${table}.processo_id IS DISTINCT FROM EXCLUDED.processo_id` : ""}${options.dedupeKey ? ` OR ${table}.dedupe_key IS DISTINCT FROM EXCLUDED.dedupe_key` : ""}`;

  await client.query(`
    INSERT INTO ${table} (${columns.join(", ")})
    SELECT ${selectColumns.join(", ")}
    FROM jsonb_to_recordset($1::jsonb) AS x(
      id text, data jsonb, created_at text, updated_at text,
      processo_id text, dedupe_key text
    )
    WHERE true
    ON CONFLICT (id) ${conflictClause}${updatePredicate}
  `, [JSON.stringify(rows)]);
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
  if (databaseReadyConfirmed) return true;
  const result = await query(`
      SELECT
        to_regclass('public.app_users') IS NOT NULL AS users_ready,
        to_regclass('public.user_sessions') IS NOT NULL AS sessions_ready,
        to_regclass('public.app_settings') IS NOT NULL AS settings_ready,
        to_regclass('public.app_schema_migrations') IS NOT NULL AS migrations_ready,
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
          SELECT 1 FROM app_schema_migrations WHERE version = '${EXPECTED_SCHEMA_MIGRATION}'
        ) AS schema_current
    `);
  const row = result.rows[0] || {};
  databaseReadyConfirmed = Boolean(
    row.users_ready &&
    row.sessions_ready &&
    row.settings_ready &&
    row.migrations_ready &&
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
  return databaseReadyConfirmed;
}

export async function detectStoreBackend() {
  if (await requireConfiguredDatabase()) return "postgres";
  return "json";
}

async function requireConfiguredDatabase() {
  if (!databaseConfigured()) return false;
  let ready;
  try {
    ready = await databaseStateReady();
  } catch (cause) {
    const error = new Error("PostgreSQL configurado, mas indisponivel.", { cause });
    error.statusCode = 503;
    throw error;
  }
  if (!ready) {
    const error = new Error("PostgreSQL configurado, mas o schema da aplicacao nao esta pronto.");
    error.statusCode = 503;
    throw error;
  }
  return true;
}

export function resolveStoreFilePath() {
  if (!isTestRuntime()) {
    return process.env.APP_STORE_PATH ? resolve(process.env.APP_STORE_PATH) : DEFAULT_STORE_FILE;
  }
  const testRoot = resolve(
    process.env.TEST_STORAGE_ROOT || join(tmpdir(), "almoxarifado-tests")
  );
  return join(testRoot, String(process.pid), "store.json");
}

export function prepareStoreForPersistence(store, options = {}) {
  if (!store || typeof store !== "object" || Array.isArray(store)) {
    throw new TypeError("O estado a persistir deve ser um objeto.");
  }

  for (const [key, label] of [
    ["processos", "processo"],
    ["fornecedores", "fornecedor"],
    ["auditoria", "auditoria"],
    ["observacoes", "observacao"],
    ["emailHistorico", "historico de e-mail"],
    ["usuarios", "usuario"]
  ]) {
    const records = store[key] ?? [];
    if (!Array.isArray(records)) throw new TypeError(`${key} deve ser uma lista.`);
    ensureRecordIds(records, label);
    store[key] = records;
  }

  const processIds = new Set(store.processos.map((record) => record.id));
  for (const [key, label] of [["auditoria", "auditoria"], ["observacoes", "observacao"]]) {
    for (const record of store[key]) {
      const processId = text(record.processoId);
      if (!processId) {
        throw new Error(`${label} ${record.id} nao possui processoId.`);
      }
      if (!options.allowExternalProcessReferences && !processIds.has(processId)) {
        throw new Error(`${label} ${record.id} referencia processo inexistente ${processId}.`);
      }
    }
  }

  if (!store.configuracoes || typeof store.configuracoes !== "object" || Array.isArray(store.configuracoes)) {
    store.configuracoes = {};
  }
  return store;
}

export function prepareSecurityEvents(options = {}) {
  const input = Array.isArray(options) ? options : (options.securityEvents || []);
  if (!Array.isArray(input)) throw new TypeError("securityEvents deve ser uma lista.");
  if (input.length > 50) throw new RangeError("Uma gravacao aceita no maximo 50 eventos de seguranca.");
  return input.map((event) => {
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      throw new TypeError("Evento de seguranca invalido.");
    }
    const eventType = text(event.eventType).slice(0, 100);
    if (!eventType) throw new TypeError("eventType e obrigatorio no evento de seguranca.");
    return {
      eventType,
      actorUserId: nullableText(event.actorUserId),
      actorEmail: normalizeEmail(event.actorEmail),
      targetUserId: nullableText(event.targetUserId),
      metadata: cloneJson(event.metadata || {})
    };
  });
}

function ensureRecordIds(records, label) {
  const ids = new Set();
  for (const record of records) {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw new TypeError(`Registro de ${label} invalido.`);
    }
    const id = text(record.id) || crypto.randomUUID();
    if (ids.has(id)) throw new Error(`ID duplicado em ${label}: ${id}.`);
    record.id = id;
    ids.add(id);
  }
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
    authVersion: positiveAuthVersion(row.auth_version),
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
    configuracoes: {},
    __revision: localStoreRevision
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
  const result = text(value);
  if (!result) throw new Error("ID obrigatorio ausente durante a persistencia.");
  return result;
}

function normalizeEmail(value = "") {
  return String(value).trim().toLowerCase();
}

function positiveAuthVersion(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
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
