import { Readable } from "node:stream";
import { google } from "googleapis";

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";

export function getDriveClient(options = {}) {
  const credentials = resolveCredentials(options);
  const auth = new google.auth.GoogleAuth({ credentials, scopes: [DRIVE_SCOPE] });
  return google.drive({ version: "v3", auth });
}

export async function uploadToDrive(content, options = {}) {
  const folderId = resolveFolderId(options);
  const drive = options.client || getDriveClient(options);
  const name = String(options.name || options.fileName || "").trim();
  if (!name) throw new TypeError("O nome do arquivo no Drive e obrigatorio.");
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content || "");
  const response = await drive.files.create({
    requestBody: {
      name,
      parents: [folderId]
    },
    media: {
      mimeType: options.mimeType || "application/octet-stream",
      body: Readable.from(buffer)
    },
    fields: "id, name, size, mimeType, modifiedTime, md5Checksum",
    supportsAllDrives: true
  });
  if (!response.data.id) throw new Error("O Drive nao retornou o ID do arquivo enviado.");
  return response.data;
}

export async function downloadFromDrive(fileId, options = {}) {
  const stream = await streamFromDrive(fileId, options);
  const maximumBytes = normalizeMaximumBytes(options.maximumBytes);
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maximumBytes) {
      stream.destroy?.();
      const error = new Error(`O arquivo excede o limite de ${maximumBytes} bytes.`);
      error.code = "FILE_SIZE_LIMIT";
      error.statusCode = 413;
      throw error;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total);
}

export async function streamFromDrive(fileId, options = {}) {
  const drive = options.client || getDriveClient(options);
  try {
    const response = await drive.files.get({
      fileId: requireFileId(fileId),
      alt: "media",
      supportsAllDrives: true
    }, { responseType: "stream" });
    return response.data;
  } catch (error) {
    throw normalizeDriveError(error);
  }
}

export async function deleteFromDrive(fileId, options = {}) {
  const drive = options.client || getDriveClient(options);
  try {
    await drive.files.delete({ fileId: requireFileId(fileId), supportsAllDrives: true });
    return true;
  } catch (error) {
    if (driveErrorStatus(error) === 404) return false;
    throw normalizeDriveError(error);
  }
}

export async function statDriveFile(fileId, options = {}) {
  const drive = options.client || getDriveClient(options);
  try {
    const response = await drive.files.get({
      fileId: requireFileId(fileId),
      fields: "id, name, size, mimeType, modifiedTime, md5Checksum, trashed",
      supportsAllDrives: true
    });
    if (response.data.trashed) return null;
    return response.data;
  } catch (error) {
    if (driveErrorStatus(error) === 404) return null;
    throw normalizeDriveError(error);
  }
}

export async function verifyDriveFolderAccess(options = {}) {
  const folderId = resolveFolderId(options);
  const drive = options.client || getDriveClient(options);
  try {
    const response = await drive.files.get({
      fileId: folderId,
      fields: "id, name, mimeType, trashed, capabilities(canAddChildren)",
      supportsAllDrives: true
    });
    if (response.data.trashed || response.data.mimeType !== "application/vnd.google-apps.folder") {
      throw new Error("GOOGLE_DRIVE_FOLDER_ID nao aponta para uma pasta ativa do Drive.");
    }
    if (response.data.capabilities?.canAddChildren === false) {
      throw new Error("A service account nao pode adicionar arquivos na pasta configurada.");
    }
    return response.data;
  } catch (error) {
    throw normalizeDriveError(error);
  }
}

export async function findFileInFolder(name, options = {}) {
  const folderId = resolveFolderId(options);
  const drive = options.client || getDriveClient(options);
  const response = await drive.files.list({
    q: `name='${escapeDriveQueryValue(name)}' and '${escapeDriveQueryValue(folderId)}' in parents and trashed=false`,
    fields: "files(id, name)",
    spaces: "drive",
    pageSize: 1,
    includeItemsFromAllDrives: true,
    supportsAllDrives: true
  });
  return response.data.files?.[0]?.id || null;
}

export function escapeDriveQueryValue(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

export function resolveFolderId(options = {}) {
  const folderId = String(options.folderId || process.env.GOOGLE_DRIVE_FOLDER_ID || "").trim();
  if (!folderId) throw new Error("GOOGLE_DRIVE_FOLDER_ID e obrigatoria para o backend Drive.");
  return folderId;
}

function resolveCredentials(options = {}) {
  const raw = options.credentials || process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY e obrigatoria para o backend Drive.");
  if (typeof raw === "object") return raw;
  try {
    const credentials = JSON.parse(String(raw));
    if (credentials.private_key) credentials.private_key = credentials.private_key.replace(/\\n/g, "\n");
    return credentials;
  } catch (error) {
    const wrapped = new Error("GOOGLE_SERVICE_ACCOUNT_KEY nao contem um JSON valido.");
    wrapped.cause = error;
    throw wrapped;
  }
}

function requireFileId(value) {
  const fileId = String(value || "").trim();
  if (!/^[A-Za-z0-9_-]+$/.test(fileId)) throw new TypeError("ID de arquivo do Drive invalido.");
  return fileId;
}

function driveErrorStatus(error) {
  return Number(error?.response?.status || error?.code || 0);
}

function normalizeDriveError(error) {
  if (driveErrorStatus(error) === 404) {
    const notFound = new Error("Arquivo nao encontrado no Drive.");
    notFound.code = "ENOENT";
    notFound.cause = error;
    return notFound;
  }
  return error;
}

function normalizeMaximumBytes(value) {
  if (value === undefined) return Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("maximumBytes deve ser um inteiro nao negativo.");
  return value;
}
