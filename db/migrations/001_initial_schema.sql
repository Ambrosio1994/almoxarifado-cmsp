-- Initial PostgreSQL schema for Almoxarifado CMSP.
-- This schema mirrors the current JSON store while preparing the app for
-- transactional persistence, auditability, and multi-instance deployment.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE IF NOT EXISTS app_schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
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
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);

CREATE INDEX IF NOT EXISTS user_sessions_user_idx ON user_sessions(user_id);
CREATE INDEX IF NOT EXISTS user_sessions_active_idx
  ON user_sessions(expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS suppliers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  razao_social text NOT NULL,
  razao_social_normalizada text GENERATED ALWAYS AS (
    upper(regexp_replace(coalesce(razao_social, ''), '[^[:alnum:]]', '', 'g'))
  ) STORED,
  email_principal citext,
  telefone_principal text NOT NULL DEFAULT '',
  endereco_principal text NOT NULL DEFAULT '',
  observacoes text NOT NULL DEFAULT '',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS suppliers_razao_social_normalizada_uidx
  ON suppliers(razao_social_normalizada)
  WHERE razao_social_normalizada <> '';

CREATE TABLE IF NOT EXISTS supplier_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id uuid NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  tipo text NOT NULL CHECK (tipo IN ('email', 'telefone', 'endereco')),
  valor text NOT NULL,
  principal boolean NOT NULL DEFAULT false,
  criado_em timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS supplier_contacts_supplier_idx ON supplier_contacts(supplier_id);

CREATE TABLE IF NOT EXISTS processes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  numero_processo text NOT NULL DEFAULT '',
  numero_processo_normalizado text GENERATED ALWAYS AS (
    upper(regexp_replace(coalesce(numero_processo, ''), '[^[:alnum:]]', '', 'g'))
  ) STORED,
  numero_empenho text NOT NULL DEFAULT '',
  numero_empenho_normalizado text GENERATED ALWAYS AS (
    upper(regexp_replace(coalesce(numero_empenho, ''), '[^[:alnum:]]', '', 'g'))
  ) STORED,
  numero_nota_fiscal text NOT NULL DEFAULT '',
  supplier_id uuid REFERENCES suppliers(id) ON DELETE SET NULL,
  fornecedor_nome text NOT NULL DEFAULT '',
  data_envio_empenho date,
  data_envio_fornecedor date,
  data_entrega date,
  data_envio_liquidacao date,
  data_liquidacao date,
  data_pagamento date,
  status text NOT NULL DEFAULT 'Enviado para SALC'
    CHECK (status IN (
      'Enviado para SALC',
      'Empenho enviado ao fornecedor',
      'Aguardando entrega',
      'Entrega parcial',
      'Entregue',
      'Aguardando envio para liquidacao',
      'Enviado para liquidacao',
      'Liquidado',
      'Pago',
      'Anulado'
    )),
  motivo_anulacao text NOT NULL DEFAULT '',
  anulado_em timestamptz,
  anulado_por text NOT NULL DEFAULT '',
  criado_por_nome text NOT NULL DEFAULT '',
  criado_por_email citext,
  criado_por_user_id uuid REFERENCES app_users(id) ON DELETE SET NULL,
  versao integer NOT NULL DEFAULT 1 CHECK (versao >= 1),
  inativo boolean NOT NULL DEFAULT false,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS processes_numero_processo_uidx
  ON processes(numero_processo_normalizado)
  WHERE numero_processo_normalizado <> '' AND inativo = false;

CREATE UNIQUE INDEX IF NOT EXISTS processes_numero_empenho_uidx
  ON processes(numero_empenho_normalizado)
  WHERE numero_empenho_normalizado <> '' AND inativo = false;

CREATE INDEX IF NOT EXISTS processes_status_idx ON processes(status) WHERE inativo = false;
CREATE INDEX IF NOT EXISTS processes_supplier_idx ON processes(supplier_id);
CREATE INDEX IF NOT EXISTS processes_data_envio_fornecedor_idx
  ON processes(data_envio_fornecedor)
  WHERE inativo = false;

CREATE TABLE IF NOT EXISTS process_materials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  process_id uuid NOT NULL REFERENCES processes(id) ON DELETE CASCADE,
  descricao text NOT NULL,
  valor_unitario numeric(14, 2) NOT NULL DEFAULT 0 CHECK (valor_unitario >= 0),
  quantidade numeric(14, 3) NOT NULL DEFAULT 0 CHECK (quantidade >= 0),
  ordem integer NOT NULL DEFAULT 0,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS process_materials_process_idx ON process_materials(process_id, ordem);

CREATE TABLE IF NOT EXISTS process_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  process_id uuid NOT NULL REFERENCES processes(id) ON DELETE CASCADE,
  document_key text NOT NULL,
  titulo text NOT NULL DEFAULT '',
  descricao text NOT NULL DEFAULT '',
  file_name text NOT NULL,
  storage_key text NOT NULL UNIQUE,
  public_path text NOT NULL DEFAULT '',
  mime_type text NOT NULL DEFAULT '',
  size_bytes bigint NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
  checksum_sha256 text NOT NULL DEFAULT '',
  uploaded_by_name text NOT NULL DEFAULT '',
  uploaded_by_user_id uuid REFERENCES app_users(id) ON DELETE SET NULL,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE INDEX IF NOT EXISTS process_documents_process_idx ON process_documents(process_id);
CREATE UNIQUE INDEX IF NOT EXISTS process_documents_single_key_uidx
  ON process_documents(process_id, document_key)
  WHERE document_key <> 'complementares' AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS process_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  process_id uuid NOT NULL REFERENCES processes(id) ON DELETE CASCADE,
  usuario_nome text NOT NULL,
  user_id uuid REFERENCES app_users(id) ON DELETE SET NULL,
  conteudo text NOT NULL,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz
);

