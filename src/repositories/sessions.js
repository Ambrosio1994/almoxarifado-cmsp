import crypto from "node:crypto";
import { databaseConfigured, query, transaction } from "../db/postgres.js";

const MEMORY_SESSIONS = new Map();

export async function createSession(userId, ttlMs = 30 * 60 * 1000) {
  const token = crypto.randomBytes(32).toString("hex");
  const now = Date.now();
  const session = {
    userId,
    createdAt: now,
    lastActivityAt: now,
    expiresAt: now + ttlMs
  };

  if (!databaseConfigured()) {
    MEMORY_SESSIONS.set(hashToken(token), session);
    return token;
  }

  await query(`
    INSERT INTO user_sessions (token_hash, user_id, created_at, last_activity_at, expires_at)
    VALUES ($1, $2, to_timestamp($3 / 1000.0), to_timestamp($4 / 1000.0), to_timestamp($5 / 1000.0))
    ON CONFLICT (token_hash) DO UPDATE SET
      user_id = EXCLUDED.user_id,
      created_at = EXCLUDED.created_at,
      last_activity_at = EXCLUDED.last_activity_at,
      expires_at = EXCLUDED.expires_at,
      revoked_at = NULL
  `, [hashToken(token), userId, session.createdAt, session.lastActivityAt, session.expiresAt]);

  return token;
}

export async function resolveSession(token, ttlMs = 30 * 60 * 1000) {
  if (!token) return null;
  if (!databaseConfigured()) {
    const session = MEMORY_SESSIONS.get(hashToken(token));
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      MEMORY_SESSIONS.delete(hashToken(token));
      return null;
    }
    session.lastActivityAt = Date.now();
    return session.userId;
  }

  return transaction(async (client) => {
    const result = await client.query(`
      SELECT s.user_id, s.last_activity_at, s.expires_at, s.revoked_at
      FROM user_sessions s
      WHERE s.token_hash = $1
      FOR UPDATE
    `, [hashToken(token)]);
    const session = result.rows[0];
    if (!session || session.revoked_at) return null;

    const now = Date.now();
    const lastActivity = new Date(session.last_activity_at).getTime();
    const expiresAt = new Date(session.expires_at).getTime();
    if (Number.isNaN(lastActivity) || Number.isNaN(expiresAt)) return null;
    if (expiresAt <= now || now - lastActivity > ttlMs) {
      await client.query(
        "UPDATE user_sessions SET revoked_at = now() WHERE token_hash = $1",
        [hashToken(token)]
      );
      return null;
    }

    await client.query(
      "UPDATE user_sessions SET last_activity_at = now() WHERE token_hash = $1",
      [hashToken(token)]
    );
    return session.user_id;
  });
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
