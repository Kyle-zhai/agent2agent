import "server-only";
import { db } from "./db";
import { newAgentId, newApiKey } from "./ids";
import { sha256Hex } from "./crypto";
import {
  MAX_AGENTS_PER_USER,
  getAgent,
  getAgentOwnedBy,
  listAgentsForUser,
} from "./agents";
import { defaultBrainConfig, generateReply, parseBrainConfig, type ConvTurn } from "./brains";
import {
  getConversation,
  listMembers,
  listMessages,
  sendMessage,
} from "./conversations";
import { logAudit } from "./audit";
import type { Agent, BrainConfig } from "./types";
import { customAlphabet } from "nanoid";

const jobId = customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 12);

export type ManagedPersonaTemplate = {
  key: string;
  display_name: string;
  emoji: string;
  description: string;
  persona: string;
};

export const PERSONA_TEMPLATES = [
  {
    key: "openclaw-coding",
    display_name: "OpenClaw Coder",
    emoji: "🦀",
    description: "Pair-programmer style — writes patches, reviews diffs, suggests refactors.",
    persona:
      "You are an OpenClaw coding agent. You think out loud about constraints, prefer the simplest correct solution, and are explicit about trade-offs. You do not invent file paths you haven't been given.",
  },
  {
    key: "openclaw-reviewer",
    display_name: "OpenClaw Reviewer",
    emoji: "🔬",
    description: "Skeptical code/architecture reviewer.",
    persona:
      "You are an OpenClaw review agent. You look for failure modes the author hasn't considered: race conditions, error paths, security implications. You're concise and never sycophantic.",
  },
  {
    key: "openclaw-pm",
    display_name: "OpenClaw PM",
    emoji: "🗒️",
    description: "Lightweight project coordination — tracks decisions, surfaces risks.",
    persona:
      "You are an OpenClaw project agent. You summarize, identify owners, and surface unresolved questions. You ask one focused question at a time.",
  },
  {
    key: "openclaw-research",
    display_name: "OpenClaw Researcher",
    emoji: "🔍",
    description: "Reads docs, compares approaches, writes summaries.",
    persona:
      "You are an OpenClaw research agent. You compare approaches, cite the trade-offs explicitly, and recommend one option with a clear reason.",
  },
  {
    key: "openclaw-auto-reviewer",
    display_name: "Auto Reviewer",
    emoji: "⚖️",
    description:
      "Auto-reviews diff_review tasks. Reads the diff, approves or requests changes. Declares task.review capability.",
    persona:
      "You are an automated code reviewer. Read the provided diff carefully. " +
      "Approve only if the change matches the task's intent AND looks safe. " +
      "Otherwise request changes with a concise, specific reason " +
      "(point to file:line where possible). " +
      'Always respond with a single JSON object: {"decision":"approve"|"request_changes","reason":"..."}.',
  },
  {
    key: "blank",
    display_name: "Blank persona",
    emoji: "🤖",
    description: "Start from scratch — define your own persona.",
    persona: "",
  },
] as const satisfies readonly ManagedPersonaTemplate[];

export type PersonaTemplateKey = (typeof PERSONA_TEMPLATES)[number]["key"];

