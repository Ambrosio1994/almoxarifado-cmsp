BEGIN;

CREATE TABLE IF NOT EXISTS app_state_revision (
  id boolean PRIMARY KEY DEFAULT true CHECK (id = true),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0)
);

INSERT INTO app_state_revision (id, revision)
VALUES (true, 0)
ON CONFLICT (id) DO NOTHING;

INSERT INTO app_schema_migrations (version)
VALUES ('003_state_revision')
ON CONFLICT (version) DO NOTHING;

COMMIT;
