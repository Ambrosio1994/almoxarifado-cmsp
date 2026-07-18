import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureUploadStorageIdentity,
  readUploadStorageIdentity,
  UPLOAD_STORAGE_MARKER_NAME
} from "../src/uploads/storage-identity.js";

const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("identidade do armazenamento de uploads", () => {
  it("vincula um volume novo ao banco e preserva a identidade nos reinicios", async () => {
    const root = await temporaryRoot();
    let databaseIdentity = "";
    const callbacks = {
      root,
      loadDatabaseIdentity: async () => databaseIdentity,
      claimDatabaseIdentity: async (identity) => {
        databaseIdentity ||= identity;
        return databaseIdentity;
      }
    };

    const firstIdentity = await ensureUploadStorageIdentity(callbacks);
    const secondIdentity = await ensureUploadStorageIdentity(callbacks);

    assert.match(firstIdentity, /^[a-f0-9-]{36}$/);
    assert.equal(secondIdentity, firstIdentity);
    assert.equal(databaseIdentity, firstIdentity);
    assert.equal(await readUploadStorageIdentity(root), firstIdentity);
  });

  it("recusa um volume vazio quando o banco ja possui uma identidade", async () => {
    const root = await temporaryRoot();
    await assert.rejects(ensureUploadStorageIdentity({
      root,
      loadDatabaseIdentity: async () => "11111111-1111-4111-8111-111111111111",
      claimDatabaseIdentity: async (identity) => identity
    }), (error) => error.code === "UPLOAD_STORAGE_IDENTITY_MISMATCH" && /marcador nao existe/.test(error.message));
  });

  it("recusa volume e banco com identidades diferentes", async () => {
    const root = await temporaryRoot();
    let databaseIdentity = "";
    await ensureUploadStorageIdentity({
      root,
      loadDatabaseIdentity: async () => databaseIdentity,
      claimDatabaseIdentity: async (identity) => (databaseIdentity ||= identity)
    });
    databaseIdentity = "22222222-2222-4222-8222-222222222222";

    await assert.rejects(ensureUploadStorageIdentity({
      root,
      loadDatabaseIdentity: async () => databaseIdentity,
      claimDatabaseIdentity: async (identity) => identity
    }), (error) => error.code === "UPLOAD_STORAGE_IDENTITY_MISMATCH" && /difere/.test(error.message));
  });

  it("mantem o marcador fora da lista de arquivos de negocio", () => {
    assert.equal(UPLOAD_STORAGE_MARKER_NAME, ".almoxarifado-storage.json");
  });
});

async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), "almox-upload-identity-"));
  temporaryRoots.push(root);
  return root;
}
