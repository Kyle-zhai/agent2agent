import "server-only";
import { db } from "./db";
import { newAgentSessionId } from "./ids";
import { logAudit } from "./audit";

export type AgentSession = {
  id: string;
  agent_id: string;
  cursor: number;
  created_at: number;
  last_seen_at: number;
};

export type SessionEvent = {
  id: number;
  conversation_id: string;
  kind: string;
  message_id: string | null;
  ref_id: string | null;
  created_at: number;
};

export const SESSION_IDLE_TTL_MS = 30 * 60 * 1000;
export const MAX_PULL = 200;

export function createSession(
  agentId: string,
  resumeCursor?: number,
): AgentSession {
  const id = newAgentSessionId();
  const now = Date.now();
  let startingCursor = resumeCursor ?? 0;
  // Cap resume cursor at current max so a malicious huge value doesn't pin
  // the server polling for unreachable events.
  const max = (
    db()
      .prepare(
        `SELECT COALESCE(MAX(id),0) AS n FROM conversation_events`,
      )
      .get() as { n: number }
  ).n;
  if (startingCursor > max) startingCursor = max;
  if (startingCursor < 0) startingCursor = 0;
  db()
    .prepare(
      `INSERT INTO agent_sessions (id, agent_id, cursor, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(id, agentId, startingCursor, now, now);
  logAudit("session.create", { agentId, detail: { session_id: id, cursor: startingCursor } });
  return {
    id,
    agent_id: agentId,
    cursor: startingCursor,
    created_at: now,
    last_seen_at: now,
  };
}

export function getSession(id: string): AgentSession | null {
  return (
    (db()
      .prepare(
        `SELECT id, agent_id, cursor, created_at, last_seen_at
         FROM agent_sessions WHERE id = ?`,
      )
      .get(id) as AgentSession | undefined) ?? null
  );
}

export function touchSession(id: string): void {
  db()
    .prepare(`UPDATE agent_sessions SET last_seen_at = ? WHERE id = ?`)
    .run(Date.now(), id);
}

export function closeSession(id: string): void {
  const s = getSession(id);
  if (!s) return;
  db().prepare("DELETE FROM agent_sessions WHERE id = ?").run(id);
  logAudit("session.close", { agentId: s.agent_id, detail: { session_id: id } });
}

export function reapIdleSessions(): number {
  const cutoff = Date.now() - SESSION_IDLE_TTL_MS;
  return db()
    .prepare("DELETE FROM agent_sessions WHERE last_seen_at < ?")
    .run(cutoff).changes;
}

export function pullEventsForSession(
  session: AgentSession,
  limit = 100,
): { events: SessionEvent[]; cursor: number } {
  const max = Math.min(MAX_PULL, Math.max(1, limit));
  const rows = db()
    .prepare(
      `SELECT ce.id, ce.conversation_id, ce.kind, ce.message_id, ce.ref_id, ce.created_at
       FROM conversation_events ce
       WHERE ce.id > ?
         AND ce.conversation_id IN (
           SELECT conversation_id FROM conversation_members WHERE agent_id = ?
         )
       ORDER BY ce.id ASC
       LIMIT ?`,
    )
    .all(session.cursor, session.agent_id, max) as SessionEvent[];

  let newCursor = session.cursor;
  if (rows.length > 0) {
    newCursor = rows[rows.length - 1].id;
    db()
      .prepare(`UPDATE agent_sessions SET cursor = ?, last_seen_at = ? WHERE id = ?`)
      .run(newCursor, Date.now(), session.id);
  } else {
    touchSession(session.id);
  }
  return { events: rows, cursor: newCursor };
}

/** Peek without advancing the cursor — used by the SSE stream so it can
 *  read multiple ticks before persisting a single new cursor value. */
export function peekEventsForSession(
  session: AgentSession,
  after: number,
  limit = 100,
): SessionEvent[] {
  const max = Math.min(MAX_PULL, Math.max(1, limit));
  return db()
    .prepare(
      `SELECT ce.id, ce.conversation_id, ce.kind, ce.message_id, ce.ref_id, ce.created_at
       FROM conversation_events ce
       WHERE ce.id > ?
         AND ce.conversation_id IN (
           SELECT conversation_id FROM conversation_members WHERE agent_id = ?
         )
       ORDER BY ce.id ASC
       LIMIT ?`,
    )
    .all(after, session.agent_id, max) as SessionEvent[];
}

export function persistSessionCursor(sessionId: string, cursor: number): void {
  db()
    .prepare(
      `UPDATE agent_sessions SET cursor = ?, last_seen_at = ? WHERE id = ?`,
    )
    .run(cursor, Date.now(), sessionId);
}
