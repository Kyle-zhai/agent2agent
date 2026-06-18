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
  completeViaTestOverride,
  escalateReviewToHuman,
  getTask,
  listTaskEvents,
  parseRequiredCapabilities,
  parseSuccessCriteria,
  requestChanges,
  transitionTaskStatus,
} from "./tasks";
import { runSandbox } from "./sandbox";
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
 *  5. It hasn't already approved (final), and hasn't already acted in the
 *     CURRENT review round — a reviewer may re-review a NEW submission after
 *     the author addresses its feedback (the round resets at each
 *     `review_requested`), but it can't double-review the same draft.
 */
export function listEligibleReviewers(task: Task): Agent[] {
  if (!task.conversation_id) return [];
  const events = listTaskEvents(task.id);
  // The current review round starts at the latest review_requested event.
  let roundStart = 0;
  for (const e of events) {
    if (e.kind === "review_requested") roundStart = e.created_at;
  }
  const ineligible = new Set<string>();
  for (const e of events) {
    if (!e.actor_agent_id) continue;
    // An approval is final — no agent needs to re-approve.
    if (e.kind === "approved") ineligible.add(e.actor_agent_id);
    // Acting in the current round (since the latest review_requested) consumes
    // this reviewer's turn until the author submits again.
    if (
      (e.kind === "approved" || e.kind === "changes_requested") &&
      e.created_at >= roundStart
    ) {
      ineligible.add(e.actor_agent_id);
    }
  }
  const members = listMembers(task.conversation_id);
  const result: Agent[] = [];
  for (const m of members) {
    if (m.agent_id === task.owner_agent_id) continue;
    if (m.agent_id === task.assigned_to_agent_id) continue;
    if (ineligible.has(m.agent_id)) continue;
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

/** The result of running a task's deterministic test_command criteria — the
 *  ground truth we anchor the LLM reviewer to. `ran` is false when there are
 *  no test_command criteria or the sandbox is disabled, in which case every
 *  escape path stays inert (fail-safe). */
export type TestPrior = { ran: boolean; allPassed: boolean; lines: string[] };

/** Run the task's test_command success-criteria against its result snapshot so
 *  the reviewer (and the stall-escape logic) can anchor to the real exit code
 *  instead of the model's guess. Reuses the exact runSandbox path the "done"
 *  gate uses, so the prior can never disagree with the real gate. */
export async function runTaskTestCommands(
  task: Task,
  actorAgentId: string,
): Promise<TestPrior> {
  const tests = parseSuccessCriteria(task).filter(
    (c): c is Extract<SuccessCriterion, { type: "test_command" }> =>
      c.type === "test_command",
  );
  if (tests.length === 0 || !task.result_snapshot_id) {
    return { ran: false, allPassed: false, lines: [] };
  }
  const lines: string[] = [];
  let ranAny = false;
  let allPassed = true;
  for (const c of tests) {
    try {
      const run = await runSandbox({
        cmd: c.cmd,
        shell: (c.shell as "bash" | "sh" | undefined) ?? "bash",
        snapshot_id: task.result_snapshot_id,
        task_id: task.id,
        initiated_by_agent_id: actorAgentId,
      });
      if (run.runtime === "skipped") {
        lines.push(`- "${c.cmd}": SKIPPED (${run.reason ?? "sandbox disabled"})`);
        continue;
      }
      ranAny = true;
      const ok = run.exit_code === 0;
      if (!ok) allPassed = false;
      lines.push(`- "${c.cmd}": ${ok ? "PASS" : "FAIL"} (exit=${run.exit_code})`);
    } catch (err) {
      allPassed = false;
      lines.push(
        `- "${c.cmd}": ERROR (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }
  return { ran: ranAny, allPassed: ranAny && allPassed, lines };
}

export function buildReviewPrompt(task: Task, testPrior?: TestPrior): string {
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
  // The result_snapshot_id is actor-controlled — bind it to the task's own
  // workspace, or this prompt would leak file contents from ANY workspace into
  // the reviewer's view (the same guard test_command/diff_pattern apply at the
  // done gate). Without it, a poisoned result_snapshot_id is a cross-workspace
  // read (IDOR).
  if (task.workspace_id && snap.workspace_id !== task.workspace_id) {
    lines.push("\n(result snapshot is not in the task's workspace — refusing to inspect)");
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

  if (testPrior?.ran) {
    lines.push("\n# Deterministic acceptance tests (ground truth)");
    lines.push(
      testPrior.allPassed
        ? "These automated acceptance tests were just run against this exact snapshot and PASS:"
        : "These automated acceptance tests were just run against this exact snapshot and FAIL:",
    );
    for (const l of testPrior.lines) lines.push(l);
    lines.push(
      testPrior.allPassed
        ? "These tests are the authoritative acceptance signal — the build accepts this code as functionally complete. Do NOT claim the code is incomplete, or that output/sections are missing, if the tests pass. Only request changes for a SPECIFIC defect the tests cannot catch (e.g. a fabricated figure, an unsafe pattern), and name it exactly."
        : "Do NOT approve while these tests fail; point the author at the failing check.",
    );
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

  // Run the deterministic tests FIRST and anchor the reviewer to the real exit
  // code — this is what stops an LLM reviewer from hallucinating "incomplete"
  // on code whose acceptance tests already pass.
  const testPrior = await runTaskTestCommands(task, reviewer.id);
  const prompt = buildReviewPrompt(task, testPrior);

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

  // Bounded rounds: if the reviewer keeps disputing work whose deterministic
  // acceptance tests PASS and we've hit the round cap, stop bouncing the author
  // forever. Default = escalate to a human; opt-in A2A_REVIEW_TEST_OVERRIDE=1
  // auto-completes on the passing tests. Never fires when tests fail/are absent.
  if (decision.decision === "request_changes" && testPrior.ran && testPrior.allPassed) {
    const maxRounds = Number(process.env.A2A_REVIEW_MAX_ROUNDS) || 3;
    const priorChanges = listTaskEvents(task.id).filter(
      (e) => e.kind === "changes_requested",
    ).length;
    if (priorChanges + 1 >= maxRounds) {
      // Only override when one approval from THIS reviewer actually meets the
      // quorum — otherwise (e.g. min_approvers≥2 with a single reviewer) the
      // override approval is wasted and the task would bounce; escalate instead.
      if (
        process.env.A2A_REVIEW_TEST_OVERRIDE === "1" &&
        diffReviewSatisfied(task, reviewer.id)
      ) {
        try {
          await completeViaTestOverride(task.id, reviewer.id);
          return {
            ok: true,
            decision: { decision: "approve", reason: "test-pass override after round cap" },
            brain_output: output.text,
          };
        } catch {
          /* fall through to escalation if the override can't record */
        }
      }
      escalateReviewToHuman(
        task.id,
        reviewer.id,
        `Review round cap (${maxRounds}) reached; deterministic tests pass but the reviewer still disputes: ${decision.reason.slice(0, 300)}`,
      );
      return { ok: false, reason: "escalated after review round cap" };
    }
  }

  try {
    if (decision.decision === "approve") {
      approveTask(task.id, reviewer.id);
      // Close the gap where an approved task sat in awaiting_review forever
      // because nothing autonomously fires the awaiting_review→done transition.
      // BUT only advance once the review quorum is actually met — for
      // min_approvers≥2 this approval may be 1-of-N, and a premature
      // transition(done) would bounce the task to changes_requested and lock
      // out the remaining reviewers (approveTask requires awaiting_review).
      if (diffReviewSatisfied(getTask(task.id)!)) {
        await tryAdvanceToDone(task.id);
      }
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
// Advancing / un-wedging a reviewed task
// -------------------------------------------------------------------------

/** Advance an awaiting_review task to done IF its criteria now pass. The
 *  transitionTaskStatus("done") gate re-evaluates EVERY criterion (including
 *  re-running the test_command), so this can only close work that genuinely
 *  passes; if a criterion fails it bounces to changes_requested for another
 *  round, exactly as a human "merge" would. */
async function tryAdvanceToDone(taskId: string): Promise<boolean> {
  const t = getTask(taskId);
  if (!t || t.status !== "awaiting_review") return false;
  const actor = t.assigned_to_agent_id ?? t.owner_agent_id;
  if (!actor) return false;
  try {
    const res = await transitionTaskStatus({
      task_id: taskId,
      to_status: "done",
      actor_agent_id: actor,
      result_snapshot_id: t.result_snapshot_id,
    });
    return res.task.status === "done";
  } catch {
    return false;
  }
}

/** Does the task have enough recorded approvals (with the required capability,
 *  if any) to satisfy its diff_review criterion? `extraApprover`, if given, is
 *  counted as one prospective additional approval — used to test whether a
 *  test-pass override from a given reviewer WOULD actually complete the quorum
 *  (recording a duplicate approval from a reviewer who already approved cannot,
 *  because approvers are counted as a distinct set). */
function diffReviewSatisfied(task: Task, extraApprover?: string): boolean {
  const dr = parseSuccessCriteria(task).find(
    (c): c is Extract<SuccessCriterion, { type: "diff_review" }> =>
      c.type === "diff_review",
  );
  if (!dr) return true;
  const approvers = new Set<string>();
  for (const e of listTaskEvents(task.id)) {
    if (e.kind === "approved" && e.actor_agent_id) approvers.add(e.actor_agent_id);
  }
  if (extraApprover) approvers.add(extraApprover);
  if (dr.approver_capability) {
    for (const a of [...approvers]) {
      const ag = getAgent(a);
      if (!ag || !agentCapabilityNames(ag).has(dr.approver_capability)) {
        approvers.delete(a);
      }
    }
  }
  return approvers.size >= dr.min_approvers;
}

/** The last independent reviewer (non-owner, non-assignee) who acted on the
 *  task — used to attribute a test-pass override approval. */
function lastReviewerFor(task: Task): string | null {
  const events = listTaskEvents(task.id);
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (
      (e.kind === "changes_requested" || e.kind === "approved") &&
      e.actor_agent_id &&
      e.actor_agent_id !== task.assigned_to_agent_id &&
      e.actor_agent_id !== task.owner_agent_id
    ) {
      return e.actor_agent_id;
    }
  }
  return null;
}

/** Called when a task is awaiting_review with diff_review required but NO
 *  eligible reviewer remains (reviewers are one-shot). Resolves the stall:
 *   1. already approved → advance to done (the post-approval auto-close).
 *   2. deterministic tests pass → escalate to a human (default), or under the
 *      opt-in A2A_REVIEW_TEST_OVERRIDE flag, auto-complete on the passing tests.
 *   3. tests fail / none / sandbox off → leave it for a human (no loop, no CPU).
 */
export async function resolveStalledReview(taskId: string): Promise<void> {
  const task = getTask(taskId);
  if (!task || task.status !== "awaiting_review") return;
  if (!taskNeedsAutoReview(task)) return;

  if (diffReviewSatisfied(task)) {
    await tryAdvanceToDone(taskId);
    return;
  }
  // Don't re-escalate a task a human has already been pointed at.
  if (listTaskEvents(taskId).some((e) => e.kind === "review_escalated")) return;

  const actor = task.owner_agent_id ?? task.assigned_to_agent_id ?? "system";
  const testPrior = await runTaskTestCommands(task, actor);
  if (!testPrior.ran || !testPrior.allPassed) return; // genuinely needs a human / a fix

  if (process.env.A2A_REVIEW_TEST_OVERRIDE === "1") {
    const reviewer = lastReviewerFor(task);
    // Only override when one approval from this reviewer meets the quorum —
    // a duplicate approval can't satisfy min_approvers≥2 with a single reviewer.
    if (reviewer && diffReviewSatisfied(task, reviewer)) {
      try {
        await completeViaTestOverride(taskId, reviewer);
        return;
      } catch {
        // Override couldn't record (auth/capability) — fall back to escalation.
      }
    }
  }
  escalateReviewToHuman(
    taskId,
    null,
    `LLM review stalled; deterministic tests pass:\n${testPrior.lines.join("\n")}`,
  );
}

// -------------------------------------------------------------------------
// Trigger: called after a task transitions to awaiting_review
// -------------------------------------------------------------------------

// In-flight (task,reviewer) dispatches, so a re-kick of maybeTriggerAutoReview
// in the same round doesn't fire a second concurrent review for the same
// reviewer. Cleared when each review settles. (Per-process; multi-process relies
// on the durable status/freshness re-check inside runAutoReview.)
const inFlightReviews = new Set<string>();

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
  if (reviewers.length === 0) {
    // No eligible reviewer remains (one-shot reviewers exhausted). Rather than
    // leave the task wedged in awaiting_review forever, resolve the stall:
    // close it if already approved, else escalate/override on passing tests.
    void resolveStalledReview(task.id).catch((err) =>
      console.error("resolveStalledReview failed", {
        task_id: task.id,
        err: err instanceof Error ? err.message : String(err),
      }),
    );
    return [];
  }

  const ids: string[] = [];
  for (const r of reviewers) {
    // Guard against a duplicate concurrent dispatch of the SAME (task,reviewer)
    // — e.g. maybeTriggerAutoReview called twice in one round (a re-kick) before
    // the first review records its event. The key clears when the review
    // settles, so a genuinely new round re-dispatches normally.
    const key = `${task.id}:${r.id}`;
    if (inFlightReviews.has(key)) continue;
    inFlightReviews.add(key);
    ids.push(r.id);
    // fire-and-forget; the runAutoReview function persists its decision
    // through approveTask / requestChanges so the result is durable.
    void runAutoReview({
      task_id: task.id,
      reviewer_agent_id: r.id,
    })
      .catch((err) => {
        console.error("auto-reviewer failed", {
          task_id: task.id,
          reviewer: r.id,
          err: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => inFlightReviews.delete(key));
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
