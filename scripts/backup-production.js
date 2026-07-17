import {
  chmodSync,
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

let connectionString;
let url;
let backupDir;

export async function runProductionBackup(argv = process.argv) {
  process.umask(0o077);
  if (argv.includes("--help")) {
    console.log("Uso: BACKUP_CONSISTENCY=application-stopped NODE_ENV=production node scripts/backup-production.js [diretorio]");
    return;
  }

  loadEnvironmentFile();
  validateEnvironment();

  connectionString = process.env.DATABASE_URL_MIGRATION || process.env.DATABASE_URL;
  url = new URL(connectionString);
  backupDir = resolve(argv[2] || process.env.BACKUP_DIR || "backups");
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  chmodSync(backupDir, 0o700);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const databaseOutput = join(backupDir, `database-${stamp}.dump`);
  const uploadsOutput = join(backupDir, `uploads-${stamp}.tar.gz`);
  const manifestOutput = join(backupDir, `backup-${stamp}.json`);
  const outputs = [databaseOutput, uploadsOutput, manifestOutput];

  try {
    await validateUploadSourceAvailability();
    await createDatabaseDump(databaseOutput, url);
    await verifyDatabaseDump(databaseOutput);
    await createUploadsArchive(uploadsOutput);
    await verifyUploadsArchive(uploadsOutput);

    const manifest = {
      version: 1,
      createdAt: new Date().toISOString(),
      consistency: process.env.BACKUP_CONSISTENCY,
      database: {
        host: url.host,
        database: decodeURIComponent(url.pathname.slice(1)),
        file: basename(databaseOutput),
        size: statSync(databaseOutput).size,
        sha256: await sha256(databaseOutput)
      },
      uploads: {
        source: uploadSourceDescription(),
        file: basename(uploadsOutput),
        size: statSync(uploadsOutput).size,
        sha256: await sha256(uploadsOutput)
      }
    };
    writeFileSync(manifestOutput, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    for (const file of outputs) chmodSync(file, 0o600);
    await verifyBackupManifest(manifestOutput, backupDir);
    try {
      pruneVerifiedBackups(manifestOutput);
    } catch (error) {
      console.warn(`Backup valido, mas a retencao automatica falhou: ${error.message}`);
    }
    console.log(`Backup consistente criado: ${manifestOutput}`);
  } catch (error) {
    for (const file of outputs) rmSync(file, { force: true });
    throw error;
  }
}

function validateEnvironment() {
  if (process.env.NODE_ENV !== "production") {
    throw new Error("O backup exige NODE_ENV=production para evitar uso do banco errado.");
  }
  const connection = process.env.DATABASE_URL_MIGRATION || process.env.DATABASE_URL;
  if (!connection) throw new Error("DATABASE_URL_MIGRATION ou DATABASE_URL nao configurada.");
  let target;
  try {
    target = new URL(connection);
  } catch {
    throw new Error("URL PostgreSQL invalida.");
  }
  if (!["postgres:", "postgresql:"].includes(target.protocol)) throw new Error("URL PostgreSQL invalida.");
  if (!target.hostname || !target.pathname.slice(1)) throw new Error("URL PostgreSQL sem host ou database.");
  if (!["require", "verify-full"].includes(target.searchParams.get("sslmode"))) {
    throw new Error("A URL de backup deve exigir SSL.");
  }
  if (!["application-stopped", "storage-snapshot"].includes(process.env.BACKUP_CONSISTENCY)) {
    throw new Error("Defina BACKUP_CONSISTENCY=application-stopped ou storage-snapshot.");
  }
  if (process.env.BACKUP_UPLOAD_SOURCE && !localUploadSource()) {
    throw new Error("BACKUP_UPLOAD_SOURCE nao existe ou nao e um diretorio.");
  }
  if (!localUploadSource() && !process.env.BACKUP_UPLOAD_DOCKER_VOLUME) {
    throw new Error("Configure BACKUP_UPLOAD_SOURCE ou BACKUP_UPLOAD_DOCKER_VOLUME para incluir uploads.");
  }
  positiveInteger("BACKUP_COMMAND_TIMEOUT_MS", 900000);
  positiveInteger("BACKUP_RETENTION_COUNT", 10);
  positiveInteger("BACKUP_RETENTION_DAYS", 30);
}

async function createDatabaseDump(output, target) {
  const childEnv = {
    ...process.env,
    PGHOST: target.hostname,
    PGPORT: target.port || "5432",
    PGDATABASE: decodeURIComponent(target.pathname.slice(1)),
    PGUSER: decodeURIComponent(target.username),
    PGPASSWORD: decodeURIComponent(target.password),
    PGSSLMODE: target.searchParams.get("sslmode"),
    PGSSLROOTCERT: process.env.PGSSLROOTCERT || (target.searchParams.get("sslmode") === "verify-full" ? "system" : undefined),
    PGCHANNELBINDING: target.searchParams.get("channel_binding") || "prefer"
  };
  const local = commandAvailable("pg_dump");
  const command = local ? "pg_dump" : "docker";
  const args = local
    ? ["--format=custom", "--no-owner", "--no-acl", "--file", output]
    : [
        "run", "--rm",
        "--user", hostUser(),
        "-e", "PGHOST", "-e", "PGPORT", "-e", "PGDATABASE", "-e", "PGUSER",
        "-e", "PGPASSWORD", "-e", "PGSSLMODE", "-e", "PGSSLROOTCERT", "-e", "PGCHANNELBINDING",
        "-v", `${backupDir}:/backup`,
        clientImage(),
        "pg_dump", "--format=custom", "--no-owner", "--no-acl", "--file", `/backup/${basename(output)}`
      ];
  if (!local) console.log("pg_dump local ausente; usando cliente PostgreSQL em container.");
  await run(command, args, childEnv);
}

async function verifyDatabaseDump(output) {
  if (commandAvailable("pg_restore")) {
    await run("pg_restore", ["--list", output], process.env, "ignore");
    return;
  }
  await run("docker", [
    "run", "--rm", "--user", hostUser(),
    "-v", `${backupDir}:/backup:ro`,
    clientImage(), "pg_restore", "--list", `/backup/${basename(output)}`
  ], process.env, "ignore");
}

async function createUploadsArchive(output) {
  const source = localUploadSource();
  if (source) {
    if (!commandAvailable("tar")) throw new Error("Comando tar obrigatorio para backup local de uploads.");
    await runToHostFile("tar", ["-czf", "-", "-C", source, "."], process.env, output);
    return;
  }
  await runToHostFile(
    "docker",
    dockerUploadsArchiveArgs(process.env.BACKUP_UPLOAD_DOCKER_VOLUME),
    process.env,
    output
  );
}

async function validateUploadSourceAvailability() {
  if (localUploadSource()) return;
  const volume = String(process.env.BACKUP_UPLOAD_DOCKER_VOLUME || "").trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(volume)) {
    throw new Error("BACKUP_UPLOAD_DOCKER_VOLUME possui nome invalido.");
  }
  // `docker run -v nome:/destino` creates a missing named volume. Inspecting it
  // first makes a typo fail closed instead of producing a valid but empty tar.
  await run("docker", ["volume", "inspect", volume], process.env, "ignore");
}

export function dockerUploadsArchiveArgs(volume) {
  return [
    "run", "--rm",
    "--network", "none",
    "--read-only",
    "--security-opt", "no-new-privileges:true",
    "--cap-drop", "ALL",
    "--cap-add", "DAC_READ_SEARCH",
    "-v", `${volume}:/uploads:ro`,
    clientImage(), "tar", "-czf", "-", "-C", "/uploads", "."
  ];
}

async function verifyUploadsArchive(output) {
  if (commandAvailable("tar")) {
    await run("tar", ["-tzf", output], process.env, "ignore");
    return;
  }
  await run("docker", [
    "run", "--rm", "--user", hostUser(),
    "-v", `${backupDir}:/backup:ro`,
    clientImage(), "tar", "-tzf", `/backup/${basename(output)}`
  ], process.env, "ignore");
}

function localUploadSource() {
  const candidate = process.env.BACKUP_UPLOAD_SOURCE;
  if (!candidate) return "";
  const source = resolve(candidate);
  return existsSync(source) && statSync(source).isDirectory() ? source : "";
}

function uploadSourceDescription() {
  return localUploadSource()
    ? `directory:${localUploadSource()}`
    : `docker-volume:${process.env.BACKUP_UPLOAD_DOCKER_VOLUME}`;
}

function clientImage() {
  return process.env.POSTGRES_CLIENT_IMAGE || "postgres:17-alpine";
}

function hostUser() {
  return `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;
}

function commandAvailable(command) {
  return !spawnSync(command, ["--version"], { stdio: "ignore" }).error;
}

function run(command, args, env, stderr = "inherit", stdout = "ignore") {
  return new Promise((resolvePromise, reject) => {
    let timedOut = false;
    let forceTimer;
    const child = spawn(command, args, {
      env,
      stdio: ["ignore", stdout, stderr]
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
      forceTimer.unref();
    }, positiveInteger("BACKUP_COMMAND_TIMEOUT_MS", 900000));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`Falha ao iniciar ${command}: ${error.message}`));
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      clearTimeout(forceTimer);
      if (timedOut) reject(new Error(`${command} excedeu BACKUP_COMMAND_TIMEOUT_MS.`));
      else if (code === 0) resolvePromise();
      else reject(new Error(`${command} encerrou com codigo ${code ?? "desconhecido"}.`));
    });
  });
}

async function runToHostFile(command, args, env, output) {
  const descriptor = openSync(output, "wx", 0o600);
  try {
    await run(command, args, env, "inherit", descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export async function verifyBackupManifest(manifestFile, directory = backupDir) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  } catch {
    throw new Error("Manifesto do backup nao e JSON valido.");
  }
  if (manifest.version !== 1 || !["application-stopped", "storage-snapshot"].includes(manifest.consistency)) {
    throw new Error("Manifesto do backup possui versao ou consistencia invalida.");
  }
  for (const [label, entry] of [["database", manifest.database], ["uploads", manifest.uploads]]) {
    if (!entry || basename(String(entry.file || "")) !== entry.file) {
      throw new Error(`Manifesto possui caminho invalido para ${label}.`);
    }
    const file = join(directory, entry.file);
    const metadata = statSync(file);
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size !== entry.size) {
      throw new Error(`Tamanho de ${label} diverge do manifesto.`);
    }
    if (!/^[a-f0-9]{64}$/i.test(String(entry.sha256 || "")) || await sha256(file) !== entry.sha256) {
      throw new Error(`SHA-256 de ${label} diverge do manifesto.`);
    }
  }
  return manifest;
}

function pruneVerifiedBackups(currentManifest) {
  const retentionCount = positiveInteger("BACKUP_RETENTION_COUNT", 10);
  const retentionDays = positiveInteger("BACKUP_RETENTION_DAYS", 30);
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const manifests = readdirSync(backupDir)
    .filter((name) => /^backup-.+\.json$/.test(name))
    .map((name) => join(backupDir, name))
    .filter((file) => file !== currentManifest)
    .sort((first, second) => statSync(second).mtimeMs - statSync(first).mtimeMs);

  for (const [index, manifestFile] of manifests.entries()) {
    if (index < retentionCount - 1 || statSync(manifestFile).mtimeMs >= cutoff) continue;
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
    } catch {
      // An unreadable manifest is not proof that its companion files form a
      // verified backup, so leave it for manual investigation.
      continue;
    }
    for (const name of [manifest.database?.file, manifest.uploads?.file, basename(manifestFile)]) {
      if (!name || basename(name) !== name) continue;
      rmSync(join(backupDir, name), { force: true });
    }
  }
}

function positiveInteger(name, fallback) {
  const raw = process.env[name] || String(fallback);
  if (!/^\d+$/.test(raw) || Number(raw) <= 0 || !Number.isSafeInteger(Number(raw))) {
    throw new Error(`${name} deve ser um inteiro positivo.`);
  }
  return Number(raw);
}

function sha256(file) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolvePromise(hash.digest("hex")));
  });
}

function loadEnvironmentFile() {
  const file = resolve(process.env.ENV_FILE || ".env.production");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [key, ...parts] = trimmed.split("=");
    if (!key || process.env[key]) continue;
    process.env[key] = parts.join("=").trim();
  }
}

function isMainModule() {
  return process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
}

if (isMainModule()) {
  await runProductionBackup();
}
