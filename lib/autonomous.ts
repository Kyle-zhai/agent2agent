import "server-only";
import { db } from "./db";
import { getAgent } from "./agents";
import { getConversation, sendMessage } from "./conversations";
import {
  getTask,
  listTaskEvents,
  parseSuccessCriteria,
  transitionTaskStatus,
} from "./tasks";
import {
  applyPatch,
  canWrite,
  fileDiffSummary,
  getWorkspace,
  listFiles,
  readFileAt,
  recentWorkspaceChangesForAgent,
} from "./workspaces";
import {
  generateReply,
  parseBrainConfig,
  type BrainContext,
  type ConvTurn,
} from "./brains";
import { agentMayUseResource } from "./grants";
import { logAudit } from "./audit";
import type { Agent, Task } from "./types";

// ---------------------------------------------------------------------------
// Autonomous task loop — the missing ReAct loop that lets a MANAGED agent
// drive an assigned task to completion without a human nudging each step.
//
// Today a managed agent only wakes on an inbound @mention and replies ONCE
// (single brain call, extract <write> artifacts, send a message). It can't
// run its own checks or move the task through the state machine. This module
// wraps the existing brain + tools into a bounded loop:
//
//   build context (task + workspace + what PEERS changed + last failures)
//     → call brain → apply <write> artifacts → parse one control action
//     → on <submit/>: push the task toward done; the deterministic
//       success_criteria gate (test_command in sandbox, diff_pattern, …)
//       either completes it or bounces to changes_requested with concrete
//       failures, which feed the NEXT iteration (feedback-driven retry)
//     → on <blocked>: post the blocker and stop (escalate to humans)
//
// Every run is HARD-BOUNDED — max steps + wall-clock — and stops on repeat
// (the brain proposing byte-identical artifacts twice). These caps are the
// non-negotiable guardrail every shipped autonomous-agent system uses.
// ---------------------------------------------------------------------------

export const AUTONOMY_MAX_STEPS = 6;
export const AUTONOMY_MAX_WALL_MS = 90_000;

export type AutonomyOutcome =
  | "completed" // task reached done (criteria passed)
  | "submitted" // pushed to awaiting_review for a reviewer/owner to close
  | "blocked" // agent declared itself blocked; humans needed
  | "capped" // hit step/wall-clock cap mid-flight
  | "stuck" // repeated identical output; bailed
  | "noop"; // nothing actionable / not eligible

export type AutonomyResult = {
  task_id: string;
  agent_id: string;
  steps: number;
  outcome: AutonomyOutcome;
  detail: string;
};

/** A single brain turn, injectable for deterministic tests (mirrors the
 *  auto-reviewer's brainStep seam). Returns the text the brain produced
 *  (control tags + <write> blocks already extracted into artifacts). */
export type AutonomyBrainStep = (input: {
  agent: Agent;
  task: Task;
  context: BrainContext;
  lastFailures: string[];
  step: number;
}) => Promise<{ text: string; thinking: string; artifacts: ArtifactOp[] }>;

type ArtifactOp = { path: string; commit_message: string; content: string };

const SUBMIT_RE = /<submit\s*\/?>/i;
const BLOCKED_RE = /<blocked>([\s\S]*?)<\/blocked>/i;

function activeTaskFor(agentId: string, taskId: string): Task | null {
  const t = getTask(taskId);
  if (!t) return null;
  if (t.assigned_to_agent_id !== agentId) return null;
  if (
    t.status !== "assigned" &&
    t.status !== "in_progress" &&
    t.status !== "changes_requested"
  ) {
    return null;
  }
  return t;
}

/** Render the loop's context: the task, the current workspace head (with
 *  small-file excerpts), what PEERS changed since this agent last acted, and
 *  the criteria that failed on the previous attempt. */
