BEGIN;

ALTER TABLE app_users
  ADD COLUMN IF NOT EXISTS auth_version bigint NOT NULL DEFAULT 1
  CHECK (auth_version > 0);

ALTER TABLE user_sessions
  ADD COLUMN IF NOT EXISTS auth_version bigint NOT NULL DEFAULT 1
  CHECK (auth_version > 0);

UPDATE user_sessions AS session
SET auth_version = users.auth_version
FROM app_users AS users
WHERE users.id = session.user_id
  AND session.auth_version IS DISTINCT FROM users.auth_version;

CREATE INDEX IF NOT EXISTS user_sessions_auth_version_idx
  ON user_sessions (user_id, auth_version)
  WHERE revoked_at IS NULL;

COMMIT;
