import { databaseConfigured, query } from "../db/postgres.js";

const memoryClaims = new Map();

export async function claimEmailDispatch(dedupeKey, metadata = {}, force = false) {
  if (!dedupeKey) return false;
  if (!databaseConfigured()) {
    const current = memoryClaims.get(dedupeKey);
    if (current?.status === "sent" || current?.status === "processing") return false;
    if (current && !force && current.status === "failed") return false;
    memoryClaims.set(dedupeKey, { status: "processing", claimedAt: Date.now(), metadata });
    return true;
  }

  const inserted = await query(`
    INSERT INTO app_email_dispatch_claims (dedupe_key, status, metadata, claimed_at, updated_at)
    VALUES ($1, 'processing', $2::jsonb, now(), now())
    ON CONFLICT (dedupe_key) DO NOTHING
    RETURNING dedupe_key
  `, [dedupeKey, JSON.stringify(metadata)]);
  if (inserted.rowCount) return true;

  const reclaimed = await query(`
    UPDATE app_email_dispatch_claims
    SET status = 'processing', metadata = $2::jsonb, claimed_at = now(), updated_at = now(), last_error = ''
    WHERE dedupe_key = $1
      AND status <> 'sent'
      AND (
        ($3::boolean = true AND status = 'failed')
      )
    RETURNING dedupe_key
  `, [dedupeKey, JSON.stringify(metadata), Boolean(force)]);
  return Boolean(reclaimed.rowCount);
}

export async function completeEmailDispatch(dedupeKey, details = {}) {
  if (!databaseConfigured()) {
    memoryClaims.set(dedupeKey, { status: "sent", claimedAt: Date.now(), details });
    return;
  }
  await query(`
    UPDATE app_email_dispatch_claims
    SET status = 'sent', sent_at = now(), updated_at = now(), result = $2::jsonb
    WHERE dedupe_key = $1 AND status = 'processing'
  `, [dedupeKey, JSON.stringify(details)]);
}

export async function failEmailDispatch(dedupeKey, error) {
  if (!databaseConfigured()) {
    memoryClaims.set(dedupeKey, { status: "failed", claimedAt: Date.now(), error: String(error?.message || error) });
    return;
  }
  await query(`
    UPDATE app_email_dispatch_claims
    SET status = 'failed', updated_at = now(), last_error = $2
    WHERE dedupe_key = $1 AND status = 'processing'
  `, [dedupeKey, String(error?.message || error).slice(0, 4000)]);
}
