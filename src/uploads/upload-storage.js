import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { databaseConfigured, query } from "../db/postgres.js";
import { createPrivateFile } from "../security/private-files.js";
import { readProcessesStore, readSettingsStore } from "../storage.js";
import {
  deleteFromDrive,
  downloadFromDrive,
  getDriveAccountIdentity,
  getDriveClient,
  resolveFolderId,
  statDriveFile,
  streamFromDrive,
  uploadToDrive,
  validateDriveConfiguration,
  verifyDriveFolderAccess
} from "./drive-storage.js";
import {
  DRIVE_UPLOAD_STORAGE_DATABASE_KEY,
  ensureDriveUploadStorageIdentity,
  inspectDriveUploadStorageIdentity,
  readDriveUploadStorageIdentity
} from "./drive-storage-identity.js";
import {
  deleteLocalUploadFile,
  ensureLocalUploadStorageReady,
  getLocalUploadBuffer,
  getLocalUploadMetadata,
  inspectLocalUploadStorageIdentity,
  putLocalUploadFile,
  serveLocalUpload
} from "./local-storage.js";
import { persistedPdfValidationError } from "./pdf-validation.js";

const LOCAL_DATABASE_KEY = "uploadStorageIdentity";
const DEFAULT_UPLOAD_ROOT = fileURLToPath(new URL("../../uploads/", import.meta.url));
const DEFAULT_INTEGRITY_CACHE_TTL_MS = 60_000;
let activeStorageIdentity = "";
let activeIdentityBackend = "";
const integrityCache = { checkedAt: 0, result: null };
const volatileDatabaseIdentities = new Map();
let uploadStorageReadiness = Object.freeze({ ready: false, backend: "", identity: "", stage: "not_started" });

export function configuredUploadStorageBackend(options = {}) {
  const backend = String(options.backend || process.env.UPLOAD_STORAGE_BACKEND || "local").trim().toLowerCase();
  if (!["local", "drive"].includes(backend)) {
    throw new Error("UPLOAD_STORAGE_BACKEND deve ser 'local' ou 'drive'.");
  }
  return backend;
}

export function backendForPath(uploadPath = "") {
  return String(uploadPath).startsWith("/uploads/drive/") ? "drive" : "local";
}

export async function ensureUploadStorageReady(options = {}) {
  let backend = "";
  let stage = "backend_validation";
  uploadStorageReadiness = Object.freeze({ ready: false, backend, identity: "", stage });
  try {
    backend = configuredUploadStorageBackend(options);
    updateUploadStorageReadiness({ backend, stage });
    const identityCallbacks = databaseIdentityCallbacks(
      backend === "drive" ? DRIVE_UPLOAD_STORAGE_DATABASE_KEY : LOCAL_DATABASE_KEY,
      options,
      { previousKey: backend === "drive" ? LOCAL_DATABASE_KEY : "" }
    );
    if (backend === "drive") {
      stage = "oauth_configuration";
      const folderId = options.client
        ? resolveFolderId(options)
        : validateDriveConfiguration(options).folderId;
      const client = options.client || getDriveClient(options);
      updateUploadStorageReadiness({ backend, stage });

      stage = "oauth_authentication";
      const account = await getDriveAccountIdentity({ ...options, client });
      emit(options, "upload_storage_oauth_validated", {
        backend,
        account: safeAccountIdentifier(account)
      });
      updateUploadStorageReadiness({ backend, stage });

      stage = "folder_access";
      await verifyDriveFolderAccess({ ...options, client, folderId });
      emit(options, "upload_storage_folder_access_verified", {
        backend,
        folderId: maskIdentifier(folderId)
      });
      updateUploadStorageReadiness({ backend, stage });

      stage = "identity_validation";
      updateUploadStorageReadiness({ backend, stage });
      activeStorageIdentity = await ensureDriveUploadStorageIdentity({
        ...options,
        ...identityCallbacks,
        client,
        folderId
      });
    } else {
      stage = "identity_validation";
      updateUploadStorageReadiness({ backend, stage });
      activeStorageIdentity = await ensureLocalUploadStorageReady({
        ...options,
        ...identityCallbacks,
        root: resolveUploadRoot(options)
      });
      emit(options, "upload_storage_identity_current", {
        backend,
        databaseIdentity: activeStorageIdentity,
        markerIdentity: activeStorageIdentity,
        migrationRequired: false
      });
    }
    activeIdentityBackend = backend;
    integrityCache.checkedAt = 0;
    integrityCache.result = null;
    uploadStorageReadiness = Object.freeze({ ready: true, backend, identity: activeStorageIdentity, stage: "ready" });
    emit(options, "upload_storage_ready", { backend, identity: activeStorageIdentity });
    return activeStorageIdentity;
  } catch (error) {
    if (!error.stage) error.stage = stage;
    uploadStorageReadiness = Object.freeze({ ready: false, backend, identity: "", stage: error.stage, code: error.code || null });
    throw error;
  }
}

