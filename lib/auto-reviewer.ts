import "server-only";
import { db } from "./db";
import { logAudit } from "./audit";
import { agentCapabilityNames, getAgent } from "./agents";
import { listMembers } from "./conversations";
import {
  fileDiffSummary,
  getSnapshot,
  readFileAt,
} from "./workspaces";
import {
  approveTask,
  getTask,
  listTaskEvents,
  parseRequiredCapabilities,
  parseSuccessCriteria,
  requestChanges,
} from "./tasks";
import { generateReply, parseBrainConfig, type ConvTurn } from "./brains";
import type { Agent, SuccessCriterion, Task } from "./types";

// -------------------------------------------------------------------------
// Selecting eligible reviewers
// -------------------------------------------------------------------------

/**
 * A reviewer is eligible when:
 *  1. It's a member of the task's conversation
 *  2. It declares `task.review` capability
 *  3. It's NOT the task owner or assignee (independence)
 *  4. It's a managed agent (has a brain) — external agents are not auto-driven
 *  5. It hasn't already left an `approved` or `changes_requested` event
 */
export function listEligibleReviewers(task: Task): Agent[] {
  if (!task.conversation_id) return [];
  const events = listTaskEvents(task.id);
  const alreadyReviewed = new Set<string>();
  for (const e of events) {
    if (e.kind === "approved" || e.kind === "changes_requested") {
      if (e.actor_agent_id) alreadyReviewed.add(e.actor_agent_id);
    }
  }
  const members = listMembers(task.conversation_id);
  const result: Agent[] = [];
  for (const m of members) {
    if (m.agent_id === task.owner_agent_id) continue;
    if (m.agent_id === task.assigned_to_agent_id) continue;
    if (alreadyReviewed.has(m.agent_id)) continue;
    const a = getAgent(m.agent_id);
    if (!a) continue;
    if (a.agent_kind !== "managed") continue;
    if (!agentCapabilityNames(a).has("task.review")) continue;
    result.push(a);
  }
  return result;
}

// -------------------------------------------------------------------------
// Prompt construction
// -------------------------------------------------------------------------

const MAX_FILE_BYTES_IN_PROMPT = 8 * 1024;
const MAX_TOTAL_BYTES_IN_PROMPT = 48 * 1024;

export function buildReviewPrompt(task: Task): string {
  const lines: string[] = [];
  lines.push("# Task under review");
  lines.push(`title: ${task.title}`);
  if (task.description) lines.push(`description:\n${task.description}`);
  const req = parseRequiredCapabilities(task);
  if (req.length > 0) {
    lines.push(`required_capabilities: ${req.join(", ")}`);
  }
  const criteria = parseSuccessCriteria(task);
  if (criteria.length > 0) {
    lines.push(`success_criteria: ${JSON.stringify(criteria)}`);
  }

  const snapId = task.result_snapshot_id;
  if (!snapId) {
    lines.push("\n(no result_snapshot_id — nothing to compare)");
    return lines.join("\n");
  }
  const snap = getSnapshot(snapId);
  if (!snap) {
    lines.push("\n(result_snapshot_id missing — cannot inspect)");
    return lines.join("\n");
  }
  const diff = fileDiffSummary(snap.parent_snapshot_id, snap.id);
  lines.push(`\n# Diff summary (vs parent ${snap.parent_snapshot_id ?? "∅"})`);
  for (const d of diff) {
    lines.push(`- ${d.status} ${d.path} (${d.size_bytes}b)`);
  }

  let totalBytes = 0;
  lines.push("\n# Changed file contents (truncated)");
  for (const d of diff) {
    if (d.status === "deleted") continue;
    const f = readFileAt(snap.id, d.path);
    if (!f) continue;
    const raw = f.content.toString("utf8");
    const slice = raw.slice(0, MAX_FILE_BYTES_IN_PROMPT);
    totalBytes += slice.length;
    if (totalBytes > MAX_TOTAL_BYTES_IN_PROMPT) {
      lines.push(`\n[…remaining files truncated for prompt budget…]`);
      break;
    }
    lines.push(`\n## ${d.path}`);
    lines.push("```");
    lines.push(slice);
    if (raw.length > slice.length) {
      lines.push(`\n[…file truncated, ${raw.length - slice.length} bytes elided…]`);
    }
    lines.push("```");
  }

  lines.push(
    "\n# Your task as reviewer\n" +
      "Decide whether to approve or request changes. " +
      'Respond with a single JSON object on one line: ' +
      '{"decision":"approve"|"request_changes","reason":"<short why>"}',
  );
  return lines.join("\n");
}

// -------------------------------------------------------------------------
// Parsing the brain output
// -------------------------------------------------------------------------