CREATE INDEX IF NOT EXISTS process_observations_process_idx
  ON process_observations(process_id, criado_em);

CREATE TABLE IF NOT EXISTS audit_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  process_id uuid REFERENCES processes(id) ON DELETE SET NULL,
  usuario_nome text NOT NULL,
  user_id uuid REFERENCES app_users(id) ON DELETE SET NULL,
  acao text NOT NULL,
  detalhes text NOT NULL DEFAULT '',
  documento jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  criado_em timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_entries_process_idx ON audit_entries(process_id, criado_em DESC);
CREATE INDEX IF NOT EXISTS audit_entries_created_idx ON audit_entries(criado_em DESC);

CREATE TABLE IF NOT EXISTS email_templates (
  template_key text PRIMARY KEY,
  assunto text NOT NULL,
  corpo text NOT NULL,
  atualizado_em timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS email_template_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_key text NOT NULL REFERENCES email_templates(template_key) ON DELETE CASCADE,
  file_name text NOT NULL,
  storage_key text NOT NULL UNIQUE,
  public_path text NOT NULL DEFAULT '',
  mime_type text NOT NULL DEFAULT '',
  size_bytes bigint NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
  uploaded_by_name text NOT NULL DEFAULT '',
  uploaded_by_user_id uuid REFERENCES app_users(id) ON DELETE SET NULL,
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
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome text NOT NULL,
  email citext NOT NULL,
  funcao text NOT NULL DEFAULT '',
  ativo boolean NOT NULL DEFAULT true,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS notification_recipients_email_uidx
  ON notification_recipients(email);

CREATE TABLE IF NOT EXISTS email_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dedupe_key text NOT NULL,
  process_id uuid REFERENCES processes(id) ON DELETE SET NULL,
  numero_processo text NOT NULL DEFAULT '',
  numero_empenho text NOT NULL DEFAULT '',
  tipo text NOT NULL,
  destinatarios_originais citext[] NOT NULL DEFAULT ARRAY[]::citext[],
  destinatarios_enviados citext[] NOT NULL DEFAULT ARRAY[]::citext[],
  assunto text NOT NULL DEFAULT '',
  status text NOT NULL CHECK (status IN ('enviado', 'erro')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  error_message text NOT NULL DEFAULT '',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  criado_em timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS email_history_dedupe_sent_uidx
  ON email_history(dedupe_key)
  WHERE status = 'enviado';

CREATE INDEX IF NOT EXISTS email_history_process_idx ON email_history(process_id, criado_em DESC);
CREATE INDEX IF NOT EXISTS email_history_created_idx ON email_history(criado_em DESC);

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