function buildAutonomousContext(
  task: Task,
  agentId: string,
  lastFailures: string[],
  sinceMs: number,
): BrainContext {
  let workspace: BrainContext["workspace"];
  if (task.workspace_id) {
    const ws = getWorkspace(task.workspace_id);
    if (ws && ws.head_snapshot_id) {
      const files = listFiles(ws.head_snapshot_id).slice(0, 12).map((f) => {
        let excerpt: string | undefined;
        if (
          f.size_bytes <= 8 * 1024 &&
          /\.(md|txt|json|sql|sh|py|ts|tsx|js|jsx|ya?ml|toml)$/.test(f.path)
        ) {
          const r = readFileAt(ws.head_snapshot_id!, f.path);
          if (r && !r.missing) excerpt = r.content.toString("utf8").slice(0, 4096);
        }
        return { path: f.path, size_bytes: f.size_bytes, excerpt };
      });
      workspace = {
        id: ws.id,
        name: ws.name,
        files,
        head_snapshot_id: ws.head_snapshot_id,
      };
    }
  }

  // "What did the peer change since I last acted" — same feed external
  // agents get on the heartbeat, now injected into the managed loop so two
  // agents actually react to each other's edits.
  const peerChanges = task.workspace_id
    ? recentWorkspaceChangesForAgent(agentId, sinceMs, 10).filter(
        (c) => c.workspace_id === task.workspace_id,
      )
    : [];

  return {
    task: { id: task.id, title: task.title, description: task.description },
    workspace,
    peerChanges: peerChanges.map((c) => ({
      by: c.created_by_agent_id,
      commit_message: c.commit_message,
      files: c.files.map((f) => `${f.status}:${f.path}`),
    })),
    lastFailures,
  };
}

/** Pull the most recent actionable feedback for the assignee so a bounced task
 *  resumes WITH the reviewer's comment / failing checks in context, instead of
 *  iterating blind. Without this, a review-gated task that bounces to
 *  changes_requested loses the reason and the agent just resubmits the same
 *  work (exactly the byte-identical-resubmit we observed). */
function recentReviewFeedback(task: Task): string[] {
  const events = listTaskEvents(task.id);
  const out: string[] = [];
  let gotComment = false;
  let gotCriteria = false;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (!gotComment && e.kind === "changes_requested") {
      try {
        const p = JSON.parse(e.payload_json) as { comment?: string };
        if (p.comment) {
          out.push(`Reviewer requested changes: ${p.comment}`);
          gotComment = true;
        }
      } catch {
        /* ignore malformed payload */
      }
    } else if (!gotCriteria && e.kind === "criteria_failed") {
      try {
        const p = JSON.parse(e.payload_json) as { failures?: string[] };
        if (Array.isArray(p.failures)) {
          for (const f of p.failures.slice(0, 8)) {
            out.push(`Acceptance check failed: ${f}`);
          }
          gotCriteria = true;
        }
      } catch {
        /* ignore malformed payload */
      }
    }
    if (gotComment && gotCriteria) break;
  }
  return out;
}

/** The current head snapshot id of the task's workspace (for criteria that
 *  evaluate against a result snapshot). */
function headSnapshot(task: Task): string | null {
  if (!task.workspace_id) return null;
  return getWorkspace(task.workspace_id)?.head_snapshot_id ?? null;
}

/** Drive one assigned task as far as it'll go this run. Idempotent-ish:
 *  re-invoking after a bounce continues from changes_requested. */
