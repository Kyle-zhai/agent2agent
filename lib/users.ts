import "server-only";
import { db } from "./db";
import { saveAvatarBytes } from "./avatars";
import { logAudit } from "./audit";
import { deleteAgentForUser } from "./agents";
import type { User } from "./auth";

export function updateUserDisplayName(userId: string, name: string): void {
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 60) {
    throw new Error("Display name must be 1-60 characters.");
  }
  db()
    .prepare("UPDATE users SET display_name = ? WHERE id = ?")
    .run(trimmed, userId);
}

export function setUserAvatarFromUpload(
  userId: string,
  bytes: Buffer,
  declaredMime: string,
): { mime: string } {
  const result = saveAvatarBytes(`user_${userId}`, bytes, declaredMime);
  db()
    .prepare("UPDATE users SET avatar_blob_path = ? WHERE id = ?")
    .run(result.blob_path, userId);
  logAudit("agent.avatar_update", {
    userId,
    detail: { for: "user", mime: result.mime, size: result.size },
  });
  return { mime: result.mime };
}

export function clearUserAvatar(userId: string): void {
  db()
    .prepare("UPDATE users SET avatar_blob_path = NULL WHERE id = ?")
    .run(userId);
}

export function getUserAvatarPath(userId: string): string | null {
  const row = db()
    .prepare("SELECT avatar_blob_path FROM users WHERE id = ?")
    .get(userId) as { avatar_blob_path: string | null } | undefined;
  return row?.avatar_blob_path ?? null;
}

/** Permanently delete a user account and every row that names them.
 *
 *  `confirmEmail` is the UI confirmation gate: it must match the account
 *  email (case-insensitive) or nothing is touched. Everything else runs in
 *  ONE transaction so a crash can never leave a half-deleted account.
 *
 *  Deletion order matters:
 *  1. Each owned assistant goes through the existing deleteAgentForUser
 *     cascade — it clears the 11 unguarded agents(id) FKs (messages, tasks,
 *     attachments, …) that a bare DELETE would trip over, and the guarded
 *     FKs (grants, handoffs, links, invites, agent_sessions, …) cascade
 *     with the agent row.
 *  2. messages_fts is a contentless FTS5 table with no FK — the bulk
 *     message deletes in step 1 leave the user's message text searchable,
 *     so we sweep every index row whose source message is gone.
 *  3. Explicit deletes for every users(id) reference. Most have ON DELETE
 *     CASCADE and would clean themselves up, but we prefer explicit
 *     statements over implicit cascade so the privacy contract is visible
 *     and testable here, not buried in DDL.
 */
export function deleteUserAccount(userId: string, confirmEmail: string): void {
  const user = db()
    .prepare("SELECT id, email FROM users WHERE id = ?")
    .get(userId) as { id: string; email: string } | undefined;
  if (!user) throw new Error("User not found.");
  if (confirmEmail.trim().toLowerCase() !== user.email.toLowerCase()) {
    throw new Error(
      "The email you typed doesn't match your account email. Nothing was deleted.",
    );
  }
  const d = db();
  const tx = d.transaction(() => {
    // 1. Owned assistants (nested transaction → savepoint in better-sqlite3).
    const owned = d
      .prepare("SELECT id FROM agents WHERE owner_user_id = ?")
      .all(userId) as Array<{ id: string }>;
    for (const a of owned) deleteAgentForUser(a.id, userId);

    // 2. Search-index rows orphaned by the bulk message deletes above.
    d.prepare(
      `DELETE FROM messages_fts
       WHERE message_id NOT IN (SELECT id FROM messages)`,
    ).run();

    // 3. Every remaining users(id) reference, explicitly.
    // Grants the user issued or received must not outlive them — this is
    // effectively a revoke-all (agent cascade already removed most).
    d.prepare(
      "DELETE FROM shared_grants WHERE from_user_id = ? OR to_user_id = ?",
    ).run(userId, userId);
    // Handoffs: both user FKs are NOT NULL ON DELETE CASCADE, so a handoff
    // the user is party to cannot survive the users-row delete anyway —
    // delete explicitly rather than relying on the implicit cascade.
    d.prepare(
      "DELETE FROM handoffs WHERE from_user_id = ? OR to_user_id = ?",
    ).run(userId, userId);
    // Agent links: initiator FK is CASCADE (delete), responder is SET NULL
    // (keep the link for the other party, drop the attribution).
    d.prepare("DELETE FROM agent_links WHERE initiated_by_user_id = ?").run(
      userId,
    );
    d.prepare(
      "UPDATE agent_links SET responded_by_user_id = NULL WHERE responded_by_user_id = ?",
    ).run(userId);
    // Invite links they created (and redemptions of those links), plus
    // redemptions they made of other people's links.
    d.prepare(
      `DELETE FROM invite_redemptions
       WHERE redeemer_user_id = ?
          OR invite_id IN (SELECT id FROM invite_links WHERE created_by_user_id = ?)`,
    ).run(userId, userId);
    d.prepare("DELETE FROM invite_links WHERE created_by_user_id = ?").run(
      userId,
    );
    // Device-auth requests they approved are user-scoped — and a pending one
    // may still hold an unclaimed plaintext API key, so delete (the schema's
    // SET NULL would leave that key at rest with no owner).
    d.prepare(
      "DELETE FROM device_auth_requests WHERE approved_by_user_id = ?",
    ).run(userId);
    // Audit trail: schema says ON DELETE SET NULL, but for beta we hard-
    // delete the user's rows. Tradeoff: privacy-positive (no orphaned
    // behavioral log keyed to a deleted person) at the cost of forensic
    // history — operators needing retention should export before deleting.
    d.prepare("DELETE FROM audit_log WHERE user_id = ?").run(userId);
    d.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
    d.prepare("DELETE FROM oauth_identities WHERE user_id = ?").run(userId);
    d.prepare("DELETE FROM users WHERE id = ?").run(userId);
  });
  tx();
}

export function getUserExtended(userId: string): User & {
  avatar_blob_path: string | null;
} {
  const row = db()
    .prepare(
      "SELECT id, email, display_name, avatar_blob_path, created_at FROM users WHERE id = ?",
    )
    .get(userId) as
    | (User & { avatar_blob_path: string | null })
    | undefined;
  if (!row) throw new Error("User not found.");
  return row;
}
