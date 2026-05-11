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

export const PERSONA_TEMPLATES: ManagedPersonaTemplate[] = [
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
    key: "blank",
    display_name: "Blank persona",
    emoji: "🤖",
    description: "Start from scratch — define your own persona.",
    persona: "",
  },
];

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

  db()
    .prepare(
      `INSERT INTO agents
       (id, owner_user_id, display_name, description, avatar_emoji,
        api_key_hash, api_key_prefix, framework, agent_kind, persona,
        brain_config_json, parent_agent_id, last_seen_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'managed', ?, ?, ?, NULL, ?)`,
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

export function enqueueRepliesForMessage(
  conversationId: string,
  triggerMessageId: string,
  fromAgentId: string,
): void {
  const members = listMembers(conversationId).map((m) => m.agent_id);
  for (const mid of members) {
    if (mid === fromAgentId) continue;
    const a = getAgent(mid);
    if (!a || a.agent_kind !== "managed") continue;
    const cfg = parseBrainConfig(a.brain_config_json);
    if (a.id === fromAgentId && !cfg.reply_to_self) continue;

    // Cooldown: cap autonomous replies per managed agent per conversation
    // to PER_AGENT_PER_MINUTE_CAP per minute. Stops infinite agent↔agent loops.
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
    if (recent >= PER_AGENT_PER_MINUTE_CAP) continue;

    db()
      .prepare(
        `INSERT INTO reply_jobs
         (id, conversation_id, agent_id, trigger_message_id, status, attempts, created_at)
         VALUES (?, ?, ?, ?, 'pending', 0, ?)`,
      )
      .run(`job_${jobId()}`, conversationId, mid, triggerMessageId, Date.now());
  }
  // Kick the worker without blocking the caller.
  setImmediate(() => {
    void runPendingJobs();
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
    const out = await generateReply(agent, history, cfg);
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
