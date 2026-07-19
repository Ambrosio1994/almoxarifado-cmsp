-- Initial PostgreSQL schema for Almoxarifado.
-- This version intentionally excludes process data.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE IF NOT EXISTS app_schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_users (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  nome text NOT NULL,
  email citext NOT NULL UNIQUE,
  foto_url text NOT NULL DEFAULT '',
  google_sub text UNIQUE,
  origem_cadastro text NOT NULL DEFAULT 'local',
  senha_hash text NOT NULL DEFAULT '',
  precisa_definir_senha boolean NOT NULL DEFAULT false,
  role text NOT NULL DEFAULT 'almoxarifado'
    CHECK (role IN ('admin', 'almoxarifado', 'auditor')),
  ativo boolean NOT NULL DEFAULT true,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_sessions (
  token_hash text PRIMARY KEY,
  user_id text NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);

CREATE INDEX IF NOT EXISTS user_sessions_user_idx ON user_sessions(user_id);
CREATE INDEX IF NOT EXISTS user_sessions_active_idx
  ON user_sessions(expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS email_templates (
  template_key text PRIMARY KEY,
  assunto text NOT NULL,
  corpo text NOT NULL,
  atualizado_em timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS email_template_attachments (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  template_key text NOT NULL REFERENCES email_templates(template_key) ON DELETE CASCADE,
  file_name text NOT NULL,
  storage_key text NOT NULL UNIQUE,
  public_path text NOT NULL DEFAULT '',
  mime_type text NOT NULL DEFAULT '',
  size_bytes bigint NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
  uploaded_by_name text NOT NULL DEFAULT '',
  uploaded_by_user_id text REFERENCES app_users(id) ON DELETE SET NULL,
  uploaded_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS email_template_attachments_template_idx
  ON email_template_attachments(template_key);

CREATE TABLE IF NOT EXISTS notification_rules (
  id boolean PRIMARY KEY DEFAULT true CHECK (id = true),
  dias_aviso_interno integer[] NOT NULL DEFAULT ARRAY[14, 21, 28],
  dia_oficio_fornecedor integer NOT NULL DEFAULT 31 CHECK (dia_oficio_fornecedor > 0),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notification_recipients (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  nome text NOT NULL,
  email citext NOT NULL,
  funcao text NOT NULL DEFAULT '',
  ativo boolean NOT NULL DEFAULT true,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS notification_recipients_email_uidx
  ON notification_recipients(email);

CREATE TABLE IF NOT EXISTS app_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO email_templates (template_key, assunto, corpo)
VALUES
  (
    'avisoPrazos',
    'Aviso de prazo - Processo {numeroProcesso}',
    'O processo {numeroProcesso} do fornecedor {fornecedor} esta com {dias} dias desde o envio do empenho.'
  ),
  (
    'oficioFornecedor',
    'Oficio ao fornecedor - Empenho {numeroEmpenho}',
    'Prezado fornecedor, solicitamos atualizacao sobre a entrega vinculada ao empenho {numeroEmpenho}.'
  )
ON CONFLICT (template_key) DO NOTHING;

INSERT INTO notification_rules (id)
VALUES (true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO app_schema_migrations (version)
VALUES ('001_initial_schema')
ON CONFLICT (version) DO NOTHING;

COMMIT;