export function uploadStorageReadinessState() {
  return uploadStorageReadiness;
}

export async function diagnoseUploadStorage(options = {}) {
  const backend = configuredUploadStorageBackend(options);
  if (backend !== "drive") throw new Error("O diagnostico OAuth exige UPLOAD_STORAGE_BACKEND=drive.");
  const folderId = options.client ? resolveFolderId(options) : validateDriveConfiguration(options).folderId;
  const client = options.client || getDriveClient(options);
  const account = await getDriveAccountIdentity({ ...options, client });
  const folder = await verifyDriveFolderAccess({ ...options, client, folderId });
  const identityCallbacks = databaseIdentityCallbacks(DRIVE_UPLOAD_STORAGE_DATABASE_KEY, options, {
    previousKey: LOCAL_DATABASE_KEY
  });
  const identity = await inspectDriveUploadStorageIdentity({
    ...options,
    ...identityCallbacks,
    client,
    folderId
  });
  return Object.freeze({
    backend,
    account: safeAccountIdentifier(account),
    folderId: maskIdentifier(folderId),
    folderName: String(folder.name || "").slice(0, 120),
    ...identity
  });
}

export async function putUploadFile(content, options = {}) {
  const backend = configuredUploadStorageBackend(options);
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content || "");
  if (backend === "local") {
    return putLocalUploadFile(buffer, {
      ...options,
      root: resolveUploadRoot(options),
      validatePersistedFile: (filePath, persistedContent) => persistedPdfValidationError(filePath, persistedContent, {
        timeoutMs: pdfValidationTimeout(options)
      })
    });
  }

  await validateBeforeDriveUpload(buffer, options);
  const uploaded = await uploadToDrive(buffer, {
    ...options,
    name: options.fileName,
    mimeType: options.mimeType
  });
  return {
    path: `/uploads/drive/${uploaded.id}/${encodeURIComponent(String(options.fileName || uploaded.name || "arquivo"))}`,
    sizeBytes: numericSize(uploaded.size, buffer.length)
  };
}

export async function getUploadBuffer(uploadPath, maximumBytes, options = {}) {
  if (backendForPath(uploadPath) === "drive") {
    const reference = parseDriveUploadPath(uploadPath);
    if (!reference) throw invalidUploadPathError();
    return downloadFromDrive(reference.fileId, { ...options, maximumBytes });
  }
  return getLocalUploadBuffer(uploadPath, maximumBytes, { ...options, root: resolveUploadRoot(options) });
}

export async function streamUploadTo(res, uploadPath, headers = {}, options = {}) {
  if (backendForPath(uploadPath) === "local") {
    return serveLocalUpload(res, uploadPath, headers, { ...options, root: resolveUploadRoot(options) });
  }
  const reference = parseDriveUploadPath(uploadPath);
  if (!reference) throw invalidUploadPathError();
  let responseStarted = false;
  try {
    const metadata = await statDriveFile(reference.fileId, options);
    if (!metadata) return sendNotFound(res, options);
    const sizeBytes = numericSize(metadata.size, null);
    const responseHeaders = { ...headers };
    const etag = driveEtag(metadata);
    if (etag) {
      responseHeaders.etag = etag;
      if (String(options.request?.headers?.["if-none-match"] || "") === etag) {
        res.writeHead(304, responseHeaders);
        res.end();
        return;
      }
    }
    if (sizeBytes !== null) responseHeaders["content-length"] = sizeBytes;
    res.writeHead(200, responseHeaders);
    responseStarted = true;
    if (String(options.request?.method || "GET").toUpperCase() === "HEAD" || sizeBytes === 0) {
      res.end();
      return;
    }
    const stream = await streamFromDrive(reference.fileId, options);
    if (typeof res.write === "function" && typeof res.on === "function") {
      await pipeline(stream, res);
    } else {
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      res.end(Buffer.concat(chunks));
    }
  } catch (error) {
    if (error.code === "ENOENT" && !responseStarted) return sendNotFound(res, options);
    if (responseStarted) return res.destroy?.(error);
    throw error;
  }
}

export async function getUploadMetadata(uploadPath, options = {}) {
  if (backendForPath(uploadPath) === "local") {
    return getLocalUploadMetadata(uploadPath, { ...options, root: resolveUploadRoot(options) });
  }
  const reference = parseDriveUploadPath(uploadPath);
  if (!reference) return null;
  const metadata = await statDriveFile(reference.fileId, options);
  if (!metadata) return null;
  return { sizeBytes: numericSize(metadata.size, 0), modifiedTime: metadata.modifiedTime || null };
}

