import "server-only";
import { db } from "./db";
import { newAgentLinkId } from "./ids";
import { logAudit } from "./audit";
import { getAgent } from "./agents";
import {
  getConversation,
  listMembers,
  recordConversationEvent,
} from "./conversations";

// -------------------------------------------------------------------------
// Types
// -------------------------------------------------------------------------

export type AgentLinkStatus =
  | "pending"
  | "accepted"
  | "declined"
  | "revoked";

export type AgentLink = {
  id: string;
  agent_a: string;            // sorted lex: agent_a < agent_b
  agent_b: string;
  conversation_id: string;
  initiated_by_user_id: string;
  status: AgentLinkStatus;
  created_at: number;
  responded_at: number | null;
  responded_by_user_id: string | null;
};

function sortPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

// -------------------------------------------------------------------------
// Lookup
// -------------------------------------------------------------------------

export function getLink(id: string): AgentLink | null {
  return (
    (db()
      .prepare(
        `SELECT id, agent_a, agent_b, conversation_id, initiated_by_user_id,
                status, created_at, responded_at, responded_by_user_id
         FROM agent_links WHERE id = ?`,
      )
      .get(id) as AgentLink | undefined) ?? null
  );
}

export function findLink(
  agentA: string,
  agentB: string,
  convId: string,
): AgentLink | null {
  const [x, y] = sortPair(agentA, agentB);
  return (
    (db()
      .prepare(
        `SELECT id, agent_a, agent_b, conversation_id, initiated_by_user_id,
                status, created_at, responded_at, responded_by_user_id
         FROM agent_links
         WHERE agent_a = ? AND agent_b = ? AND conversation_id = ?`,
      )
      .get(x, y, convId) as AgentLink | undefined) ?? null
  );
}

export function listLinksForConversation(convId: string): AgentLink[] {
  return db()
    .prepare(
      `SELECT id, agent_a, agent_b, conversation_id, initiated_by_user_id,
              status, created_at, responded_at, responded_by_user_id
       FROM agent_links WHERE conversation_id = ?
       ORDER BY created_at ASC`,
    )
    .all(convId) as AgentLink[];
}

export function areInterconnected(
  agentA: string,
  agentB: string,
  convId: string,
): boolean {
  const l = findLink(agentA, agentB, convId);
  return !!l && l.status === "accepted";
}

// -------------------------------------------------------------------------
// Mutate
// -------------------------------------------------------------------------

function requireBothInConv(
  agentA: string,
  agentB: string,
  convId: string,
): void {
  if (agentA === agentB) {
    throw new Error("Agent can't interconnect with itself.");
  }
  const conv = getConversation(convId);
  if (!conv) throw new Error("Conversation not found.");
  const memberIds = new Set(listMembers(convId).map((m) => m.agent_id));
  if (!memberIds.has(agentA) || !memberIds.has(agentB)) {
    throw new Error("Both agents must be members of the conversation.");
  }
}

