BEGIN;

ALTER TABLE app_users ADD COLUMN IF NOT EXISTS access_justification text NOT NULL DEFAULT '';
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS access_requested_at timestamptz;

COMMIT;
