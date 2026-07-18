import { Readable } from "node:stream";
import { google } from "googleapis";

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";

export function getDriveClient(options = {}) {
  const credentials = resolveOAuthCredentials(options);
  const oauth2Client = new google.auth.OAuth2(credentials.clientId, credentials.clientSecret);
  oauth2Client.setCredentials({ refresh_token: credentials.refreshToken });
  return google.drive({ version: "v3", auth: oauth2Client });
}

export async function uploadToDrive(content, options = {}) {
  const folderId = resolveFolderId(options);
  const drive = options.client || getDriveClient(options);
  const name = String(options.name || options.fileName || "").trim();
  if (!name) throw new TypeError("O nome do arquivo no Drive e obrigatorio.");
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content || "");
  try {
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
  } catch (error) {
    throw wrapDriveError(error, "enviar arquivo");
  }
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
    const wrapped = wrapDriveError(error, "baixar arquivo");
    if (driveErrorStatus(error) === 404) {
      wrapped.code = "ENOENT";
      wrapped.statusCode = 404;
    }
    throw wrapped;
  }
}

export async function deleteFromDrive(fileId, options = {}) {
  const drive = options.client || getDriveClient(options);
  try {
    await drive.files.delete({ fileId: requireFileId(fileId), supportsAllDrives: true });
    return true;
  } catch (error) {
    if (driveErrorStatus(error) === 404) return false;
    throw wrapDriveError(error, "excluir arquivo");
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
    throw wrapDriveError(error, "consultar arquivo");
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
      throw new Error("A conta OAuth nao pode adicionar arquivos na pasta configurada.");
    }
    return response.data;
  } catch (error) {
    throw wrapDriveError(error, "verificar pasta");
  }
}

export async function findFileInFolder(name, options = {}) {
  const folderId = resolveFolderId(options);
  const drive = options.client || getDriveClient(options);
  try {
    const response = await drive.files.list({
      q: `name='${escapeDriveQueryValue(name)}' and '${escapeDriveQueryValue(folderId)}' in parents and trashed=false`,
      fields: "files(id, name)",
      spaces: "drive",
      pageSize: 1,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true
    });
    return response.data.files?.[0]?.id || null;
  } catch (error) {
    throw wrapDriveError(error, "listar arquivos");
  }
}

export function escapeDriveQueryValue(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

export function resolveFolderId(options = {}) {
  const folderId = String(options.folderId || process.env.GOOGLE_DRIVE_FOLDER_ID || "").trim();
  if (!folderId) throw new Error("GOOGLE_DRIVE_FOLDER_ID e obrigatoria para o backend Drive.");
  return folderId;
}

function resolveOAuthCredentials(options = {}) {
  const clientId = String(options.clientId || process.env.GOOGLE_CLIENT_ID || "").trim();
  const clientSecret = String(options.clientSecret || process.env.GOOGLE_CLIENT_SECRET || "").trim();
  const refreshToken = String(options.refreshToken || process.env.GOOGLE_REFRESH_TOKEN || "").trim();

  if (!clientId) throw new Error("GOOGLE_CLIENT_ID e obrigatoria para o backend Drive.");
  if (!clientSecret) throw new Error("GOOGLE_CLIENT_SECRET e obrigatoria para o backend Drive.");
  if (!refreshToken) throw new Error("GOOGLE_REFRESH_TOKEN e obrigatoria para o backend Drive.");

  return { clientId, clientSecret, refreshToken };
}

function requireFileId(value) {
  const fileId = String(value || "").trim();
  if (!/^[A-Za-z0-9_-]+$/.test(fileId)) throw new TypeError("ID de arquivo do Drive invalido.");
  return fileId;
}

function driveErrorStatus(error) {
  return Number(error?.response?.status || error?.code || 0);
}

function wrapDriveError(error, operation) {
  const status = error?.code || error?.response?.status || null;
  const reason = error?.response?.data?.error?.errors?.[0]?.reason || error?.errors?.[0]?.reason || null;
  const message = error?.response?.data?.error?.message || error?.message || "Erro desconhecido no Google Drive.";
  const wrapped = new Error(`Falha ao ${operation} no Google Drive: ${message}`);
  wrapped.code = status;
  wrapped.reason = reason;
  wrapped.cause = error;
  return wrapped;
}

function normalizeMaximumBytes(value) {
  if (value === undefined) return Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("maximumBytes deve ser um inteiro nao negativo.");
  return value;
}
