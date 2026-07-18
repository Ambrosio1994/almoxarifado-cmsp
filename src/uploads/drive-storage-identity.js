import { randomUUID } from "node:crypto";
import { downloadFromDrive, findFileInFolder, uploadToDrive } from "./drive-storage.js";

export const DRIVE_UPLOAD_STORAGE_MARKER_NAME = ".almoxarifado-storage.json";
export const DRIVE_UPLOAD_STORAGE_DATABASE_KEY = "uploadStorageIdentityDrive";
const MARKER_VERSION = 1;
const MAX_MARKER_BYTES = 1_024;

export async function ensureDriveUploadStorageIdentity(options = {}) {
  if (typeof options.loadDatabaseIdentity !== "function" || typeof options.claimDatabaseIdentity !== "function") {
    throw new TypeError("Os callbacks de identidade do banco sao obrigatorios.");
  }

  let markerId = await findFileInFolder(DRIVE_UPLOAD_STORAGE_MARKER_NAME, options);
  let markerIdentity = markerId ? await readDriveMarker(markerId, options) : "";
  const databaseIdentity = normalizeIdentity(await options.loadDatabaseIdentity());

  if (databaseIdentity && !markerIdentity) {
    throw storageIdentityError("O banco reconhece outra pasta do Drive, mas o marcador nao existe na pasta configurada.");
  }
  if (databaseIdentity && markerIdentity && databaseIdentity !== markerIdentity) {
    throw storageIdentityError("A identidade da pasta do Drive difere da identidade registrada no banco.");
  }

  if (!markerIdentity) {
    markerIdentity = randomUUID();
    const content = Buffer.from(`${JSON.stringify({ version: MARKER_VERSION, id: markerIdentity })}\n`);
    await uploadToDrive(content, {
      ...options,
      name: DRIVE_UPLOAD_STORAGE_MARKER_NAME,
      mimeType: "application/json"
    });
  }

  const claimedIdentity = normalizeIdentity(await options.claimDatabaseIdentity(markerIdentity));
  if (!claimedIdentity || claimedIdentity !== markerIdentity) {
    throw storageIdentityError("Nao foi possivel vincular com seguranca a pasta do Drive ao banco.");
  }
  return markerIdentity;
}

export async function readDriveUploadStorageIdentity(options = {}) {
  const markerId = await findFileInFolder(DRIVE_UPLOAD_STORAGE_MARKER_NAME, options);
  return markerId ? readDriveMarker(markerId, options) : "";
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

function normalizeIdentity(value, options = {}) {
  const identity = String(value || "").trim();
  if (!identity && !options.required) return "";
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(identity)) {
    throw storageIdentityError("Identidade invalida do armazenamento de uploads do Drive.");
  }
  return identity.toLowerCase();
}

function storageIdentityError(message) {
  const error = new Error(message);
  error.code = "UPLOAD_STORAGE_IDENTITY_MISMATCH";
  return error;
}
