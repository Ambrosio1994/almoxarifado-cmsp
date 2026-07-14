import crypto from "node:crypto";
import { databaseConfigured, query } from "../db/postgres.js";

const memoryEvents = [];

export async function recordSecurityEvent(eventType, event = {}) {
  const entry = {
    id: crypto.randomUUID(),
    eventType: String(eventType),
    actorUserId: event.actorUserId || null,
    actorEmail: String(event.actorEmail || "").toLowerCase(),
    targetUserId: event.targetUserId || null,
    metadata: event.metadata || {},
    createdAt: new Date().toISOString()
  };
  if (!databaseConfigured()) {
    memoryEvents.unshift(entry);
    if (memoryEvents.length > 1000) memoryEvents.length = 1000;
    return entry;
  }
  await query(`
    INSERT INTO app_security_audit (id, event_type, actor_user_id, actor_email, target_user_id, metadata, created_at)
    VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::timestamptz)
  `, [entry.id, entry.eventType, entry.actorUserId, entry.actorEmail, entry.targetUserId, JSON.stringify(entry.metadata), entry.createdAt]);
  return entry;
}

export async function listSecurityEvents(limit = 200) {
  const safeLimit = Math.min(1000, Math.max(1, Number(limit) || 200));
  if (!databaseConfigured()) return memoryEvents.slice(0, safeLimit);
  const result = await query(`
    SELECT id, event_type, actor_user_id, actor_email, target_user_id, metadata, created_at
    FROM app_security_audit ORDER BY created_at DESC LIMIT $1
  `, [safeLimit]);
  return result.rows.map((row) => ({
    id: row.id, eventType: row.event_type, actorUserId: row.actor_user_id,
    actorEmail: row.actor_email, targetUserId: row.target_user_id,
    metadata: row.metadata, createdAt: new Date(row.created_at).toISOString()
  }));
}
