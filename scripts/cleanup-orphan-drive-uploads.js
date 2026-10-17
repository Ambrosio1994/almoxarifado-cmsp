import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { closePool } from "../src/db/postgres.js";
import { detectStoreBackend, readStore } from "../src/storage.js";
import {
  deleteFromDrive,
  getDriveClient,
  listFolderFiles,
  resolveFolderId
} from "../src/uploads/drive-storage.js";
import { DRIVE_UPLOAD_STORAGE_MARKER_NAME } from "../src/uploads/drive-storage-identity.js";
import { configuredUploadStorageBackend } from "../src/uploads/upload-storage.js";

// Varredura de orfaos do backend Drive.
//
// No backend Drive cada upload vira um arquivo filho direto da pasta raiz
// (GOOGLE_DRIVE_FOLDER_ID) e o caminho publico embute o proprio id do arquivo
// (/uploads/drive/<fileId>/<nome>). Assim, o conjunto de arquivos referenciados
// e exatamente o conjunto de ids extraidos dos caminhos armazenados no banco.
//
// O modo padrao e somente leitura (dry-run). Excluir exige --apply e
// --confirm-delete-orphans, e em producao exige --confirm-backup.

const DRIVE_PATH_PREFIX = "/uploads/drive/";
const DRIVE_FILE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const DEFAULT_GRACE_MS = 86_400_000;

export function referencedDriveFileIds(store) {
  const ids = new Set();
  const add = (value) => {
    const path = String(typeof value === "string" ? value : value?.path || "");
    if (path.startsWith(DRIVE_PATH_PREFIX)) {
      const fileId = path.slice(DRIVE_PATH_PREFIX.length).split("/")[0];
      if (DRIVE_FILE_ID_PATTERN.test(fileId)) ids.add(fileId);
      return;
    }
    if (value && typeof value === "object" && value.backend === "drive") {
      const fileId = String(value.fileId || "");
      if (DRIVE_FILE_ID_PATTERN.test(fileId)) ids.add(fileId);
    }
  };
  for (const processo of store?.processos || []) {
    for (const value of Object.values(processo?.documentos || {})) {
      if (Array.isArray(value)) value.forEach(add);
      else add(value);
    }
  }
  for (const template of Object.values(store?.configuracoes?.emailTemplates || {})) {
    (template?.anexos || []).forEach(add);
  }
  return ids;
}

export function classifyDriveOrphans(files, referencedIds, options = {}) {
  const now = options.now ?? Date.now();
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  const markerName = options.markerName || DRIVE_UPLOAD_STORAGE_MARKER_NAME;
  const referenced = referencedIds instanceof Set ? referencedIds : new Set(referencedIds || []);
  const present = new Set();
  const scanned = [];
  const orphans = [];
  const protectedByGrace = [];
  const folders = [];

  for (const file of files || []) {
    const id = String(file?.id || "");
    if (!id) continue;
    if (file.mimeType === "application/vnd.google-apps.folder") {
      folders.push(id);
      continue;
    }
    // Nunca considerar o marcador de identidade do armazenamento como orfao.
    if (String(file.name || "") === markerName) continue;
    scanned.push(id);
    present.add(id);
    if (referenced.has(id)) continue;
    const modified = Date.parse(String(file.modifiedTime || ""));
    // Arquivo sem data confiavel de modificacao nao e removido.
    if (Number.isFinite(modified) && now - modified >= graceMs) orphans.push(file);
    else protectedByGrace.push(file);
  }

  const missingReferences = [...referenced].filter((id) => !present.has(id));
  return { scanned, orphans, protectedByGrace, missingReferences, folders };
}

export async function runDriveUploadCleanup(options = {}) {
  const apply = Boolean(options.apply);
  const expectedBackend = String(
    options.expectedBackend || (process.env.NODE_ENV === "production" ? "postgres" : "json")
  );
  if (!["postgres", "json"].includes(expectedBackend)) {
    throw new Error("--expect-backend deve ser postgres ou json.");
  }
  const graceMs = options.graceMs
    ?? positiveInteger(process.env.ORPHAN_UPLOAD_GRACE_MS || String(DEFAULT_GRACE_MS), "ORPHAN_UPLOAD_GRACE_MS");

  const uploadBackend = options.uploadBackend || configuredUploadStorageBackend(options);
  if (uploadBackend !== "drive") {
    throw new Error(`A varredura de orfaos do Drive exige UPLOAD_STORAGE_BACKEND=drive (atual: ${uploadBackend}).`);
  }

  const backend = options.backend || await detectStoreBackend();
  if (backend !== expectedBackend) {
    throw new Error(`Backend ativo ${backend} difere do esperado ${expectedBackend}.`);
  }

  const store = options.store || await readStore();
  const folderId = resolveFolderId(options);
  const client = options.client || getDriveClient(options);
  const files = options.files || await listFolderFiles({ ...options, client, folderId });
  const referenced = referencedDriveFileIds(store);
  const classification = classifyDriveOrphans(files, referenced, {
    now: options.now,
    graceMs,
    markerName: options.markerName
  });

  const deleted = [];
  for (const file of classification.orphans) {
    if (!apply) continue;
    await deleteFromDrive(file.id, { ...options, client });
    deleted.push(String(file.id));
  }
  const orphanIds = classification.orphans.map((file) => String(file.id));

  return {
    backend,
    uploadBackend,
    folderId,
    referenced: referenced.size,
    scanned: classification.scanned.length,
    orphans: classification.orphans.length,
    missingReferences: classification.missingReferences.length,
    protectedByGrace: classification.protectedByGrace.length,
    folders: classification.folders.length,
    graceMs,
    applied: apply,
    deleted,
    orphanIds,
    orphanFiles: classification.orphans.map((file) => ({
      id: String(file.id),
      name: String(file.name || ""),
      modifiedTime: file.modifiedTime || null
    })),
    missingReferenceIds: classification.missingReferences
  };
}

async function main() {
  const apply = process.argv.includes("--apply");
  if (apply && !process.argv.includes("--confirm-delete-orphans")) {
    throw new Error("Use --confirm-delete-orphans para confirmar a exclusao.");
  }
  if (apply && process.env.NODE_ENV === "production" && !process.argv.includes("--confirm-backup")) {
    throw new Error("Em producao, confirme um backup verificado com --confirm-backup.");
  }

  try {
    const result = await runDriveUploadCleanup({
      apply,
      expectedBackend: optionValue("--expect-backend") || undefined
    });
    for (const file of result.orphanFiles) {
      console.log(`${apply ? "removido" : "orphan"}: ${file.id} ${file.name}`);
    }
    for (const id of result.missingReferenceIds) {
      console.log(`missing-reference: ${id}`);
    }
    console.log(JSON.stringify({
      backend: result.backend,
      uploadBackend: result.uploadBackend,
      folder: result.folderId,
      referenced: result.referenced,
      scanned: result.scanned,
      orphans: result.orphans,
      missingReferences: result.missingReferences,
      protectedByGrace: result.protectedByGrace,
      folders: result.folders,
      graceMs: result.graceMs,
      applied: result.applied
    }));
  } finally {
    await closePool();
  }
}

function optionValue(name) {
  const prefix = `${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length) || "";
}

function positiveInteger(value, name) {
  if (!/^\d+$/.test(value) || Number(value) <= 0 || !Number.isSafeInteger(Number(value))) {
    throw new Error(`${name} deve ser um inteiro positivo.`);
  }
  return Number(value);
}

function isMainModule() {
  return process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
}

if (isMainModule()) {
  await main();
}
