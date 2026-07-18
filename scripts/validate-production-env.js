import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isValidPassword, PASSWORD_POLICY_MESSAGE } from "../src/security/password-policy.js";

let errors = [];

export function validateProductionEnvironment() {
  const duplicatedEnvironmentKeys = loadEnvironmentFile();
  errors = duplicatedEnvironmentKeys.map((key) => `${key} esta definido mais de uma vez no arquivo de ambiente.`);

  required("DATABASE_URL");
  if (process.env.DB_SSL !== "true") errors.push("DB_SSL deve ser true em producao.");
  if (process.env.DB_CA_CERT_PATH && !existsSync(resolve(process.env.DB_CA_CERT_PATH))) {
    errors.push("DB_CA_CERT_PATH nao existe ou nao esta acessivel.");
  }
  validateDatabaseUrl("DATABASE_URL", false);
  validateDatabaseUrl("DATABASE_URL_MIGRATION", false);
  validateDatabaseUrl("TEST_DATABASE_URL", false);
  validateTestDatabaseTarget();
  paired("LOCAL_ADMIN_EMAIL", "LOCAL_ADMIN_PASSWORD");
  paired("GMAIL_USER", "GMAIL_APP_PASSWORD");
  paired("SMTP_USER", "SMTP_PASS");
  errors.push(...validateAdminBootstrap(process.env));
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
  validateUploadStorage(process.env);

  if (process.env.LOCAL_ADMIN_PASSWORD && !isValidPassword(process.env.LOCAL_ADMIN_PASSWORD)) {
    errors.push(`LOCAL_ADMIN_PASSWORD invalida. ${PASSWORD_POLICY_MESSAGE}`);
  }
  for (const name of [
    "SESSION_TIMEOUT_MS",
    "SESSION_COOKIE_MAX_AGE_MS",
    "LOGIN_RATE_LIMIT_WINDOW_MS",
    "LOGIN_RATE_LIMIT_MAX",
    "AUTH_MAX_BODY_BYTES",
    "ADMIN_MAX_BODY_BYTES",
    "LOGIN_SCRYPT_CONCURRENCY",
    "LOGIN_SCRYPT_MAX_QUEUE",
    "MAX_JSON_BODY_BYTES",
    "MAX_UPLOAD_BYTES",
    "MAX_PROCESS_UPLOAD_BYTES",
    "MAX_TEMPLATE_UPLOAD_BYTES",
    "MAX_PROCESS_DOCUMENTS",
    "MAX_TEMPLATE_ATTACHMENTS",
    "MAX_COMPILED_DOWNLOAD_BYTES",
    "MAX_COMPILED_DOWNLOADS",
    "PDF_COMMAND_TIMEOUT_MS",
    "SMTP_CONNECT_TIMEOUT_MS",
    "SMTP_COMMAND_TIMEOUT_MS",
    "EMAIL_DISPATCH_LEASE_MS",
    "EMAIL_CHECK_INTERVAL_MS",
    "DASHBOARD_CACHE_TTL_MS",
    "DB_SLOW_QUERY_MS"
  ]) {
    positiveInteger(name);
  }
  if (positiveIntegerValue("SESSION_COOKIE_MAX_AGE_MS") < positiveIntegerValue("SESSION_TIMEOUT_MS")) {
    errors.push("SESSION_COOKIE_MAX_AGE_MS deve ser maior ou igual a SESSION_TIMEOUT_MS.");
  }
  for (const name of ["AUTH_MAX_BODY_BYTES", "ADMIN_MAX_BODY_BYTES"]) {
    if (positiveIntegerValue(name) > positiveIntegerValue("MAX_JSON_BODY_BYTES")) {
      errors.push(`${name} deve ser menor ou igual a MAX_JSON_BODY_BYTES.`);
    }
  }
  return [...errors];
}

