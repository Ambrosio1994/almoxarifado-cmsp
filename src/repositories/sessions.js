import crypto from "node:crypto";
import { databaseConfigured, query } from "../db/postgres.js";
import { readUserById } from "../storage.js";

const MEMORY_SESSIONS = new Map();

export async function createSession(userId, ttlMs = 30 * 60 * 1000, authVersion = 1) {
  const token = crypto.randomBytes(32).toString("hex");
  const now = Date.now();
  const session = {
    userId,
    createdAt: now,
    lastActivityAt: now,
    expiresAt: now + ttlMs,
    authVersion: positiveAuthVersion(authVersion)
  };

  if (!databaseConfigured()) {
    MEMORY_SESSIONS.set(hashToken(token), session);
    return token;
  }

  const result = await query(`
    INSERT INTO user_sessions (token_hash, user_id, created_at, last_activity_at, expires_at, auth_version)
    SELECT $1, $2, to_timestamp($3 / 1000.0), to_timestamp($4 / 1000.0), to_timestamp($5 / 1000.0), auth_version
    FROM app_users
    WHERE id = $2
    ON CONFLICT (token_hash) DO UPDATE SET
      user_id = EXCLUDED.user_id,
      created_at = EXCLUDED.created_at,
      last_activity_at = EXCLUDED.last_activity_at,
      expires_at = EXCLUDED.expires_at,
      auth_version = EXCLUDED.auth_version,
      revoked_at = NULL
    RETURNING user_id
  `, [hashToken(token), userId, session.createdAt, session.lastActivityAt, session.expiresAt]);
  if (!result.rowCount) throw new Error("Usuario da sessao nao encontrado.");

  return token;
}

export async function resolveSession(token, ttlMs = 30 * 60 * 1000) {
  const session = await resolveSessionContext(token, ttlMs);
  return session?.userId || null;
}

export async function resolveSessionUser(token, ttlMs = 30 * 60 * 1000) {
  const session = await resolveSessionContext(token, ttlMs);
  if (!session) return null;
  const user = await readUserById(session.userId);
  if (!user || user.ativo === false || positiveAuthVersion(user.authVersion) !== session.authVersion) return null;
  return user;
}

async function resolveSessionContext(token, ttlMs) {
  if (!token) return null;
  if (!databaseConfigured()) {
    const session = MEMORY_SESSIONS.get(hashToken(token));
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      MEMORY_SESSIONS.delete(hashToken(token));
      return null;
    }
    session.lastActivityAt = Date.now();
    session.expiresAt = session.lastActivityAt + ttlMs;
    return { userId: session.userId, authVersion: positiveAuthVersion(session.authVersion) };
  }

  const tokenHash = hashToken(token);
  const result = await query(`
    SELECT sessions.user_id, sessions.auth_version, sessions.last_activity_at
    FROM user_sessions AS sessions
    JOIN app_users AS users ON users.id = sessions.user_id
    WHERE sessions.token_hash = $1
      AND sessions.revoked_at IS NULL
      AND sessions.expires_at > now()
      AND sessions.last_activity_at > now() - make_interval(secs => $2::double precision / 1000.0)
      AND sessions.auth_version = users.auth_version
      AND users.ativo = true
  `, [tokenHash, ttlMs]);
  const session = result.rows[0];
  if (!session) return null;

  const lastActivity = new Date(session.last_activity_at).getTime();
  const touchIntervalMs = Math.max(1_000, Math.min(60_000, Math.floor(ttlMs / 4)));
  if (Number.isFinite(lastActivity) && Date.now() - lastActivity >= touchIntervalMs) {
    const touched = await query(`
      UPDATE user_sessions AS sessions
      SET last_activity_at = now(),
          expires_at = now() + make_interval(secs => $2::double precision / 1000.0)
      FROM app_users AS users
      WHERE sessions.token_hash = $1
        AND users.id = sessions.user_id
        AND sessions.auth_version = users.auth_version
        AND users.ativo = true
        AND sessions.revoked_at IS NULL
        AND sessions.expires_at > now()
        AND sessions.last_activity_at <= now() - make_interval(secs => $3::double precision / 1000.0)
      RETURNING sessions.user_id, sessions.auth_version
    `, [tokenHash, ttlMs, touchIntervalMs]);
    if (touched.rowCount) {
      return {
        userId: touched.rows[0].user_id,
        authVersion: positiveAuthVersion(touched.rows[0].auth_version)
      };
    }
    const refreshed = await query(`
      SELECT sessions.user_id, sessions.auth_version
      FROM user_sessions AS sessions
      JOIN app_users AS users ON users.id = sessions.user_id
      WHERE sessions.token_hash = $1
        AND sessions.revoked_at IS NULL
        AND sessions.expires_at > now()
        AND sessions.last_activity_at > now() - make_interval(secs => $2::double precision / 1000.0)
        AND sessions.auth_version = users.auth_version
        AND users.ativo = true
    `, [tokenHash, ttlMs]);
    return refreshed.rows[0] ? {
      userId: refreshed.rows[0].user_id,
      authVersion: positiveAuthVersion(refreshed.rows[0].auth_version)
    } : null;
  }
  return { userId: session.user_id, authVersion: positiveAuthVersion(session.auth_version) };
}

export async function revokeSession(token) {
  if (!token) return;
  if (!databaseConfigured()) {
    MEMORY_SESSIONS.delete(hashToken(token));
    return;
  }
  await query(
    "UPDATE user_sessions SET revoked_at = now() WHERE token_hash = $1",
    [hashToken(token)]
  );
}

export async function revokeUserSessions(userId) {
  if (!userId) return;
  if (!databaseConfigured()) {
    for (const [tokenHash, session] of MEMORY_SESSIONS.entries()) {
      if (session.userId === userId) MEMORY_SESSIONS.delete(tokenHash);
    }
    return;
  }
  await query(
    "UPDATE user_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL",
    [userId]
  );
}

export async function cleanupExpiredSessions(retentionDays = 7) {
  if (!databaseConfigured()) {
    const now = Date.now();
    for (const [tokenHash, session] of MEMORY_SESSIONS.entries()) {
      if (session.expiresAt <= now) MEMORY_SESSIONS.delete(tokenHash);
    }
    return;
  }
  await query(`
    DELETE FROM user_sessions
    WHERE expires_at < now() - ($1::integer * interval '1 day')
       OR revoked_at < now() - ($1::integer * interval '1 day')
  `, [Math.max(1, Number(retentionDays) || 7)]);
}

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function positiveAuthVersion(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
}
