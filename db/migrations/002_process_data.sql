-- Process data moved from JSON storage to PostgreSQL.

BEGIN;

CREATE TABLE IF NOT EXISTS app_processes (
  id text PRIMARY KEY,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS app_processes_updated_idx
  ON app_processes(updated_at DESC);

CREATE TABLE IF NOT EXISTS app_suppliers (
  id text PRIMARY KEY,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS app_suppliers_updated_idx
  ON app_suppliers(updated_at DESC);

CREATE TABLE IF NOT EXISTS app_process_observations (
  id text PRIMARY KEY,
  processo_id text NOT NULL REFERENCES app_processes(id) ON DELETE CASCADE,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS app_process_observations_process_idx
  ON app_process_observations(processo_id, created_at DESC);

CREATE TABLE IF NOT EXISTS app_process_audit (
  id text PRIMARY KEY,
  processo_id text NOT NULL REFERENCES app_processes(id) ON DELETE CASCADE,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS app_process_audit_process_idx
  ON app_process_audit(processo_id, created_at DESC);

CREATE TABLE IF NOT EXISTS app_email_history (
  id text PRIMARY KEY,
  dedupe_key text UNIQUE,
  processo_id text,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS app_email_history_process_idx
  ON app_email_history(processo_id, created_at DESC);

COMMIT;