export async function deleteUploadFile(uploadPath, options = {}) {
  if (backendForPath(uploadPath) === "local") {
    return deleteLocalUploadFile(uploadPath, { ...options, root: resolveUploadRoot(options) });
  }
  const reference = parseDriveUploadPath(uploadPath);
  if (!reference) return false;
  return deleteFromDrive(reference.fileId, options);
}

export async function inspectUploadIntegrity(options = {}) {
  const now = Date.now();
  const ttlMs = positiveInteger(options.cacheTtlMs ?? process.env.UPLOAD_INTEGRITY_CACHE_TTL_MS, DEFAULT_INTEGRITY_CACHE_TTL_MS);
  if (!options.force && integrityCache.result && now - integrityCache.checkedAt < ttlMs) return integrityCache.result;

  const references = options.references || await loadUploadReferences();
  let available = 0;
  let missing = 0;
  for (const uploadPath of references) {
    if (await getUploadMetadata(uploadPath, options)) available += 1;
    else missing += 1;
  }

  const backend = configuredUploadStorageBackend(options);
  let identityMatches = false;
  if (activeStorageIdentity && activeIdentityBackend === backend) {
    identityMatches = backend === "drive"
      ? await readDriveUploadStorageIdentity(options) === activeStorageIdentity
      : await inspectLocalUploadStorageIdentity(activeStorageIdentity, { ...options, root: resolveUploadRoot(options) });
  }
  const result = Object.freeze({
    ok: identityMatches && missing === 0,
    identity: identityMatches,
    referenced: references.length,
    available,
    missing
  });
  integrityCache.checkedAt = now;
  integrityCache.result = result;
  return result;
}

export function parseDriveUploadPath(uploadPath = "") {
  const match = String(uploadPath).match(/^\/uploads\/drive\/([A-Za-z0-9_-]+)\/([^/]+)$/);
  if (!match) return null;
  try {
    return { fileId: match[1], fileName: decodeURIComponent(match[2]) };
  } catch {
    return null;
  }
}

async function validateBeforeDriveUpload(content, options) {
  const directory = await mkdtemp(join(tmpdir(), "almox-drive-upload-"));
  const tempPath = join(directory, `${randomUUID()}-${String(options.fileName || "upload").replace(/[^A-Za-z0-9._-]/g, "_")}`);
  try {
    await createPrivateFile(tempPath, content, { root: directory, mode: 0o600, sync: true });
    const validationError = await persistedPdfValidationError(tempPath, content, { timeoutMs: pdfValidationTimeout(options) });
    if (validationError) throw validationFailure(validationError);
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => null);
  }
}

function databaseIdentityCallbacks(key, options, callbackOptions = {}) {
  if (options.loadDatabaseIdentity || options.claimDatabaseIdentity) {
    if (typeof options.loadDatabaseIdentity !== "function" || typeof options.claimDatabaseIdentity !== "function") {
      throw new TypeError("Os dois callbacks de identidade do banco devem ser informados juntos.");
    }
    return {
      loadDatabaseIdentity: options.loadDatabaseIdentity,
      claimDatabaseIdentity: options.claimDatabaseIdentity,
      loadPreviousDatabaseIdentity: typeof options.loadPreviousDatabaseIdentity === "function"
        ? options.loadPreviousDatabaseIdentity
        : async () => "",
      migrateDatabaseIdentity: options.migrateDatabaseIdentity
    };
  }
  if (!databaseConfigured()) {
    return {
      loadDatabaseIdentity: async () => volatileDatabaseIdentities.get(key) || "",
      loadPreviousDatabaseIdentity: async () => callbackOptions.previousKey
        ? volatileDatabaseIdentities.get(callbackOptions.previousKey) || ""
        : "",
      claimDatabaseIdentity: async (identity) => {
        if (!volatileDatabaseIdentities.has(key)) volatileDatabaseIdentities.set(key, identity);
        return volatileDatabaseIdentities.get(key);
      },
      migrateDatabaseIdentity: async (expectedIdentity, identity) => {
        const current = volatileDatabaseIdentities.get(key) || "";
        if (current === expectedIdentity) volatileDatabaseIdentities.set(key, identity);
        return volatileDatabaseIdentities.get(key) || "";
      }
    };
  }
  return {
    loadDatabaseIdentity: () => loadPersistedIdentity(key),
    loadPreviousDatabaseIdentity: () => callbackOptions.previousKey
      ? loadPersistedIdentity(callbackOptions.previousKey)
      : "",
    claimDatabaseIdentity: async (identity) => {
      await query(`
        INSERT INTO app_settings (key, value, updated_at)
        VALUES ($1, $2::jsonb, now())
        ON CONFLICT (key) DO NOTHING
      `, [key, JSON.stringify({ id: identity })]);
      const result = await query("SELECT value FROM app_settings WHERE key = $1 LIMIT 1", [key]);
      return result.rows[0]?.value?.id || "";
    },
    migrateDatabaseIdentity: async (expectedIdentity, identity) => {
      const migrated = await query(`
        UPDATE app_settings
        SET value = $3::jsonb, updated_at = now()
        WHERE key = $1 AND value->>'id' = $2
        RETURNING value
      `, [key, expectedIdentity, JSON.stringify({
        id: identity,
        migratedFrom: expectedIdentity,
        migratedAt: new Date().toISOString()
      })]);
      if (migrated.rows[0]?.value?.id) return migrated.rows[0].value.id;
      return loadPersistedIdentity(key);
    }
  };
}