export function spawnManagedAgent(
  userId: string,
  input: {
    handle: string;
    purpose?: string | null;
    display_name: string;
    persona: string;
    description?: string;
    avatar_emoji?: string;
    framework?: string;
    parent_agent_id?: string | null;
    brain?: Partial<BrainConfig>;
    capabilities?: Array<{ name: string; version?: string }>;
  },
): Agent {
  const display = input.display_name.trim();
  if (display.length < 1 || display.length > 60) {
    throw new Error("Display name must be 1-60 characters.");
  }
  const count = (
    db()
      .prepare("SELECT COUNT(*) AS n FROM agents WHERE owner_user_id = ?")
      .get(userId) as { n: number }
  ).n;
  if (count >= MAX_AGENTS_PER_USER) {
    throw new Error(
      `Agent limit reached (${MAX_AGENTS_PER_USER} per account).`,
    );
  }
  const id = newAgentId(input.handle, input.purpose ?? null);
  const { key, prefix } = newApiKey();
  const now = Date.now();
  const description = (input.description ?? "").trim().slice(0, 280);
  const emoji = (input.avatar_emoji ?? "🦀").slice(0, 4);
  const framework = input.framework ?? "openclaw";
  const persona = input.persona.trim().slice(0, 4000);
  const brainCfg: BrainConfig = { ...defaultBrainConfig(), ...(input.brain ?? {}) };
  const parentId = input.parent_agent_id ?? null;

  const caps = input.capabilities ?? [];
  db()
    .prepare(
      `INSERT INTO agents
       (id, owner_user_id, display_name, description, avatar_emoji,
        api_key_hash, api_key_prefix, framework, agent_kind, persona,
        brain_config_json, parent_agent_id, capabilities, last_seen_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'managed', ?, ?, ?, ?, NULL, ?)`,
    )
    .run(
      id,
      userId,
      display,
      description,
      emoji,
      sha256Hex(key),
      prefix,
      framework,
      persona,
      JSON.stringify(brainCfg),
      parentId,
      JSON.stringify(caps),
      now,
    );
  // Auto-friend with all of this user's other agents — managed agents are
  // additions to your stable, not strangers.
  autoFriendOwnAgents(userId, id);
  logAudit("agent.create", {
    userId,
    agentId: id,
    detail: {
      kind: "managed",
      framework,
      brain_provider: brainCfg.provider,
      parent: parentId,
    },
  });
  return getAgent(id)!;
}

export function cloneManagedAgent(
  userId: string,
  parentId: string,
  newHandle: string,
  newDisplayName: string,
  overrides?: { persona?: string; emoji?: string; description?: string },
): Agent {
  const parent = getAgentOwnedBy(parentId, userId);
  if (!parent) throw new Error("Parent agent not found.");
  if (parent.agent_kind !== "managed") {
    throw new Error("Only managed agents can be cloned.");
  }
  return spawnManagedAgent(userId, {
    handle: newHandle,
    purpose: parent.id.split(".")[1] ?? null,
    display_name: newDisplayName,
    persona: overrides?.persona ?? parent.persona,
    description: overrides?.description ?? parent.description,
    avatar_emoji: overrides?.emoji ?? parent.avatar_emoji,
    framework: parent.framework,
    parent_agent_id: parent.id,
    brain: parseBrainConfig(parent.brain_config_json),
  });
}

function autoFriendOwnAgents(userId: string, newAgentId: string): void {
  const others = listAgentsForUser(userId).filter((a) => a.id !== newAgentId);
  const tx = db().transaction(() => {
    for (const o of others) {
      const [a, b] =
        newAgentId < o.id ? [newAgentId, o.id] : [o.id, newAgentId];
      db()
        .prepare(
          `INSERT OR IGNORE INTO friendships (agent_a, agent_b, created_at)
           VALUES (?, ?, ?)`,
        )
        .run(a, b, Date.now());
    }
  });
  tx();
}

const PER_AGENT_PER_MINUTE_CAP = 4;

const MENTION_RE = /@([a-z][a-z0-9-]{1,29})\b/g;

export function extractMentionedHandles(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(MENTION_RE)) {
    out.push(m[1]);
  }
  return out;
}

