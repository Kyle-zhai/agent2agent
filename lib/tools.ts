import "server-only";
import { db } from "./db";
import { newToolInvocationId } from "./ids";
import { logAudit } from "./audit";
import {
  applyPatch,
  canRead,
  canWrite,
  getSnapshot,
  getWorkspace,
  listFiles,
  readFileAt,
} from "./workspaces";
import {
  getTask,
  parseRequiredCapabilities,
  parseSuccessCriteria,
  transitionTaskStatus,
} from "./tasks";
import {
  listMembers,
  saveAttachment,
  sendMessage,
} from "./conversations";
import { agentCapabilityNames, getAgent } from "./agents";
import type { Agent, TaskStatus } from "./types";

// -------------------------------------------------------------------------
// Tool definition
// -------------------------------------------------------------------------

export type ToolContext = {
  agent: Agent;
  taskId?: string | null;
};

export type ToolSchema = {
  type: "object";
  required: string[];
  properties: Record<
    string,
    { type: string; description: string; enum?: string[] }
  >;
};

export type Tool = {
  name: string;
  description: string;
  requires_capability: string;
  schema: ToolSchema;
  invoke: (
    args: Record<string, unknown>,
    ctx: ToolContext,
  ) => Promise<unknown>;
};

// -------------------------------------------------------------------------
// Built-in tools
// -------------------------------------------------------------------------

function need<T>(args: Record<string, unknown>, key: string, type: "string" | "number"): T {
  const v = args[key];
  if (typeof v !== type) {
    throw new Error(`tool arg "${key}" must be ${type}`);
  }
  return v as T;
}

function optional<T>(args: Record<string, unknown>, key: string, type: "string" | "number"): T | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== type) {
    throw new Error(`tool arg "${key}" must be ${type} if present`);
  }
  return v as T;
}

const workspaceReadFile: Tool = {
  name: "workspace.read_file",
  description:
    "Read a file from a workspace snapshot. Returns utf-8 content, sha, and size.",
  requires_capability: "workspace.read",
  schema: {
    type: "object",
    required: ["workspace_id", "path"],
    properties: {
      workspace_id: { type: "string", description: "workspace id (wks_...)" },
      path: { type: "string", description: "relative file path inside the workspace" },
      rev: {
        type: "string",
        description: "snapshot id; defaults to current head_snapshot_id",
      },
    },
  },
  async invoke(args, ctx) {
    const wsId = need<string>(args, "workspace_id", "string");
    const path = need<string>(args, "path", "string");
    const rev = optional<string>(args, "rev", "string");
    const ws = getWorkspace(wsId);
    if (!ws) throw new Error("workspace not found");
    if (!canRead(ws.id, ctx.agent.id)) throw new Error("not subscribed");
    const effectiveRev = rev ?? ws.head_snapshot_id;
    if (!effectiveRev) throw new Error("workspace has no head snapshot");
    const f = readFileAt(effectiveRev, path);
    if (!f) throw new Error("file not found at rev");
    return {
      workspace_id: ws.id,
      rev: effectiveRev,
      path: f.file.path,
      sha: f.file.content_sha256,
      size: f.file.size_bytes,
      content: f.content.toString("utf8"),
    };
  },
};

const workspaceWriteFile: Tool = {
  name: "workspace.write_file",
  description:
    "Create or modify a file in a workspace. Submits a patch with optimistic concurrency; returns 409-shaped result if against_rev is stale.",
  requires_capability: "workspace.write",
  schema: {
    type: "object",
    required: ["workspace_id", "path", "content", "against_rev"],
    properties: {
      workspace_id: { type: "string", description: "wks_..." },
      path: { type: "string", description: "relative path" },
      content: { type: "string", description: "new utf-8 file content" },
      against_rev: { type: "string", description: "snapshot id you read from" },
      commit_message: { type: "string", description: "short why" },
      thinking: { type: "string", description: "longer reasoning (optional)" },
      task_id: { type: "string", description: "tsk_... to attach the patch to" },
    },
  },
  async invoke(args, ctx) {
    const wsId = need<string>(args, "workspace_id", "string");
    const path = need<string>(args, "path", "string");
    const content = need<string>(args, "content", "string");
    const againstRev = need<string>(args, "against_rev", "string");
    const commitMessage = optional<string>(args, "commit_message", "string");
    const thinking = optional<string>(args, "thinking", "string");
    const taskId = optional<string>(args, "task_id", "string") ?? ctx.taskId ?? null;

    const ws = getWorkspace(wsId);
    if (!ws) throw new Error("workspace not found");
    if (!canWrite(ws.id, ctx.agent.id)) throw new Error("writer role required");
    const result = applyPatch({
      workspace_id: ws.id,
      agent_id: ctx.agent.id,
      against_rev: againstRev,
      ops: [{ path, op: "modify", content: Buffer.from(content, "utf8") }],
      commit_message: commitMessage,
      thinking,
      task_id: taskId,
    });
    return result;
  },
};

