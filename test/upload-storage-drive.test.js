import { Readable, Writable } from "node:stream";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findFileInFolder, getDriveClient } from "../src/uploads/drive-storage.js";
import { DRIVE_UPLOAD_STORAGE_DATABASE_KEY } from "../src/uploads/drive-storage-identity.js";
import {
  deleteUploadFile,
  diagnoseUploadStorage,
  ensureUploadStorageReady,
  getUploadBuffer,
  getUploadMetadata,
  inspectUploadIntegrity,
  putUploadFile,
  streamUploadTo,
  uploadStorageReadinessState
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

  it("exige GOOGLE_DRIVE_FOLDER_ID antes de autenticar", async () => {
    const fake = createFakeDrive();
    await assert.rejects(
      ensureUploadStorageReady({ backend: "drive", client: fake.client }),
      /GOOGLE_DRIVE_FOLDER_ID/
    );
    assert.equal(uploadStorageReadinessState().ready, false);
    assert.equal(uploadStorageReadinessState().stage, "oauth_configuration");
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

  it("inicializa normalmente quando banco e marcador possuem a mesma identidade", async () => {
    const fake = createFakeDrive();
    const identity = "11111111-1111-4111-8111-111111111111";
    fake.seedMarker(identity);
    const store = createIdentityStore(identity);
    const events = [];
    const options = {
      backend: "drive",
      client: fake.client,
      folderId: fake.folderId,
      ...store.callbacks,
      onEvent: (event, data) => events.push({ event, data })
    };

    assert.equal(await ensureUploadStorageReady(options), identity);
    assert.equal(store.current(), identity);
    assert.equal(fake.fileByName(".almoxarifado-storage.json")?.mimeType, "application/json");
    assert.equal(DRIVE_UPLOAD_STORAGE_DATABASE_KEY, "uploadStorageIdentityDrive");
    assert.equal(uploadStorageReadinessState().ready, true);
    assert.deepEqual(events.map(({ event }) => event), [
      "upload_storage_oauth_validated",
      "upload_storage_folder_access_verified",
      "upload_storage_identity_current",
      "upload_storage_ready"
    ]);

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

  it("vincula banco vazio a um marcador ja existente", async () => {
    const fake = createFakeDrive();
    const identity = "11111111-1111-4111-8111-111111111111";
    fake.seedMarker(identity);
    const store = createIdentityStore();

    assert.equal(await ensureUploadStorageReady({
      backend: "drive",
      client: fake.client,
      folderId: fake.folderId,
      ...store.callbacks
    }), identity);
    assert.equal(store.current(), identity);
    assert.equal(fake.markerCount(), 1);
  });

  it("cria uma unica identidade quando banco e pasta ainda estao vazios", async () => {
    const fake = createFakeDrive();
    const store = createIdentityStore();
    const options = {
      backend: "drive",
      client: fake.client,
      folderId: fake.folderId,
      ...store.callbacks
    };

    const first = await ensureUploadStorageReady(options);
    const second = await ensureUploadStorageReady(options);
    assert.equal(second, first);
    assert.equal(store.current(), first);
    assert.equal(fake.markerCount(), 1);
  });

  it("recusa pasta sem marcador quando a migracao nao foi autorizada", async () => {
    const fake = createFakeDrive();
    const store = createIdentityStore("11111111-1111-4111-8111-111111111111");
    await assert.rejects(ensureUploadStorageReady({
      backend: "drive",
      client: fake.client,
      folderId: fake.folderId,
      ...store.callbacks
    }), (error) => error.code === "UPLOAD_STORAGE_IDENTITY_MISMATCH"
      && error.migrationRequired === true
      && /UPLOAD_STORAGE_ALLOW_IDENTITY_MIGRATION=true/.test(error.message));
    assert.equal(fake.markerCount(), 0);
    assert.equal(store.migrationCount(), 0);
  });

  it("conclui a migracao autorizada e reinicia sem a variavel temporaria", async () => {
    const fake = createFakeDrive();
    const oldIdentity = "11111111-1111-4111-8111-111111111111";
    const store = createIdentityStore(oldIdentity);
    const events = [];
    const migratedIdentity = await ensureUploadStorageReady({
      backend: "drive",
      client: fake.client,
      folderId: fake.folderId,
      ...store.callbacks,
      allowIdentityMigration: true,
      onEvent: (event) => events.push(event)
    });
    assert.notEqual(migratedIdentity, oldIdentity);
    assert.equal(store.current(), migratedIdentity);
    assert.equal(fake.markerIdentity(), migratedIdentity);
    assert.equal(store.migrationCount(), 1);
    assert.ok(events.includes("upload_storage_identity_migration_started"));
    assert.ok(events.includes("upload_storage_identity_migration_completed"));

    assert.equal(await ensureUploadStorageReady({
      backend: "drive",
      client: fake.client,
      folderId: fake.folderId,
      ...store.callbacks
    }), migratedIdentity);
    assert.equal(store.migrationCount(), 1);
    assert.equal(fake.markerCount(), 1);
  });

  it("retoma idempotentemente quando o marcador foi criado antes da atualizacao do banco", async () => {
    const fake = createFakeDrive();
    const oldIdentity = "11111111-1111-4111-8111-111111111111";
    const markerIdentity = "22222222-2222-4222-8222-222222222222";
    fake.seedMarker(markerIdentity);
    const store = createIdentityStore(oldIdentity);

    assert.equal(await ensureUploadStorageReady({
      backend: "drive",
      client: fake.client,
      folderId: fake.folderId,
      ...store.callbacks,
      allowIdentityMigration: true
    }), markerIdentity);
    assert.equal(store.current(), markerIdentity);
    assert.equal(store.migrationCount(), 1);
    assert.equal(fake.markerCount(), 1);
  });

  it("nao repete a migracao quando a autorizacao temporaria permanece ativa", async () => {
    const fake = createFakeDrive();
    const identity = "11111111-1111-4111-8111-111111111111";
    fake.seedMarker(identity);
    const store = createIdentityStore(identity);
    const events = [];

    assert.equal(await ensureUploadStorageReady({
      backend: "drive",
      client: fake.client,
      folderId: fake.folderId,
      ...store.callbacks,
      allowIdentityMigration: true,
      onEvent: (event) => events.push(event)
    }), identity);
    assert.equal(store.migrationCount(), 0);
    assert.ok(events.includes("upload_storage_identity_migration_flag_still_enabled"));
  });

  it("recusa marcadores duplicados com identidades conflitantes", async () => {
    const fake = createFakeDrive();
    fake.seedMarker("11111111-1111-4111-8111-111111111111");
    fake.seedMarker("22222222-2222-4222-8222-222222222222");
    const store = createIdentityStore("11111111-1111-4111-8111-111111111111");

    await assert.rejects(ensureUploadStorageReady({
      backend: "drive",
      client: fake.client,
      folderId: fake.folderId,
      ...store.callbacks,
      allowIdentityMigration: true
    }), (error) => error.code === "UPLOAD_STORAGE_IDENTITY_MISMATCH" && /conflitantes/.test(error.message));
    assert.equal(store.migrationCount(), 0);
  });

  it("exige autorizacao ao trocar do backend local para a primeira identidade Drive", async () => {
    const fake = createFakeDrive();
    const previousIdentity = "11111111-1111-4111-8111-111111111111";
    const store = createIdentityStore("", previousIdentity);
    const options = {
      backend: "drive",
      client: fake.client,
      folderId: fake.folderId,
      ...store.callbacks
    };

    await assert.rejects(ensureUploadStorageReady(options), (error) => error.migrationRequired === true);
    const identity = await ensureUploadStorageReady({ ...options, allowIdentityMigration: true });
    assert.match(identity, /^[a-f0-9-]{36}$/);
    assert.equal(store.current(), identity);
    assert.equal(fake.markerIdentity(), identity);
  });

  it("classifica refresh token invalido, pasta sem permissao e pasta inexistente", async () => {
    const invalidToken = createFakeDrive({ oauthError: driveApiError(400, "invalid_grant") });
    await assert.rejects(ensureUploadStorageReady(driveOptions(invalidToken)), (error) => (
      error.code === "GOOGLE_REFRESH_TOKEN_INVALID" && /GOOGLE_REFRESH_TOKEN/.test(error.message)
    ));

    const denied = createFakeDrive({ canAddChildren: false });
    await assert.rejects(ensureUploadStorageReady(driveOptions(denied)), (error) => (
      error.code === "GOOGLE_DRIVE_FOLDER_ACCESS_DENIED"
    ));

    const missing = createFakeDrive({ folderError: driveNotFound() });
    await assert.rejects(ensureUploadStorageReady(driveOptions(missing)), (error) => (
      error.code === "GOOGLE_DRIVE_FOLDER_NOT_FOUND"
    ));
  });

  it("diagnostica OAuth, pasta e identidade sem alterar banco ou marcador", async () => {
    const fake = createFakeDrive();
    const identity = "11111111-1111-4111-8111-111111111111";
    fake.seedMarker(identity);
    const store = createIdentityStore(identity);
    const result = await diagnoseUploadStorage({
      backend: "drive",
      client: fake.client,
      folderId: fake.folderId,
      ...store.callbacks
    });

    assert.equal(result.compatible, true);
    assert.equal(result.migrationRequired, false);
    assert.equal(result.databaseIdentity, identity);
    assert.equal(result.markerIdentity, identity);
    assert.equal(result.account, "al***@example.com");
    assert.equal(result.folderId, "fold...test");
    assert.equal(store.migrationCount(), 0);
    assert.equal(fake.markerCount(), 1);
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

function createFakeDrive(options = {}) {
  const folderId = "folder-test";
  const modifiedTime = "2026-07-18T12:00:00.000Z";
  const files = new Map();
  let sequence = 0;
  let listQuery = "";

  const client = {
    about: {
      get: async () => {
        if (options.oauthError) throw options.oauthError;
        return { data: { user: {
          displayName: "Conta Teste",
          emailAddress: "almox.test@example.com",
          permissionId: "permission-test"
        } } };
      }
    },
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
          if (options.folderError) throw options.folderError;
          return { data: {
            id: folderId,
            name: "Uploads de teste",
            mimeType: "application/vnd.google-apps.folder",
            trashed: false,
            capabilities: { canAddChildren: options.canAddChildren !== false }
          } };
        }
        const file = files.get(fileId);
        if (!file) throw driveNotFound();
        return { data: alt === "media" ? Readable.from(file.content) : publicMetadata(file) };
      },
      list: async ({ q, pageSize }) => {
        listQuery = q;
        const encodedName = q.match(/^name='((?:\\.|[^'])*)'/)?.[1] || "";
        const name = encodedName.replace(/\\'/g, "'").replace(/\\\\/g, "\\");
        const matches = [...files.values()]
          .filter((item) => item.name === name)
          .slice(0, pageSize || 100)
          .map((file) => ({ id: file.id, name: file.name }));
        return { data: { files: matches } };
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
    markerCount: () => [...files.values()].filter((file) => file.name === ".almoxarifado-storage.json").length,
    markerIdentity: () => {
      const marker = [...files.values()].find((file) => file.name === ".almoxarifado-storage.json");
      return marker ? JSON.parse(marker.content.toString("utf8")).id : "";
    },
    seedMarker: (identity) => {
      const content = Buffer.from(JSON.stringify({ version: 1, id: identity }));
      const id = `file-${++sequence}`;
      files.set(id, { id, name: ".almoxarifado-storage.json", content, size: String(content.length), mimeType: "application/json", modifiedTime });
      return id;
    },
    lastListQuery: () => listQuery
  };
}

function createIdentityStore(initialIdentity = "", previousIdentity = "") {
  let databaseIdentity = initialIdentity;
  let migrations = 0;
  return {
    callbacks: {
      loadDatabaseIdentity: async () => databaseIdentity,
      loadPreviousDatabaseIdentity: async () => previousIdentity,
      claimDatabaseIdentity: async (identity) => (databaseIdentity ||= identity),
      migrateDatabaseIdentity: async (expectedIdentity, identity) => {
        if (databaseIdentity === expectedIdentity) {
          databaseIdentity = identity;
          migrations += 1;
        }
        return databaseIdentity;
      }
    },
    current: () => databaseIdentity,
    migrationCount: () => migrations
  };
}

function driveOptions(fake) {
  return {
    backend: "drive",
    client: fake.client,
    folderId: fake.folderId,
    ...createIdentityStore().callbacks
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

function driveApiError(status, reason) {
  const error = new Error(reason);
  error.response = { status, data: { error: reason } };
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
