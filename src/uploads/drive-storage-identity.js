import { createHash } from "node:crypto";
import { downloadFromDrive, findFileInFolder, listFilesInFolder, resolveFolderId, uploadToDrive } from "./drive-storage.js";

export const DRIVE_UPLOAD_STORAGE_MARKER_NAME = ".almoxarifado-storage.json";
export const DRIVE_UPLOAD_STORAGE_DATABASE_KEY = "uploadStorageIdentityDrive";
const MARKER_VERSION = 1;
const MAX_MARKER_BYTES = 1_024;

export async function ensureDriveUploadStorageIdentity(options = {}) {
  requireIdentityCallbacks(options);
  const snapshot = await inspectDriveUploadStorageIdentity(options);
  emit(options, "upload_storage_identity_current", {
    backend: "drive",
    databaseIdentity: snapshot.databaseIdentity || null,
    markerIdentity: snapshot.markerIdentity || null,
    previousBackendIdentity: snapshot.previousBackendIdentity || null,
    migrationRequired: snapshot.migrationRequired
  });

  if (snapshot.compatible) {
    const claimedIdentity = normalizeIdentity(await options.claimDatabaseIdentity(snapshot.markerIdentity));
    if (claimedIdentity !== snapshot.markerIdentity) throw claimError();
    warnIfMigrationFlagRemainsEnabled(options, snapshot.markerIdentity);
    return snapshot.markerIdentity;
  }

  if (!snapshot.migrationRequired) {
    const markerIdentity = snapshot.markerIdentity || await createDriveMarker(
      deterministicFolderIdentity(resolveFolderId(options)),
      options
    );
    const claimedIdentity = normalizeIdentity(await options.claimDatabaseIdentity(markerIdentity));
    if (claimedIdentity !== markerIdentity) throw claimError();
    return markerIdentity;
  }

  if (!identityMigrationAllowed(options)) {
    throw migrationRequiredError(snapshot);
  }

  const oldIdentity = snapshot.databaseIdentity || snapshot.previousBackendIdentity;
  const newIdentity = snapshot.markerIdentity || deterministicFolderIdentity(resolveFolderId(options));
  emit(options, "upload_storage_identity_migration_started", {
    backend: "drive",
    oldIdentity,
    newIdentity
  });

  const markerIdentity = snapshot.markerIdentity || await createDriveMarker(newIdentity, options);
  let storedIdentity;
  if (snapshot.databaseIdentity && snapshot.databaseIdentity !== markerIdentity) {
    if (typeof options.migrateDatabaseIdentity !== "function") {
      throw new TypeError("O callback de migracao da identidade do banco e obrigatorio.");
    }
    storedIdentity = normalizeIdentity(await options.migrateDatabaseIdentity(snapshot.databaseIdentity, markerIdentity));
  } else {
    storedIdentity = normalizeIdentity(await options.claimDatabaseIdentity(markerIdentity));
  }
  if (storedIdentity !== markerIdentity) throw claimError();

  emit(options, "upload_storage_identity_migration_completed", {
    backend: "drive",
    oldIdentity,
    newIdentity: markerIdentity
  });
  return markerIdentity;
}

export async function inspectDriveUploadStorageIdentity(options = {}) {
  if (typeof options.loadDatabaseIdentity !== "function") {
    throw new TypeError("O callback de leitura da identidade do banco e obrigatorio.");
  }
  const markers = await listFilesInFolder(DRIVE_UPLOAD_STORAGE_MARKER_NAME, options);
  const markerIdentities = await Promise.all(markers.map((marker) => readDriveMarker(marker.id, options)));
  if (new Set(markerIdentities).size > 1) {
    throw storageIdentityError("A pasta do Drive contem marcadores de identidade conflitantes.");
  }
  const markerIdentity = markerIdentities[0] || "";
  const databaseIdentity = normalizeIdentity(await options.loadDatabaseIdentity());
  const previousBackendIdentity = normalizeIdentity(
    typeof options.loadPreviousDatabaseIdentity === "function"
      ? await options.loadPreviousDatabaseIdentity()
      : ""
  );
  const compatible = Boolean(databaseIdentity && markerIdentity && databaseIdentity === markerIdentity);
  const migrationRequired = Boolean(
    (databaseIdentity && databaseIdentity !== markerIdentity)
    || (!databaseIdentity && previousBackendIdentity)
  );
  return Object.freeze({
    databaseIdentity,
    markerIdentity,
    previousBackendIdentity,
    compatible,
    migrationRequired
  });
}