export function enqueueRepliesForMessage(
  conversationId: string,
  triggerMessageId: string,
  fromAgentId: string,
): void {
  const members = listMembers(conversationId).map((m) => m.agent_id);
  // Resolve mentions on the trigger message: @handle in text matches an
  // agent in the room whose ID starts with `handle.`
  const trigger = db()
    .prepare("SELECT text FROM messages WHERE id = ?")
    .get(triggerMessageId) as { text: string } | undefined;
  const mentionedHandles = trigger ? extractMentionedHandles(trigger.text) : [];
  const mentionedIds = new Set(
    members.filter((mid) =>
      mentionedHandles.some((h) => mid.toLowerCase().startsWith(h + ".")),
    ),
  );

  for (const mid of members) {
    if (mid === fromAgentId) continue;
    const a = getAgent(mid);
    if (!a || a.agent_kind !== "managed") continue;
    // (We used to parse cfg here for reply_to_self. The earlier
    // `mid === fromAgentId` continue makes that dead, so the cfg parse is
    // intentionally skipped to save work on every member of every send.)

    const isMentioned = mentionedIds.has(mid);
    const cutoff = Date.now() - 60_000;
    const recent = (
      db()
        .prepare(
          `SELECT COUNT(*) AS n FROM messages
           WHERE conversation_id = ? AND from_agent_id = ?
             AND kind = 'agent_to_agent' AND created_at > ?`,
        )
        .get(conversationId, mid, cutoff) as { n: number }
    ).n;
    // @mention lifts the standard 4/min cap to 2× — humans can still cut
    // through autonomous chatter, but agents @-spamming each other can't
    // ping-pong forever.
    const cap = isMentioned
      ? PER_AGENT_PER_MINUTE_CAP * 2
      : PER_AGENT_PER_MINUTE_CAP;
    if (recent >= cap) continue;
    // Bonus: when @mentioned, only honor mentions originating from a
    // non-managed (human-driven) agent. Mentions between managed agents
    // don't bypass the standard cap.
    if (
      isMentioned &&
      recent >= PER_AGENT_PER_MINUTE_CAP
    ) {
      const sender = getAgent(fromAgentId);
      if (!sender || sender.agent_kind === "managed") continue;
    }

    db()
      .prepare(
        `INSERT INTO reply_jobs
         (id, conversation_id, agent_id, trigger_message_id, status, attempts, created_at)
         VALUES (?, ?, ?, ?, 'pending', 0, ?)`,
      )
      .run(`job_${jobId()}`, conversationId, mid, triggerMessageId, Date.now());
  }
  // Kick the worker without blocking the caller. A bare `void` would
  // discard rejection diagnostics — surface to stderr instead.
  setImmediate(() => {
    runPendingJobs().catch((err) => {
      console.error("runPendingJobs worker crashed", {
        err: err instanceof Error ? err.message : String(err),
      });
    });
  });
}

let workerRunning = false;
const inFlight = new Set<string>();

export async function runPendingJobs(maxBatch = 5): Promise<void> {
  if (workerRunning) return;
  workerRunning = true;
  try {
    let processed = 0;
    while (processed < maxBatch) {
      const job = db()
        .prepare(
          `SELECT id, conversation_id, agent_id, trigger_message_id
           FROM reply_jobs
           WHERE status = 'pending' AND id NOT IN (${
             inFlight.size > 0
               ? Array.from(inFlight)
                   .map(() => "?")
                   .join(",")
               : "''"
           })
           ORDER BY created_at ASC LIMIT 1`,
        )
        .get(...inFlight) as
        | {
            id: string;
            conversation_id: string;
            agent_id: string;
            trigger_message_id: string;
          }
        | undefined;
      if (!job) break;
      inFlight.add(job.id);
      try {
        await processJob(job);
        processed++;
      } finally {
        inFlight.delete(job.id);
      }
    }
  } finally {
    workerRunning = false;
  }
}

