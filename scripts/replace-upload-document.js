import { lstat, readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { closePool, databaseConfigured, query, transaction } from "../src/db/postgres.js";
import {
  getDriveClient,
  listFilesByAppProperty,
  statDriveFile,
  uploadToDrive,
  validateDriveConfiguration,
  verifyDriveFolderAccess
} from "../src/uploads/drive-storage.js";
import { persistedPdfValidationError } from "../src/uploads/pdf-validation.js";
import { commitDocumentReplacement, replaceUploadDocument } from "../src/uploads/replace-upload-document.js";

export function parseReplaceDocumentArgs(argv) {
  const options = { dryRun: false, confirm: false, allowPaid: false };
  const values = new Map([
    ["--process-id", "processId"],
    ["--document-key", "documentKey"],
    ["--file", "filePath"],
    ["--technical-user", "technicalUser"],
    ["--reason", "reason"]
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--confirm") options.confirm = true;
    else if (argument === "--allow-paid") options.allowPaid = true;
    else if (values.has(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} exige um valor.`);
      options[values.get(argument)] = value;
      index += 1;
    } else {
      throw new Error(`Argumento desconhecido: ${argument}`);
    }
  }
  options.technicalUser = String(options.technicalUser || process.env.STORAGE_REPAIR_TECHNICAL_USER || "storage-repair-cli").trim();
  options.reason = String(options.reason || "Substituicao administrativa de upload local ausente").trim();
  return options;
}

export async function runReplaceDocumentCli(argv = process.argv.slice(2), overrides = {}) {
  const options = parseReplaceDocumentArgs(argv);
  if (!databaseConfigured()) throw new Error("DATABASE_URL e obrigatoria.");
  validateDriveConfiguration();
  const drive = overrides.drive || getDriveClient();
  const dependencies = {
    loadProcess: async (id) => (await query("SELECT data FROM app_processes WHERE id = $1 LIMIT 1", [id])).rows[0]?.data || null,
    readPdf: readAndValidatePdf,
    verifyDriveFolderAccess: () => verifyDriveFolderAccess({ client: drive }),
    listRepairFiles: (key, value) => listFilesByAppProperty(key, value, { client: drive }),
    uploadToDrive: (content, uploadOptions) => uploadToDrive(content, { ...uploadOptions, client: drive }),
    statDriveFile: (fileId) => statDriveFile(fileId, { client: drive }),
    commitReplacement: (change) => commitDocumentReplacement(change, transaction),
    ...overrides.dependencies
  };
  const result = await replaceUploadDocument(options, dependencies);
  console.log(JSON.stringify({ event: "upload_document_replacement", ...result }));
  return result;
}

async function readAndValidatePdf(filePath) {
  const absolutePath = resolve(String(filePath || ""));
  const metadata = await lstat(absolutePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("--file deve apontar para um arquivo regular, nao simbolico.");
  const content = await readFile(absolutePath);
  const validationError = await persistedPdfValidationError(absolutePath, content);
  return { content, fileName: basename(absolutePath), validationError };
}

function safeError(error) {
  return {
    event: "upload_document_replacement_failed",
    code: String(error?.code || "UNKNOWN").slice(0, 80),
    message: String(error?.message || "Erro desconhecido").replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[database-url-redacted]").slice(0, 500)
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  try {
    await runReplaceDocumentCli();
  } catch (error) {
    console.error(JSON.stringify(safeError(error)));
    process.exitCode = 1;
  } finally {
    await closePool().catch(() => null);
  }
}
