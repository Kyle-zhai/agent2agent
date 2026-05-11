import "server-only";
import { db } from "./db";
import { newFriendRequestId } from "./ids";
import { getAgent, getAgentOwnedBy } from "./agents";
import { consume, RATE_LIMITS } from "./rate-limit";
import { logAudit } from "./audit";
import type { FriendRequest } from "./types";

export type { FriendRequest } from "./types";

export const MAX_FRIENDS_PER_AGENT = 200;

function pair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

export function areFriends(a: string, b: string): boolean {
  if (a === b) return true;
  const [x, y] = pair(a, b);
  const row = db()
    .prepare("SELECT 1 FROM friendships WHERE agent_a = ? AND agent_b = ?")
    .get(x, y);
  return !!row;
}

export function sendFriendRequest(
  userId: string,
  fromAgentId: string,
  toAgentId: string,
): FriendRequest {
  if (fromAgentId === toAgentId) {
    throw new Error("Cannot friend yourself.");
  }
  const owned = getAgentOwnedBy(fromAgentId, userId);
  if (!owned) throw new Error("You don't own that agent.");
  const target = getAgent(toAgentId);
  if (!target) throw new Error("Target agent not found.");
  if (areFriends(fromAgentId, toAgentId)) {
    throw new Error("Already friends.");
  }
  const rl = consume(`friend:agent:${fromAgentId}`, RATE_LIMITS.friendRequest);
  if (!rl.allowed) {
    throw new Error(
      `Too many friend requests. Try again in ${rl.retryAfterSeconds}s.`,
    );
  }
  const friendCount = listFriendsOfAgent(fromAgentId).length;
  if (friendCount >= MAX_FRIENDS_PER_AGENT) {
    throw new Error(`Friend limit reached (${MAX_FRIENDS_PER_AGENT}).`);
  }
  const existing = db()
    .prepare(
      `SELECT * FROM friend_requests
       WHERE (from_agent_id = ? AND to_agent_id = ?)
          OR (from_agent_id = ? AND to_agent_id = ?)`,
    )
    .get(fromAgentId, toAgentId, toAgentId, fromAgentId) as
    | FriendRequest
    | undefined;
  if (existing) {
    if (existing.status === "pending") {
      if (existing.to_agent_id === fromAgentId) {
        return acceptFriendRequest(userId, existing.id);
      }
      throw new Error("Friend request already pending.");
    }
    db().prepare("DELETE FROM friend_requests WHERE id = ?").run(existing.id);
  }
  const fr: FriendRequest = {
    id: newFriendRequestId(),
    from_agent_id: fromAgentId,
    to_agent_id: toAgentId,
    status: "pending",
    created_at: Date.now(),
    responded_at: null,
  };
  db()
    .prepare(
      `INSERT INTO friend_requests
       (id, from_agent_id, to_agent_id, status, created_at, responded_at)
       VALUES (?, ?, ?, 'pending', ?, NULL)`,
    )
    .run(fr.id, fr.from_agent_id, fr.to_agent_id, fr.created_at);
  logAudit("friend.request_send", {
    userId,
    agentId: fromAgentId,
    detail: { to: toAgentId },
  });
  return fr;
}

export function acceptFriendRequest(
  userId: string,
  requestId: string,
): FriendRequest {
  const row = db()
    .prepare("SELECT * FROM friend_requests WHERE id = ?")
    .get(requestId) as FriendRequest | undefined;
  if (!row) throw new Error("Friend request not found.");
  if (row.status !== "pending") throw new Error("Request already resolved.");
  const owned = getAgentOwnedBy(row.to_agent_id, userId);
  if (!owned) throw new Error("Not your request to accept.");
  const now = Date.now();
  const [a, b] = pair(row.from_agent_id, row.to_agent_id);
  const tx = db().transaction(() => {
    db()
      .prepare(
        `UPDATE friend_requests SET status = 'accepted', responded_at = ?
         WHERE id = ?`,
      )
      .run(now, requestId);
    db()
      .prepare(
        `INSERT OR IGNORE INTO friendships (agent_a, agent_b, created_at)
         VALUES (?, ?, ?)`,
      )
      .run(a, b, now);
  });
  tx();
  logAudit("friend.request_accept", {
    userId,
    agentId: row.to_agent_id,
    detail: { from: row.from_agent_id },
  });
  return { ...row, status: "accepted", responded_at: now };
}

export function rejectFriendRequest(
  userId: string,
  requestId: string,
): FriendRequest {
  const row = db()
    .prepare("SELECT * FROM friend_requests WHERE id = ?")
    .get(requestId) as FriendRequest | undefined;
  if (!row) throw new Error("Friend request not found.");
  if (row.status !== "pending") throw new Error("Request already resolved.");
  const owned = getAgentOwnedBy(row.to_agent_id, userId);
  if (!owned) throw new Error("Not your request to reject.");
  const now = Date.now();
  db()
    .prepare(
      `UPDATE friend_requests SET status = 'rejected', responded_at = ?
       WHERE id = ?`,
    )
    .run(now, requestId);
  logAudit("friend.request_reject", {
    userId,
    agentId: row.to_agent_id,
    detail: { from: row.from_agent_id },
  });
  return { ...row, status: "rejected", responded_at: now };
}

export function listFriendsOfAgent(agentId: string): string[] {
  const rows = db()
    .prepare(
      `SELECT CASE WHEN agent_a = ? THEN agent_b ELSE agent_a END AS friend_id
       FROM friendships WHERE agent_a = ? OR agent_b = ?`,
    )
    .all(agentId, agentId, agentId) as { friend_id: string }[];
  return rows.map((r) => r.friend_id);
}

export function listIncomingRequests(userId: string): FriendRequest[] {
  return db()
    .prepare(
      `SELECT fr.* FROM friend_requests fr
       JOIN agents a ON a.id = fr.to_agent_id
       WHERE a.owner_user_id = ? AND fr.status = 'pending'
       ORDER BY fr.created_at DESC`,
    )
    .all(userId) as FriendRequest[];
}

export function listOutgoingRequests(userId: string): FriendRequest[] {
  return db()
    .prepare(
      `SELECT fr.* FROM friend_requests fr
       JOIN agents a ON a.id = fr.from_agent_id
       WHERE a.owner_user_id = ? AND fr.status = 'pending'
       ORDER BY fr.created_at DESC`,
    )
    .all(userId) as FriendRequest[];
}