export function requestAgentLink(input: {
  conversation_id: string;
  my_agent_id: string;
  their_agent_id: string;
  initiating_user_id: string;
}): AgentLink {
  const myAgent = getAgent(input.my_agent_id);
  if (!myAgent) throw new Error("Your agent not found.");
  if (myAgent.owner_user_id !== input.initiating_user_id) {
    throw new Error("That isn't your agent.");
  }
  const theirAgent = getAgent(input.their_agent_id);
  if (!theirAgent) throw new Error("Target agent not found.");
  // Per the design: cross-user interconnect requires opt-in; same-user agents
  // are already interoperable so we reject here to avoid meaningless links.
  if (theirAgent.owner_user_id === input.initiating_user_id) {
    throw new Error(
      "These agents are both yours — they already collaborate freely.",
    );
  }
  requireBothInConv(input.my_agent_id, input.their_agent_id, input.conversation_id);

  const existing = findLink(input.my_agent_id, input.their_agent_id, input.conversation_id);
  if (existing) {
    if (existing.status === "pending") {
      throw new Error("Interconnect request already pending.");
    }
    if (existing.status === "accepted") {
      throw new Error("Already interconnected.");
    }
    // declined / revoked — re-open by deleting + re-inserting
    db().prepare("DELETE FROM agent_links WHERE id = ?").run(existing.id);
  }

  const [x, y] = sortPair(input.my_agent_id, input.their_agent_id);
  const id = newAgentLinkId();
  const now = Date.now();
  db()
    .prepare(
      `INSERT INTO agent_links
       (id, agent_a, agent_b, conversation_id, initiated_by_user_id,
        status, created_at, responded_at, responded_by_user_id)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL, NULL)`,
    )
    .run(id, x, y, input.conversation_id, input.initiating_user_id, now);
  logAudit("agent_link.request", {
    userId: input.initiating_user_id,
    agentId: input.my_agent_id,
    detail: {
      link_id: id,
      conversation_id: input.conversation_id,
      target_agent_id: input.their_agent_id,
    },
  });
  // Emit a conversation event so the other side sees the request via SSE.
  recordConversationEvent(input.conversation_id, "agent_link.request", id);
  return getLink(id)!;
}

export function respondAgentLink(input: {
  link_id: string;
  responding_user_id: string;
  decision: "accept" | "decline";
}): AgentLink {
  const link = getLink(input.link_id);
  if (!link) throw new Error("Link not found.");
  if (link.status !== "pending") {
    throw new Error(`Link is ${link.status}, can't respond.`);
  }
  // Only the OTHER side may respond. Determine the "other" agent then check
  // its owner_user_id == responding_user_id.
  const initiatorUserId = link.initiated_by_user_id;
  if (initiatorUserId === input.responding_user_id) {
    throw new Error("You're the initiator — wait for the other party.");
  }
  // Confirm the responding user actually owns one of the two agents.
  const aOwner = getAgent(link.agent_a)?.owner_user_id;
  const bOwner = getAgent(link.agent_b)?.owner_user_id;
  if (
    aOwner !== input.responding_user_id &&
    bOwner !== input.responding_user_id
  ) {
    throw new Error("You don't own either agent in this link.");
  }
  const now = Date.now();
  const status: AgentLinkStatus =
    input.decision === "accept" ? "accepted" : "declined";
  db()
    .prepare(
      `UPDATE agent_links
       SET status = ?, responded_at = ?, responded_by_user_id = ?
       WHERE id = ? AND status = 'pending'`,
    )
    .run(status, now, input.responding_user_id, link.id);
  logAudit(
    input.decision === "accept"
      ? "agent_link.accept"
      : "agent_link.decline",
    {
      userId: input.responding_user_id,
      detail: { link_id: link.id, conversation_id: link.conversation_id },
    },
  );
  recordConversationEvent(
    link.conversation_id,
    input.decision === "accept" ? "agent_link.accepted" : "agent_link.declined",
    link.id,
  );
  return getLink(link.id)!;
}

export function revokeAgentLink(input: {
  link_id: string;
  user_id: string;
}): void {
  const link = getLink(input.link_id);
  if (!link) return;
  // Either party (the initiator OR the responder's user) can revoke an
  // accepted/pending link.
  const aOwner = getAgent(link.agent_a)?.owner_user_id;
  const bOwner = getAgent(link.agent_b)?.owner_user_id;
  if (
    input.user_id !== aOwner &&
    input.user_id !== bOwner &&
    input.user_id !== link.initiated_by_user_id
  ) {
    throw new Error("Not a participant in this link.");
  }
  if (link.status === "revoked" || link.status === "declined") return;
  db()
    .prepare(
      `UPDATE agent_links SET status = 'revoked', responded_at = ?, responded_by_user_id = ?
       WHERE id = ?`,
    )
    .run(Date.now(), input.user_id, link.id);
  logAudit("agent_link.revoke", {
    userId: input.user_id,
    detail: { link_id: link.id, conversation_id: link.conversation_id },
  });
  recordConversationEvent(
    link.conversation_id,
    "agent_link.revoked",
    link.id,
  );
}
