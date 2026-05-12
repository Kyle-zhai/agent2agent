import "server-only";
import { db } from "./db";
import { newTaskId } from "./ids";
import { logAudit } from "./audit";
import {
  agentCapabilityNames,
  getAgent,
  parseAgentCapabilities,
} from "./agents";
import {
  fileDiffSummary,
  getSnapshot,
  getWorkspace,
  listFiles,
  readFileAt,
} from "./workspaces";
import type {
  SuccessCriterion,
  Task,
  TaskArtifact,
  TaskArtifactKind,
  TaskEvent,
  TaskEventKind,
  TaskStatus,
} from "./types";

const TASK_COLUMNS =
  "id, conversation_id, workspace_id, parent_task_id, title, description, owner_agent_id, assigned_to_agent_id, status, required_capabilities, success_criteria, result_snapshot_id, created_at, updated_at";

// ---- state machine ----------------------------------------------------------

const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  open: ["assigned", "cancelled"],
  assigned: ["in_progress", "open", "cancelled"],
  in_progress: ["awaiting_review", "cancelled"],
  awaiting_review: ["changes_requested", "done"],
  changes_requested: ["in_progress", "cancelled"],
  done: [],
  cancelled: [],
};

export function isTransitionAllowed(
  from: TaskStatus,
  to: TaskStatus,
): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

// ---- input validation -------------------------------------------------------

const TITLE_MAX = 200;
const DESC_MAX = 8000;
const COMMENT_MAX = 4000;
const MAX_REQUIRED_CAPS = 16;
const MAX_CRITERIA = 16;

const CAP_NAME_RE = /^[a-z][a-z0-9_.-]{1,40}$/i;

