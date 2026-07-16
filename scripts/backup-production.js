import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";

if (process.argv.includes("--help")) {
  console.log("Uso: NODE_ENV=production node scripts/backup-production.js [diretorio]");
  process.exit(0);
}

loadEnvironmentFile();

if (process.env.NODE_ENV !== "production") {
  throw new Error("O backup exige NODE_ENV=production para evitar uso do banco errado.");
}

const connectionString = process.env.DATABASE_URL_MIGRATION || process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL_MIGRATION ou DATABASE_URL nao configurada.");

const url = new URL(connectionString);
if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error("URL PostgreSQL invalida.");
const sslmode = url.searchParams.get("sslmode");
if (!["require", "verify-full"].includes(sslmode)) throw new Error("A URL de backup deve exigir SSL.");

const backupDir = resolve(process.argv[2] || process.env.BACKUP_DIR || "backups");
mkdirSync(backupDir, { recursive: true, mode: 0o700 });
chmodSync(backupDir, 0o700);
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const output = join(backupDir, `neon-${stamp}.dump`);
const childEnv = {
  ...process.env,
  PGHOST: url.hostname,
  PGPORT: url.port || "5432",
  PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
  PGUSER: decodeURIComponent(url.username),
  PGPASSWORD: decodeURIComponent(url.password),
  PGSSLMODE: sslmode,
  PGSSLROOTCERT: process.env.PGSSLROOTCERT || (sslmode === "verify-full" ? "system" : undefined),
  PGCHANNELBINDING: url.searchParams.get("channel_binding") || "prefer"
};

const pgDumpAvailable = !spawnSync("pg_dump", ["--version"], { stdio: "ignore" }).error;
const backupFile = output.split("/").pop();
const command = pgDumpAvailable ? "pg_dump" : "docker";
const args = pgDumpAvailable
  ? ["--format=custom", "--no-owner", "--no-acl", "--file", output]
  : [
      "run", "--rm",
      "--user", `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
      "-e", "PGHOST", "-e", "PGPORT", "-e", "PGDATABASE", "-e", "PGUSER",
      "-e", "PGPASSWORD", "-e", "PGSSLMODE", "-e", "PGSSLROOTCERT", "-e", "PGCHANNELBINDING",
      "-v", `${backupDir}:/backup`,
      process.env.POSTGRES_CLIENT_IMAGE || "postgres:17-alpine",
      "pg_dump", "--format=custom", "--no-owner", "--no-acl", "--file", `/backup/${backupFile}`
    ];

if (!pgDumpAvailable) console.log("pg_dump local ausente; usando cliente PostgreSQL em container.");

const child = spawn(command, args, {
  env: childEnv,
  stdio: ["ignore", "inherit", "inherit"]
});

child.on("error", (error) => {
  try { unlinkSync(output); } catch {}
  console.error(`Falha ao iniciar ${command}: ${error.message}`);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  if (code !== 0) {
    try { unlinkSync(output); } catch {}
    console.error("Backup falhou; descarte o arquivo incompleto.");
    process.exitCode = code || 1;
    return;
  }
  chmodSync(output, 0o600);
  console.log(`Backup criado com permissao 600: ${output}`);
});

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