export async function readDriveUploadStorageIdentity(options = {}) {
  const markerId = await findFileInFolder(DRIVE_UPLOAD_STORAGE_MARKER_NAME, options);
  return markerId ? readDriveMarker(markerId, options) : "";
}

async function createDriveMarker(identity, options) {
  const normalizedIdentity = normalizeIdentity(identity, { required: true });
  const content = Buffer.from(`${JSON.stringify({ version: MARKER_VERSION, id: normalizedIdentity })}\n`);
  const marker = await uploadToDrive(content, {
    ...options,
    name: DRIVE_UPLOAD_STORAGE_MARKER_NAME,
    mimeType: "application/json"
  });
  const persistedIdentity = await readDriveMarker(marker.id, options);
  if (persistedIdentity !== normalizedIdentity) {
    throw storageIdentityError("O marcador criado na pasta do Drive nao preservou a identidade esperada.");
  }
  return persistedIdentity;
}

async function readDriveMarker(markerId, options) {
  try {
    const content = await downloadFromDrive(markerId, { ...options, maximumBytes: MAX_MARKER_BYTES });
    const marker = JSON.parse(content.toString("utf8"));
    if (marker?.version !== MARKER_VERSION) throw storageIdentityError("Versao invalida do marcador de uploads do Drive.");
    return normalizeIdentity(marker.id, { required: true });
  } catch (error) {
    if (error instanceof SyntaxError) throw storageIdentityError("O marcador da pasta do Drive esta corrompido.");
    throw error;
  }
}

function deterministicFolderIdentity(folderId) {
  const digest = createHash("sha256").update(`almoxarifado-drive-folder:${folderId}`).digest();
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function identityMigrationAllowed(options) {
  const value = options.allowIdentityMigration ?? process.env.UPLOAD_STORAGE_ALLOW_IDENTITY_MIGRATION;
  return value === true || String(value || "").trim().toLowerCase() === "true";
}

function migrationRequiredError(snapshot) {
  const message = snapshot.databaseIdentity
    ? snapshot.markerIdentity
      ? "A identidade da pasta do Drive difere da identidade registrada no banco."
      : "O banco reconhece outra pasta do Drive, mas o marcador nao existe na pasta configurada."
    : "O banco reconhece o backend anterior e a migracao para o Drive ainda nao foi autorizada.";
  const error = storageIdentityError(`${message} Defina UPLOAD_STORAGE_ALLOW_IDENTITY_MIGRATION=true somente para a migracao controlada.`);
  error.migrationRequired = true;
  return error;
}

function warnIfMigrationFlagRemainsEnabled(options, identity) {
  if (!identityMigrationAllowed(options)) return;
  emit(options, "upload_storage_identity_migration_flag_still_enabled", {
    backend: "drive",
    identity
  });
}

function requireIdentityCallbacks(options) {
  if (typeof options.loadDatabaseIdentity !== "function" || typeof options.claimDatabaseIdentity !== "function") {
    throw new TypeError("Os callbacks de identidade do banco sao obrigatorios.");
  }
}

function emit(options, event, data) {
  if (typeof options.onEvent === "function") options.onEvent(event, data);
}

function normalizeIdentity(value, options = {}) {
  const identity = String(value || "").trim();
  if (!identity && !options.required) return "";
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(identity)) {
    throw storageIdentityError("Identidade invalida do armazenamento de uploads do Drive.");
  }
  return identity.toLowerCase();
}

function claimError() {
  return storageIdentityError("Nao foi possivel vincular com seguranca a pasta do Drive ao banco.");
}

function storageIdentityError(message) {
  const error = new Error(message);
  error.code = "UPLOAD_STORAGE_IDENTITY_MISMATCH";
  return error;
}
