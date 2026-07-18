import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  createPrivateFile,
  readRegularFileLimited
} from "../security/private-files.js";

export const UPLOAD_STORAGE_MARKER_NAME = ".almoxarifado-storage.json";
const MARKER_VERSION = 1;
const MAX_MARKER_BYTES = 1_024;

export async function ensureUploadStorageIdentity(options = {}) {
  const root = options.root;
  if (!root) throw new TypeError("A raiz de uploads e obrigatoria.");
  if (typeof options.loadDatabaseIdentity !== "function" || typeof options.claimDatabaseIdentity !== "function") {
    throw new TypeError("Os callbacks de identidade do banco sao obrigatorios.");
  }

  let markerIdentity = await readUploadStorageIdentity(root);
  const databaseIdentity = normalizeIdentity(await options.loadDatabaseIdentity());

  if (databaseIdentity && !markerIdentity) {
    throw storageIdentityError("O banco reconhece outro armazenamento, mas o marcador nao existe no volume montado.");
  }
  if (databaseIdentity && markerIdentity && databaseIdentity !== markerIdentity) {
    throw storageIdentityError("A identidade do volume de uploads difere da identidade registrada no banco.");
  }

  if (!markerIdentity) {
    const candidate = randomUUID();
    try {
      await writeUploadStorageIdentity(root, candidate);
      markerIdentity = candidate;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      markerIdentity = await readUploadStorageIdentity(root);
    }
  }

  const claimedIdentity = normalizeIdentity(await options.claimDatabaseIdentity(markerIdentity));
  if (!claimedIdentity || claimedIdentity !== markerIdentity) {
    throw storageIdentityError("Nao foi possivel vincular com seguranca o volume de uploads ao banco.");
  }
  return markerIdentity;
}

export async function readUploadStorageIdentity(root) {
  try {
    const { content } = await readRegularFileLimited(join(root, UPLOAD_STORAGE_MARKER_NAME), {
      root,
      mode: 0o600,
      maximumBytes: MAX_MARKER_BYTES
    });
    const marker = JSON.parse(content.toString("utf8"));
    if (marker?.version !== MARKER_VERSION) throw storageIdentityError("Versao invalida do marcador de uploads.");
    return normalizeIdentity(marker.id, { required: true });
  } catch (error) {
    if (error.code === "ENOENT") return "";
    if (error instanceof SyntaxError) throw storageIdentityError("O marcador do volume de uploads esta corrompido.");
    throw error;
  }
}

async function writeUploadStorageIdentity(root, identity) {
  const content = Buffer.from(`${JSON.stringify({ version: MARKER_VERSION, id: normalizeIdentity(identity, { required: true }) })}\n`);
  await createPrivateFile(join(root, UPLOAD_STORAGE_MARKER_NAME), content, {
    root,
    mode: 0o600,
    sync: true
  });
}

function normalizeIdentity(value, options = {}) {
  const identity = String(value || "").trim();
  if (!identity && !options.required) return "";
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(identity)) {
    throw storageIdentityError("Identidade invalida do armazenamento de uploads.");
  }
  return identity.toLowerCase();
}

function storageIdentityError(message) {
  const error = new Error(message);
  error.code = "UPLOAD_STORAGE_IDENTITY_MISMATCH";
  return error;
}
