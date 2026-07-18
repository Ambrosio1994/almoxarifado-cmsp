import { randomUUID } from "node:crypto";
import {
  deleteFromDrive,
  downloadFromDrive,
  uploadToDrive,
  verifyDriveFolderAccess
} from "../src/uploads/drive-storage.js";

const probeContent = Buffer.from(`almoxarifado-drive-check:${randomUUID()}\n`, "utf8");
let probeId = "";

try {
  const folder = await verifyDriveFolderAccess();
  const probe = await uploadToDrive(probeContent, {
    name: `.almoxarifado-drive-check-${randomUUID()}.txt`,
    mimeType: "text/plain"
  });
  probeId = probe.id;
  const downloaded = await downloadFromDrive(probeId, { maximumBytes: 4_096 });
  if (!downloaded.equals(probeContent)) throw new Error("O conteudo lido do Drive difere do conteudo enviado.");
  await deleteFromDrive(probeId);
  probeId = "";
  console.log(JSON.stringify({
    ok: true,
    folderId: folder.id,
    folderName: folder.name,
    upload: true,
    download: true,
    delete: true
  }));
} finally {
  if (probeId) await deleteFromDrive(probeId).catch(() => null);
}
