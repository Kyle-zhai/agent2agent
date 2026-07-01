import "server-only";
import { randomBytes } from "node:crypto";
import { db } from "./db";
import { newInviteId } from "./ids";
import { logAudit } from "./audit";
import { getAgent, getAgentOwnedBy, listAgentsForUser } from "./agents";
import { acceptFriendRequest, sendFriendRequest } from "./friends";

// -------------------------------------------------------------------------
// Types
// -------------------------------------------------------------------------

export type InviteLink = {
  id: string;
  code: string;
  created_by_user_id: string;
  inviter_agent_id: string;
  note: string;
  max_uses: number;
  used_count: number;
  expires_at: number | null;
  created_at: number;
};

export type InviteRedemption = {
  invite_id: string;
  redeemer_user_id: string;
  redeemer_agent_id: string;
  redeemed_at: number;
};

// -------------------------------------------------------------------------
// Creation
// -------------------------------------------------------------------------

export const DEFAULT_INVITE_TTL_MS = 7 * 24 * 3600 * 1000; // 7 days
export const MAX_NOTE_LEN = 280;
const MAX_INVITES_PER_DAY_PER_USER = 50;

function newInviteCode(): string {
  // 22 chars base64url ≈ 132 bits entropy — unguessable without DB access.
  return randomBytes(16).toString("base64url");
}

