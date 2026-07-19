import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  dockerUploadsArchiveArgs,
  verifyBackupManifest
} from "../scripts/backup-production.js";
import { validateAdminBootstrap, validateUploadStorage } from "../scripts/validate-production-env.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporaryRoot = await mkdtemp(join(tmpdir(), "almox-operations-tests-"));

after(async () => {
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe("scripts operacionais", () => {
  it("monta o volume de uploads somente para leitura e envia o tar pela saida padrao", () => {
    const args = dockerUploadsArchiveArgs("volume_existente");
    assert.ok(args.includes("none"));
    assert.ok(args.includes("--read-only"));
    assert.ok(args.includes("no-new-privileges:true"));
    assert.ok(args.includes("DAC_READ_SEARCH"));
    assert.ok(args.includes("volume_existente:/uploads:ro"));
    assert.equal(args.includes("--user"), false);
    assert.deepEqual(args.slice(-6), ["tar", "-czf", "-", "-C", "/uploads", "."]);

    const source = readText("scripts/backup-production.js");
    const validation = source.indexOf("await validateUploadSourceAvailability()");
    const dump = source.indexOf("await createDatabaseDump(databaseOutput, url)");
    assert.ok(validation >= 0 && validation < dump, "o volume deve ser validado antes do dump");
    assert.match(source, /\["volume", "inspect", volume\]/);
  });

  it("confere tamanho e hash dos artefatos registrados no manifesto", async () => {
    const directory = join(temporaryRoot, "manifest");
    await mkdir(directory, { recursive: true });
    const databaseFile = join(directory, "database.dump");
    const uploadsFile = join(directory, "uploads.tar.gz");
    await writeFile(databaseFile, "dump-valido", { mode: 0o600 });
    await writeFile(uploadsFile, "archive-valido", { mode: 0o600 });
    const manifestFile = join(directory, "backup.json");
    const manifest = {
      version: 1,
      consistency: "application-stopped",
      database: await manifestEntry(databaseFile, "database.dump"),
      uploads: await manifestEntry(uploadsFile, "uploads.tar.gz")
    };
    await writeFile(manifestFile, JSON.stringify(manifest), { mode: 0o600 });

    assert.equal((await verifyBackupManifest(manifestFile, directory)).version, 1);
    await writeFile(uploadsFile, "archive-adulterado");
    await assert.rejects(() => verifyBackupManifest(manifestFile, directory), /diverge do manifesto/);
  });

  it("exige bootstrap local ou confirmacao explicita de administrador existente", () => {
    const blocked = validateAdminBootstrap({
      ADMIN_EMAILS: "admin@example.com",
      CONFIRM_EXISTING_ADMIN_PROVISIONED: "false"
    });
    assert.match(blocked.join(" "), /CONFIRM_EXISTING_ADMIN_PROVISIONED=true/);

    const existing = validateAdminBootstrap({
      ADMIN_EMAILS: "admin@example.com",
      CONFIRM_EXISTING_ADMIN_PROVISIONED: "true"
    });
    assert.deepEqual(existing, []);

    const bootstrap = validateAdminBootstrap({
      ADMIN_EMAILS: "",
      LOCAL_ADMIN_EMAIL: "admin@example.com",
      LOCAL_ADMIN_PASSWORD: "Senha@123",
      CONFIRM_EXISTING_ADMIN_PROVISIONED: "false"
    });
    assert.deepEqual(bootstrap, []);
  });

  it("exige pasta e credenciais OAuth completas ao ativar o backend Drive", () => {
    for (const variable of [
      "GOOGLE_DRIVE_FOLDER_ID",
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
      "GOOGLE_REFRESH_TOKEN"
    ]) {
      const environment = {
        UPLOAD_STORAGE_BACKEND: "drive",
        GOOGLE_DRIVE_FOLDER_ID: "folder",
        GOOGLE_CLIENT_ID: "client-id",
        GOOGLE_CLIENT_SECRET: "client-secret",
        GOOGLE_REFRESH_TOKEN: "refresh-token"
      };
      delete environment[variable];
      assert.match(validateUploadStorage(environment).join(" "), new RegExp(variable));
    }

    assert.deepEqual(validateUploadStorage({
      UPLOAD_STORAGE_BACKEND: "drive",
      GOOGLE_DRIVE_FOLDER_ID: "folder",
      GOOGLE_CLIENT_ID: "client-id",
      GOOGLE_CLIENT_SECRET: "client-secret",
      GOOGLE_REFRESH_TOKEN: "refresh-token"
    }), []);

    assert.match(validateUploadStorage({
      UPLOAD_STORAGE_BACKEND: "drive",
      GOOGLE_DRIVE_FOLDER_ID: "folder",
      GOOGLE_CLIENT_ID: "client-id",
      GOOGLE_CLIENT_SECRET: "client-secret",
      GOOGLE_REFRESH_TOKEN: "refresh-token",
      UPLOAD_STORAGE_ALLOW_IDENTITY_MIGRATION: "sempre"
    }).join(" "), /UPLOAD_STORAGE_ALLOW_IDENTITY_MIGRATION/);
    assert.match(validateUploadStorage({
      UPLOAD_STORAGE_BACKEND: "local",
      UPLOAD_STORAGE_ALLOW_IDENTITY_MIGRATION: "true"
    }).join(" "), /UPLOAD_STORAGE_BACKEND=drive/);
  });

  it("nao mantem autenticacao ativa por conta de servico", () => {
    const legacyEnvironmentName = ["GOOGLE", "SERVICE", "ACCOUNT", "KEY"].join("_");
    const legacyAuthClass = ["Google", "Auth"].join("");
    const legacyResolver = ["resolve", "Credentials"].join("");
    const activeSources = [
      "src/uploads/drive-storage.js",
      "src/uploads/drive-storage-identity.js",
      "src/uploads/upload-storage.js",
      "src/server.js",
      "scripts/validate-production-env.js"
    ].map(readText).join("\n");

    assert.equal(activeSources.includes(legacyEnvironmentName), false);
    assert.equal(activeSources.includes(legacyAuthClass), false);
    assert.equal(activeSources.includes(legacyResolver), false);
  });

  it("inclui a implementacao atual no Docker sem copia duplicada ou exclusao", () => {
    const dockerfile = readText("Dockerfile");
    const dockerignore = readText(".dockerignore");
    assert.match(dockerfile, /COPY --chown=node:node \. \./);
    assert.match(dockerfile, /CMD \["node", "src\/server\.js"\]/);
    assert.doesNotMatch(dockerignore, /^src\/?$/m);
    assert.doesNotMatch(dockerignore, /^scripts\/?$/m);
    assert.equal(readText("src/uploads/drive-storage.js").length > 0, true);
  });

  it("le dominio e porta do env como texto, sem source nem avaliacao de shell", async () => {
    const environmentFile = join(temporaryRoot, "target.env");
    await writeFile(environmentFile, "PRODUCTION_DOMAIN=\"painel.example.com\"\nAPP_PORT='4321'\n", { mode: 0o600 });
    const target = runBash(["scripts/deploy-production.sh", "target"], {
      ENV_FILE: environmentFile
    });
    assert.equal(target.status, 0, target.stderr);
    assert.equal(target.stdout.trim(), "domain=painel.example.com\nport=4321");

    const marker = join(temporaryRoot, "nao-deve-exist");
    await writeFile(environmentFile, `PRODUCTION_DOMAIN=$(touch ${marker})\nAPP_PORT=3000\n`, { mode: 0o600 });
    const rejected = runBash(["scripts/deploy-production.sh", "target"], {
      ENV_FILE: environmentFile
    });
    assert.notEqual(rejected.status, 0);
    await assert.rejects(() => readFile(marker), (error) => error.code === "ENOENT");
  });

  it("reinicia a aplicacao no trap quando o shell sai durante o backup", async () => {
    const fakeCompose = join(temporaryRoot, "fake-compose.sh");
    const log = join(temporaryRoot, "compose.log");
    await writeFile(fakeCompose, "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >> \"$TRAP_LOG\"\n", { mode: 0o700 });
    await chmod(fakeCompose, 0o700);
    const command = [
      "source scripts/deploy-production.sh",
      `COMPOSE=(\"${fakeCompose}\")`,
      "arm_backup_restart_trap",
      "exit 7"
    ].join("; ");
    const result = runBash(["-c", command], {
      ENV_FILE: join(temporaryRoot, "inexistente.env"),
      TRAP_LOG: log
    });
    assert.equal(result.status, 7, result.stderr);
    assert.equal((await readFile(log, "utf8")).trim(), "start app");
  });

  it("mantem sintaxe valida nos scripts alterados", () => {
    const shell = runBash(["-n", "scripts/deploy-production.sh"]);
    assert.equal(shell.status, 0, shell.stderr);
    const cleanup = readText("scripts/cleanup-orphan-uploads.js");
    assert.match(cleanup, /typeof value === "string" \? value : value\?\.path/);
    assert.match(cleanup, /missing-reference:/);
    assert.match(cleanup, /UPLOAD_STORAGE_MARKER_NAME/);
    const compose = readText("compose.production.yml");
    assert.match(compose, /name: almoxarifado_uploads/);
    const deploy = readText("scripts/deploy-production.sh");
    assert.match(deploy, /verify_upload_mount/);
    assert.match(deploy, /run --rm --no-deps app node src\/server\.js --check-upload-storage/);
    assert.ok(deploy.indexOf("check_upload_integrity") < deploy.indexOf('"${COMPOSE[@]}" up -d --no-deps app'));
  });
});

function readText(relativePath) {
  return readFileSync(join(root, relativePath), "utf8");
}

async function manifestEntry(file, name) {
  const content = await readFile(file);
  return {
    file: name,
    size: content.length,
    sha256: createHash("sha256").update(content).digest("hex")
  };
}

function processEnvironment() {
  return {
    PATH: process.env.PATH || "",
    HOME: process.env.HOME || temporaryRoot,
    LANG: process.env.LANG || "C.UTF-8"
  };
}

function runBash(args, environment = processEnvironment()) {
  return spawnSync("bash", args, {
    cwd: root,
    env: { ...processEnvironment(), ...environment },
    encoding: "utf8"
  });
}