export async function runAutonomousTask(
  agentId: string,
  taskId: string,
  opts: {
    brainStep?: AutonomyBrainStep;
    maxSteps?: number;
    maxWallMs?: number;
    now?: () => number;
  } = {},
): Promise<AutonomyResult> {
  const now = opts.now ?? Date.now;
  const maxSteps = opts.maxSteps ?? AUTONOMY_MAX_STEPS;
  const maxWallMs = opts.maxWallMs ?? AUTONOMY_MAX_WALL_MS;
  const startedAt = now();

  const agent = getAgent(agentId);
  if (!agent) return res(taskId, agentId, 0, "noop", "agent gone");
  let task = activeTaskFor(agentId, taskId);
  if (!task) {
    return res(taskId, agentId, 0, "noop", "task not assigned to agent or not active");
  }
  // Only MANAGED agents run server-side; external agents drive themselves
  // via the REST/heartbeat loop.
  if (agent.agent_kind !== "managed") {
    return res(taskId, agentId, 0, "noop", "agent is not managed");
  }

  const cfg = parseBrainConfig(agent.brain_config_json);
  // If the task is configured for human/reviewer sign-off (a diff_review or
  // manual criterion), the loop's job is to get it to awaiting_review and
  // hand off — it must not self-approve past a review gate.
  const criteria = parseSuccessCriteria(task);
  const reviewGated = criteria.some(
    (c) => c.type === "diff_review" || c.type === "manual",
  );

  // Resume with any feedback the reviewer / acceptance checks left, so a
  // bounced task is fixed against real reasons rather than re-submitted blind.
  let lastFailures: string[] = recentReviewFeedback(task);
  let lastArtifactSig = "";
  let steps = 0;
  const lastActedAt = task.updated_at;

  while (steps < maxSteps) {
    if (now() - startedAt > maxWallMs) {
      postAgentNote(task, agent, "Paused: hit the time budget for this run. Will resume on the next tick.");
      return res(task.id, agentId, steps, "capped", "wall-clock cap");
    }
    steps += 1;

    // assigned / changes_requested → in_progress so the work is visible.
    if (task.status === "assigned" || task.status === "changes_requested") {
      await transitionTaskStatus({
        task_id: task.id,
        to_status: "in_progress",
        actor_agent_id: agentId,
      });
      task = getTask(task.id)!;
    }

    const context = buildAutonomousContext(task, agentId, lastFailures, lastActedAt);
    const out = opts.brainStep
      ? await opts.brainStep({ agent, task, context, lastFailures, step: steps })
      : await generateReply(agent, synthHistory(task), cfg, context);

    // Apply <write> artifacts to the workspace (writer role required).
    let snapshotId = headSnapshot(task);
    if (out.artifacts.length > 0 && task.workspace_id) {
      const sig = out.artifacts
        .map((a) => `${a.path} ${a.content}`)
        .join("");
      if (sig === lastArtifactSig) {
        postAgentNote(task, agent, "Stopping: I'm repeating the same change without progress. A human should take a look.");
        return res(task.id, agentId, steps, "stuck", "repeated identical artifacts");
      }
      lastArtifactSig = sig;
      const ws = getWorkspace(task.workspace_id);
      // Honor a write GRANT, not just a subscription, so a cross-team assignee
      // handed access via a grant can still commit (matches the reply path and
      // the workspace.write tool).
      const mayWrite =
        !!ws &&
        (canWrite(ws.id, agentId) ||
          agentMayUseResource({
            using_agent_id: agentId,
            resource_type: "workspace",
            resource_id: ws.id,
            required_scope: "write",
          }));
      if (ws && ws.head_snapshot_id && mayWrite) {
        try {
          const patch = applyPatch({
            workspace_id: ws.id,
            agent_id: agentId,
            against_rev: ws.head_snapshot_id,
            ops: out.artifacts.map((a) => ({
              path: a.path,
              op: "create" as const,
              content: a.content,
            })),
            commit_message:
              out.artifacts.length === 1
                ? out.artifacts[0].commit_message
                : `${out.artifacts.length} files by ${agent.display_name}`,
            task_id: task.id,
          });
          if (patch.ok) snapshotId = patch.snapshot_id;
        } catch (err) {
          // A same-file conflict (409) or validation error shouldn't crash the
          // run — surface it as a failure to retry against.
          lastFailures = [
            `workspace write failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200),
          ];
          continue;
        }
      }
    }

    // Control action: blocked?
    const blocked = out.text.match(BLOCKED_RE);
    if (blocked) {
      postAgentNote(task, agent, `Blocked: ${blocked[1].trim().slice(0, 500)}`);
      logAudit("task.status_change", {
        agentId,
        detail: { task_id: task.id, autonomy: "blocked" },
      });
      return res(task.id, agentId, steps, "blocked", "agent declared blocked");
    }

    // Control action: submit?
    if (SUBMIT_RE.test(out.text)) {
      // in_progress → awaiting_review (always legal from in_progress).
      task = getTask(task.id)!;
      if (task.status === "in_progress") {
        await transitionTaskStatus({
          task_id: task.id,
          to_status: "awaiting_review",
          actor_agent_id: agentId,
          result_snapshot_id: snapshotId,
        });
        task = getTask(task.id)!;
      }
      if (reviewGated) {
        // Hand off to the review flow (auto-reviewer or a human) — do not
        // self-approve past a review gate.
        const chat = out.text.replace(SUBMIT_RE, "").trim();
        postAgentNote(task, agent, chat || "Submitted for review.");
        return res(task.id, agentId, steps, "submitted", "awaiting review (review-gated)");
      }
      // No review gate: attempt to close. The deterministic criteria gate
      // inside transitionTaskStatus decides — pass ⇒ done, fail ⇒ bounce to
      // changes_requested with the concrete reasons.
      const closed = await transitionTaskStatus({
        task_id: task.id,
        to_status: "done",
        actor_agent_id: agentId,
        result_snapshot_id: snapshotId,
      });
      task = getTask(task.id)!;
      if (task.status === "done") {
        const chat = out.text.replace(SUBMIT_RE, "").trim();
        postAgentNote(task, agent, chat || "Done — success criteria passed.");
        return res(task.id, agentId, steps, "completed", "criteria passed");
      }
      // Bounced: feed the failures back and keep going.
      lastFailures = closed.criteria_failures ?? ["criteria failed"];
      continue;
    }

    // No control action this step: the brain just produced work/chatter.
    // If it also produced no artifacts, there's nothing to make progress on
    // — surface the message and stop rather than burning the step budget.
    if (out.artifacts.length === 0) {
      const chat = out.text.trim();
      if (chat) postAgentNote(task, agent, chat);
      return res(task.id, agentId, steps, "submitted", "no action emitted");
    }
  }

  postAgentNote(task, agent, "Paused: reached the step budget for this run. Will resume on the next tick.");
  return res(task.id, agentId, steps, "capped", "step cap");
}

function synthHistory(task: Task): ConvTurn[] {
  // The loop is task-driven, not chat-driven — give the brain a single
  // synthetic "do the task" turn; the real grounding is in BrainContext.
  return [
    {
      agent_id: task.owner_agent_id,
      display_name: "task",
      text: `Work the assigned task to completion. When the deliverable is ready, emit <submit/>. If you cannot proceed, emit <blocked>reason</blocked>.`,
      is_self: false,
    },
  ];
}

function postAgentNote(task: Task, agent: Agent, text: string): void {
  if (!task.conversation_id) return;
  const conv = getConversation(task.conversation_id);
  if (!conv) return;
  try {
    sendMessage(task.conversation_id, agent.id, { text, kind: "agent_to_agent" });
  } catch (err) {
    // best-effort — a posting failure must not abort the loop's result, but it
    // must NOT vanish silently either (e.g. the agent was removed from the
    // conversation mid-task, so its closing note is lost). Log so an operator
    // can see the dropped note.
    console.warn("autonomy: failed to post agent note", {
      task_id: task.id,
      agent_id: agent.id,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

function res(
  taskId: string,
  agentId: string,
  steps: number,
  outcome: AutonomyOutcome,
  detail: string,
): AutonomyResult {
  return { task_id: taskId, agent_id: agentId, steps, outcome, detail };
}

// ---------------------------------------------------------------------------
// Self-enqueue tick — what flips the loop from "human nudges each step" to
// autonomous. Finds managed agents with an actionable (assigned or
// changes_requested) task and runs each once. Driven by a guarded interval
// (instrumentation.ts) or invoked directly in tests.
// ---------------------------------------------------------------------------

export function findActionableAutonomousWork(limit = 10): Array<{
  agent_id: string;
  task_id: string;
}> {
  return db()
    .prepare(
      `SELECT t.assigned_to_agent_id AS agent_id, t.id AS task_id
       FROM tasks t
       JOIN agents a ON a.id = t.assigned_to_agent_id
       WHERE a.agent_kind = 'managed'
         AND t.assigned_to_agent_id IS NOT NULL
         AND t.status IN ('assigned', 'changes_requested')
       ORDER BY t.updated_at ASC
       LIMIT ?`,
    )
    .all(Math.max(1, Math.min(50, limit))) as Array<{
    agent_id: string;
    task_id: string;
  }>;
}

let tickRunning = false;

/** One pass: drive each actionable managed task once. Serial (better-sqlite3
 *  is sync and brain calls are the slow part) and self-guarded so overlapping
 *  ticks don't double-run a task. */
export async function tickAutonomousAgents(
  opts: { limit?: number; brainStep?: AutonomyBrainStep } = {},
): Promise<AutonomyResult[]> {
  if (tickRunning) return [];
  tickRunning = true;
  const results: AutonomyResult[] = [];
  try {
    for (const w of findActionableAutonomousWork(opts.limit ?? 10)) {
      try {
        results.push(
          await runAutonomousTask(w.agent_id, w.task_id, {
            brainStep: opts.brainStep,
          }),
        );
      } catch (err) {
        console.error("autonomous tick: task run failed", {
          task_id: w.task_id,
          agent_id: w.agent_id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } finally {
    tickRunning = false;
  }
  return results;
}
