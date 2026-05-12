import "server-only";
import { customAlphabet } from "nanoid";
import { db } from "./db";
import type { AuditLog } from "./types";

const id = customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 14);

export type AuditAction =
  | "auth.signup"
  | "auth.signin"
  | "auth.signin_fail"
  | "auth.signout"
  | "auth.lockout"
  | "auth.password_change"
  | "auth.password_change_fail"
  | "agent.create"
  | "agent.delete"
  | "agent.key_rotate"
  | "agent.avatar_update"
  | "agent.reply_failed"
  | "friend.request_send"
  | "friend.request_accept"
  | "friend.request_reject"
  | "conversation.create_direct"
  | "conversation.create_group"
  | "conversation.persona_override"
  | "conversation.member_add"
  | "conversation.member_remove"
  | "conversation.title_change"
  | "message.send"
  | "message.edit"
  | "message.delete"
  | "message.react"
  | "message.forward"
  | "rate_limit.exceeded"
  | "workspace.create"
  | "workspace.patch"
  | "workspace.patch_conflict"
  | "workspace.subscribe"
  | "task.create"
  | "task.assign"
  | "task.status_change"
  | "task.comment"
  | "task.success_criteria_pass"
  | "task.success_criteria_fail"
  | "agent.capabilities_set"
  | "session.create"
  | "session.close"
  | "tool.invoke"
  | "tool.invoke_denied"
  | "tool.invoke_failed"
  | "sandbox.run"
  | "sandbox.run_failed"
  | "auth.oauth_signin"
  | "auth.oauth_signup"
  | "auth.oauth_link"
  | "auth.oauth_unlink"
  | "auth.oauth_callback_fail"
  | "invite.create"
  | "invite.redeem"
  | "invite.redeem_fail"
  | "invite.revoke"
  | "task.dep_add"
  | "task.dep_remove"
  | "task.subtask_created"
  | "task.transition_blocked"
  | "rpc.dispatch"
  | "rpc.completed"
  | "rpc.timeout"
  | "rpc.failed"
  | "rpc.cancelled"
  | "debate.started"
  | "debate.finished"
  | "debate.failed"
  | "task.split"
  | "agent_link.request"
  | "agent_link.accept"
  | "agent_link.decline"
  | "agent_link.revoke"
  | "conversation.self_member_add";

export type AuditContext = {
  userId?: string | null;
  agentId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  detail?: Record<string, unknown>;
};

export function logAudit(action: AuditAction, ctx: AuditContext = {}): void {
  try {
    db()
      .prepare(
        `INSERT INTO audit_log
         (id, user_id, agent_id, action, detail_json, ip, user_agent, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `aud_${id()}`,
        ctx.userId ?? null,
        ctx.agentId ?? null,
        action,
        JSON.stringify(ctx.detail ?? {}),
        ctx.ip ?? null,
        ctx.userAgent ?? null,
        Date.now(),
      );
  } catch (err) {
    // Audit must never break the request path — but a failure to write the
    // security trail is itself a security concern. Surface it at minimum to
    // stderr so the operator notices schema drift / disk-full immediately.
    console.error("logAudit failed (request continued)", {
      action,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

export function listAuditForUser(userId: string, limit = 100): AuditLog[] {
  return db()
    .prepare(
      `SELECT * FROM audit_log
       WHERE user_id = ? OR agent_id IN (SELECT id FROM agents WHERE owner_user_id = ?)
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(userId, userId, limit) as AuditLog[];
}

/** v0.13.2 retention helper.
 *  Removes audit_log rows older than `olderThanMs` (default 90 days).
 *  Returns number of rows deleted. Operator should run periodically
 *  (e.g., daily cron). No automatic scheduling because the project ships
 *  as a single Node process with no cron framework. */
export function pruneAuditLog(olderThanMs = 90 * 24 * 3600 * 1000): number {
  const cutoff = Date.now() - olderThanMs;
  const info = db()
    .prepare("DELETE FROM audit_log WHERE created_at < ?")
    .run(cutoff);
  return info.changes;
}

export function ipFromRequest(req: Request): string | null {
  const fwd = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return fwd || req.headers.get("x-real-ip") || null;
}

export function uaFromRequest(req: Request): string | null {
  return req.headers.get("user-agent");
}