const workspaceListFiles: Tool = {
  name: "workspace.list_files",
  description: "List files in a workspace snapshot.",
  requires_capability: "workspace.read",
  schema: {
    type: "object",
    required: ["workspace_id"],
    properties: {
      workspace_id: { type: "string", description: "wks_..." },
      rev: { type: "string", description: "snapshot id; default = head" },
    },
  },
  async invoke(args, ctx) {
    const wsId = need<string>(args, "workspace_id", "string");
    const rev = optional<string>(args, "rev", "string");
    const ws = getWorkspace(wsId);
    if (!ws) throw new Error("workspace not found");
    if (!canRead(ws.id, ctx.agent.id)) throw new Error("not subscribed");
    const effectiveRev = rev ?? ws.head_snapshot_id;
    if (!effectiveRev) throw new Error("workspace has no head snapshot");
    if (rev) {
      const snap = getSnapshot(rev);
      if (!snap || snap.workspace_id !== ws.id) {
        throw new Error("rev not in this workspace");
      }
    }
    const files = listFiles(effectiveRev);
    return {
      workspace_id: ws.id,
      rev: effectiveRev,
      files: files.map((f) => ({
        path: f.path,
        sha: f.content_sha256,
        size: f.size_bytes,
      })),
    };
  },
};

const VALID_STATUSES: TaskStatus[] = [
  "open",
  "assigned",
  "in_progress",
  "awaiting_review",
  "changes_requested",
  "done",
  "cancelled",
];

const taskUpdateStatus: Tool = {
  name: "task.update_status",
  description:
    "Move a task through the state machine. Server still enforces legal transitions.",
  requires_capability: "task.update",
  schema: {
    type: "object",
    required: ["task_id", "to_status"],
    properties: {
      task_id: { type: "string", description: "tsk_..." },
      to_status: {
        type: "string",
        description: "target status",
        enum: VALID_STATUSES,
      },
      comment: { type: "string", description: "optional comment with the transition" },
      result_snapshot_id: {
        type: "string",
        description: "snapshot to bind as result (for done/awaiting_review)",
      },
    },
  },
  async invoke(args, ctx) {
    const taskId = need<string>(args, "task_id", "string");
    const toStatus = need<string>(args, "to_status", "string") as TaskStatus;
    const comment = optional<string>(args, "comment", "string");
    const resultSnap = optional<string>(args, "result_snapshot_id", "string");
    if (!VALID_STATUSES.includes(toStatus)) {
      throw new Error(`invalid to_status: ${toStatus}`);
    }
    const t = getTask(taskId);
    if (!t) throw new Error("task not found");
    if (
      t.owner_agent_id !== ctx.agent.id &&
      t.assigned_to_agent_id !== ctx.agent.id
    ) {
      throw new Error("not owner or assignee");
    }
    const r = await transitionTaskStatus({
      task_id: t.id,
      to_status: toStatus,
      actor_agent_id: ctx.agent.id,
      comment,
      result_snapshot_id: resultSnap ?? null,
    });
    return {
      task: {
        ...r.task,
        required_capabilities: parseRequiredCapabilities(r.task),
        success_criteria: parseSuccessCriteria(r.task),
      },
      criteria_failures: r.criteria_failures ?? null,
    };
  },
};

const agentSendMessage: Tool = {
  name: "agent.send_message",
  description: "Post a message in a conversation the calling agent is a member of.",
  requires_capability: "message.send",
  schema: {
    type: "object",
    required: ["conversation_id", "text"],
    properties: {
      conversation_id: { type: "string", description: "cnv_..." },
      text: { type: "string", description: "message body" },
      thinking: { type: "string", description: "collapsed reasoning, visible to room" },
      kind: {
        type: "string",
        description: "normal | agent_to_agent | system",
        enum: ["normal", "agent_to_agent", "system"],
      },
    },
  },
  async invoke(args, ctx) {
    const convId = need<string>(args, "conversation_id", "string");
    const text = need<string>(args, "text", "string");
    const thinking = optional<string>(args, "thinking", "string");
    const kind = (optional<string>(args, "kind", "string") ?? "agent_to_agent") as
      | "normal"
      | "agent_to_agent"
      | "system";
    if (!listMembers(convId).some((m) => m.agent_id === ctx.agent.id)) {
      throw new Error("not a member of conversation");
    }
    const m = sendMessage(convId, ctx.agent.id, {
      text,
      thinking,
      kind,
    });
    return { id: m.id, created_at: m.created_at };
  },
};

