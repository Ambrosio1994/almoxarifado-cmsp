import crypto from "node:crypto";
import { databaseConfigured, query } from "../db/postgres.js";

const memoryClaims = new Map();
const DEFAULT_LEASE_MS = positiveInteger(process.env.EMAIL_DISPATCH_LEASE_MS, 10 * 60 * 1000);

export async function claimEmailDispatch(dedupeKey, metadata = {}, force = false, leaseMs = DEFAULT_LEASE_MS) {
  if (!dedupeKey) return null;
  const claimToken = crypto.randomUUID();
  const claimedMetadata = { ...metadata, claimToken };
  if (!databaseConfigured()) {
    const current = memoryClaims.get(dedupeKey);
    const staleProcessing = current?.status === "processing" && Date.now() - current.claimedAt >= leaseMs;
    if (current?.status === "sent" || (current?.status === "processing" && !staleProcessing)) return null;
    if (current?.status === "failed" && !force) return null;
    memoryClaims.set(dedupeKey, { status: "processing", claimedAt: Date.now(), metadata: claimedMetadata, claimToken });
    return claimToken;
  }

  const inserted = await query(`
    INSERT INTO app_email_dispatch_claims (dedupe_key, status, metadata, claimed_at, updated_at)
    VALUES ($1, 'processing', $2::jsonb, now(), now())
    ON CONFLICT (dedupe_key) DO NOTHING
    RETURNING dedupe_key
  `, [dedupeKey, JSON.stringify(claimedMetadata)]);
  if (inserted.rowCount) return claimToken;

  const reclaimed = await query(`
    UPDATE app_email_dispatch_claims
    SET status = 'processing', metadata = $2::jsonb, claimed_at = now(), updated_at = now(), last_error = ''
    WHERE dedupe_key = $1
      AND status <> 'sent'
      AND (($3::boolean = true AND status = 'failed')
        OR (status = 'processing' AND updated_at <= now() - make_interval(secs => $4::double precision / 1000.0)))
    RETURNING dedupe_key
  `, [dedupeKey, JSON.stringify(claimedMetadata), Boolean(force), leaseMs]);
  return reclaimed.rowCount ? claimToken : null;
}

export async function completeEmailDispatch(dedupeKey, claimToken, details = {}) {
  if (!dedupeKey || typeof claimToken !== "string" || !claimToken) return false;
  if (!databaseConfigured()) {
    const current = memoryClaims.get(dedupeKey);
    if (!current || current.status !== "processing" || current.claimToken !== claimToken) return false;
    memoryClaims.set(dedupeKey, { status: "sent", claimedAt: Date.now(), details });
    return true;
  }
  const result = await query(`
    UPDATE app_email_dispatch_claims
    SET status = 'sent', sent_at = now(), updated_at = now(), result = $3::jsonb
    WHERE dedupe_key = $1 AND status = 'processing'
      AND metadata->>'claimToken' = $2
  `, [dedupeKey, claimToken, JSON.stringify(details)]);
  return Boolean(result.rowCount);
}

export async function failEmailDispatch(dedupeKey, claimToken, error) {
  if (!dedupeKey || typeof claimToken !== "string" || !claimToken) return false;
  if (!databaseConfigured()) {
    const current = memoryClaims.get(dedupeKey);
    if (!current || current.status !== "processing" || current.claimToken !== claimToken) return false;
    memoryClaims.set(dedupeKey, { status: "failed", claimedAt: Date.now(), error: String(error?.message || error) });
    return true;
  }
  const result = await query(`
    UPDATE app_email_dispatch_claims
    SET status = 'failed', updated_at = now(), last_error = $3
    WHERE dedupe_key = $1 AND status = 'processing'
      AND metadata->>'claimToken' = $2
  `, [dedupeKey, claimToken, String(error?.message || error).slice(0, 4000)]);
  return Boolean(result.rowCount);
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
