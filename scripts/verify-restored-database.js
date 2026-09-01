import { readdir } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createPoolConfig } from "../src/db/postgres.js";

export function databaseTarget(url, name) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${name} deve ser uma URL PostgreSQL valida.`);
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname || !parsed.pathname.slice(1)) {
    throw new Error(`${name} deve ser uma URL PostgreSQL valida com host e database.`);
  }
  return {
    host: parsed.hostname.toLowerCase(),
    port: parsed.port || "5432",
    database: decodeURIComponent(parsed.pathname.slice(1)).toLowerCase()
  };
}

export function assertRestoreTargetSafe(restoreUrl, environment = process.env) {
  const restore = databaseTarget(restoreUrl, "RESTORE_DATABASE_URL");
  for (const [name, url] of [["DATABASE_URL", environment.DATABASE_URL], ["DATABASE_URL_MIGRATION", environment.DATABASE_URL_MIGRATION]]) {
    if (!url) continue;
    const candidate = databaseTarget(url, name);
    if (restore.host === candidate.host && restore.port === candidate.port && restore.database === candidate.database) {
      throw new Error(`RESTORE_DATABASE_URL nao pode apontar para o mesmo banco de ${name}.`);
    }
  }
  return restore;
}

export function collectUploadPaths(records = [], settings = {}) {
  const references = new Set();
  const add = (value) => {
    const path = String(typeof value === "string" ? value : value?.path || "");
    if (path.startsWith("/uploads/")) references.add(path);
  };
  for (const record of records) {
    for (const value of Object.values(record?.documentos || {})) {
      if (Array.isArray(value)) value.forEach(add);
      else add(value);
    }
  }
  for (const template of Object.values(settings?.emailTemplates || {})) {
    for (const attachment of template?.anexos || []) add(attachment);
  }
  return references;
}

export async function verifyRestoredDatabase(options = {}) {
  const environment = options.environment || process.env;
  const databaseUrl = options.databaseUrl || environment.RESTORE_DATABASE_URL;
  if (!databaseUrl) throw new Error("RESTORE_DATABASE_URL e obrigatoria.");
  if ((options.confirmation || environment.RESTORE_DATABASE_CONFIRMATION) !== "isolated-restored") {
    throw new Error("Defina RESTORE_DATABASE_CONFIRMATION=isolated-restored apos confirmar o alvo isolado.");
  }
  const target = assertRestoreTargetSafe(databaseUrl, environment);
  const client = options.client || new pg.Client(createPoolConfig(databaseUrl));
  const ownsClient = !options.client;
  try {
    if (ownsClient) await client.connect();
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const migrations = await client.query("SELECT version FROM app_schema_migrations ORDER BY version");
    const counts = await client.query(`SELECT
        (SELECT count(*)::int FROM app_processes) AS processes,
        (SELECT COALESCE(sum(jsonb_array_length(COALESCE(data->'materiais', '[]'::jsonb))), 0)::int FROM app_processes) AS items,
        (SELECT count(*)::int FROM app_users) AS users,
        (SELECT count(*)::int FROM app_process_audit) AS process_audit,
        (SELECT count(*)::int FROM app_security_audit) AS security_audit`);
    const orphans = await client.query(`SELECT
        (SELECT count(*)::int FROM app_process_observations o LEFT JOIN app_processes p ON p.id = o.processo_id WHERE p.id IS NULL) AS observations,
        (SELECT count(*)::int FROM app_process_audit a LEFT JOIN app_processes p ON p.id = a.processo_id WHERE p.id IS NULL) AS process_audit,
        (SELECT count(*)::int FROM app_email_history e LEFT JOIN app_processes p ON p.id = e.processo_id WHERE e.processo_id IS NOT NULL AND p.id IS NULL) AS email_history,
        (SELECT count(*)::int FROM user_sessions s LEFT JOIN app_users u ON u.id = s.user_id WHERE u.id IS NULL) AS sessions`);
    const processes = await client.query("SELECT data FROM app_processes");
    const settings = await client.query("SELECT value FROM app_settings WHERE key = 'configuracoes' LIMIT 1");
    await client.query("COMMIT");
    const expectedMigrations = (await readdir(new URL("../db/migrations/", import.meta.url)))
      .filter((name) => /^\d+_.+\.sql$/.test(name))
      .map((name) => name.replace(/\.sql$/, ""))
      .sort();
    const applied = new Set(migrations.rows.map((row) => row.version));
    const missingMigrations = expectedMigrations.filter((version) => !applied.has(version));
    const countRow = counts.rows[0];
    const orphanRow = orphans.rows[0];
    const referencePaths = collectUploadPaths(processes.rows.map((row) => row.data), settings.rows[0]?.value);
    const uploadCheck = verifyUploadReferences(referencePaths, options.uploadRoot || environment.RESTORE_UPLOAD_ROOT);
    const errors = [
      ...missingMigrations.map((version) => `migration-missing:${version}`),
      ...Object.entries(orphanRow).filter(([, count]) => Number(count) > 0).map(([name, count]) => `orphan:${name}=${count}`),
      ...uploadCheck.errors,
      ...restoreBaselineErrors(countRow, environment)
    ];
    return {
      target,
      migrations: { expected: expectedMigrations.length, applied: applied.size, missing: missingMigrations },
      counts: countRow,
      orphans: orphanRow,
      uploads: { referenced: referencePaths.size, ...uploadCheck.summary },
      valid: errors.length === 0,
      errors
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => null);
    throw error;
  } finally {
    if (ownsClient) await client.end();
  }
}

export function restoreBaselineErrors(counts = {}, environment = {}) {
  return ["processes", "items", "users", "process_audit", "security_audit"].flatMap((field) => {
    const key = `RESTORE_EXPECTED_${field.toUpperCase()}`;
    const expected = environment[key];
    if (expected === undefined || expected === "") return [`baseline-missing:${field}`];
    if (!/^\d+$/.test(String(expected))) return [`baseline-invalid:${field}`];
    return Number(counts[field]) === Number(expected) ? [] : [`count-mismatch:${field}`];
  });
}

function verifyUploadReferences(references, uploadRoot) {
  if (!uploadRoot) return { summary: { checked: false, missing: null }, errors: ["uploads:not-checked"] };
  const root = resolve(uploadRoot);
  if (!existsSync(root) || !statSync(root).isDirectory()) return { summary: { checked: false, missing: null }, errors: ["uploads:root-unavailable"] };
  const missing = [];
  for (const publicPath of references) {
    const candidate = resolve(root, publicPath.replace(/^\/uploads\/+/, ""));
    const relativePath = relative(root, candidate);
    if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath) || !existsSync(candidate)) missing.push(publicPath);
  }
  return { summary: { checked: true, missing: missing.length }, errors: missing.length ? ["uploads:missing-references"] : [] };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const report = await verifyRestoredDatabase();
    console.log(JSON.stringify(report, null, 2));
    if (!report.valid) process.exitCode = 2;
  } catch (error) {
    console.error(JSON.stringify({ event: "restore_validation_failed", message: String(error?.message || "Erro de validacao").replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[database-url-redacted]") }));
    process.exitCode = 1;
  }
}
