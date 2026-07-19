import { createHash, randomUUID } from "node:crypto";
import { basename, extname } from "node:path";
import { parseDriveUploadPath } from "./upload-storage.js";

const REPAIR_PROPERTY = "almoxarifadoRepairKey";

export async function replaceUploadDocument(options, dependencies) {
  const processId = required(options.processId, "--process-id");
  const documentKey = required(options.documentKey, "--document-key");
  required(options.filePath, "--file");
  const technicalUser = required(options.technicalUser, "--technical-user");
  const reason = required(options.reason, "--reason");
  if (options.dryRun === options.confirm) throw new Error("Informe exatamente uma opcao: --dry-run ou --confirm.");

  const process = await dependencies.loadProcess(processId);
  if (!process) throw codedError("Processo nao encontrado.", "PROCESS_NOT_FOUND");
  if (String(process.status || "").trim().toLowerCase() === "pago" && !options.allowPaid) {
    throw codedError("O processo esta Pago. Use --allow-paid para uma correcao administrativa explicita.", "PAID_PROCESS_BLOCKED");
  }
  if (!Object.prototype.hasOwnProperty.call(process.documentos || {}, documentKey)) {
    throw codedError(`A chave ${documentKey} nao existe nos documentos do processo.`, "DOCUMENT_KEY_NOT_FOUND");
  }
  const previousDocument = process.documentos[documentKey];
  if (!previousDocument || Array.isArray(previousDocument) || typeof previousDocument !== "object") {
    throw codedError("A referencia do documento nao e um objeto substituivel.", "DOCUMENT_REFERENCE_INVALID");
  }

  const currentDriveReference = parseDriveUploadPath(previousDocument.path);
  if (currentDriveReference) {
    const currentFile = await dependencies.statDriveFile(currentDriveReference.fileId);
    if (currentFile) {
      if (previousDocument.backend === "drive" && previousDocument.fileId === currentDriveReference.fileId) {
        return { status: "already_valid", processId, documentKey, path: previousDocument.path, fileId: currentDriveReference.fileId };
      }
      const normalizedDocument = {
        ...previousDocument,
        backend: "drive",
        fileId: currentDriveReference.fileId
      };
      if (options.dryRun) {
        return {
          status: "dry_run",
          processId,
          documentKey,
          oldPath: previousDocument.path,
          path: previousDocument.path,
          fileId: currentDriveReference.fileId,
          wouldNormalizeDriveMetadata: true
        };
      }
      const now = (dependencies.now || (() => new Date()))().toISOString();
      const audit = createReplacementAudit({
        processId, documentKey, previousDocument, newDocument: normalizedDocument,
        technicalUser, reason, allowPaid: options.allowPaid, now, dependencies
      });
      const result = await dependencies.commitReplacement({
        processId,
        documentKey,
        expectedDocument: previousDocument,
        newDocument: normalizedDocument,
        audit,
        now
      });
      return {
        status: result?.status === "already_updated" ? "already_updated" : "metadata_normalized",
        processId,
        documentKey,
        path: previousDocument.path,
        fileId: currentDriveReference.fileId
      };
    }
  }

  const input = await dependencies.readPdf(options.filePath);
  validatePdfInput(input, options.filePath);
  await dependencies.verifyDriveFolderAccess();
  const sha256 = createHash("sha256").update(input.content).digest("hex");
  const md5 = createHash("md5").update(input.content).digest("hex");
  const repairKey = createHash("sha256")
    .update(`upload-repair:v1:${processId}:${documentKey}:${sha256}`)
    .digest("hex");
  const originalName = String(previousDocument.fileName || input.fileName || basename(options.filePath)).trim();
  const candidates = await dependencies.listRepairFiles(REPAIR_PROPERTY, repairKey);
  const reusable = candidates.find((file) => file && String(file.size) === String(input.content.length)
    && (!file.md5Checksum || String(file.md5Checksum).toLowerCase() === md5));

  if (options.dryRun) {
    return {
      status: "dry_run",
      processId,
      documentKey,
      oldPath: previousDocument.path || null,
      originalName,
      sizeBytes: input.content.length,
      wouldReuseDriveFile: Boolean(reusable)
    };
  }

  const uploaded = reusable || await dependencies.uploadToDrive(input.content, {
    name: originalName,
    mimeType: "application/pdf",
    appProperties: { [REPAIR_PROPERTY]: repairKey }
  });
  const confirmed = await dependencies.statDriveFile(uploaded.id);
  if (!confirmed || String(confirmed.size) !== String(input.content.length)
      || (confirmed.md5Checksum && String(confirmed.md5Checksum).toLowerCase() !== md5)) {
    throw codedError("O upload nao foi confirmado pelo Google Drive.", "DRIVE_UPLOAD_NOT_CONFIRMED");
  }

  const now = (dependencies.now || (() => new Date()))().toISOString();
  const newPath = `/uploads/drive/${confirmed.id}/${encodeURIComponent(originalName)}`;
  const newDocument = {
    ...previousDocument,
    fileName: originalName,
    path: newPath,
    backend: "drive",
    fileId: confirmed.id,
    mimeType: "application/pdf",
    sizeBytes: input.content.length,
    uploadedAt: now,
    uploadedBy: technicalUser,
    uploadedByEmail: technicalUser
  };
  const audit = createReplacementAudit({
    processId, documentKey, previousDocument, newDocument,
    technicalUser, reason, allowPaid: options.allowPaid, now, dependencies
  });
  const result = await dependencies.commitReplacement({
    processId,
    documentKey,
    expectedDocument: previousDocument,
    newDocument,
    audit,
    now
  });
  return { status: result?.status || "replaced", processId, documentKey, oldPath: previousDocument.path || null, path: newPath, fileId: confirmed.id, reusedDriveFile: Boolean(reusable) };
}

