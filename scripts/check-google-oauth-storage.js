import { closePool } from "../src/db/postgres.js";
import { diagnoseUploadStorage } from "../src/uploads/upload-storage.js";

try {
  const result = await diagnoseUploadStorage({ backend: process.env.UPLOAD_STORAGE_BACKEND });
  console.log(JSON.stringify({
    event: "google_storage_check",
    ok: result.compatible,
    backend: result.backend,
    account: result.account,
    folderId: result.folderId,
    folderName: result.folderName,
    databaseIdentity: result.databaseIdentity || null,
    markerIdentity: result.markerIdentity || null,
    previousBackendIdentity: result.previousBackendIdentity || null,
    migrationRequired: result.migrationRequired,
    instruction: result.migrationRequired
      ? "Autorize uma unica inicializacao com UPLOAD_STORAGE_ALLOW_IDENTITY_MIGRATION=true."
      : null
  }));
  process.exitCode = result.compatible ? 0 : 1;
} catch (error) {
  console.error(JSON.stringify({
    event: "google_storage_check_failed",
    ok: false,
    stage: error?.stage || null,
    code: error?.code || error?.response?.status || null,
    message: safeMessage(error)
  }));
  process.exitCode = 1;
} finally {
  await closePool().catch(() => null);
}

function safeMessage(error) {
  return String(error?.message || "Erro desconhecido no diagnostico do Google Drive.")
    .replace(/1\/\/[A-Za-z0-9._-]+/g, "[refresh-token-redacted]")
    .replace(/ya29\.[A-Za-z0-9._-]+/g, "[access-token-redacted]")
    .slice(0, 500);
}
