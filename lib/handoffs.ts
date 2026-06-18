import "server-only";
import { db } from "./db";
import { newHandoffId } from "./ids";
import { logAudit } from "./audit";
import { getAgent } from "./agents";
import {
  getConversation,
  listMembers,
  recordConversationEvent,
  sendMessage,
} from "./conversations";
import {
  canRead,
  canWrite,
  getSubscription,
  getWorkspace,
  subscribeAgent,
} from "./workspaces";
import {
  findLink,
  requestAgentLink,
  respondAgentLink,
} from "./agent-links";
import { createTask } from "./tasks";
import {
  ALL_SCOPES,
  DURATION_PRESETS,
  createGrantsForHandoff,
  revokeGrantsForHandoff,
} from "./grants";
import type { Handoff, HandoffStatus, GrantScope } from "./types";

export type { Handoff, HandoffStatus } from "./types";

// ---------------------------------------------------------------------------
// Content filtering
//
// The composer accepts markers the user (talking to their own agent) drops to
// keep things out of the share-able body:
//
//   [[private]] some sentence [[/private]]
//   [[private]] one-line note (until newline)
//   {{private: note }}
//   >private: an entire line
//
// In addition to markers, lines that match heuristic phrases like "do not
// share" / "internal only" / "confidential" are auto-redacted so a careless
// user doesn't leak by forgetting markers. We never silently drop content
// without counting it — every redaction increments `redaction_count` and the
// `private_summary` lists how many bits were hidden + why.
// ---------------------------------------------------------------------------

const HEURISTIC_PHRASES: Array<{ re: RegExp; reason: string }> = [
  { re: /\bdo not share\b/i, reason: "matched 'do not share'" },
  { re: /\bdon't share\b/i, reason: "matched 'don't share'" },
  { re: /\binternal only\b/i, reason: "matched 'internal only'" },
  { re: /\bconfidential\b/i, reason: "matched 'confidential'" },
  { re: /\bnot for sharing\b/i, reason: "matched 'not for sharing'" },
  { re: /\bsecret:/i, reason: "matched 'secret:'" },
];

export type FilterResult = {
  shared_body: string;
  private_summary: string;
  redaction_count: number;
  redactions: Array<{ reason: string; chars: number }>;
};

const REDACTION_PLACEHOLDER = "〈hidden by your assistant〉";

export function filterPrivateContent(input: string): FilterResult {
  const redactions: Array<{ reason: string; chars: number }> = [];
  let text = input;

  // 1. [[private]] ... [[/private]] block markers (multi-line, non-greedy).
  text = text.replace(
    /\[\[private\]\]([\s\S]*?)\[\[\/private\]\]/gi,
    (_, body: string) => {
      redactions.push({
        reason: "[[private]] block",
        chars: body.length,
      });
      return REDACTION_PLACEHOLDER;
    },
  );

  // 2. {{private: ...}} inline.
  text = text.replace(/\{\{\s*private\s*:\s*([\s\S]*?)\}\}/gi, (_, body: string) => {
    redactions.push({
      reason: "{{private:}} inline",
      chars: body.length,
    });
    return REDACTION_PLACEHOLDER;
  });

  // 3. [[private]] up to end-of-line (single-line marker without closer).
  text = text.replace(/\[\[private\]\][^\n]*/gi, (m: string) => {
    redactions.push({
      reason: "[[private]] one-liner",
      chars: m.length,
    });
    return REDACTION_PLACEHOLDER;
  });

  // 4. Line-leading "> private:" or "# private:".
  text = text.replace(/^[ \t]*[>#]\s*private\s*:[^\n]*/gim, (m: string) => {
    redactions.push({
      reason: "private: prefixed line",
      chars: m.length,
    });
    return REDACTION_PLACEHOLDER;
  });

  // 5. Heuristic phrase scan, line-by-line. Only triggers on lines NOT already
  //    redacted — otherwise the placeholder itself would re-match.
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (line.includes(REDACTION_PLACEHOLDER)) {
      out.push(line);
      continue;
    }
    let matched = false;
    for (const h of HEURISTIC_PHRASES) {
      if (h.re.test(line)) {
        redactions.push({ reason: h.reason, chars: line.length });
        out.push(REDACTION_PLACEHOLDER);
        matched = true;
        break;
      }
    }
    if (!matched) out.push(line);
  }
  const sharedBody = out.join("\n").trim();

  const reasons = new Map<string, number>();
  for (const r of redactions) {
    reasons.set(r.reason, (reasons.get(r.reason) ?? 0) + 1);
  }
  const summaryLines: string[] = [];
  if (redactions.length === 0) {
    summaryLines.push("Nothing was filtered out.");
  } else {
    summaryLines.push(
      `${redactions.length} section${redactions.length === 1 ? "" : "s"} hidden:`,
    );
    for (const [reason, count] of reasons) {
      summaryLines.push(`  • ${count}× ${reason}`);
    }
  }
  return {
    shared_body: sharedBody,
    private_summary: summaryLines.join("\n"),
    redaction_count: redactions.length,
    redactions,
  };
}

