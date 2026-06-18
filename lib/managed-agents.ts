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
import {
  defaultBrainConfig,
  generateReply,
  parseBrainConfig,
  type BrainContext,
  type ConvTurn,
} from "./brains";
import {
  getConversation,
  listMembers,
  listMessages,
  sendMessage,
} from "./conversations";
import {
  applyPatch,
  canWrite,
  listFiles,
  listWorkspacesForConversation,
  readFileAt,
  recentWorkspaceChangesForAgent,
} from "./workspaces";
import { listTasksForConversation } from "./tasks";
import { agentMayUseResource } from "./grants";
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

// Lease-based job claim (v0.20). A worker ATOMICALLY claims one job by
// stamping a lease; the lease expiring (worker crashed mid-job) makes the job
// claimable again, so a crash re-delivers instead of permanently losing it.
// MAX_JOB_ATTEMPTS bounds the retries so a job that crashes the worker every
// time lands in 'failed' (dead-letter) rather than looping forever.
export const JOB_LEASE_MS = 60_000;
export const MAX_JOB_ATTEMPTS = 3;

type ClaimedJob = {
  id: string;
  conversation_id: string;
  agent_id: string;
  trigger_message_id: string;
};

/** Atomically claim the next runnable job: a 'pending' one, or a 'running' one
 *  whose lease expired (its worker died). One UPDATE … WHERE id=(SELECT …)
 *  RETURNING is race-safe even across processes — SQLite serializes writers,
 *  so two workers can't claim the same row. */
export function claimNextJob(now: number): ClaimedJob | null {
  const row = db()
    .prepare(
      `UPDATE reply_jobs
         SET status = 'running',
             attempts = attempts + 1,
             started_at = ?,
             lease_until = ?
       WHERE id = (
         SELECT id FROM reply_jobs
         WHERE attempts < ?
           AND (status = 'pending'
                OR (status = 'running' AND (lease_until IS NULL OR lease_until < ?)))
         ORDER BY created_at ASC
         LIMIT 1
       )
       RETURNING id, conversation_id, agent_id, trigger_message_id`,
    )
    .get(now, now + JOB_LEASE_MS, MAX_JOB_ATTEMPTS, now) as ClaimedJob | undefined;
  return row ?? null;
}

