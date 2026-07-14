BEGIN;

CREATE TABLE IF NOT EXISTS app_email_dispatch_claims (
  dedupe_key text PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('processing', 'sent', 'failed')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_error text NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS app_email_dispatch_claims_status_idx
  ON app_email_dispatch_claims (status, updated_at);

COMMIT;
