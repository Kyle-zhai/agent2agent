import "server-only";
import { db } from "./db";
import { logAudit } from "./audit";
import { getAgent } from "./agents";
import { listMembers } from "./conversations";
import {
  fileDiffSummary,
  getSnapshot,
  readFileAt,
} from "./workspaces";
import {
  parseRequiredCapabilities,
  parseSuccessCriteria,
} from "./tasks";
import { generateReply, parseBrainConfig, type ConvTurn } from "./brains";
import type { Agent, Task } from "./types";

// -------------------------------------------------------------------------
// Types
// -------------------------------------------------------------------------

export type DebateRole = "pro" | "con" | "arbiter";

export type DebateArgument = {
  role: DebateRole;
  agent_id: string;
  text: string;
  thinking?: string;
};

export type DebateOutcome =
  | {
      ok: true;
      decision: "approve" | "request_changes";
      reason: string;
      arguments: DebateArgument[];
    }
  | { ok: false; reason: string };

/** Test seam: identical pattern to auto-reviewer's BrainStep. Production
 *  call sites pass undefined → real brain. */
export type DebateBrainStep = (input: {
  agent: Agent;
  role: DebateRole;
  prompt: string;
}) => Promise<{ text: string; thinking?: string }>;

// -------------------------------------------------------------------------
// Prompt construction
// -------------------------------------------------------------------------

const MAX_FILE_BYTES = 6 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024;

function diffDigest(task: Task): string {
  const snapId = task.result_snapshot_id;
  if (!snapId) return "(no result_snapshot_id — only task description is visible)";
  const snap = getSnapshot(snapId);
  if (!snap) return "(result_snapshot_id missing)";
  const diff = fileDiffSummary(snap.parent_snapshot_id, snap.id);
  const out: string[] = [];
  out.push(`## Diff summary (vs parent ${snap.parent_snapshot_id ?? "∅"})`);
  for (const d of diff) {
    out.push(`- ${d.status} ${d.path} (${d.size_bytes}b)`);
  }
  let total = 0;
  for (const d of diff) {
    if (d.status === "deleted") continue;
    const f = readFileAt(snap.id, d.path);
    if (!f) continue;
    const slice = f.content.toString("utf8").slice(0, MAX_FILE_BYTES);
    total += slice.length;
    if (total > MAX_TOTAL_BYTES) {
      out.push("\n[…remaining files truncated for prompt budget…]");
      break;
    }
    out.push(`\n## ${d.path}`);
    out.push("```");
    out.push(slice);
    out.push("```");
  }
  return out.join("\n");
}

function taskHeader(task: Task): string {
  const lines = [`# Task: ${task.title}`];
  if (task.description) lines.push(task.description);
  const req = parseRequiredCapabilities(task);
  if (req.length > 0) lines.push(`required_capabilities: ${req.join(", ")}`);
  return lines.join("\n");
}

export function buildProPrompt(task: Task): string {
  return [
    taskHeader(task),
    "",
    diffDigest(task),
    "",
    "# Your role: PRO advocate",
    "Argue the strongest case for APPROVING this change as-is. " +
      "Be concrete — point to specific lines / files where possible. " +
      "Reply with a single short paragraph (≤ 150 words). " +
      "Do not hedge with 'but'. The CON advocate will surface concerns separately.",
  ].join("\n");
}

export function buildConPrompt(task: Task): string {
  return [
    taskHeader(task),
    "",
    diffDigest(task),
    "",
    "# Your role: CON advocate",
    "Argue the strongest case for REJECTING this change. " +
      "Look for: missed requirements, regressions, security issues, ambiguity, " +
      "violations of stated success criteria. Be specific (file:line where possible). " +
      "Reply with a single short paragraph (≤ 150 words). " +
      "If you cannot find an objection, say so plainly.",
  ].join("\n");
}

export function buildArbiterPrompt(
  task: Task,
  pro: string,
  con: string,
): string {
  return [
    taskHeader(task),
    "",
    diffDigest(task),
    "",
    "# Two arguments were submitted",
    "## PRO",
    pro,
    "",
    "## CON",
    con,
    "",
    "# Your role: ARBITER",
    "Synthesize. Decide whether to approve or request_changes. " +
      "Cite which side's points won and why. " +
      'Respond with ONE JSON object on one line: ' +
      '{"decision":"approve"|"request_changes","reason":"<≤300 chars>"}',
  ].join("\n");
}

// -------------------------------------------------------------------------
// Parsing arbiter decision
// -------------------------------------------------------------------------

export function parseArbiterDecision(
  text: string,
): { decision: "approve" | "request_changes"; reason: string } {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) {
    return {
      decision: "request_changes",
      reason: "arbiter reply had no JSON",
    };
  }
  try {
    const parsed = JSON.parse(m[0]) as {
      decision?: unknown;
      reason?: unknown;
    };
    const reason =
      typeof parsed.reason === "string"
        ? parsed.reason.slice(0, 300)
        : "(no reason given)";
    if (parsed.decision === "approve") {
      return { decision: "approve", reason };
    }
    return { decision: "request_changes", reason };
  } catch {
    return {
      decision: "request_changes",
      reason: "arbiter reply was not valid JSON",
    };
  }
}

// -------------------------------------------------------------------------
// Validation
// -------------------------------------------------------------------------

