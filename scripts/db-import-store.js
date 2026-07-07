import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { closePool, databaseConfigured, transaction } from "../src/db/postgres.js";

const storePath = fileURLToPath(new URL("../data/store.json", import.meta.url));

if (!databaseConfigured()) {
  console.error("DATABASE_URL nao configurada.");
  process.exit(1);
}

try {
  const raw = await readFile(storePath, "utf8");
  const store = JSON.parse(raw);
  await importStore(store);
  console.log("data/store.json importado para o PostgreSQL com sucesso.");
} catch (error) {
  console.error(`Falha ao importar store.json: ${error.message}`);
  process.exitCode = 1;
} finally {
  await closePool().catch(() => null);
}

async function importStore(store) {
  await transaction(async (client) => {
    await importUsers(client, store.usuarios || []);
    await importSettings(client, store.configuracoes || {});
  });
}

async function importUsers(client, users) {
  for (const user of users) {
    await client.query(`
      INSERT INTO app_users (
        id, nome, email, foto_url, google_sub, origem_cadastro, senha_hash,
        precisa_definir_senha, ativo, criado_em, atualizado_em
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10::timestamptz, now()), COALESCE($11::timestamptz, now()))
      ON CONFLICT (id) DO UPDATE SET
        nome = EXCLUDED.nome,
        email = EXCLUDED.email,
        foto_url = EXCLUDED.foto_url,
        google_sub = EXCLUDED.google_sub,
        origem_cadastro = EXCLUDED.origem_cadastro,
        senha_hash = EXCLUDED.senha_hash,
        precisa_definir_senha = EXCLUDED.precisa_definir_senha,
        ativo = EXCLUDED.ativo,
        atualizado_em = EXCLUDED.atualizado_em
    `, [
      textId(user.id),
      text(user.nome || user.name || user.email || "Usuario"),
      normalizeEmail(user.email),
      text(user.foto || user.fotoUrl),
      nullableText(user.googleSub),
      text(user.origemCadastro || "local"),
      text(user.senhaHash),
      Boolean(user.precisaDefinirSenha),
      user.ativo !== false,
      timestamp(user.criadoEm),
      timestamp(user.atualizadoEm)
    ]);
  }
}

async function importSettings(client, settings) {
  const templates = settings.emailTemplates || {};
  const rules = settings.notificationRules || {};
  const recipients = settings.responsaveis || [];

  await client.query("DELETE FROM email_template_attachments");
  await client.query("DELETE FROM email_templates");
  for (const [templateKey, template] of Object.entries(templates)) {
    await client.query(
      "INSERT INTO email_templates (template_key, assunto, corpo, atualizado_em) VALUES ($1, $2, $3, now())",
      [templateKey, text(template.assunto), text(template.corpo)]
    );

    for (const attachment of Array.isArray(template.anexos) ? template.anexos : []) {
      await client.query(`
        INSERT INTO email_template_attachments (
          id, template_key, file_name, storage_key, public_path, mime_type, uploaded_by_name, uploaded_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::timestamptz, now()))
      `, [
        textId(attachment.id),
        templateKey,
        text(attachment.fileName),
        storageKey(attachment.path, attachment.fileName),
        text(attachment.path),
        text(attachment.mimeType),
        text(attachment.uploadedBy),
        timestamp(attachment.uploadedAt)
      ]);
    }
  }

  await client.query(`
    INSERT INTO notification_rules (id, dias_aviso_interno, dia_oficio_fornecedor, atualizado_em)
    VALUES (true, $1::integer[], $2, now())
    ON CONFLICT (id) DO UPDATE SET
      dias_aviso_interno = EXCLUDED.dias_aviso_interno,
      dia_oficio_fornecedor = EXCLUDED.dia_oficio_fornecedor,
      atualizado_em = EXCLUDED.atualizado_em
  `, [
    Array.isArray(rules.diasAvisoInterno) ? rules.diasAvisoInterno.map(Number).filter(Boolean) : [14, 21, 28],
    Number(rules.diaOficioFornecedor || 31)
  ]);

  await client.query("DELETE FROM notification_recipients");
  for (const recipient of recipients) {
    await client.query(`
      INSERT INTO notification_recipients (id, nome, email, funcao, ativo, criado_em, atualizado_em)
      VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, now()), COALESCE($7::timestamptz, now()))
    `, [
      textId(recipient.id),
      text(recipient.nome),
      normalizeEmail(recipient.email),
      text(recipient.funcao),
      recipient.ativo !== false,
      timestamp(recipient.criadoEm),
      timestamp(recipient.atualizadoEm)
    ]);
  }

  await client.query(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES ('configuracoes', $1::jsonb, now())
    ON CONFLICT (key) DO UPDATE SET
      value = EXCLUDED.value,
      updated_at = EXCLUDED.updated_at
  `, [JSON.stringify(settings)]);
}

function text(value = "") {
  return String(value ?? "").trim();
}

function nullableText(value = "") {
  const result = text(value);
  return result || null;
}

function textId(value = "") {
  return text(value) || crypto.randomUUID();
}

function normalizeEmail(value = "") {
  return String(value).trim().toLowerCase();
}

function timestamp(value = "") {
  const result = text(value);
  if (!result) return null;
  const parsed = new Date(result);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function storageKey(path = "", fileName = "") {
  return text(path) || `${crypto.randomUUID()}-${text(fileName || "arquivo")}`;
}