export function createInvite(input: {
  user_id: string;
  inviter_agent_id: string;
  note?: string;
  max_uses?: number;
  ttl_ms?: number;
}): InviteLink {
  const agent = getAgentOwnedBy(input.inviter_agent_id, input.user_id);
  if (!agent) throw new Error("You don't own that agent.");

  // Per-user rate limit on invite creation — prevent spam.
  const since = Date.now() - 24 * 3600 * 1000;
  const recent = (
    db()
      .prepare(
        "SELECT COUNT(*) AS n FROM invite_links WHERE created_by_user_id = ? AND created_at > ?",
      )
      .get(input.user_id, since) as { n: number }
  ).n;
  if (recent >= MAX_INVITES_PER_DAY_PER_USER) {
    throw new Error(
      `Too many invites in 24 hours (limit ${MAX_INVITES_PER_DAY_PER_USER}).`,
    );
  }

  const note = (input.note ?? "").trim().slice(0, MAX_NOTE_LEN);
  const maxUses = Math.max(1, Math.min(100, input.max_uses ?? 1));
  const ttl = Math.max(60_000, input.ttl_ms ?? DEFAULT_INVITE_TTL_MS);
  const now = Date.now();
  const id = newInviteId();
  const code = newInviteCode();

  db()
    .prepare(
      `INSERT INTO invite_links
       (id, code, created_by_user_id, inviter_agent_id, note,
        max_uses, used_count, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    )
    .run(id, code, input.user_id, agent.id, note, maxUses, now + ttl, now);

  logAudit("invite.create", {
    userId: input.user_id,
    agentId: agent.id,
    detail: { invite_id: id, max_uses: maxUses, ttl_ms: ttl },
  });
  return getInvite(id)!;
}

// -------------------------------------------------------------------------
// Lookup
// -------------------------------------------------------------------------

export function getInvite(id: string): InviteLink | null {
  return (
    (db()
      .prepare(
        `SELECT id, code, created_by_user_id, inviter_agent_id, note,
                max_uses, used_count, expires_at, created_at
         FROM invite_links WHERE id = ?`,
      )
      .get(id) as InviteLink | undefined) ?? null
  );
}

export function getInviteByCode(code: string): InviteLink | null {
  return (
    (db()
      .prepare(
        `SELECT id, code, created_by_user_id, inviter_agent_id, note,
                max_uses, used_count, expires_at, created_at
         FROM invite_links WHERE code = ?`,
      )
      .get(code) as InviteLink | undefined) ?? null
  );
}

export function listInvitesForUser(userId: string): InviteLink[] {
  return db()
    .prepare(
      `SELECT id, code, created_by_user_id, inviter_agent_id, note,
              max_uses, used_count, expires_at, created_at
       FROM invite_links WHERE created_by_user_id = ?
       ORDER BY created_at DESC`,
    )
    .all(userId) as InviteLink[];
}

export function revokeInvite(userId: string, inviteId: string): void {
  const inv = getInvite(inviteId);
  if (!inv) return;
  if (inv.created_by_user_id !== userId) {
    throw new Error("Not your invite.");
  }
  db().prepare("DELETE FROM invite_links WHERE id = ?").run(inviteId);
  logAudit("invite.revoke", {
    userId,
    detail: { invite_id: inviteId },
  });
}

// -------------------------------------------------------------------------
// Redemption
// -------------------------------------------------------------------------

export type RedeemResult = {
  invite: InviteLink;
  friendship: { inviter_agent_id: string; redeemer_agent_id: string };
};

export function redeemInvite(input: {
  code: string;
  redeemer_user_id: string;
  redeemer_agent_id?: string | null;
}): RedeemResult {
  const inv = getInviteByCode(input.code);
  if (!inv) {
    logAudit("invite.redeem_fail", {
      userId: input.redeemer_user_id,
      detail: { reason: "not_found" },
    });
    throw new Error("Invite link not found or already revoked.");
  }
  if (inv.created_by_user_id === input.redeemer_user_id) {
    throw new Error("You cannot redeem your own invite.");
  }
  if (inv.expires_at && inv.expires_at < Date.now()) {
    logAudit("invite.redeem_fail", {
      userId: input.redeemer_user_id,
      detail: { invite_id: inv.id, reason: "expired" },
    });
    throw new Error("Invite link has expired.");
  }
  if (inv.used_count >= inv.max_uses) {
    logAudit("invite.redeem_fail", {
      userId: input.redeemer_user_id,
      detail: { invite_id: inv.id, reason: "exhausted" },
    });
    throw new Error("Invite link has been fully used.");
  }
  // Same user can only redeem once.
  const already = db()
    .prepare(
      `SELECT 1 FROM invite_redemptions WHERE invite_id = ? AND redeemer_user_id = ?`,
    )
    .get(inv.id, input.redeemer_user_id);
  if (already) {
    throw new Error("You have already redeemed this invite.");
  }

  // Pick redeemer's agent: explicit param > first agent > error
  let redeemerAgentId = input.redeemer_agent_id ?? null;
  if (redeemerAgentId) {
    const a = getAgentOwnedBy(redeemerAgentId, input.redeemer_user_id);
    if (!a) throw new Error("That agent is not yours.");
  } else {
    const myAgents = listAgentsForUser(input.redeemer_user_id);
    if (myAgents.length === 0) {
      throw new Error(
        "Create an agent before redeeming an invite (/app/agents/new).",
      );
    }
    redeemerAgentId = myAgents[0].id;
  }

  const inviterAgent = getAgent(inv.inviter_agent_id);
  if (!inviterAgent) {
    throw new Error("The inviter's agent no longer exists.");
  }

  // Build friendship via the friend-request path so audit/events are
  // consistent with regular adds. Inviter sends -> we accept.
  try {
    const req = sendFriendRequest(
      inv.created_by_user_id,
      inv.inviter_agent_id,
      redeemerAgentId,
    );
    acceptFriendRequest(input.redeemer_user_id, req.id);
  } catch (err) {
    // If they're already friends (rare race), proceed silently — invite still
    // counts as redeemed so the inviter sees their counter move.
    const msg = err instanceof Error ? err.message : "";
    if (!msg.includes("already")) throw err;
  }

  const now = Date.now();
  db().transaction(() => {
    db()
      .prepare(
        `INSERT INTO invite_redemptions
         (invite_id, redeemer_user_id, redeemer_agent_id, redeemed_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(inv.id, input.redeemer_user_id, redeemerAgentId, now);
    db()
      .prepare(
        `UPDATE invite_links SET used_count = used_count + 1 WHERE id = ?`,
      )
      .run(inv.id);
  })();

  logAudit("invite.redeem", {
    userId: input.redeemer_user_id,
    detail: {
      invite_id: inv.id,
      inviter_user_id: inv.created_by_user_id,
      inviter_agent_id: inv.inviter_agent_id,
      redeemer_agent_id: redeemerAgentId,
    },
  });

  return {
    invite: getInvite(inv.id)!,
    friendship: {
      inviter_agent_id: inv.inviter_agent_id,
      redeemer_agent_id: redeemerAgentId,
    },
  };
}
