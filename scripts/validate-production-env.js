import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

loadEnvironmentFile();

const errors = [];

required("DATABASE_URL");
if (process.env.DB_SSL !== "true") errors.push("DB_SSL deve ser true em producao.");
validateDatabaseUrl("DATABASE_URL", false);
validateDatabaseUrl("DATABASE_URL_MIGRATION", false);
paired("LOCAL_ADMIN_EMAIL", "LOCAL_ADMIN_PASSWORD");
paired("GMAIL_USER", "GMAIL_APP_PASSWORD");
paired("SMTP_USER", "SMTP_PASS");
if (!(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) && !(process.env.SMTP_USER && process.env.SMTP_PASS)) {
  errors.push("Configure credenciais SMTP por GMAIL_USER/GMAIL_APP_PASSWORD ou SMTP_USER/SMTP_PASS.");
}
if (process.env.SMTP_USER && !process.env.SMTP_HOST) errors.push("SMTP_HOST e obrigatorio ao usar SMTP_USER.");
if (process.env.SMTP_USER && !process.env.EMAIL_FROM_ADDRESS && !process.env.GMAIL_USER) {
  errors.push("EMAIL_FROM_ADDRESS e obrigatorio ao usar SMTP_USER.");
}
if (process.env.EMAIL_FROM_ADDRESS && !isEmail(process.env.EMAIL_FROM_ADDRESS)) {
  errors.push("EMAIL_FROM_ADDRESS deve ser um endereco de e-mail valido.");
}
required("EMAIL_TEST_RECIPIENT");
if (!process.env.ADMIN_EMAILS && !(process.env.LOCAL_ADMIN_EMAIL && process.env.LOCAL_ADMIN_PASSWORD)) {
  errors.push("Configure ADMIN_EMAILS ou uma conta LOCAL_ADMIN completa.");
}

if (process.env.LOCAL_ADMIN_PASSWORD && process.env.LOCAL_ADMIN_PASSWORD.length < 12) {
  errors.push("LOCAL_ADMIN_PASSWORD deve ter ao menos 12 caracteres.");
}
if (process.env.GOOGLE_CLIENT_ID && !process.env.GOOGLE_ALLOWED_DOMAINS) {
  errors.push("GOOGLE_ALLOWED_DOMAINS e obrigatorio quando GOOGLE_CLIENT_ID estiver configurado.");
}
for (const name of ["SESSION_TIMEOUT_MS", "LOGIN_RATE_LIMIT_WINDOW_MS", "LOGIN_RATE_LIMIT_MAX", "MAX_JSON_BODY_BYTES", "MAX_UPLOAD_BYTES"]) {
  positiveInteger(name);
}

if (errors.length) {
  errors.forEach((error) => console.error(`- ${error}`));
  process.exit(1);
}
console.log("Configuracao de producao valida (segredos nao exibidos).");

function required(name) {
  if (!process.env[name]) errors.push(`${name} e obrigatorio.`);
}

function paired(first, second) {
  if (Boolean(process.env[first]) !== Boolean(process.env[second])) {
    errors.push(`${first} e ${second} devem ser configurados juntos.`);
  }
}

function positiveInteger(name) {
  const value = process.env[name];
  if (value && (!/^\d+$/.test(value) || Number(value) <= 0)) errors.push(`${name} deve ser um inteiro positivo.`);
}

function isEmail(value) {
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(String(value).trim());
}

function validateDatabaseUrl(name = "DATABASE_URL", requiredValue = true) {
  if (!process.env[name]) {
    if (requiredValue) errors.push(`${name} e obrigatorio.`);
    return;
  }
  try {
    const url = new URL(process.env[name]);
    if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error();
    if (!url.hostname || !url.pathname.slice(1)) throw new Error();
    if (!["require", "verify-full"].includes(url.searchParams.get("sslmode"))) {
      errors.push(`${name} deve incluir sslmode=require ou sslmode=verify-full.`);
    }
  } catch {
    errors.push(`${name} deve ser uma URL PostgreSQL valida com host e database.`);
  }
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
