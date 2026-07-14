BEGIN;

CREATE TABLE IF NOT EXISTS app_security_audit (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  event_type text NOT NULL,
  actor_user_id text REFERENCES app_users(id) ON DELETE SET NULL,
  actor_email citext NOT NULL DEFAULT '',
  target_user_id text REFERENCES app_users(id) ON DELETE SET NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS app_security_audit_created_idx ON app_security_audit (created_at DESC);
CREATE INDEX IF NOT EXISTS app_security_audit_actor_idx ON app_security_audit (actor_user_id, created_at DESC);

DROP TRIGGER IF EXISTS app_security_audit_immutable ON app_security_audit;
CREATE TRIGGER app_security_audit_immutable
BEFORE UPDATE OR DELETE ON app_security_audit
FOR EACH ROW EXECUTE FUNCTION prevent_process_audit_mutation();

COMMIT;