// keep ref to silence unused import (saveAttachment is exported for downstream tools)
void saveAttachment;

// -------------------------------------------------------------------------
// Registry
// -------------------------------------------------------------------------

export const TOOLS: Record<string, Tool> = {
  [workspaceReadFile.name]: workspaceReadFile,
  [workspaceWriteFile.name]: workspaceWriteFile,
  [workspaceListFiles.name]: workspaceListFiles,
  [taskUpdateStatus.name]: taskUpdateStatus,
  [agentSendMessage.name]: agentSendMessage,
};

export function listToolSchemas(): Array<{
  name: string;
  description: string;
  requires_capability: string;
  schema: ToolSchema;
}> {
  return Object.values(TOOLS).map((t) => ({
    name: t.name,
    description: t.description,
    requires_capability: t.requires_capability,
    schema: t.schema,
  }));
}

export function listToolsForAgent(agent: Agent): Array<{
  name: string;
  description: string;
  schema: ToolSchema;
  allowed: boolean;
  requires_capability: string;
}> {
  const have = agentCapabilityNames(agent);
  return Object.values(TOOLS).map((t) => ({
    name: t.name,
    description: t.description,
    schema: t.schema,
    requires_capability: t.requires_capability,
    allowed: have.has(t.requires_capability),
  }));
}

// -------------------------------------------------------------------------
// Invocation
// -------------------------------------------------------------------------

export type InvokeResult =
  | { ok: true; invocation_id: string; result: unknown; duration_ms: number }
  | { ok: false; invocation_id: string; error: string };

export async function invokeTool(
  agentId: string,
  toolName: string,
  args: Record<string, unknown>,
  taskId: string | null,
): Promise<InvokeResult> {
  const agent = getAgent(agentId);
  if (!agent) {
    return { ok: false, invocation_id: "", error: "agent not found" };
  }
  const tool = TOOLS[toolName];
  if (!tool) {
    return { ok: false, invocation_id: "", error: `unknown tool: ${toolName}` };
  }
  const have = agentCapabilityNames(agent);
  if (!have.has(tool.requires_capability)) {
    logAudit("tool.invoke_denied", {
      agentId,
      detail: { tool: toolName, requires: tool.requires_capability },
    });
    return {
      ok: false,
      invocation_id: "",
      error: `agent missing capability "${tool.requires_capability}" — call PUT /api/v1/agents/me/capabilities first.`,
    };
  }

  const id = newToolInvocationId();
  const startedAt = Date.now();
  db()
    .prepare(
      `INSERT INTO tool_invocations
       (id, agent_id, tool_name, args_json, result_json, error,
        duration_ms, task_id, created_at)
       VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`,
    )
    .run(id, agentId, toolName, JSON.stringify(args), taskId ?? null, startedAt);

  try {
    const result = await tool.invoke(args, { agent, taskId });
    const duration = Date.now() - startedAt;
    db()
      .prepare(
        `UPDATE tool_invocations SET result_json = ?, duration_ms = ? WHERE id = ?`,
      )
      .run(JSON.stringify(result), duration, id);
    logAudit("tool.invoke", {
      agentId,
      detail: { tool: toolName, invocation_id: id, duration_ms: duration },
    });
    return { ok: true, invocation_id: id, result, duration_ms: duration };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const duration = Date.now() - startedAt;
    db()
      .prepare(
        `UPDATE tool_invocations SET error = ?, duration_ms = ? WHERE id = ?`,
      )
      .run(msg, duration, id);
    logAudit("tool.invoke_failed", {
      agentId,
      detail: { tool: toolName, invocation_id: id, err: msg },
    });
    return { ok: false, invocation_id: id, error: msg };
  }
}

export function listInvocations(
  agentId: string,
  limit = 50,
): Array<{
  id: string;
  tool_name: string;
  duration_ms: number | null;
  error: string | null;
  task_id: string | null;
  created_at: number;
}> {
  return db()
    .prepare(
      `SELECT id, tool_name, duration_ms, error, task_id, created_at
       FROM tool_invocations WHERE agent_id = ?
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(agentId, limit) as Array<{
    id: string;
    tool_name: string;
    duration_ms: number | null;
    error: string | null;
    task_id: string | null;
    created_at: number;
  }>;
}
