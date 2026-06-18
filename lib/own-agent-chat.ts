import "server-only";
import { db } from "./db";
import { getAgent, listAgentsForUser } from "./agents";
import {
  createDirectConversation,
  getConversation,
  listMessages,
} from "./conversations";
import type { Agent, MessageWithRelations } from "./types";

// ---------------------------------------------------------------------------
// "Chat with my agent" private channel
//
// For any user we ensure there's a 1-on-1 direct conversation between their
// primary EXTERNAL agent (the one that represents the human typing) and their
// primary MANAGED agent (the one that auto-replies). The dock UI shown on
// the left of any collab room renders this conversation.
//
// Why a real conversation (not a synthetic feed)?
//   - Reuses the existing message pipeline, SSE, search, attachments, and
//     auto-reply job system. The managed agent already auto-replies in 1:1s
//     thanks to enqueueRepliesForMessage in lib/managed-agents.ts.
//   - The user can open the same chat full-screen via the sidebar.
//   - History persists across collab rooms — the agent has long memory.
// ---------------------------------------------------------------------------

export type OwnAgentChannel = {
  conversation_id: string;
  external_agent: Agent;
  managed_agent: Agent;
  recent_messages: MessageWithRelations[];
};

/** Pick the user's most-recently-used external agent. Falls back to the
 *  oldest non-managed agent. Returns null if the user has none. */
export function pickPrimaryExternalAgent(userId: string): Agent | null {
  const agents = listAgentsForUser(userId);
  const external = agents.filter((a) => a.agent_kind === "external");
  if (external.length === 0) return null;
  external.sort(
    (a, b) =>
      (b.last_message_at ?? b.created_at) -
      (a.last_message_at ?? a.created_at),
  );
  return external[0];
}

/** Pick the user's most-recently-used managed agent. */
export function pickPrimaryManagedAgent(userId: string): Agent | null {
  const agents = listAgentsForUser(userId);
  const managed = agents.filter((a) => a.agent_kind === "managed");
  if (managed.length === 0) return null;
  managed.sort(
    (a, b) =>
      (b.last_message_at ?? b.created_at) -
      (a.last_message_at ?? a.created_at),
  );
  return managed[0];
}

/** Return the direct conversation id between the two agents, creating one
 *  if it doesn't yet exist. createDirectConversation already handles the
 *  "exists" path idempotently and accepts same-owner pairs (areFriends() is
 *  true for same-owner agents by default). */
export function ensureOwnAgentConversation(
  userId: string,
  externalAgentId: string,
  managedAgentId: string,
): string {
  // Look up an existing direct conv between this exact pair first to
  // avoid the friend-check path in createDirectConversation when the
  // conversation already exists (cheap, also makes the function idempotent
  // even if the friendship row got cleaned for some reason).
  const existing = db()
    .prepare(
      `SELECT c.id FROM conversations c
       JOIN conversation_members m1 ON m1.conversation_id = c.id AND m1.agent_id = ?
       JOIN conversation_members m2 ON m2.conversation_id = c.id AND m2.agent_id = ?
       WHERE c.type = 'direct' LIMIT 1`,
    )
    .get(externalAgentId, managedAgentId) as { id: string } | undefined;
  if (existing) return existing.id;
  const conv = createDirectConversation(
    userId,
    externalAgentId,
    managedAgentId,
  );
  return conv.id;
}

export function getOwnAgentChannel(userId: string): OwnAgentChannel | null {
  const ext = pickPrimaryExternalAgent(userId);
  const managed = pickPrimaryManagedAgent(userId);
  if (!ext || !managed) return null;
  const convId = ensureOwnAgentConversation(userId, ext.id, managed.id);
  const conv = getConversation(convId);
  if (!conv) return null;
  const recent = listMessages(convId, { limit: 50 });
  // Make sure both agents still resolve (defensive against race conditions
  // where one was just deleted).
  const extNow = getAgent(ext.id);
  const managedNow = getAgent(managed.id);
  if (!extNow || !managedNow) return null;
  return {
    conversation_id: convId,
    external_agent: extNow,
    managed_agent: managedNow,
    recent_messages: recent,
  };
}