function validateRequiredCapabilities(input: unknown): string[] {
  if (input == null) return [];
  if (!Array.isArray(input)) {
    throw new Error("required_capabilities must be a JSON array of names.");
  }
  if (input.length > MAX_REQUIRED_CAPS) {
    throw new Error("Too many required capabilities.");
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of input) {
    if (typeof v !== "string" || !CAP_NAME_RE.test(v)) {
      throw new Error(`Invalid capability name: ${String(v)}`);
    }
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function validateSuccessCriteria(input: unknown): SuccessCriterion[] {
  if (input == null) return [];
  if (!Array.isArray(input)) {
    throw new Error("success_criteria must be a JSON array.");
  }
  if (input.length > MAX_CRITERIA) {
    throw new Error("Too many success criteria.");
  }
  const out: SuccessCriterion[] = [];
  for (const c of input) {
    if (!c || typeof c !== "object") {
      throw new Error("Each criterion must be an object.");
    }
    const obj = c as Record<string, unknown>;
    const type = obj.type;
    switch (type) {
      case "test_command":
        if (typeof obj.cmd !== "string" || obj.cmd.length < 1) {
          throw new Error("test_command.cmd is required.");
        }
        out.push({
          type: "test_command",
          shell: typeof obj.shell === "string" ? obj.shell : undefined,
          cmd: obj.cmd,
          sandbox:
            typeof obj.sandbox === "string" ? obj.sandbox : undefined,
        });
        break;
      case "diff_review": {
        const min =
          typeof obj.min_approvers === "number" ? obj.min_approvers : 1;
        out.push({
          type: "diff_review",
          min_approvers: Math.max(1, Math.min(5, Math.floor(min))),
          approver_capability:
            typeof obj.approver_capability === "string"
              ? obj.approver_capability
              : undefined,
        });
        break;
      }
      case "diff_pattern":
        out.push({
          type: "diff_pattern",
          forbidden: Array.isArray(obj.forbidden)
            ? obj.forbidden.filter((s): s is string => typeof s === "string")
            : undefined,
          required: Array.isArray(obj.required)
            ? obj.required.filter((s): s is string => typeof s === "string")
            : undefined,
        });
        break;
      case "capability_check":
        if (!Array.isArray(obj.must_include)) {
          throw new Error("capability_check.must_include must be array.");
        }
        out.push({
          type: "capability_check",
          must_include: obj.must_include.filter(
            (s): s is string => typeof s === "string",
          ),
        });
        break;
      case "manual":
        if (typeof obj.approver_agent_id !== "string") {
          throw new Error("manual.approver_agent_id required.");
        }
        out.push({
          type: "manual",
          approver_agent_id: obj.approver_agent_id,
        });
        break;
      default:
        throw new Error(`Unknown success criterion type: ${String(type)}`);
    }
  }
  return out;
}

// ---- CRUD -------------------------------------------------------------------

export function getTask(id: string): Task | null {
  return (
    (db()
      .prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE id = ?`)
      .get(id) as Task | undefined) ?? null
  );
}

export type CreateTaskInput = {
  title: string;
  description?: string;
  owner_agent_id: string;
  assigned_to_agent_id?: string | null;
  conversation_id?: string | null;
  workspace_id?: string | null;
  parent_task_id?: string | null;
  required_capabilities?: unknown;
  success_criteria?: unknown;
};

export function createTask(input: CreateTaskInput): Task {
  const title = input.title.trim();
  if (title.length < 1 || title.length > TITLE_MAX) {
    throw new Error(`title must be 1-${TITLE_MAX} chars.`);
  }
  const description = (input.description ?? "").slice(0, DESC_MAX);
  const owner = getAgent(input.owner_agent_id);
  if (!owner) throw new Error("owner_agent_id not found.");

  const required = validateRequiredCapabilities(input.required_capabilities);
  const criteria = validateSuccessCriteria(input.success_criteria);

  let assignedTo: string | null = null;
  let status: TaskStatus = "open";
  if (input.assigned_to_agent_id) {
    const assignee = getAgent(input.assigned_to_agent_id);
    if (!assignee) throw new Error("assigned_to_agent_id not found.");
    if (required.length > 0) {
      const have = agentCapabilityNames(assignee);
      const missing = required.filter((c) => !have.has(c));
      if (missing.length > 0) {
        throw new Error(
          `Assignee missing capabilities: ${missing.join(", ")}`,
        );
      }
    }
    assignedTo = assignee.id;
    status = "assigned";
  }

  if (input.workspace_id) {
    if (!getWorkspace(input.workspace_id)) {
      throw new Error("workspace_id not found.");
    }
  }
  if (input.parent_task_id && !getTask(input.parent_task_id)) {
    throw new Error("parent_task_id not found.");
  }

  const id = newTaskId();
  const now = Date.now();
  db()
    .prepare(
      `INSERT INTO tasks
       (id, conversation_id, workspace_id, parent_task_id,
        title, description,
        owner_agent_id, assigned_to_agent_id,
        status, required_capabilities, success_criteria, result_snapshot_id,
        created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    )
    .run(
      id,
      input.conversation_id ?? null,
      input.workspace_id ?? null,
      input.parent_task_id ?? null,
      title,
      description,
      owner.id,
      assignedTo,
      status,
      JSON.stringify(required),
      JSON.stringify(criteria),
      now,
      now,
    );

  appendEvent(id, owner.id, "created", { title });
  if (assignedTo) {
    appendEvent(id, owner.id, "assigned", { to: assignedTo });
  }
  logAudit("task.create", {
    agentId: owner.id,
    detail: { task_id: id, assigned_to: assignedTo, required },
  });
  if (assignedTo) {
    logAudit("task.assign", {
      agentId: owner.id,
      detail: { task_id: id, to: assignedTo },
    });
  }
  return getTask(id)!;
}

// ---- listing ----------------------------------------------------------------

export function listTasksForConversation(
  conversationId: string,
  limit = 100,
): Task[] {
  return db()
    .prepare(
      `SELECT ${TASK_COLUMNS} FROM tasks
       WHERE conversation_id = ?
       ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(conversationId, limit) as Task[];
}

export function listTasksAssignedTo(agentId: string, limit = 100): Task[] {
  return db()
    .prepare(
      `SELECT ${TASK_COLUMNS} FROM tasks
       WHERE assigned_to_agent_id = ?
         AND status NOT IN ('done','cancelled')
       ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(agentId, limit) as Task[];
}

export function listTasksOwnedBy(agentId: string, limit = 100): Task[] {
  return db()
    .prepare(
      `SELECT ${TASK_COLUMNS} FROM tasks
       WHERE owner_agent_id = ?
       ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(agentId, limit) as Task[];
}

// ---- events + artifacts -----------------------------------------------------

function appendEvent(
  taskId: string,
  actorAgentId: string | null,
  kind: TaskEventKind,
  payload: Record<string, unknown>,
): TaskEvent {
  const now = Date.now();
  const info = db()
    .prepare(
      `INSERT INTO task_events
       (task_id, actor_agent_id, kind, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(taskId, actorAgentId, kind, JSON.stringify(payload), now);
  return {
    id: info.lastInsertRowid as number,
    task_id: taskId,
    actor_agent_id: actorAgentId,
    kind,
    payload_json: JSON.stringify(payload),
    created_at: now,
  };
}

export function listTaskEvents(taskId: string, limit = 200): TaskEvent[] {
  return db()
    .prepare(
      `SELECT id, task_id, actor_agent_id, kind, payload_json, created_at
       FROM task_events WHERE task_id = ?
       ORDER BY id ASC LIMIT ?`,
    )
    .all(taskId, limit) as TaskEvent[];
}

export function addTaskComment(
  taskId: string,
  actorAgentId: string,
  body: string,
): TaskEvent {
  const t = getTask(taskId);
  if (!t) throw new Error("Task not found.");
  const trimmed = body.trim().slice(0, COMMENT_MAX);
  if (trimmed.length === 0) throw new Error("Comment is empty.");
  touchUpdated(taskId);
  logAudit("task.comment", {
    agentId: actorAgentId,
    detail: { task_id: taskId, len: trimmed.length },
  });
  return appendEvent(taskId, actorAgentId, "comment", { body: trimmed });
}

export function addTaskArtifact(
  taskId: string,
  kind: TaskArtifactKind,
  refId: string,
  addedByAgentId: string | null,
): TaskArtifact {
  const t = getTask(taskId);
  if (!t) throw new Error("Task not found.");
  const now = Date.now();
  db()
    .prepare(
      `INSERT OR IGNORE INTO task_artifacts
       (task_id, kind, ref_id, added_by_agent_id, added_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(taskId, kind, refId, addedByAgentId, now);
  touchUpdated(taskId);
  appendEvent(taskId, addedByAgentId, "patch_attached", {
    artifact_kind: kind,
    ref_id: refId,
  });
  return {
    task_id: taskId,
    kind,
    ref_id: refId,
    added_by_agent_id: addedByAgentId,
    added_at: now,
  };
}

export function listTaskArtifacts(taskId: string): TaskArtifact[] {
  return db()
    .prepare(
      `SELECT task_id, kind, ref_id, added_by_agent_id, added_at
       FROM task_artifacts WHERE task_id = ?
       ORDER BY added_at ASC`,
    )
    .all(taskId) as TaskArtifact[];
}

function touchUpdated(taskId: string): void {
  db()
    .prepare("UPDATE tasks SET updated_at = ? WHERE id = ?")
    .run(Date.now(), taskId);
}

// ---- assignment + transition ------------------------------------------------

export type AssignInput = {
  task_id: string;
  assignee_agent_id: string | null; // null = unassign
  actor_agent_id: string;
};

export function assignTask(input: AssignInput): Task {
  const t = getTask(input.task_id);
  if (!t) throw new Error("Task not found.");
  if (t.owner_agent_id !== input.actor_agent_id) {
    throw new Error("Only the owner can re-assign.");
  }
  if (input.assignee_agent_id === null) {
    db()
      .prepare(
        `UPDATE tasks SET assigned_to_agent_id = NULL,
                          status = 'open',
                          updated_at = ?
         WHERE id = ?`,
      )
      .run(Date.now(), t.id);
    appendEvent(t.id, input.actor_agent_id, "unassigned", {});
    return getTask(t.id)!;
  }

  const assignee = getAgent(input.assignee_agent_id);
  if (!assignee) throw new Error("Assignee not found.");

  const required = JSON.parse(t.required_capabilities) as string[];
  if (required.length > 0) {
    const have = agentCapabilityNames(assignee);
    const missing = required.filter((c) => !have.has(c));
    if (missing.length > 0) {
      throw new Error(
        `Assignee missing capabilities: ${missing.join(", ")}`,
      );
    }
  }
  const nextStatus: TaskStatus =
    t.status === "open" || t.status === "assigned" ? "assigned" : t.status;
  db()
    .prepare(
      `UPDATE tasks SET assigned_to_agent_id = ?,
                        status = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(assignee.id, nextStatus, Date.now(), t.id);
  appendEvent(t.id, input.actor_agent_id, "assigned", { to: assignee.id });
  logAudit("task.assign", {
    agentId: input.actor_agent_id,
    detail: { task_id: t.id, to: assignee.id },
  });
  return getTask(t.id)!;
}

export type TransitionInput = {
  task_id: string;
  to_status: TaskStatus;
  actor_agent_id: string;
  comment?: string;
  result_snapshot_id?: string | null;
};

export function transitionTaskStatus(input: TransitionInput): {
  task: Task;
  criteria_failures?: string[];
} {
  const t = getTask(input.task_id);
  if (!t) throw new Error("Task not found.");
  if (!isTransitionAllowed(t.status, input.to_status)) {
    throw new Error(
      `Illegal status transition: ${t.status} → ${input.to_status}`,
    );
  }
  // Authorization: owner can always move; assignee can move forward only.
  const isOwner = t.owner_agent_id === input.actor_agent_id;
  const isAssignee = t.assigned_to_agent_id === input.actor_agent_id;
  if (!isOwner && !isAssignee) {
    throw new Error("Only owner or assignee can transition this task.");
  }

  let finalStatus = input.to_status;
  let criteriaFailures: string[] | undefined;
  let resultSnap: string | null =
    input.result_snapshot_id ?? t.result_snapshot_id;

  // On "done" enforce success criteria.
  if (input.to_status === "done") {
    const evalRes = evaluateSuccessCriteria(t, {
      actor_agent_id: input.actor_agent_id,
      result_snapshot_id: resultSnap,
    });
    if (!evalRes.ok) {
      finalStatus = "changes_requested";
      criteriaFailures = evalRes.failures;
      logAudit("task.success_criteria_fail", {
        agentId: input.actor_agent_id,
        detail: { task_id: t.id, failures: evalRes.failures },
      });
    } else {
      logAudit("task.success_criteria_pass", {
        agentId: input.actor_agent_id,
        detail: { task_id: t.id },
      });
    }
  }

  const now = Date.now();
  db()
    .prepare(
      `UPDATE tasks
       SET status = ?, result_snapshot_id = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(finalStatus, resultSnap, now, t.id);

  appendEvent(t.id, input.actor_agent_id, "status_change", {
    from: t.status,
    to: finalStatus,
    requested: input.to_status,
    result_snapshot_id: resultSnap,
  });
  if (input.comment && input.comment.trim()) {
    addTaskComment(t.id, input.actor_agent_id, input.comment);
  }
  if (input.to_status === "awaiting_review" && finalStatus === "awaiting_review") {
    appendEvent(t.id, input.actor_agent_id, "review_requested", {});
  }
  if (criteriaFailures) {
    appendEvent(t.id, null, "criteria_failed", { failures: criteriaFailures });
  }
  logAudit("task.status_change", {
    agentId: input.actor_agent_id,
    detail: { task_id: t.id, from: t.status, to: finalStatus },
  });
  return { task: getTask(t.id)!, criteria_failures: criteriaFailures };
}

// ---- success criteria evaluation -------------------------------------------

type CriteriaResult = { ok: true } | { ok: false; failures: string[] };

export function evaluateSuccessCriteria(
  task: Task,
  ctx: { actor_agent_id: string; result_snapshot_id: string | null },
): CriteriaResult {
  let criteria: SuccessCriterion[] = [];
  try {
    criteria = JSON.parse(task.success_criteria);
  } catch {
    return { ok: true }; // tolerate malformed criteria as "no criteria"
  }
  const failures: string[] = [];
  for (const c of criteria) {
    const res = evaluateOne(c, task, ctx);
    if (!res.ok) failures.push(res.reason);
  }
  return failures.length === 0 ? { ok: true } : { ok: false, failures };
}

function evaluateOne(
  c: SuccessCriterion,
  task: Task,
  ctx: { actor_agent_id: string; result_snapshot_id: string | null },
): { ok: true } | { ok: false; reason: string } {
  switch (c.type) {
    case "capability_check": {
      const actor = getAgent(ctx.actor_agent_id);
      if (!actor) return { ok: false, reason: "capability_check: actor not found" };
      const have = agentCapabilityNames(actor);
      const missing = c.must_include.filter((n) => !have.has(n));
      return missing.length === 0
        ? { ok: true }
        : { ok: false, reason: `capability_check missing: ${missing.join(", ")}` };
    }
    case "manual": {
      return ctx.actor_agent_id === c.approver_agent_id
        ? { ok: true }
        : {
            ok: false,
            reason: `manual: requires approval by ${c.approver_agent_id}`,
          };
    }
    case "diff_pattern": {
      const snapId = ctx.result_snapshot_id ?? task.result_snapshot_id;
      if (!snapId) return { ok: false, reason: "diff_pattern: no result snapshot" };
      const snap = getSnapshot(snapId);
      if (!snap) return { ok: false, reason: "diff_pattern: snapshot missing" };
      const parentId = snap.parent_snapshot_id;
      const diff = fileDiffSummary(parentId, snapId);
      // For pattern matching we concatenate the contents of changed (added or
      // modified) files. Deleted files cannot contribute new patterns.
      const buffers: string[] = [];
      for (const d of diff) {
        if (d.status === "deleted") continue;
        const r = readFileAt(snapId, d.path);
        if (r) buffers.push(`# ${d.path}\n${r.content.toString("utf8")}`);
      }
      const text = buffers.join("\n\n");
      const fbProblems: string[] = [];
      for (const f of c.forbidden ?? []) {
        try {
          if (new RegExp(f).test(text)) fbProblems.push(`forbidden:${f}`);
        } catch {
          fbProblems.push(`bad_regex:${f}`);
        }
      }
      for (const r of c.required ?? []) {
        try {
          if (!new RegExp(r).test(text)) fbProblems.push(`required:${r}`);
        } catch {
          fbProblems.push(`bad_regex:${r}`);
        }
      }
      return fbProblems.length === 0
        ? { ok: true }
        : { ok: false, reason: `diff_pattern: ${fbProblems.join(", ")}` };
    }
    case "diff_review": {
      // diff_review needs N independent approvers; we count distinct "approved"
      // events. The actor closing the task may also count if they have the
      // required capability.
      const events = listTaskEvents(task.id);
      const approvers = new Set<string>();
      for (const e of events) {
        if (e.kind === "approved" && e.actor_agent_id) {
          approvers.add(e.actor_agent_id);
        }
      }
      // closing-actor self-approval is allowed for single-approver scenarios
      // unless the actor is the owner (avoid trivial self-approval).
      if (
        c.min_approvers === 1 &&
        ctx.actor_agent_id !== task.owner_agent_id
      ) {
        approvers.add(ctx.actor_agent_id);
      }
      if (c.approver_capability) {
        for (const a of [...approvers]) {
          const ag = getAgent(a);
          if (!ag || !agentCapabilityNames(ag).has(c.approver_capability)) {
            approvers.delete(a);
          }
        }
      }
      return approvers.size >= c.min_approvers
        ? { ok: true }
        : {
            ok: false,
            reason: `diff_review: need ${c.min_approvers} approvers with capability ${c.approver_capability ?? "*"}, have ${approvers.size}`,
          };
    }
    case "test_command": {
      // v0.5 cannot execute commands (sandbox arrives in v0.6).
      // We surface this as an explicit failure rather than silently passing.
      return {
        ok: false,
        reason: `test_command not executed in v0.5 (sandbox lands in v0.6)`,
      };
    }
    default:
      return { ok: false, reason: `unknown criterion type` };
  }
}

// ---- helpers ----------------------------------------------------------------

export function approveTask(taskId: string, actorAgentId: string): TaskEvent {
  const t = getTask(taskId);
  if (!t) throw new Error("Task not found.");
  if (t.status !== "awaiting_review") {
    throw new Error("Task is not awaiting review.");
  }
  if (t.owner_agent_id === actorAgentId) {
    throw new Error("Owner cannot self-approve to avoid trivial reviews.");
  }
  touchUpdated(taskId);
  return appendEvent(taskId, actorAgentId, "approved", {});
}

export function requestChanges(
  taskId: string,
  actorAgentId: string,
  comment: string,
): TaskEvent {
  const t = getTask(taskId);
  if (!t) throw new Error("Task not found.");
  if (t.status !== "awaiting_review") {
    throw new Error("Task is not awaiting review.");
  }
  transitionTaskStatus({
    task_id: taskId,
    to_status: "changes_requested",
    actor_agent_id: actorAgentId,
    comment,
  });
  return appendEvent(taskId, actorAgentId, "changes_requested", {
    comment: comment.slice(0, COMMENT_MAX),
  });
}

export function parseRequiredCapabilities(t: Task): string[] {
  try {
    const v = JSON.parse(t.required_capabilities);
    return Array.isArray(v) ? v.filter((s) => typeof s === "string") : [];
  } catch {
    return [];
  }
}

export function parseSuccessCriteria(t: Task): SuccessCriterion[] {
  try {
    const v = JSON.parse(t.success_criteria);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

// Re-export for convenience.
export type { Task, TaskStatus, TaskEvent, TaskArtifact, SuccessCriterion };

// Internal helper to keep listFiles usage unitary; re-exported via tests.
export const _internals = { listFiles };
