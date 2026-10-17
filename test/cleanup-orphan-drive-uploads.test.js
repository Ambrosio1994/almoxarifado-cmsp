import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { listFolderFiles } from "../src/uploads/drive-storage.js";
import {
  classifyDriveOrphans,
  referencedDriveFileIds,
  runDriveUploadCleanup
} from "../scripts/cleanup-orphan-drive-uploads.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

const MARKER = ".almoxarifado-storage.json";
const PDF = "application/pdf";
const FOLDER = "application/vnd.google-apps.folder";
const OLD = "2020-01-01T00:00:00.000Z";
const NOW = Date.parse("2026-01-01T00:00:00.000Z");

describe("varredura de orfaos do Drive", () => {
  it("extrai ids referenciados dos documentos, anexos e caminhos drive", () => {
    const ids = referencedDriveFileIds({
      processos: [{
        documentos: {
          empenho: { path: "/uploads/drive/file-1/nota.pdf" },
          nf: ["/uploads/drive/file-2/nf.pdf", { path: "/uploads/drive/file-3/nf.pdf" }],
          local: { path: "/uploads/local/arquivo.pdf" },
          solto: { backend: "drive", fileId: "file-4" }
        }
      }],
      configuracoes: {
        emailTemplates: { a: { anexos: [{ path: "/uploads/drive/file-5/template.pdf" }] } }
      }
    });
    assert.deepEqual([...ids].sort(), ["file-1", "file-2", "file-3", "file-4", "file-5"]);
  });

  it("classifica orfaos ignorando marcador, pastas e arquivos sem data confiavel", () => {
    const result = classifyDriveOrphans([
      { id: "keep", name: "keep.pdf", mimeType: PDF, modifiedTime: OLD },
      { id: "orphan", name: "velho.pdf", mimeType: PDF, modifiedTime: OLD },
      { id: "novo", name: "novo.pdf", mimeType: PDF, modifiedTime: "2025-12-31T23:00:00.000Z" },
      { id: "sem-data", name: "sem.pdf", mimeType: PDF },
      { id: "marker", name: MARKER, mimeType: "application/json", modifiedTime: OLD },
      { id: "pasta", name: "sub", mimeType: FOLDER }
    ], new Set(["keep", "ausente"]), { now: NOW, graceMs: 86_400_000 });

    assert.deepEqual(result.orphans.map((file) => file.id), ["orphan"]);
    assert.deepEqual(result.protectedByGrace.map((file) => file.id).sort(), ["novo", "sem-data"]);
    assert.deepEqual(result.missingReferences, ["ausente"]);
    assert.deepEqual(result.folders, ["pasta"]);
    assert.deepEqual(result.scanned.sort(), ["keep", "novo", "orphan", "sem-data"]);
  });

  it("lista todos os arquivos da pasta paginando os resultados", async () => {
    const requests = [];
    const client = {
      files: {
        list: async (params) => {
          requests.push(params);
          if (requests.length === 1) {
            return { data: { files: [{ id: "a", name: "a.pdf" }], nextPageToken: "proxima" } };
          }
          return { data: { files: [{ id: "b", name: "b.pdf" }] } };
        }
      }
    };
    const files = await listFolderFiles({ client, folderId: "pasta", pageSize: 1 });
    assert.deepEqual(files.map((file) => file.id), ["a", "b"]);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].pageToken, undefined);
    assert.equal(requests[1].pageToken, "proxima");
    assert.match(requests[0].q, /'pasta' in parents/);
  });

  it("mantem o dry-run somente leitura e remove apenas orfaos com --apply", async () => {
    const store = {
      processos: [{
        documentos: {
          empenho: { path: "/uploads/drive/keep-id/nota.pdf" },
          nf: [{ path: "/uploads/drive/keep-array/nf.pdf" }]
        }
      }],
      configuracoes: {
        emailTemplates: { a: { anexos: [{ path: "/uploads/drive/keep-template/template.pdf" }] } }
      }
    };
    const pages = () => [{
      files: [
        { id: "keep-id", name: "nota.pdf", mimeType: PDF, modifiedTime: OLD },
        { id: "keep-array", name: "nf.pdf", mimeType: PDF, modifiedTime: OLD },
        { id: "keep-template", name: "template.pdf", mimeType: PDF, modifiedTime: OLD },
        { id: "orphan-1", name: "velho.pdf", mimeType: PDF, modifiedTime: OLD },
        { id: "marker", name: MARKER, mimeType: "application/json", modifiedTime: OLD },
        { id: "pasta", name: "sub", mimeType: FOLDER }
      ]
    }];
    const base = {
      expectedBackend: "json",
      backend: "json",
      uploadBackend: "drive",
      store,
      folderId: "pasta",
      graceMs: 0,
      now: NOW
    };

    const dryRunClient = createDriveClient(pages());
    const dryRun = await runDriveUploadCleanup({ ...base, client: dryRunClient, apply: false });
    assert.equal(dryRun.referenced, 3);
    assert.equal(dryRun.scanned, 4);
    assert.equal(dryRun.orphans, 1);
    assert.equal(dryRun.folders, 1);
    assert.equal(dryRun.applied, false);
    assert.deepEqual(dryRun.orphanIds, ["orphan-1"]);
    assert.deepEqual(dryRun.deleted, []);
    assert.equal(dryRunClient.requests.some((request) => request.deleted), false);

    const applyClient = createDriveClient(pages());
    const applied = await runDriveUploadCleanup({ ...base, client: applyClient, apply: true });
    assert.equal(applied.applied, true);
    assert.deepEqual(applied.orphanIds, ["orphan-1"]);
    assert.deepEqual(applied.deleted, ["orphan-1"]);
    const deletions = applyClient.requests.filter((request) => request.deleted);
    assert.deepEqual(deletions.map((request) => request.params.fileId), ["orphan-1"]);
  });

  it("recusa varredura quando o backend de uploads nao e o Drive", async () => {
    await assert.rejects(() => runDriveUploadCleanup({
      expectedBackend: "json",
      backend: "json",
      uploadBackend: "local",
      store: {},
      client: createDriveClient([]),
      folderId: "pasta"
    }), /UPLOAD_STORAGE_BACKEND=drive/);
  });

  it("recusa --apply sem a confirmacao explicita e exige o backend Drive na CLI", () => {
    const withoutConfirmation = runScript(["--apply"]);
    assert.equal(withoutConfirmation.status, 1);
    assert.match(`${withoutConfirmation.stdout}${withoutConfirmation.stderr}`, /--confirm-delete-orphans/);

    const wrongBackend = runScript([], { UPLOAD_STORAGE_BACKEND: "local" });
    assert.equal(wrongBackend.status, 1);
    assert.match(`${wrongBackend.stdout}${wrongBackend.stderr}`, /UPLOAD_STORAGE_BACKEND=drive/);
  });
});

function runScript(args, env = {}) {
  return spawnSync(process.execPath, ["scripts/cleanup-orphan-drive-uploads.js", ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, NODE_ENV: "test", ...env }
  });
}

function createDriveClient(pages) {
  const requests = [];
  const queue = [...pages];
  return {
    requests,
    files: {
      list: async (params) => {
        requests.push({ params });
        return { data: queue.shift() || { files: [] } };
      },
      delete: async (params) => {
        requests.push({ deleted: true, params });
        return { data: {} };
      }
    }
  };
}