type Decision =
  | { decision: "approve"; reason: string }
  | { decision: "request_changes"; reason: string };

export function parseDecision(text: string): Decision {
  // The brain may wrap JSON in prose or ```json fences. Find the first {...} blob.
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    return { decision: "request_changes", reason: "no JSON in reviewer reply" };
  }
  try {
    const parsed = JSON.parse(match[0]) as {
      decision?: unknown;
      reason?: unknown;
    };
    const reason = typeof parsed.reason === "string" ? parsed.reason : "";
    if (parsed.decision === "approve") {
      return { decision: "approve", reason };
    }
    return {
      decision: "request_changes",
      reason: reason || "no reason given",
    };
  } catch {
    return {
      decision: "request_changes",
      reason: "reviewer reply was not valid JSON",
    };
  }
}

// -------------------------------------------------------------------------
// Running one review
// -------------------------------------------------------------------------

/** Test seam: override the brain step so tests can drive the reviewer
 *  decision deterministically. Production passes nothing → real brain. */
export type BrainStep = (input: {
  reviewer: Agent;
  prompt: string;
}) => Promise<{ text: string; thinking?: string }>;

export async function runAutoReview(
  input: {
    task_id: string;
    reviewer_agent_id: string;
  },
  brainStep?: BrainStep,
): Promise<
  | { ok: true; decision: Decision; brain_output: string }
  | { ok: false; reason: string }
> {
  const task = getTask(input.task_id);
  if (!task) return { ok: false, reason: "task not found" };
  if (task.status !== "awaiting_review") {
    return { ok: false, reason: `task not awaiting_review (${task.status})` };
  }
  const reviewer = getAgent(input.reviewer_agent_id);
  if (!reviewer) return { ok: false, reason: "reviewer not found" };

  const prompt = buildReviewPrompt(task);

  let output: { text: string; thinking?: string };
  try {
    if (brainStep) {
      output = await brainStep({ reviewer, prompt });
    } else {
      const history: ConvTurn[] = [
        {
          agent_id: "system",
          display_name: "system",
          text: prompt,
          is_self: false,
        },
      ];
      const cfg = parseBrainConfig(reviewer.brain_config_json);
      output = await generateReply(reviewer, history, cfg);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logAudit("agent.reply_failed", {
      agentId: reviewer.id,
      detail: { task_id: task.id, role: "auto-reviewer", err: msg },
    });
    return { ok: false, reason: msg };
  }
  const decision = parseDecision(output.text);

  // Dedup: another in-flight review could have moved the task; re-check.
  const fresh = getTask(task.id);
  if (!fresh || fresh.status !== "awaiting_review") {
    return { ok: false, reason: "task status moved before review applied" };
  }
  try {
    if (decision.decision === "approve") {
      approveTask(task.id, reviewer.id);
    } else {
      await requestChanges(
        task.id,
        reviewer.id,
        decision.reason.slice(0, 4000),
      );
    }
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
  return { ok: true, decision, brain_output: output.text };
}

// -------------------------------------------------------------------------
// Trigger: called after a task transitions to awaiting_review
// -------------------------------------------------------------------------

function taskNeedsAutoReview(task: Task): boolean {
  if (task.status !== "awaiting_review") return false;
  const criteria = parseSuccessCriteria(task);
  return criteria.some(
    (c: SuccessCriterion) => c.type === "diff_review",
  );
}

/** Enqueue auto-reviews for a task that just hit awaiting_review.
 *  Returns the list of triggered reviewer ids. Reviews run async; errors
 *  are surfaced via task events / audit, not as a thrown error here. */
export function maybeTriggerAutoReview(task: Task): string[] {
  if (!taskNeedsAutoReview(task)) return [];
  const reviewers = listEligibleReviewers(task);
  if (reviewers.length === 0) return [];

  const ids: string[] = [];
  for (const r of reviewers) {
    ids.push(r.id);
    // fire-and-forget; the runAutoReview function persists its decision
    // through approveTask / requestChanges so the result is durable.
    void runAutoReview({
      task_id: task.id,
      reviewer_agent_id: r.id,
    }).catch((err) => {
      console.error("auto-reviewer failed", {
        task_id: task.id,
        reviewer: r.id,
        err: err instanceof Error ? err.message : String(err),
      });
    });
  }
  // Surface via audit so operators can see the chain.
  if (ids.length > 0) {
    logAudit("task.status_change", {
      detail: {
        task_id: task.id,
        auto_review_dispatched_to: ids,
      },
    });
  }
  // touch the row so updated_at reflects the dispatch
  db()
    .prepare("UPDATE tasks SET updated_at = ? WHERE id = ?")
    .run(Date.now(), task.id);
  return ids;
}