function createReplacementAudit(values) {
  return {
    id: (values.dependencies.randomUUID || randomUUID)(),
    processoId: values.processId,
    usuario: values.technicalUser,
    usuarioEmail: values.technicalUser,
    acao: "Documento substituido administrativamente no armazenamento",
    detalhes: values.reason,
    documento: { chave: values.documentKey, ...values.newDocument },
    alteracoes: {
      documentKey: values.documentKey,
      caminhoAnterior: values.previousDocument.path || null,
      caminhoNovo: values.newDocument.path,
      backendAnterior: values.previousDocument.backend || "local",
      backendNovo: "drive",
      fileId: values.newDocument.fileId,
      motivo: values.reason,
      usuarioTecnico: values.technicalUser,
      allowPaid: Boolean(values.allowPaid)
    },
    criadoEm: values.now
  };
}

export async function commitDocumentReplacement(change, runTransaction) {
  return runTransaction(async (client) => {
    const locked = await client.query("SELECT data FROM app_processes WHERE id = $1 FOR UPDATE", [change.processId]);
    if (!locked.rows[0]) throw codedError("Processo nao encontrado durante a transacao.", "PROCESS_NOT_FOUND");
    const process = locked.rows[0].data;
    const current = process?.documentos?.[change.documentKey];
    if (current?.path === change.newDocument.path) return { status: "already_updated" };
    if (JSON.stringify(current) !== JSON.stringify(change.expectedDocument)) {
      throw codedError("A referencia do documento mudou durante a operacao; o banco nao foi alterado.", "DOCUMENT_REFERENCE_CHANGED");
    }
    const updated = {
      ...process,
      documentos: { ...process.documentos, [change.documentKey]: change.newDocument },
      atualizadoEm: change.now,
      versao: Number.isInteger(process.versao) ? process.versao + 1 : process.versao
    };
    await client.query("UPDATE app_processes SET data = $2::jsonb, updated_at = $3::timestamptz WHERE id = $1", [change.processId, JSON.stringify(updated), change.now]);
    await client.query("INSERT INTO app_process_audit (id, processo_id, data, created_at) VALUES ($1, $2, $3::jsonb, $4::timestamptz) ON CONFLICT (id) DO NOTHING", [change.audit.id, change.processId, JSON.stringify(change.audit), change.now]);
    await client.query("UPDATE app_state_revision SET revision = revision + 1 WHERE id = true");
    return { status: "replaced" };
  });
}

function validatePdfInput(input, filePath) {
  if (!input?.content || !Buffer.isBuffer(input.content) || input.content.length === 0) throw codedError("O arquivo PDF esta vazio.", "PDF_INVALID");
  if (extname(String(filePath || input.fileName || "")).toLowerCase() !== ".pdf") throw codedError("O arquivo deve possuir extensao .pdf.", "PDF_INVALID");
  if (!input.content.subarray(0, 4).equals(Buffer.from("%PDF"))) throw codedError("O conteudo do arquivo nao e PDF.", "PDF_INVALID");
  if (input.validationError) throw codedError(input.validationError.message || "PDF invalido.", "PDF_INVALID");
}

function required(value, name) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`${name} e obrigatorio.`);
  return text;
}

function codedError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}
