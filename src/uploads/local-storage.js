import { rm } from "node:fs/promises";
import { join, normalize, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import {
  createPrivateFile,
  hardenPrivateTree,
  openRegularFileNoFollow,
  privateFileMetadata,
  readRegularFileLimited,
  UnsafeFilePathError
} from "../security/private-files.js";
import { ensureUploadStorageIdentity, readUploadStorageIdentity } from "./storage-identity.js";

export async function ensureLocalUploadStorageReady(options = {}) {
  const root = requireRoot(options);
  await hardenPrivateTree(root);
  return ensureUploadStorageIdentity({ ...options, root });
}

export async function putLocalUploadFile(content, options = {}) {
  const root = requireRoot(options);
  const relativeDirectory = localDirectory(options);
  const fileName = requireFileName(options.fileName);
  const fullPath = join(root, relativeDirectory, fileName);
  await createPrivateFile(fullPath, content, { root, mode: 0o600, sync: true });
  try {
    if (typeof options.validatePersistedFile === "function") {
      const validationError = await options.validatePersistedFile(fullPath, content);
      if (validationError) throw validationFailure(validationError);
    }
  } catch (error) {
    await rm(fullPath, { force: true }).catch(() => null);
    throw error;
  }
  return {
    path: `/uploads/${relativeDirectory ? `${relativeDirectory}/` : ""}${encodeURIComponent(fileName)}`,
    sizeBytes: Buffer.byteLength(content)
  };
}

export async function getLocalUploadBuffer(uploadPath, maximumBytes, options = {}) {
  const fullPath = uploadReferenceFilePath(uploadPath, options);
  if (!fullPath) throw unsafeUploadPathError();
  return (await readRegularFileLimited(fullPath, {
    root: requireRoot(options),
    mode: 0o600,
    maximumBytes
  })).content;
}

export async function serveLocalUpload(res, uploadPath, headers = {}, options = {}) {
  const fullPath = uploadReferenceFilePath(uploadPath, options);
  if (!fullPath) throw unsafeUploadPathError();
  let opened;
  let responseStarted = false;
  try {
    opened = await openRegularFileNoFollow(fullPath, { root: requireRoot(options), mode: 0o600 });
    const metadata = opened.metadata;
    const responseHeaders = { ...headers };
    if (options.etag !== false) {
      responseHeaders.etag = `W/"${metadata.size.toString(16)}-${Math.trunc(metadata.mtimeMs).toString(16)}"`;
      if (String(options.request?.headers?.["if-none-match"] || "") === responseHeaders.etag) {
        res.writeHead(304, responseHeaders);
        res.end();
        return;
      }
    }
    res.writeHead(200, { ...responseHeaders, "content-length": metadata.size });
    responseStarted = true;
    if (String(options.request?.method || "GET").toUpperCase() === "HEAD" || metadata.size === 0) {
      res.end();
      return;
    }
    const stream = opened.handle.createReadStream({ autoClose: false, start: 0, end: metadata.size - 1 });
    if (typeof res.write === "function" && typeof res.on === "function") {
      await pipeline(stream, res);
    } else {
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      res.end(Buffer.concat(chunks));
    }
  } catch (error) {
    if (error.code === "ENOENT") return sendNotFound(res, options);
    if (error instanceof UnsafeFilePathError || error.code === "ELOOP") {
      const forbidden = new Error("Acesso negado");
      forbidden.statusCode = 403;
      throw forbidden;
    }
    if (responseStarted) return res.destroy?.(error);
    throw error;
  } finally {
    await opened?.handle.close().catch(() => null);
  }
}

export async function getLocalUploadMetadata(uploadPath, options = {}) {
  const fullPath = uploadReferenceFilePath(uploadPath, options);
  if (!fullPath) return null;
  try {
    const metadata = await privateFileMetadata(fullPath, { root: requireRoot(options), mode: 0o600 });
    return { sizeBytes: metadata.size, modifiedTime: metadata.mtime.toISOString() };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function deleteLocalUploadFile(uploadPath, options = {}) {
  const fullPath = uploadReferenceFilePath(uploadPath, options);
  if (!fullPath) return false;
  const metadata = await getLocalUploadMetadata(uploadPath, options);
  if (!metadata) return false;
  await rm(fullPath, { force: true });
  return true;
}

export function uploadReferenceFilePath(uploadPath = "", options = {}) {
  const path = String(uploadPath || "");
  if (!path.startsWith("/uploads/") || path.startsWith("/uploads/drive/") || path.includes("\0")) return "";
  let relativePath;
  try {
    relativePath = decodeURIComponent(path.replace(/^\/uploads\/+/, ""));
  } catch {
    return "";
  }
  const root = requireRoot(options);
  const fullPath = normalize(join(root, relativePath));
  return isPathWithin(root, fullPath) ? fullPath : "";
}

export async function inspectLocalUploadStorageIdentity(expectedIdentity, options = {}) {
  const markerIdentity = await readUploadStorageIdentity(requireRoot(options));
  return Boolean(expectedIdentity) && markerIdentity === expectedIdentity;
}

function localDirectory(options) {
  if (options.category) {
    const category = requirePathSegment(options.category);
    const scope = options.scope ? `/${requirePathSegment(options.scope)}` : "";
    return `${category}${scope}`;
  }
  return requirePathSegment(options.processId);
}

function requireRoot(options) {
  const root = String(options.root || "").trim();
  if (!root) throw new TypeError("A raiz local de uploads e obrigatoria.");
  return resolve(root);
}

function requirePathSegment(value) {
  const segment = String(value || "").trim();
  if (!segment || segment === "." || segment === ".." || /[\\/\0]/.test(segment)) {
    throw new TypeError("Segmento de caminho de upload invalido.");
  }
  return segment;
}

function requireFileName(value) {
  const name = String(value || "").trim();
  if (!name || name === "." || name === ".." || /[\\/\0]/.test(name)) throw new TypeError("Nome de upload invalido.");
  return name;
}

function isPathWithin(root, target) {
  const fromRoot = relative(resolve(root), resolve(target));
  return fromRoot === "" || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !fromRoot.startsWith(sep));
}

function validationFailure(validationError) {
  const error = new Error(validationError.message || "O arquivo enviado e invalido.");
  error.statusCode = validationError.statusCode || 400;
  error.code = "UPLOAD_VALIDATION_FAILED";
  return error;
}

function unsafeUploadPathError() {
  const error = new UnsafeFilePathError("Caminho de upload invalido.");
  error.statusCode = 403;
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
