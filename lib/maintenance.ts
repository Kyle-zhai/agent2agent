import "server-only";
import { db } from "./db";
import { reapIdleSessions } from "./sessions";
import { pruneAuditLog } from "./audit";

// ---------------------------------------------------------------------------
// Retention sweep. The single-SQLite-file model has no external cron, and
// several tables grew forever: a2a_idempotency, device_auth_requests,
// rate_limit_buckets, conversation_events, finished reply_jobs — plus
// reapIdleSessions() and pruneAuditLog() existed but were NEVER called.
// This consolidates all of it into one best-effort sweep, wired to a low
// interval in instrumentation.ts. Each cutoff is well past any window the
// data is actually used in, so deletes can't affect live behavior.
// ---------------------------------------------------------------------------

const MS = { hour: 3_600_000, day: 86_400_000 };

export const RETENTION = {
  // Idempotency only protects against network retries — minutes, not days.
  idempotency: 7 * MS.day,
  // Device-auth rows are terminal (claimed/denied/expired) or stale-pending.
  deviceAuth: 1 * MS.hour,
  // A bucket idle this long has fully refilled; deleting == resetting it.
  rateLimit: 1 * MS.day,
  // SSE cursors never look back this far.
  conversationEvents: 30 * MS.day,
  // Terminal jobs (done/failed) we no longer need for recovery.
  replyJobs: 7 * MS.day,
  // Acked deliveries are pure history — the recipient already confirmed.
  deliveryAcked: 7 * MS.day,
  // Un-acked deliveries this old belong to agents that never came back;
  // no poller waits a month, so dropping them can't lose a live message.
  deliveryUnacked: 30 * MS.day,
} as const;

export type SweepResult = {
  idempotency: number;
  deviceAuth: number;
  rateLimit: number;
  conversationEvents: number;
  replyJobs: number;
  deliveryAcked: number;
  deliveryUnacked: number;
  webSessions: number;
  agentSessions: number;
  auditLog: number;
  accountEmailTokens: number;
};

/** Delete aged rows across the unbounded tables. Best-effort and safe to run
 *  concurrently with normal traffic (single SQLite writer serializes it). */
export function runMaintenanceSweep(now = Date.now()): SweepResult {
  const del = (sql: string, cutoff: number): number =>
    db().prepare(sql).run(cutoff).changes;

  return {
    idempotency: del(
      "DELETE FROM a2a_idempotency WHERE created_at < ?",
      now - RETENTION.idempotency,
    ),
    deviceAuth: del(
      // Only sweep settled rows; an in-flight pending request past its TTL is
      // already non-functional but we still wait one extra hour to delete.
      "DELETE FROM device_auth_requests WHERE expires_at < ?",
      now - RETENTION.deviceAuth,
    ),
    rateLimit: del(
      "DELETE FROM rate_limit_buckets WHERE last_refill_at < ?",
      now - RETENTION.rateLimit,
    ),
    conversationEvents: del(
      "DELETE FROM conversation_events WHERE created_at < ?",
      now - RETENTION.conversationEvents,
    ),
    replyJobs: db()
      .prepare(
        `DELETE FROM reply_jobs
         WHERE status IN ('done','failed') AND finished_at IS NOT NULL
           AND finished_at < ?`,
      )
      .run(now - RETENTION.replyJobs).changes,
    deliveryAcked: del(
      "DELETE FROM delivery_queue WHERE ack_at IS NOT NULL AND ack_at < ?",
      now - RETENTION.deliveryAcked,
    ),
    deliveryUnacked: del(
      "DELETE FROM delivery_queue WHERE ack_at IS NULL AND created_at < ?",
      now - RETENTION.deliveryUnacked,
    ),
    // Expired web (cookie) sessions — getCurrentUser only deletes the one it
    // happens to hit, so the rest accumulate. agent_sessions (events
    // protocol) are swept separately by reapIdleSessions.
    webSessions: del("DELETE FROM sessions WHERE expires_at < ?", now),
    agentSessions: reapIdleSessions(),
    auditLog: pruneAuditLog(),
    // Account-email tokens: drop once expired (used or not) — the plaintext
    // only ever lived in the email; an expired row is dead weight.
    accountEmailTokens:
      del("DELETE FROM password_reset_tokens WHERE expires_at < ?", now) +
      del("DELETE FROM email_verification_tokens WHERE expires_at < ?", now),
  };
}
