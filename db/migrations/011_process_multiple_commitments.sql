BEGIN;

DROP INDEX IF EXISTS app_processes_numero_processo_uidx;

CREATE INDEX IF NOT EXISTS app_processes_numero_processo_idx
  ON app_processes ((regexp_replace(lower(data->>'numeroProcesso'), '[^a-z0-9]', '', 'g')))
  WHERE COALESCE(data->>'numeroProcesso', '') <> ''
    AND COALESCE((data->>'inativo')::boolean, false) = false;

INSERT INTO app_schema_migrations (version)
VALUES ('011_process_multiple_commitments')
ON CONFLICT (version) DO NOTHING;

COMMIT;
