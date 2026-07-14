BEGIN;

CREATE TABLE IF NOT EXISTS auth_rate_limits (
  rate_key text PRIMARY KEY,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  window_started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS auth_rate_limits_updated_idx ON auth_rate_limits (updated_at);

COMMIT;
