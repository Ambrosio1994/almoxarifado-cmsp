BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS app_processes_numero_processo_uidx
  ON app_processes ((regexp_replace(lower(data->>'numeroProcesso'), '[^a-z0-9]', '', 'g')))
  WHERE COALESCE(data->>'numeroProcesso', '') <> ''
    AND COALESCE((data->>'inativo')::boolean, false) = false;

CREATE UNIQUE INDEX IF NOT EXISTS app_processes_numero_empenho_uidx
  ON app_processes ((regexp_replace(lower(data->>'numeroEmpenho'), '[^a-z0-9]', '', 'g')))
  WHERE COALESCE(data->>'numeroEmpenho', '') <> ''
    AND COALESCE((data->>'inativo')::boolean, false) = false;

CREATE INDEX IF NOT EXISTS app_processes_status_idx
  ON app_processes ((data->>'status'));

CREATE INDEX IF NOT EXISTS app_processes_fornecedor_idx
  ON app_processes (lower(data->>'fornecedor'));

CREATE OR REPLACE FUNCTION prevent_process_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'app_process_audit is append-only';
END;
$$;

DROP TRIGGER IF EXISTS app_process_audit_immutable ON app_process_audit;
CREATE TRIGGER app_process_audit_immutable
BEFORE UPDATE OR DELETE ON app_process_audit
FOR EACH ROW EXECUTE FUNCTION prevent_process_audit_mutation();

COMMIT;