function ensureRoleAgent(
  task: Task,
  agentId: string,
  label: DebateRole,
): { ok: true; agent: Agent } | { ok: false; reason: string } {
  const a = getAgent(agentId);
  if (!a) return { ok: false, reason: `${label} agent not found: ${agentId}` };
  if (!task.conversation_id) {
    return { ok: false, reason: `${label} debate requires task in a conversation` };
  }
  const members = listMembers(task.conversation_id);
  if (!members.some((m) => m.agent_id === a.id)) {
    return {
      ok: false,
      reason: `${label} agent ${a.id} is not a member of the task's conversation`,
    };
  }
  return { ok: true, agent: a };
}

// -------------------------------------------------------------------------
// Idempotency — has a debate already finished for this snapshot?
// -------------------------------------------------------------------------

function findPriorDebate(
  taskId: string,
  resultSnapshotId: string,
): DebateOutcome | null {
  const rows = db()
    .prepare(
      `SELECT payload_json FROM task_events
       WHERE task_id = ? AND kind = 'debate_finished'
       ORDER BY id DESC LIMIT 5`,
    )
    .all(taskId) as Array<{ payload_json: string }>;
  for (const r of rows) {
    try {
      const p = JSON.parse(r.payload_json) as DebateOutcome & {
        snapshot_id?: string;
      };
      if ((p as { snapshot_id?: string }).snapshot_id === resultSnapshotId) {
        return p;
      }
    } catch {
      /* malformed payload — skip */
    }
  }
  return null;
}

// -------------------------------------------------------------------------
// runDebate — executes the three brain calls in sequence
// -------------------------------------------------------------------------

export async function runDebate(
  task: Task,
  panel: {
    pro_agent_id: string;
    con_agent_id: string;
    arbiter_agent_id: string;
  },
  brainStep?: DebateBrainStep,
): Promise<DebateOutcome> {
  const snapId = task.result_snapshot_id;
  if (!snapId) {
    return {
      ok: false,
      reason: "debate_panel requires result_snapshot_id (set it when transitioning)",
    };
  }
  const prior = findPriorDebate(task.id, snapId);
  if (prior) return prior;

  const pro = ensureRoleAgent(task, panel.pro_agent_id, "pro");
  if (!pro.ok) return { ok: false, reason: pro.reason };
  const con = ensureRoleAgent(task, panel.con_agent_id, "con");
  if (!con.ok) return { ok: false, reason: con.reason };
  const arb = ensureRoleAgent(task, panel.arbiter_agent_id, "arbiter");
  if (!arb.ok) return { ok: false, reason: arb.reason };
  // Independence: arbiter must be different from pro and con. Pro and con
  // can be the same agent in degenerate setups but we reject as useless.
  if (pro.agent.id === con.agent.id) {
    return { ok: false, reason: "pro and con must be different agents" };
  }
  if (arb.agent.id === pro.agent.id || arb.agent.id === con.agent.id) {
    return {
      ok: false,
      reason: "arbiter must be independent of pro and con",
    };
  }

  logAudit("debate.started", {
    detail: {
      task_id: task.id,
      snapshot_id: snapId,
      pro: pro.agent.id,
      con: con.agent.id,
      arbiter: arb.agent.id,
    },
  });

  async function step(
    agent: Agent,
    role: DebateRole,
    prompt: string,
  ): Promise<{ text: string; thinking?: string }> {
    if (brainStep) return brainStep({ agent, role, prompt });
    const history: ConvTurn[] = [
      {
        agent_id: "system",
        display_name: "system",
        text: prompt,
        is_self: false,
      },
    ];
    const cfg = parseBrainConfig(agent.brain_config_json);
    return generateReply(agent, history, cfg);
  }

  let proOut, conOut, arbOut;
  try {
    proOut = await step(pro.agent, "pro", buildProPrompt(task));
    conOut = await step(con.agent, "con", buildConPrompt(task));
    arbOut = await step(
      arb.agent,
      "arbiter",
      buildArbiterPrompt(task, proOut.text, conOut.text),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logAudit("debate.failed", {
      detail: { task_id: task.id, err: msg },
    });
    return { ok: false, reason: `debate brain call failed: ${msg}` };
  }

  const decision = parseArbiterDecision(arbOut.text);
  const argument_list: DebateArgument[] = [
    { role: "pro", agent_id: pro.agent.id, text: proOut.text, thinking: proOut.thinking },
    { role: "con", agent_id: con.agent.id, text: conOut.text, thinking: conOut.thinking },
    { role: "arbiter", agent_id: arb.agent.id, text: arbOut.text, thinking: arbOut.thinking },
  ];
  // Persist each side as task_events for the timeline.
  for (const a of argument_list) {
    db()
      .prepare(
        `INSERT INTO task_events (task_id, actor_agent_id, kind, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        task.id,
        a.agent_id,
        "debate_argument",
        JSON.stringify({
          role: a.role,
          text: a.text,
          thinking: a.thinking ?? null,
        }),
        Date.now(),
      );
  }
  // Persist the outcome (with snapshot_id stamp for idempotency).
  const outcome: DebateOutcome = {
    ok: true,
    decision: decision.decision,
    reason: decision.reason,
    arguments: argument_list,
  };
  db()
    .prepare(
      `INSERT INTO task_events (task_id, actor_agent_id, kind, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      task.id,
      arb.agent.id,
      "debate_finished",
      JSON.stringify({ ...outcome, snapshot_id: snapId }),
      Date.now(),
    );
  logAudit("debate.finished", {
    detail: {
      task_id: task.id,
      decision: decision.decision,
      snapshot_id: snapId,
    },
  });
  return outcome;
}
