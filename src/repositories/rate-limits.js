import { databaseConfigured, query } from "../db/postgres.js";

const memoryLimits = new Map();

export async function isRateLimited(key, windowMs, maximum) {
  if (!databaseConfigured()) {
    const current = memoryLimits.get(key);
    if (!current) return false;
    if (Date.now() - current.startedAt > windowMs) {
      memoryLimits.delete(key);
      return false;
    }
    return current.attempts >= maximum;
  }
  const result = await query(`
    SELECT attempts >= $3::integer AS limited
    FROM auth_rate_limits
    WHERE rate_key = $1
      AND window_started_at > now() - make_interval(secs => $2::double precision / 1000.0)
  `, [key, windowMs, maximum]);
  return Boolean(result.rows[0]?.limited);
}

export async function recordRateLimitFailure(key, windowMs) {
  if (!databaseConfigured()) {
    const now = Date.now();
    const current = memoryLimits.get(key);
    if (!current || now - current.startedAt > windowMs) memoryLimits.set(key, { attempts: 1, startedAt: now });
    else current.attempts += 1;
    pruneMemory(windowMs);
    return;
  }
  await query(`
    INSERT INTO auth_rate_limits (rate_key, attempts, window_started_at, updated_at)
    VALUES ($1, 1, now(), now())
    ON CONFLICT (rate_key) DO UPDATE SET
      attempts = CASE
        WHEN auth_rate_limits.window_started_at <= now() - make_interval(secs => $2::double precision / 1000.0) THEN 1
        ELSE auth_rate_limits.attempts + 1
      END,
      window_started_at = CASE
        WHEN auth_rate_limits.window_started_at <= now() - make_interval(secs => $2::double precision / 1000.0) THEN now()
        ELSE auth_rate_limits.window_started_at
      END,
      updated_at = now()
  `, [key, windowMs]);
}

export async function clearRateLimit(key) {
  if (!databaseConfigured()) {
    memoryLimits.delete(key);
    return;
  }
  await query("DELETE FROM auth_rate_limits WHERE rate_key = $1", [key]);
}

export async function cleanupRateLimits() {
  if (!databaseConfigured()) {
    pruneMemory(24 * 60 * 60 * 1000);
    return;
  }
  await query("DELETE FROM auth_rate_limits WHERE updated_at < now() - interval '1 day'");
}

function pruneMemory(maxAgeMs) {
  const cutoff = Date.now() - maxAgeMs;
  for (const [key, value] of memoryLimits.entries()) {
    if (value.startedAt < cutoff) memoryLimits.delete(key);
  }
}