// ---------------------------------------------------------------------------
// CRUD + lifecycle
// ---------------------------------------------------------------------------

const HANDOFF_COLUMNS =
  "id, conversation_id, workspace_id, from_agent_id, from_user_id, " +
  "to_agent_id, to_user_id, title, brief, shared_body, private_summary, " +
  "redaction_count, attachment_ids_json, task_id, link_id, status, " +
  "created_at, responded_at, response_note, scopes_json, duration_key";

export function getHandoff(id: string): Handoff | null {
  return (
    (db()
      .prepare(`SELECT ${HANDOFF_COLUMNS} FROM handoffs WHERE id = ?`)
      .get(id) as Handoff | undefined) ?? null
  );
}

export function listHandoffsForConversation(
  conversationId: string,
  limit = 50,
): Handoff[] {
  return db()
    .prepare(
      `SELECT ${HANDOFF_COLUMNS} FROM handoffs
       WHERE conversation_id = ?
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(conversationId, limit) as Handoff[];
}

/** Proposed handoffs awaiting THIS user's decision (to_user is them). Used by
 *  the agent-facing heartbeat (`pending_handoffs`) and the REST list endpoint
 *  so a local agent can discover what it needs to accept/decline — the
 *  agent-driven equivalent of the web Inbox's pending-handoffs row. */
export function listPendingHandoffsToUser(userId: string, limit = 50): Handoff[] {
  return db()
    .prepare(
      `SELECT ${HANDOFF_COLUMNS} FROM handoffs
       WHERE to_user_id = ? AND status = 'proposed'
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(userId, limit) as Handoff[];
}

/** Every handoff this user is a party to (proposer OR recipient), newest
 *  first — backs `GET /api/v1/handoffs` so an agent can see the full picture
 *  (what it offered, what it received, and their statuses). */
export function listHandoffsForUser(userId: string, limit = 50): Handoff[] {
  return db()
    .prepare(
      `SELECT ${HANDOFF_COLUMNS} FROM handoffs
       WHERE from_user_id = ? OR to_user_id = ?
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(userId, userId, limit) as Handoff[];
}

export type ProposeHandoffInput = {
  conversation_id: string;
  from_user_id: string;
  from_agent_id: string;
  to_agent_id: string;
  title: string;
  brief: string;
  body: string;
  attachment_ids?: string[];
  workspace_id?: string | null;
  /** Scope set the recipient agent will receive on accept. Defaults to
   *  ["read","comment"] — least-privilege baseline. */
  scopes?: import("./types").GrantScope[];
  /** Duration preset key from DURATION_PRESETS (e.g. "24h"). */
  duration_key?: string;
};

export function proposeHandoff(input: ProposeHandoffInput): Handoff {
  const title = input.title.trim();
  if (title.length < 1 || title.length > 120) {
    throw new Error("Handoff title must be 1–120 characters.");
  }
  const brief = (input.brief ?? "").trim().slice(0, 600);
  if (input.body.length > 16_000) {
    throw new Error("Handoff body is too long (limit 16k chars).");
  }
  const conv = getConversation(input.conversation_id);
  if (!conv) throw new Error("Conversation not found.");

  const fromAgent = getAgent(input.from_agent_id);
  if (!fromAgent) throw new Error("Your agent not found.");
  if (fromAgent.owner_user_id !== input.from_user_id) {
    throw new Error("That isn't your agent.");
  }
  const toAgent = getAgent(input.to_agent_id);
  if (!toAgent) throw new Error("Target agent not found.");
  if (toAgent.owner_user_id === input.from_user_id) {
    throw new Error(
      "Hand off to a peer's agent — your own agents already collaborate freely.",
    );
  }

  const memberIds = new Set(listMembers(input.conversation_id).map((m) => m.agent_id));
  if (!memberIds.has(fromAgent.id) || !memberIds.has(toAgent.id)) {
    throw new Error("Both agents must be members of this conversation.");
  }

  if (input.workspace_id) {
    const ws = getWorkspace(input.workspace_id);
    if (!ws) throw new Error("Workspace not found.");
    if (ws.conversation_id && ws.conversation_id !== input.conversation_id) {
      throw new Error("Workspace belongs to a different conversation.");
    }
  }

  const filtered = filterPrivateContent(input.body);

  // Normalise + validate scope/duration choice so a bad form value can't
  // sneak into the DB and re-emerge at accept time. ALL_SCOPES and
  // DURATION_PRESETS are the canonical lists.
  const allScopeNames = new Set<string>(ALL_SCOPES as readonly string[]);
  const cleanScopes = (input.scopes ?? ["read", "comment"]).filter((s) =>
    allScopeNames.has(s),
  );
  if (cleanScopes.length === 0) cleanScopes.push("read");
  const durationKey =
    DURATION_PRESETS.find((d) => d.key === input.duration_key)?.key ?? "24h";

  // Authority gate: the proposer can only delegate workspace access they
  // already hold. write/admin scopes require write; read/comment require
  // read. Without this, accept-time subscription would bootstrap authority
  // the proposer never had (privilege escalation onto someone else's
  // workspace, defeating the grant system's assertGranterAuthority).
  if (input.workspace_id) {
    const needsWrite = cleanScopes.some((s) => s === "write" || s === "admin");
    const hasAuthority = needsWrite
      ? canWrite(input.workspace_id, fromAgent.id)
      : canRead(input.workspace_id, fromAgent.id);
    if (!hasAuthority) {
      throw new Error(
        needsWrite
          ? "You don't have write access to that workspace to hand off."
          : "You don't have access to that workspace to hand off.",
      );
    }
  }

  const id = newHandoffId();
  const now = Date.now();
  db()
    .prepare(
      `INSERT INTO handoffs
       (id, conversation_id, workspace_id,
        from_agent_id, from_user_id, to_agent_id, to_user_id,
        title, brief, shared_body, private_summary, redaction_count,
        attachment_ids_json, task_id, link_id, status,
        created_at, responded_at, response_note,
        scopes_json, duration_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'proposed', ?, NULL, '', ?, ?)`,
    )
    .run(
      id,
      input.conversation_id,
      input.workspace_id ?? null,
      fromAgent.id,
      input.from_user_id,
      toAgent.id,
      toAgent.owner_user_id,
      title,
      brief,
      filtered.shared_body,
      filtered.private_summary,
      filtered.redaction_count,
      JSON.stringify(input.attachment_ids ?? []),
      now,
      JSON.stringify(cleanScopes),
      durationKey,
    );

  // Drop a system message into the conversation so peers see the handoff
  // arrive as a card in chat. The message body is short — the card itself
  // renders the rich content. The ref_id on the conversation_event lets
  // ConversationView locate handoff data without an extra round-trip.
  const announce = `📨 Handoff: **${title}** — awaiting ${toAgent.display_name}'s human review.`;
  try {
    sendMessage(input.conversation_id, fromAgent.id, {
      text: announce,
      kind: "agent_to_agent",
    });
  } catch (err) {
    // Roll back the handoff row if the announcement send fails — otherwise
    // we'd have a phantom proposal nobody sees.
    db().prepare("DELETE FROM handoffs WHERE id = ?").run(id);
    throw err;
  }
  recordConversationEvent(input.conversation_id, "handoff.proposed", id);
  logAudit("handoff.propose", {
    userId: input.from_user_id,
    agentId: fromAgent.id,
    detail: {
      handoff_id: id,
      conversation_id: input.conversation_id,
      to_agent: toAgent.id,
      to_user: toAgent.owner_user_id,
      redactions: filtered.redaction_count,
      workspace_id: input.workspace_id ?? null,
    },
  });
  return getHandoff(id)!;
}

export type RespondHandoffInput = {
  handoff_id: string;
  responding_user_id: string;
  decision: "accept" | "decline";
  note?: string;
};

export function respondHandoff(input: RespondHandoffInput): Handoff {
  const h = getHandoff(input.handoff_id);
  if (!h) throw new Error("Handoff not found.");
  if (h.status !== "proposed") {
    throw new Error(`Handoff is ${h.status}; only proposed handoffs can be answered.`);
  }
  if (h.to_user_id !== input.responding_user_id) {
    throw new Error("Only the receiving user can respond to this handoff.");
  }

  const note = (input.note ?? "").trim().slice(0, 600);
  const now = Date.now();

  if (input.decision === "decline") {
    // Race-safe gate: only flip if status is still 'proposed'. A concurrent
    // accept/decline would have already moved status; we must not stomp on it.
    const info = db()
      .prepare(
        `UPDATE handoffs
         SET status = 'declined', responded_at = ?, response_note = ?
         WHERE id = ? AND status = 'proposed'`,
      )
      .run(now, note, h.id);
    if (info.changes === 0) {
      throw new Error(
        "Handoff was already resolved (refresh and try again).",
      );
    }
    recordConversationEvent(h.conversation_id, "handoff.declined", h.id);
    logAudit("handoff.decline", {
      userId: input.responding_user_id,
      detail: { handoff_id: h.id, conversation_id: h.conversation_id },
    });
    try {
      sendMessage(h.conversation_id, h.to_agent_id, {
        text:
          `❌ Handoff declined: **${h.title}**` +
          (note ? `\n\n> ${note.replace(/\n/g, "\n> ")}` : ""),
        kind: "agent_to_agent",
      });
    } catch {
      // Best effort — the chat note is a courtesy.
    }
    return getHandoff(h.id)!;
  }

  // ACCEPT — wire collaboration plumbing in a single transaction so partial
  // failures don't leave us with, e.g., a workspace subscription but no task.
  //
  // Defensive re-checks because the world can shift between propose and
  // accept: agents leaving the conversation, workspaces being deleted, or
  // an opposite-direction agent_link being raced through the API.
  // NOTE: the membership re-check lives INSIDE the transaction below — a
  // pre-transaction check would leave a window where a concurrent member
  // removal lands between check and commit, minting grants for an agent
  // that is no longer in the room (OWASP ASI08).

  if (h.workspace_id && !getWorkspace(h.workspace_id)) {
    throw new Error(
      "The shared workspace was deleted — handoff can't proceed.",
    );
  }
  if (h.workspace_id) {
    // Re-verify the proposer STILL holds the access being delegated — it can
    // be revoked between propose and accept. Without this pre-check the
    // failure surfaces inside the transaction as assertGranterAuthority's
    // "Cannot grant access you don't hold" — a confusing error aimed at the
    // wrong party (the accepting recipient). Checking here keeps the handoff
    // cleanly in 'proposed' with an accurate, actionable message.
    let needsWrite = false;
    try {
      const raw = JSON.parse(h.scopes_json) as unknown;
      needsWrite =
        Array.isArray(raw) && raw.some((s) => s === "write" || s === "admin");
    } catch {
      /* default read */
    }
    const stillHas = needsWrite
      ? canWrite(h.workspace_id, h.from_agent_id)
      : canRead(h.workspace_id, h.from_agent_id);
    if (!stillHas) {
      throw new Error(
        "The proposer no longer has access to the shared workspace — this handoff can't be accepted. Ask them to re-propose.",
      );
    }
  }

  let linkId: string | null = null;
  let taskId: string | null = null;
  let grantIds: string[] = [];

  const tx = db().transaction(() => {
    // Membership re-validation, transactionally serialized with the grant
    // mint: SQLite's single writer means no member removal can interleave
    // between this read and the commit. If either agent left the room the
    // whole accept (status flip included) rolls back cleanly.
    const members = new Set(
      listMembers(h.conversation_id).map((m) => m.agent_id),
    );
    if (!members.has(h.from_agent_id) || !members.has(h.to_agent_id)) {
      throw new Error(
        "One of the agents has left the conversation — handoff can't proceed.",
      );
    }

    // Race-safe gate the same way decline does: only flip status if it was
    // still 'proposed' at the start of this transaction.
    const gate = db()
      .prepare(
        `UPDATE handoffs SET status = 'accepted',
                            responded_at = ?,
                            response_note = ?
         WHERE id = ? AND status = 'proposed'`,
      )
      .run(now, note, h.id);
    if (gate.changes === 0) {
      throw new Error(
        "Handoff was already resolved (refresh and try again).",
      );
    }

    if (h.workspace_id) {
      // Subscription = "is admitted to this room at all". Grant = "what
      // exactly are they allowed to do". The proposer (from_agent) must
      // ALREADY hold the access being delegated — verified at propose time
      // and re-verified by assertGranterAuthority when the grant is minted
      // below — so we do NOT bootstrap a writer subscription for them here.
      // Doing so would manufacture the very authority the grant system is
      // supposed to require (privilege escalation). We only admit the
      // RECIPIENT as a reader so they appear in the workspace membership
      // panel; their actual capability rides on the signed, revocable grant.
      const toSub = getSubscription(h.workspace_id, h.to_agent_id);
      if (!toSub) {
        subscribeAgent(h.workspace_id, h.to_agent_id, "reader");
      }
    }

    // Mint the capability-scoped grants the recipient will actually use
    // to read/write the shared resources. createGrantsForHandoff issues
    // one grant per resource (conversation always, workspace if any).
    let parsedScopes: GrantScope[];
    try {
      const raw = JSON.parse(h.scopes_json) as unknown;
      parsedScopes = Array.isArray(raw)
        ? raw.filter((s): s is GrantScope =>
            (ALL_SCOPES as readonly string[]).includes(s as string),
          )
        : ["read", "comment"];
      if (parsedScopes.length === 0) parsedScopes = ["read"];
    } catch {
      parsedScopes = ["read", "comment"];
    }
    const grants = createGrantsForHandoff({
      handoff_id: h.id,
      from_user_id: h.from_user_id,
      from_agent_id: h.from_agent_id,
      to_agent_id: h.to_agent_id,
      workspace_id: h.workspace_id,
      conversation_id: h.conversation_id,
      scopes: parsedScopes,
      duration_key: h.duration_key,
    });
    grantIds = grants.map((g) => g.id);

    // Interconnect — find existing, otherwise create + immediately accept.
    // We tolerate the "bob already initiated a link the other direction"
    // case: the handoff acceptance is intent enough to upgrade the link,
    // but respondAgentLink refuses self-response. We fall through to
    // leaving the existing pending link untouched — humans can sort it
    // out via the Members panel — rather than failing the entire accept.
    let link = findLink(h.from_agent_id, h.to_agent_id, h.conversation_id);
    try {
      if (!link) {
        link = requestAgentLink({
          conversation_id: h.conversation_id,
          my_agent_id: h.from_agent_id,
          their_agent_id: h.to_agent_id,
          initiating_user_id: h.from_user_id,
        });
      }
      if (link.status === "pending") {
        link = respondAgentLink({
          link_id: link.id,
          responding_user_id: input.responding_user_id,
          decision: "accept",
        });
      } else if (link.status === "declined" || link.status === "revoked") {
        // Reopen — requestAgentLink deletes the prior row first.
        link = requestAgentLink({
          conversation_id: h.conversation_id,
          my_agent_id: h.from_agent_id,
          their_agent_id: h.to_agent_id,
          initiating_user_id: h.from_user_id,
        });
        link = respondAgentLink({
          link_id: link.id,
          responding_user_id: input.responding_user_id,
          decision: "accept",
        });
      }
      linkId = link.id;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // The "you're the initiator" case is the one we intentionally swallow.
      // Anything else (membership, ownership) is a real bug — re-throw to
      // roll back the transaction.
      if (!/initiator/i.test(msg)) throw err;
      linkId = link?.id ?? null;
    }

    // Collab task — owned by the from-agent (who proposed), assigned to the
    // to-agent (who agreed to do the work).
    const taskDescription =
      `Handoff from ${h.from_agent_id}.\n\n` +
      (h.brief ? `Brief:\n${h.brief}\n\n` : "") +
      `Shared body:\n${h.shared_body || "(no body — see brief)"}` +
      (note ? `\n\nAcceptance note:\n${note}` : "");
    const task = createTask({
      title: h.title,
      description: taskDescription.slice(0, 8000),
      owner_agent_id: h.from_agent_id,
      assigned_to_agent_id: h.to_agent_id,
      conversation_id: h.conversation_id,
      workspace_id: h.workspace_id,
    });
    taskId = task.id;

    db()
      .prepare(
        `UPDATE handoffs SET task_id = ?, link_id = ? WHERE id = ?`,
      )
      .run(taskId, linkId, h.id);
  });
  tx();

  recordConversationEvent(h.conversation_id, "handoff.accepted", h.id);
  logAudit("handoff.accept", {
    userId: input.responding_user_id,
    detail: {
      handoff_id: h.id,
      conversation_id: h.conversation_id,
      task_id: taskId,
      link_id: linkId,
      grant_ids: grantIds,
      scopes_json: h.scopes_json,
      duration_key: h.duration_key,
    },
  });
  // Use the scope/duration to build a human-readable summary the
  // recipient sees right in chat. Showing exactly what's granted (and
  // for how long) is the security UX win — no "what does accept even
  // mean?" guessing.
  let grantSummary = "";
  try {
    const scopes = (JSON.parse(h.scopes_json) as string[]).join(" + ");
    const presetLabel =
      DURATION_PRESETS.find((d) => d.key === h.duration_key)?.label ??
      h.duration_key;
    grantSummary = `\n\n🔑 Granted: \`${scopes}\` for ${presetLabel}.`;
  } catch {
    /* fall through with empty summary */
  }
  try {
    sendMessage(h.conversation_id, h.to_agent_id, {
      text:
        `✅ Handoff accepted: **${h.title}** — collaboration is now active.` +
        grantSummary +
        (note ? `\n\n> ${note.replace(/\n/g, "\n> ")}` : ""),
      kind: "agent_to_agent",
    });
  } catch {
    // courtesy message — never block the lifecycle
  }
  return getHandoff(h.id)!;
}

export function withdrawHandoff(input: {
  handoff_id: string;
  user_id: string;
}): Handoff {
  const h = getHandoff(input.handoff_id);
  if (!h) throw new Error("Handoff not found.");
  if (h.from_user_id !== input.user_id) {
    throw new Error("Only the proposer can withdraw.");
  }
  if (h.status !== "proposed") {
    throw new Error("Only proposed handoffs can be withdrawn.");
  }
  const now = Date.now();
  const info = db()
    .prepare(
      `UPDATE handoffs SET status = 'withdrawn', responded_at = ?
       WHERE id = ? AND status = 'proposed'`,
    )
    .run(now, h.id);
  if (info.changes === 0) {
    throw new Error(
      "Handoff was already resolved (refresh and try again).",
    );
  }
  recordConversationEvent(h.conversation_id, "handoff.withdrawn", h.id);
  logAudit("handoff.withdraw", {
    userId: input.user_id,
    detail: { handoff_id: h.id, conversation_id: h.conversation_id },
  });
  try {
    sendMessage(h.conversation_id, h.from_agent_id, {
      text: `↩️ Handoff withdrawn: **${h.title}**`,
      kind: "agent_to_agent",
    });
  } catch {
    // courtesy message — never block the lifecycle
  }
  return getHandoff(h.id)!;
}

export function markHandoffCompleted(input: {
  handoff_id: string;
  user_id: string;
}): Handoff {
  const h = getHandoff(input.handoff_id);
  if (!h) throw new Error("Handoff not found.");
  if (h.from_user_id !== input.user_id && h.to_user_id !== input.user_id) {
    throw new Error("Not your handoff to complete.");
  }
  if (h.status !== "accepted") {
    throw new Error("Only accepted handoffs can be completed.");
  }
  db()
    .prepare(
      `UPDATE handoffs SET status = 'completed', responded_at = ? WHERE id = ?`,
    )
    .run(Date.now(), h.id);
  // Least privilege: once the collaboration is done, the scoped grants the
  // acceptance minted should not linger. Revoking them is the symmetric
  // inverse of createGrantsForHandoff (called on accept).
  revokeGrantsForHandoff({
    handoff_id: h.id,
    user_id: input.user_id,
    reason: "handoff completed",
  });
  recordConversationEvent(h.conversation_id, "handoff.completed", h.id);
  return getHandoff(h.id)!;
}
