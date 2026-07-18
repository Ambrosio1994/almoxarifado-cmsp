import { Readable, Writable } from "node:stream";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findFileInFolder, getDriveClient } from "../src/uploads/drive-storage.js";
import { DRIVE_UPLOAD_STORAGE_DATABASE_KEY } from "../src/uploads/drive-storage-identity.js";
import {
  deleteUploadFile,
  ensureUploadStorageReady,
  getUploadBuffer,
  getUploadMetadata,
  inspectUploadIntegrity,
  putUploadFile,
  streamUploadTo
} from "../src/uploads/upload-storage.js";

describe("upload-storage (backend drive)", () => {
  it("cria o cliente OAuth2 e exige todas as credenciais sem chamar o Google", () => {
    assert.throws(() => getDriveClient({}), /GOOGLE_CLIENT_ID/);
    assert.throws(() => getDriveClient({ clientId: "client-id" }), /GOOGLE_CLIENT_SECRET/);
    assert.throws(() => getDriveClient({
      clientId: "client-id",
      clientSecret: "client-secret"
    }), /GOOGLE_REFRESH_TOKEN/);

    const drive = getDriveClient({
      clientId: "client-id",
      clientSecret: "client-secret",
      refreshToken: "refresh-token"
    });
    assert.equal(drive.context._options.auth.credentials.refresh_token, "refresh-token");
  });

  it("simplifica erros da API do Drive sem perder codigo e motivo", async () => {
    const original = new Error("mensagem da biblioteca");
    original.code = 403;
    original.response = {
      status: 403,
      data: { error: { message: "Quota excedida", errors: [{ reason: "storageQuotaExceeded" }] } }
    };
    const client = { files: { list: async () => { throw original; } } };

    await assert.rejects(
      findFileInFolder("arquivo.txt", { client, folderId: "folder" }),
      (error) => error.message === "Falha ao listar arquivos no Google Drive: Quota excedida"
        && error.code === 403
        && error.reason === "storageQuotaExceeded"
        && error.cause === original
    );
  });

  it("grava com fileId no path, le metadados e conteudo e exclui de forma idempotente", async () => {
    const fake = createFakeDrive();
    const content = Buffer.from("conteudo de teste no Drive", "utf8");
    const stored = await putUploadFile(content, {
      backend: "drive",
      client: fake.client,
      folderId: fake.folderId,
      fileName: "nota fiscal á.pdf.txt",
      mimeType: "text/plain",
      processId: "processo-1"
    });

    assert.match(stored.path, /^\/uploads\/drive\/file-1\/nota%20fiscal%20%C3%A1\.pdf\.txt$/);
    assert.equal(stored.sizeBytes, content.length);
    assert.deepEqual(await getUploadBuffer(stored.path, 1_024, { client: fake.client }), content);
    assert.deepEqual(await getUploadMetadata(stored.path, { client: fake.client }), {
      sizeBytes: content.length,
      modifiedTime: fake.modifiedTime
    });
    const response = new FakeResponse();
    await streamUploadTo(response, stored.path, { "content-type": "text/plain" }, {
      client: fake.client,
      request: { method: "GET", headers: {} }
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["content-length"], content.length);
    assert.deepEqual(response.body(), content);
    assert.equal(await deleteUploadFile(stored.path, { client: fake.client }), true);
    assert.equal(await deleteUploadFile(stored.path, { client: fake.client }), false);
  });

  it("estabelece a identidade exclusiva do Drive e preserva o contrato do health check", async () => {
    const fake = createFakeDrive();
    let databaseIdentity = "";
    const options = {
      backend: "drive",
      client: fake.client,
      folderId: fake.folderId,
      loadDatabaseIdentity: async () => databaseIdentity,
      claimDatabaseIdentity: async (identity) => (databaseIdentity ||= identity)
    };

    const identity = await ensureUploadStorageReady(options);
    assert.match(identity, /^[a-f0-9-]{36}$/);
    assert.equal(databaseIdentity, identity);
    assert.equal(fake.fileByName(".almoxarifado-storage.json")?.mimeType, "application/json");
    assert.equal(DRIVE_UPLOAD_STORAGE_DATABASE_KEY, "uploadStorageIdentityDrive");

    const upload = await putUploadFile(Buffer.from("health"), {
      backend: "drive",
      client: fake.client,
      folderId: fake.folderId,
      fileName: "health.txt",
      mimeType: "text/plain"
    });
    assert.deepEqual(await inspectUploadIntegrity({
      ...options,
      force: true,
      references: [upload.path, "/uploads/drive/arquivo-ausente/ausente.txt"]
    }), {
      ok: false,
      identity: true,
      referenced: 2,
      available: 1,
      missing: 1
    });
  });

  it("recusa pasta sem marcador quando o banco ja reconhece outra identidade", async () => {
    const fake = createFakeDrive();
    await assert.rejects(ensureUploadStorageReady({
      backend: "drive",
      client: fake.client,
      folderId: fake.folderId,
      loadDatabaseIdentity: async () => "11111111-1111-4111-8111-111111111111",
      claimDatabaseIdentity: async (identity) => identity
    }), (error) => error.code === "UPLOAD_STORAGE_IDENTITY_MISMATCH" && /marcador nao existe/.test(error.message));
  });

  it("recusa marcador e banco com identidades diferentes", async () => {
    const fake = createFakeDrive();
    fake.seed(".almoxarifado-storage.json", Buffer.from(JSON.stringify({
      version: 1,
      id: "11111111-1111-4111-8111-111111111111"
    })));
    await assert.rejects(ensureUploadStorageReady({
      backend: "drive",
      client: fake.client,
      folderId: fake.folderId,
      loadDatabaseIdentity: async () => "22222222-2222-4222-8222-222222222222",
      claimDatabaseIdentity: async (identity) => identity
    }), (error) => error.code === "UPLOAD_STORAGE_IDENTITY_MISMATCH" && /difere/.test(error.message));
  });

  it("valida PDF localmente e nao envia conteudo invalido ao Drive", async () => {
    const fake = createFakeDrive();
    await assert.rejects(putUploadFile(Buffer.from("%PDF-corrompido"), {
      backend: "drive",
      client: fake.client,
      folderId: fake.folderId,
      fileName: "corrompido.pdf",
      mimeType: "application/pdf"
    }), (error) => error.code === "UPLOAD_VALIDATION_FAILED");
    assert.equal(fake.fileCount(), 0);
  });

  it("escapa aspas e barras invertidas na busca por nome", async () => {
    const fake = createFakeDrive();
    await findFileInFolder("marcador\\d'agua.json", { client: fake.client, folderId: fake.folderId });
    assert.match(fake.lastListQuery(), /name='marcador\\\\d\\'agua\.json'/);
  });
});

function createFakeDrive() {
  const folderId = "folder-test";
  const modifiedTime = "2026-07-18T12:00:00.000Z";
  const files = new Map();
  let sequence = 0;
  let listQuery = "";

  const client = {
    files: {
      create: async ({ requestBody, media }) => {
        const id = `file-${++sequence}`;
        const content = await consume(media.body);
        const file = {
          id,
          name: requestBody.name,
          content,
          size: String(content.length),
          mimeType: media.mimeType,
          modifiedTime,
          md5Checksum: `checksum-${sequence}`
        };
        files.set(id, file);
        return { data: publicMetadata(file) };
      },
      get: async ({ fileId, alt }) => {
        if (fileId === folderId) {
          return { data: {
            id: folderId,
            name: "Uploads de teste",
            mimeType: "application/vnd.google-apps.folder",
            trashed: false,
            capabilities: { canAddChildren: true }
          } };
        }
        const file = files.get(fileId);
        if (!file) throw driveNotFound();
        return { data: alt === "media" ? Readable.from(file.content) : publicMetadata(file) };
      },
      list: async ({ q }) => {
        listQuery = q;
        const encodedName = q.match(/^name='((?:\\.|[^'])*)'/)?.[1] || "";
        const name = encodedName.replace(/\\'/g, "'").replace(/\\\\/g, "\\");
        const file = [...files.values()].find((item) => item.name === name);
        return { data: { files: file ? [{ id: file.id, name: file.name }] : [] } };
      },
      delete: async ({ fileId }) => {
        if (!files.delete(fileId)) throw driveNotFound();
        return { data: {} };
      }
    }
  };

  return {
    client,
    folderId,
    modifiedTime,
    seed: (name, content, mimeType = "application/json") => {
      const id = `file-${++sequence}`;
      files.set(id, { id, name, content, size: String(content.length), mimeType, modifiedTime });
      return id;
    },
    fileByName: (name) => [...files.values()].find((file) => file.name === name),
    fileCount: () => files.size,
    lastListQuery: () => listQuery
  };
}

async function consume(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function publicMetadata(file) {
  const { content, ...metadata } = file;
  return metadata;
}

function driveNotFound() {
  const error = new Error("not found");
  error.response = { status: 404 };
  return error;
}

class FakeResponse extends Writable {
  constructor() {
    super();
    this.statusCode = 0;
    this.headers = {};
    this.chunks = [];
  }

  writeHead(statusCode, headers = {}) {
    this.statusCode = statusCode;
    this.headers = { ...headers };
    return this;
  }

  _write(chunk, encoding, callback) {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }

  body() {
    return Buffer.concat(this.chunks);
  }
}