async function processJob(job: {
  id: string;
  conversation_id: string;
  agent_id: string;
  trigger_message_id: string;
}): Promise<void> {
  const startedAt = Date.now();
  db()
    .prepare(
      `UPDATE reply_jobs SET status = 'running', attempts = attempts + 1,
       started_at = ? WHERE id = ?`,
    )
    .run(startedAt, job.id);
  try {
    const agent = getAgent(job.agent_id);
    if (!agent) throw new Error("agent gone");
    const conv = getConversation(job.conversation_id);
    if (!conv) throw new Error("conversation gone");
    const cfg = parseBrainConfig(agent.brain_config_json);
    const history = buildHistory(job.conversation_id, agent.id, cfg.max_history ?? 24);
    if (history.length === 0) {
      throw new Error("no history");
    }
    // Per-conversation persona override beats the base persona for this run.
    const override = db()
      .prepare(
        `SELECT persona FROM conversation_personas
         WHERE conversation_id = ? AND agent_id = ?`,
      )
      .get(job.conversation_id, agent.id) as { persona: string } | undefined;
    const effectiveAgent: Agent = override
      ? { ...agent, persona: override.persona }
      : agent;
    const out = await generateReply(effectiveAgent, history, cfg);
    if (!out.text.trim() && !out.thinking.trim()) {
      throw new Error("empty reply");
    }
    sendMessage(job.conversation_id, agent.id, {
      text: out.text || "(reasoning only — see above)",
      thinking: out.thinking,
      kind: "agent_to_agent",
    });
    db()
      .prepare(
        `UPDATE reply_jobs SET status = 'done', finished_at = ? WHERE id = ?`,
      )
      .run(Date.now(), job.id);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    db()
      .prepare(
        `UPDATE reply_jobs SET status = 'failed', finished_at = ?,
         last_error = ? WHERE id = ?`,
      )
      .run(Date.now(), msg.slice(0, 280), job.id);
    console.error("reply_job failed", {
      jobId: job.id,
      agentId: job.agent_id,
      conversationId: job.conversation_id,
      err: msg,
    });
    try {
      // Audit + SSE so the typing indicator stops AND the operator + user
      // see that the agent gave up rather than waiting forever.
      logAudit("agent.reply_failed", {
        agentId: job.agent_id,
        detail: {
          conversation_id: job.conversation_id,
          trigger_message_id: job.trigger_message_id,
          error: msg.slice(0, 200),
        },
      });
      db()
        .prepare(
          `INSERT INTO conversation_events (conversation_id, kind, message_id, created_at)
           VALUES (?, 'reply_failed', ?, ?)`,
        )
        .run(job.conversation_id, job.trigger_message_id, Date.now());
    } catch (auditErr) {
      // The audit/event side effect mustn't break the worker — but a
      // schema drift on conversation_events that prevents the 'reply_failed'
      // row from inserting would mean the typing indicator never clears.
      // Log it so the second-order silent failure surfaces immediately.
      console.error("reply_job post-failure audit/event also failed", {
        jobId: job.id,
        err: auditErr instanceof Error ? auditErr.message : String(auditErr),
      });
    }
  }
}

export function resumeOrphanedJobs(): void {
  // Anything left in 'running' from a prior process restart is unrecoverable
  // — mark it failed so the typing indicator clears and the worker doesn't
  // permanently believe an agent is mid-reply.
  const now = Date.now();
  const result = db()
    .prepare(
      `UPDATE reply_jobs SET status = 'failed', finished_at = ?,
       last_error = 'orphaned: server restarted'
       WHERE status = 'running'`,
    )
    .run(now);
  if (result.changes > 0) {
    console.warn(
      `reply_jobs: marked ${result.changes} orphaned 'running' jobs as failed on startup`,
    );
  }
}

function buildHistory(
  conversationId: string,
  selfAgentId: string,
  maxHistory: number,
): ConvTurn[] {
  const recent = listMessages(conversationId, { limit: maxHistory * 2 });
  const tail = recent.slice(-maxHistory);
  const memberAgents = listMembers(conversationId)
    .map((m) => getAgent(m.agent_id))
    .filter((a): a is Agent => !!a);
  const nameById = Object.fromEntries(
    memberAgents.map((a) => [a.id, a.display_name]),
  );
  return tail.map((m) => ({
    agent_id: m.from_agent_id,
    display_name: nameById[m.from_agent_id] ?? m.from_agent_id,
    text: m.text,
    thinking: m.thinking || undefined,
    is_self: m.from_agent_id === selfAgentId,
  }));
}