export function validateAdminBootstrap(environment = {}) {
  const adminErrors = [];
  const localAdminConfigured = Boolean(environment.LOCAL_ADMIN_EMAIL && environment.LOCAL_ADMIN_PASSWORD);
  const existingAdminConfirmation = environment.CONFIRM_EXISTING_ADMIN_PROVISIONED;
  if (existingAdminConfirmation && !["true", "false"].includes(existingAdminConfirmation)) {
    adminErrors.push("CONFIRM_EXISTING_ADMIN_PROVISIONED deve ser true ou false.");
  }
  if (environment.LOCAL_ADMIN_EMAIL && !isEmail(environment.LOCAL_ADMIN_EMAIL)) {
    adminErrors.push("LOCAL_ADMIN_EMAIL deve ser um endereco de e-mail valido.");
  }
  const adminEmails = String(environment.ADMIN_EMAILS || "").split(",").map((email) => email.trim()).filter(Boolean);
  if (adminEmails.some((email) => !isEmail(email))) {
    adminErrors.push("ADMIN_EMAILS deve conter somente enderecos de e-mail validos separados por virgula.");
  }
  if (!localAdminConfigured && !(adminEmails.length && existingAdminConfirmation === "true")) {
    adminErrors.push("Configure LOCAL_ADMIN_EMAIL/LOCAL_ADMIN_PASSWORD para bootstrap ou, somente em banco ja provisionado, ADMIN_EMAILS e CONFIRM_EXISTING_ADMIN_PROVISIONED=true.");
  }
  return adminErrors;
}

export function validateUploadStorage(environment = {}) {
  const uploadErrors = [];
  const backend = String(environment.UPLOAD_STORAGE_BACKEND || "local").trim().toLowerCase();
  if (!["local", "drive"].includes(backend)) {
    uploadErrors.push("UPLOAD_STORAGE_BACKEND deve ser local ou drive.");
    return uploadErrors;
  }
  if (backend !== "drive") return uploadErrors;
  if (!String(environment.GOOGLE_DRIVE_FOLDER_ID || "").trim()) {
    uploadErrors.push("GOOGLE_DRIVE_FOLDER_ID e obrigatoria quando UPLOAD_STORAGE_BACKEND=drive.");
  }
  for (const name of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"]) {
    if (!String(environment[name] || "").trim()) {
      uploadErrors.push(`${name} e obrigatoria quando UPLOAD_STORAGE_BACKEND=drive.`);
    }
  }
  return uploadErrors;
}

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

function positiveIntegerValue(name) {
  const value = process.env[name];
  return /^\d+$/.test(String(value || "")) && Number(value) > 0 ? Number(value) : Number.NaN;
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
    if (/^(APP_USER|MIGRATION_USER)$/i.test(decodeURIComponent(url.username)) || /YOUR_|APP_USER|MIGRATION_USER/i.test(url.hostname)) {
      errors.push(`${name} ainda contem marcadores do arquivo de exemplo.`);
      return;
    }
    if (!["require", "verify-full"].includes(url.searchParams.get("sslmode"))) {
      errors.push(`${name} deve incluir sslmode=require ou sslmode=verify-full.`);
    }
  } catch {
    errors.push(`${name} deve ser uma URL PostgreSQL valida com host e database.`);
  }
}

function validateTestDatabaseTarget() {
  if (!process.env.TEST_DATABASE_URL) return;
  let test;
  try {
    test = databaseTarget(process.env.TEST_DATABASE_URL);
  } catch {
    return;
  }
  if (!/(?:^|[_-])test(?:$|[_-])|test/i.test(test.database)) {
    errors.push("TEST_DATABASE_URL deve apontar para um database identificado como teste.");
  }
  for (const name of ["DATABASE_URL", "DATABASE_URL_MIGRATION"]) {
    if (!process.env[name]) continue;
    try {
      const target = databaseTarget(process.env[name]);
      if (target.host === test.host && target.port === test.port && target.database === test.database) {
        errors.push(`TEST_DATABASE_URL nao pode apontar para o mesmo banco de ${name}.`);
      }
    } catch {
      // The regular URL validator reports malformed values.
    }
  }
}

function databaseTarget(value) {
  const url = new URL(value);
  return {
    host: url.hostname.toLowerCase(),
    port: url.port || "5432",
    database: decodeURIComponent(url.pathname.slice(1)).toLowerCase()
  };
}

function loadEnvironmentFile() {
  const file = resolve(process.env.ENV_FILE || ".env.production");
  if (!existsSync(file)) return [];
  const seen = new Set();
  const duplicates = new Set();
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [key, ...parts] = trimmed.split("=");
    if (!key) continue;
    if (seen.has(key)) duplicates.add(key);
    seen.add(key);
    if (process.env[key]) continue;
    process.env[key] = parts.join("=").trim();
  }
  return [...duplicates];
}

function isMainModule() {
  return process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
}

if (isMainModule()) {
  const validationErrors = validateProductionEnvironment();
  if (validationErrors.length) {
    validationErrors.forEach((error) => console.error(`- ${error}`));
    process.exit(1);
  }
  console.log("Configuracao de producao valida (segredos nao exibidos).");
}
