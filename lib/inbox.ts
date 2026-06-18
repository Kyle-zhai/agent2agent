import "server-only";
import { db } from "./db";

// ---------------------------------------------------------------------------
// Agent Inbox — one read-only aggregation of everything "waiting on me".
//
// Five sources, each of which already has its own approval surface:
//   1. handoffs        — proposed, addressed to me            → conversation
//   2. agent_links     — pending, my agent is the target      → conversation
//   3. friend_requests — pending, addressed to my agents      → /app/contacts
//   4. tasks           — awaiting_review, my agent owns them  → task detail
//   5. device_auth     — pending device authorizations        → /app/device
//
// This module NEVER mutates: there are deliberately no accept/decline helpers
// here. The inbox links back to where each item is handled today so there is
// a single source of truth per workflow (no duplicate approval channels).
//
// Cross-user isolation is the hard requirement: every query is keyed on the
// viewing user's id (via ownership joins), EXCEPT device-auth requests, which
// are unscoped pre-approval by design — any signed-in user can approve one on
// /app/device (proof of possession is the typed code, which we intentionally
// do NOT surface here).
// ---------------------------------------------------------------------------

export type InboxKind =
  | "handoff"
  | "agent_link"
  | "friend_request"
  | "task_review"
  | "device_auth";

export type InboxItem = {
  kind: InboxKind;
  /** Id of the underlying row (handoff id, link id, request id, task id…). */
  id: string;
  title: string;
  subtitle: string;
  /** When the item started waiting on the user (ms epoch). */
  created_at: number;
  /** Where this item is handled today — the inbox adds no approval surface. */
  href: string;
};

function pendingHandoffs(userId: string): InboxItem[] {
  const rows = db()
    .prepare(
      `SELECT id, title, from_agent_id, conversation_id, created_at
       FROM handoffs
       WHERE to_user_id = ? AND status = 'proposed'
       ORDER BY created_at DESC`,
    )
    .all(userId) as Array<{
    id: string;
    title: string;
    from_agent_id: string;
    conversation_id: string;
    created_at: number;
  }>;
  return rows.map((r) => ({
    kind: "handoff" as const,
    id: r.id,
    title: r.title,
    subtitle: `Handoff from ${r.from_agent_id} — accept or decline`,
    created_at: r.created_at,
    href: `/app/c/${encodeURIComponent(r.conversation_id)}`,
  }));
}

function pendingAgentLinks(userId: string): InboxItem[] {
  // "Waiting on me" = pending AND I own one of the two agents AND I did not
  // initiate (respondAgentLink refuses the initiator). requestAgentLink
  // rejects same-owner pairs, so exactly one side belongs to the responder.
  const rows = db()
    .prepare(
      `SELECT l.id, l.agent_a, l.agent_b, l.conversation_id, l.created_at
       FROM agent_links l
       JOIN agents a ON a.id = l.agent_a
       JOIN agents b ON b.id = l.agent_b
       WHERE l.status = 'pending'
         AND l.initiated_by_user_id != ?
         AND (a.owner_user_id = ? OR b.owner_user_id = ?)
       ORDER BY l.created_at DESC`,
    )
    .all(userId, userId, userId) as Array<{
    id: string;
    agent_a: string;
    agent_b: string;
    conversation_id: string;
    created_at: number;
  }>;
  return rows.map((r) => ({
    kind: "agent_link" as const,
    id: r.id,
    title: "Agent interconnect request",
    subtitle: `${r.agent_a} ↔ ${r.agent_b}`,
    created_at: r.created_at,
    href: `/app/c/${encodeURIComponent(r.conversation_id)}`,
  }));
}

function pendingFriendRequests(userId: string): InboxItem[] {
  const rows = db()
    .prepare(
      `SELECT fr.id, fr.from_agent_id, fr.to_agent_id, fr.created_at
       FROM friend_requests fr
       JOIN agents a ON a.id = fr.to_agent_id
       WHERE a.owner_user_id = ? AND fr.status = 'pending'
       ORDER BY fr.created_at DESC`,
    )
    .all(userId) as Array<{
    id: string;
    from_agent_id: string;
    to_agent_id: string;
    created_at: number;
  }>;
  return rows.map((r) => ({
    kind: "friend_request" as const,
    id: r.id,
    title: "Friend request",
    subtitle: `${r.from_agent_id} wants to friend ${r.to_agent_id}`,
    created_at: r.created_at,
    href: "/app/contacts",
  }));
}

function tasksAwaitingMyReview(userId: string): InboxItem[] {
  // Reviewability rule kept simple and aligned with the task lifecycle: the
  // owner agent's human decides on awaiting_review work (the assignee cannot
  // approve their own output). We surface created_at as "since the review was
  // requested" using updated_at — the transition into awaiting_review touches
  // updated_at, which is the moment the task started waiting on this user.
  const rows = db()
    .prepare(
      `SELECT t.id, t.title, t.conversation_id, t.owner_agent_id,
              t.assigned_to_agent_id, t.updated_at
       FROM tasks t
       JOIN agents o ON o.id = t.owner_agent_id
       WHERE o.owner_user_id = ? AND t.status = 'awaiting_review'
       ORDER BY t.updated_at DESC`,
    )
    .all(userId) as Array<{
    id: string;
    title: string;
    conversation_id: string | null;
    owner_agent_id: string;
    assigned_to_agent_id: string | null;
    updated_at: number;
  }>;
  return rows.map((r) => ({
    kind: "task_review" as const,
    id: r.id,
    title: r.title,
    subtitle: r.assigned_to_agent_id
      ? `Awaiting review — work by ${r.assigned_to_agent_id}`
      : "Awaiting review",
    created_at: r.updated_at,
    // Task detail lives under its conversation. A conversationless task has
    // no detail page; fall back to the owning agent's page.
    href: r.conversation_id
      ? `/app/c/${encodeURIComponent(r.conversation_id)}/tasks/${encodeURIComponent(r.id)}`
      : `/app/agents/${encodeURIComponent(r.owner_agent_id)}`,
  }));
}

function pendingDeviceAuth(): InboxItem[] {
  // Unscoped pre-approval (the row binds to a user only when approved), so
  // these show for every signed-in user — exactly like /app/device. We do NOT
  // include the user_code: typing the code the device displays is the
  // proof-of-possession step, and leaking it here would defeat it.
  const rows = db()
    .prepare(
      `SELECT id, agent_name, platform, created_at
       FROM device_auth_requests
       WHERE status = 'pending' AND expires_at > ?
       ORDER BY created_at DESC`,
    )
    .all(Date.now()) as Array<{
    id: string;
    agent_name: string;
    platform: string;
    created_at: number;
  }>;
  return rows.map((r) => ({
    kind: "device_auth" as const,
    id: r.id,
    title: `“${r.agent_name || "Unnamed agent"}” wants to connect`,
    subtitle: `Device authorization (${r.platform}) — enter the code shown on the device`,
    created_at: r.created_at,
    href: "/app/device",
  }));
}

/** Everything pending the user's decision, newest first. */
export function listInboxItems(userId: string): InboxItem[] {
  const items = [
    ...pendingHandoffs(userId),
    ...pendingAgentLinks(userId),
    ...pendingFriendRequests(userId),
    ...tasksAwaitingMyReview(userId),
    ...pendingDeviceAuth(),
  ];
  items.sort((a, b) => b.created_at - a.created_at);
  return items;
}

/** Badge count for the sidebar rail — total across all five sources. */
export function countInboxItems(userId: string): number {
  return listInboxItems(userId).length;
}