export async function runPendingJobs(maxBatch = 5): Promise<void> {
  if (workerRunning) return;
  workerRunning = true;
  try {
    let processed = 0;
    while (processed < maxBatch) {
      const job = claimNextJob(Date.now());
      if (!job) break;
      await processJob(job);
      processed++;
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
  // status/attempts/started_at/lease_until were already stamped atomically by
  // claimNextJob — processJob just runs the work and writes a terminal state.

  // Idempotency guard: if a PRIOR attempt already delivered this job's message
  // (lease expired after the send committed, then the job was re-claimed),
  // finalize without sending a second copy. at-least-once delivery, exactly
  // once observed.
  const prior = db()
    .prepare("SELECT sent_message_id FROM reply_jobs WHERE id = ?")
    .get(job.id) as { sent_message_id: string | null } | undefined;
  if (prior?.sent_message_id) {
    db()
      .prepare(
        `UPDATE reply_jobs SET status = 'done', finished_at = ?, lease_until = NULL
         WHERE id = ?`,
      )
      .run(Date.now(), job.id);
    return;
  }

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

    // Build BrainContext so the agent sees the workspace + open tasks for
    // this conversation. Without this, the agent's only signal is the chat
    // history — which produces lots of chatter and zero artifacts (see
    // scripts/experiments/collab-vs-solo.mjs for the baseline that motivated
    // this change). For groups with a workspace, the agent can now emit
    // <write> blocks; processJob extracts them and commits below.
    const context = buildBrainContext(job.conversation_id, agent.id);

    const out = await generateReply(effectiveAgent, history, cfg, context);
    if (!out.text.trim() && !out.thinking.trim() && out.artifacts.length === 0) {
      throw new Error("empty reply");
    }

    // Apply any artifacts the brain produced. We do this BEFORE sending the
    // chat message so the workspace.changed event ordering matches "agent
    // talks about its commit" → "commit visible".
    if (out.artifacts.length > 0 && context?.workspace) {
      const ws = context.workspace;
      // Dedup: drop any artifact whose path already has identical content
      // to what the brain proposed. We only have the workspace excerpt
      // (up to 4 KB) so the check is conservative — if the excerpt fully
      // covers the new content AND matches, treat as a no-op.
      const dedupedArtifacts = out.artifacts.filter((a) => {
        const existing = ws.files.find((f) => f.path === a.path);
        if (!existing || !existing.excerpt) return true;
        const incoming = a.content.trim();
        const prev = existing.excerpt.trim();
        // The excerpt is capped (~4 KB); only treat as a no-op when it fully
        // matches the proposed content. (A byte-size compare here was dead:
        // it was AND-ed with this same equality, so it never changed the result.)
        const isDup = prev === incoming;
        return !isDup;
      });
      // Honor a write GRANT, not just a subscription — a cross-team agent
      // handed write access via a grant (no local subscription) must still be
      // able to commit its artifacts, matching the workspace.write tool's gate.
      const mayWrite =
        canWrite(ws.id, agent.id) ||
        agentMayUseResource({
          using_agent_id: agent.id,
          resource_type: "workspace",
          resource_id: ws.id,
          required_scope: "write",
        });
      if (mayWrite && dedupedArtifacts.length > 0) {
        try {
          applyPatch({
            workspace_id: ws.id,
            agent_id: agent.id,
            against_rev: ws.head_snapshot_id,
            ops: dedupedArtifacts.map((a) => ({
              path: a.path,
              op: "create" as const,
              content: a.content,
            })),
            commit_message:
              dedupedArtifacts.length === 1
                ? dedupedArtifacts[0].commit_message
                : `${dedupedArtifacts.length} files by ${agent.display_name}`,
          });
        } catch (err) {
          // Patch may fail because of a path validation error or a stale
          // against_rev. We don't want this to kill the reply — log so an
          // operator can diagnose, and surface a hint inline.
          const msg = err instanceof Error ? err.message : String(err);
          console.warn("brain artifact patch failed", {
            agentId: agent.id,
            conversationId: job.conversation_id,
            workspaceId: ws.id,
            err: msg,
          });
          out.thinking +=
            `\n(workspace patch failed: ${msg.slice(0, 120)})`;
        }
      } else {
        // Not subscribed as writer/admin — skip patch silently but
        // surface in thinking so it's visible in the agent reasoning panel.
        out.thinking += `\n(brain wanted to write ${out.artifacts.length} file(s) but agent lacks workspace writer role)`;
      }
    }

    // Send the reply AND mark the job done in ONE transaction, recording the
    // message id. better-sqlite3 commits all-or-nothing, so a crash leaves the
    // job either fully pending/running with NO message, or fully done with
    // exactly one — never the in-between that the lease re-claim turns into a
    // duplicate. (sendMessage's own transaction nests as a savepoint.)
    db().transaction(() => {
      const m = sendMessage(job.conversation_id, agent.id, {
        text: out.text || "(reasoning only — see above)",
        thinking: out.thinking,
        kind: "agent_to_agent",
      });
      db()
        .prepare(
          `UPDATE reply_jobs SET status = 'done', finished_at = ?, lease_until = NULL,
           sent_message_id = ? WHERE id = ?`,
        )
        .run(Date.now(), m.id, job.id);
    })();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Business failure is terminal (we don't auto-retry a bad reply). Crashes
    // that never reach this catch leave the job 'running' with an expired
    // lease → claimNextJob re-delivers until MAX_JOB_ATTEMPTS. Clearing the
    // lease here marks this attempt done so a still-valid lease can't reclaim.
    db()
      .prepare(
        `UPDATE reply_jobs SET status = 'failed', finished_at = ?,
         last_error = ?, lease_until = NULL WHERE id = ?`,
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
  // v0.20: leases make most orphan recovery automatic — a 'running' job whose
  // worker died is re-claimable once its lease expires (claimNextJob). On
  // startup we only need to (1) expire leases immediately so recovery doesn't
  // wait out the TTL, and (2) dead-letter jobs that already burned all their
  // attempts (these would otherwise be invisible — never re-claimed, never
  // terminal). No more blanket-failing every in-flight job.
  const now = Date.now();
  db()
    .prepare(
      `UPDATE reply_jobs SET lease_until = ?
       WHERE status = 'running' AND attempts < ?`,
    )
    .run(now - 1, MAX_JOB_ATTEMPTS);
  const dead = db()
    .prepare(
      `UPDATE reply_jobs SET status = 'failed', finished_at = ?,
       last_error = 'gave up after max attempts (worker kept crashing)',
       lease_until = NULL
       WHERE status = 'running' AND attempts >= ?`,
    )
    .run(now, MAX_JOB_ATTEMPTS);
  if (dead.changes > 0) {
    console.warn(
      `reply_jobs: dead-lettered ${dead.changes} job(s) that exhausted ${MAX_JOB_ATTEMPTS} attempts`,
    );
  }
}

function buildBrainContext(
  conversationId: string,
  agentId: string,
): BrainContext | undefined {
  // Find the most recently-created workspace tied to this conversation. A
  // conv can have multiple workspaces — we only enrich with the primary one
  // (head of the list, which listWorkspacesForConversation already returns
  // newest-first). Stop early if there's nothing to ground on.
  const wss = listWorkspacesForConversation(conversationId);
  const ws = wss[0];
  let workspaceCtx: BrainContext["workspace"] | undefined;
  if (ws && ws.head_snapshot_id) {
    const files = listFiles(ws.head_snapshot_id);
    const enriched = files.slice(0, 10).map((f) => {
      // Only include excerpt for small text-y files. Anything > 8KB or
      // binary-looking is summarised by metadata alone — the brain doesn't
      // need every byte to reason.
      let excerpt: string | undefined;
      if (f.size_bytes <= 8 * 1024 && /\.(md|txt|json|sql|sh|py|ts|tsx|js|jsx|yaml|yml|toml)$/.test(f.path)) {
        try {
          const r = readFileAt(ws.head_snapshot_id!, f.path);
          if (r && !r.missing) {
            excerpt = r.content.toString("utf8").slice(0, 4 * 1024);
          }
        } catch {
          /* swallow — excerpt is best-effort */
        }
      }
      return {
        path: f.path,
        size_bytes: f.size_bytes,
        excerpt,
      };
    });
    workspaceCtx = {
      id: ws.id,
      name: ws.name,
      files: enriched,
      head_snapshot_id: ws.head_snapshot_id,
    };
  }

  // Surface the most-recent open task assigned to this agent so the brain
  // can stay goal-anchored across turns instead of drifting with chat.
  const tasks = listTasksForConversation(conversationId, 20);
  const myOpenTask = tasks.find(
    (t) =>
      t.assigned_to_agent_id === agentId &&
      t.status !== "done" &&
      t.status !== "cancelled",
  );
  const taskCtx: BrainContext["task"] | undefined = myOpenTask
    ? {
        id: myOpenTask.id,
        title: myOpenTask.title,
        description: myOpenTask.description,
      }
    : undefined;

  if (!workspaceCtx && !taskCtx) return undefined;

  // What peers committed since this agent last spoke — so a managed agent
  // replying in a room with a workspace reacts to the other side's edits
  // instead of being blind to them. Window: this agent's last message in
  // the room (fall back to last 10 min).
  let peerChanges: BrainContext["peerChanges"];
  if (workspaceCtx) {
    const lastMine = db()
      .prepare(
        `SELECT created_at FROM messages
         WHERE conversation_id = ? AND from_agent_id = ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(conversationId, agentId) as { created_at: number } | undefined;
    const since = lastMine?.created_at ?? Date.now() - 10 * 60_000;
    const changes = recentWorkspaceChangesForAgent(agentId, since, 8).filter(
      (c) => c.workspace_id === workspaceCtx!.id,
    );
    if (changes.length > 0) {
      peerChanges = changes.map((c) => ({
        by: c.created_by_agent_id,
        commit_message: c.commit_message,
        files: c.files.map((f) => `${f.status}:${f.path}`),
      }));
    }
  }

  return { workspace: workspaceCtx, task: taskCtx, peerChanges };
}

function buildHistory(
  conversationId: string,
  selfAgentId: string,
  maxHistory: number,
): ConvTurn[] {
  // Only show messages from AFTER this agent joined. An agent added mid-thread
  // was not party to the pre-join backlog; feeding it that history creates false
  // continuity (and leaks content it never received). Agents present since
  // creation join before the first message, so they still see everything.
  const joined = (
    db()
      .prepare(
        "SELECT joined_at FROM conversation_members WHERE conversation_id = ? AND agent_id = ?",
      )
      .get(conversationId, selfAgentId) as { joined_at: number } | undefined
  )?.joined_at;
  const recent = listMessages(conversationId, {
    sinceCreatedAt: joined ? joined - 1 : 0,
    limit: maxHistory * 2,
  });
  const tail = recent.slice(-maxHistory);
  const memberAgents = listMembers(conversationId)
    .map((m) => getAgent(m.agent_id))
    .filter((a): a is Agent => !!a);
  const nameById = Object.fromEntries(
    memberAgents.map((a) => [a.id, a.display_name]),
  );
  return tail.map((m) => ({
    agent_id: m.from_agent_id,
    message_id: m.id,
    display_name: nameById[m.from_agent_id] ?? m.from_agent_id,
    text: m.text,
    thinking: m.thinking || undefined,
    is_self: m.from_agent_id === selfAgentId,
  }));
}