async function loadPersistedIdentity(key) {
  const result = await query("SELECT value FROM app_settings WHERE key = $1 LIMIT 1", [key]);
  return result.rows[0]?.value?.id || "";
}

function updateUploadStorageReadiness(values) {
  uploadStorageReadiness = Object.freeze({ ...uploadStorageReadiness, ready: false, ...values });
}

function emit(options, event, data) {
  if (typeof options.onEvent === "function") options.onEvent(event, data);
}

function maskIdentifier(value) {
  const identifier = String(value || "").trim();
  if (identifier.length <= 8) return identifier ? `${identifier.slice(0, 2)}...${identifier.slice(-2)}` : "";
  return `${identifier.slice(0, 4)}...${identifier.slice(-4)}`;
}

function safeAccountIdentifier(account = {}) {
  const email = String(account.emailAddress || "").trim();
  if (email.includes("@")) {
    const [local, domain] = email.split("@", 2);
    return `${local.slice(0, 2)}***@${domain}`;
  }
  return maskIdentifier(account.permissionId || account.displayName || "autenticada");
}

async function loadUploadReferences() {
  const [processStore, settingsStore] = await Promise.all([readProcessesStore(), readSettingsStore()]);
  const references = new Map();
  const add = (value) => {
    const path = String(typeof value === "string" ? value : value?.path || "");
    const comparablePath = comparableUploadPath(path);
    if (comparablePath && !references.has(comparablePath)) references.set(comparablePath, path);
  };
  for (const processo of processStore.processos || []) {
    for (const value of Object.values(processo.documentos || {})) {
      if (Array.isArray(value)) value.forEach(add);
      else add(value);
    }
  }
  for (const template of Object.values(settingsStore.configuracoes?.emailTemplates || {})) {
    for (const attachment of template.anexos || []) add(attachment);
  }
  return [...references.values()];
}

function comparableUploadPath(value) {
  const path = String(value || "");
  if (!path.startsWith("/uploads/") || path.includes("\0")) return "";
  try {
    return decodeURIComponent(path).normalize("NFC");
  } catch {
    return "";
  }
}

function resolveUploadRoot(options = {}) {
  return resolve(options.root || process.env.UPLOAD_STORAGE_ROOT || DEFAULT_UPLOAD_ROOT);
}

function pdfValidationTimeout(options) {
  return positiveInteger(options.pdfCommandTimeoutMs ?? process.env.PDF_COMMAND_TIMEOUT_MS, 10_000);
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function numericSize(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function driveEtag(metadata) {
  if (metadata.md5Checksum) return `"${metadata.md5Checksum}"`;
  if (metadata.size && metadata.modifiedTime) {
    return `W/"${Number(metadata.size).toString(16)}-${Date.parse(metadata.modifiedTime).toString(16)}"`;
  }
  return "";
}

function validationFailure(validationError) {
  const error = new Error(validationError.message || "O arquivo enviado e invalido.");
  error.statusCode = validationError.statusCode || 400;
  error.code = "UPLOAD_VALIDATION_FAILED";
  return error;
}

function invalidUploadPathError() {
  const error = new Error("Caminho de upload invalido.");
  error.statusCode = 403;
  error.code = "UNSAFE_FILE_PATH";
  return error;
}

function sendNotFound(res, options) {
  const statusCode = options.notFoundStatus || 404;
  if (options.notFoundMessage) {
    const body = JSON.stringify({ error: options.notFoundMessage });
    res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
    res.end(body);
  } else {
    res.writeHead(statusCode, { "content-type": "text/plain; charset=utf-8" });
    res.end("Arquivo nao encontrado");
  }
  return null;
}
