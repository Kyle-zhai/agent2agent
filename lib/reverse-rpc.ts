import "server-only";
import { db } from "./db";
import { newRpcCallId } from "./ids";
import { logAudit } from "./audit";
import { agentCapabilityNames, getAgent } from "./agents";
import { areFriends } from "./friends";
import type { Agent } from "./types";

// -------------------------------------------------------------------------
// Types
// -------------------------------------------------------------------------

export type RpcCallStatus =
  | "pending"
  | "completed"
  | "failed"
  | "timeout"
  | "cancelled";

export type RpcCall = {
  id: string;
  caller_agent_id: string;
  target_agent_id: string;
  tool_name: string;
  args_json: string;
  status: RpcCallStatus;
  result_json: string | null;
  error: string | null;
  task_id: string | null;
  created_at: number;
  delivered_at: number | null;
  finished_at: number | null;
};

export type RpcResolution =
  | { ok: true; result: unknown; duration_ms: number }
  | { ok: false; reason: string; status: RpcCallStatus };

// -------------------------------------------------------------------------
// In-process deferred map — single Node process model.
// Migrating to multi-instance requires turning this into a poll-based wait
// (caller polls `tool_call_requests` until status != 'pending').
// -------------------------------------------------------------------------

type Pending = {
  resolve: (r: RpcResolution) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
};

const pendingCalls = new Map<string, Pending>();
export const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 5 * 60_000;

// -------------------------------------------------------------------------
// Host discovery
// -------------------------------------------------------------------------

/** Returns agents declaring `mcp.host` capability with the given tool name. */
export function findHostsForTool(toolName: string): Agent[] {
  const rows = db()
    .prepare(
      `SELECT id FROM agents WHERE capabilities LIKE ?`,
    )
    .all(`%"mcp.host"%`) as Array<{ id: string }>;
  const out: Agent[] = [];
  for (const r of rows) {
    const a = getAgent(r.id);
    if (!a) continue;
    const caps = JSON.parse(a.capabilities) as Array<Record<string, unknown>>;
    const host = caps.find((c) => c.name === "mcp.host");
    if (!host) continue;
    const tools = Array.isArray(host.tools) ? (host.tools as string[]) : [];
    if (tools.includes(toolName)) out.push(a);
  }
  return out;
}

/** Authorization: the caller can route to host iff they're friends or
 *  the host is the caller itself (rare but legal). */
function canRouteTo(caller: Agent, host: Agent): boolean {
  if (caller.id === host.id) return true;
  return areFriends(caller.id, host.id);
}

// -------------------------------------------------------------------------
// Initiate a call
// -------------------------------------------------------------------------

export type DispatchInput = {
  caller_agent_id: string;
  tool_name: string;
  args: Record<string, unknown>;
  task_id?: string | null;
  timeout_ms?: number;
};

/** Server-side entry: create the request row, pick a host, wait for the
 *  agent to POST back its result. Promise resolves with the final outcome. */
export async function dispatchToolCall(input: DispatchInput): Promise<RpcResolution> {
  const caller = getAgent(input.caller_agent_id);
  if (!caller) {
    return { ok: false, reason: "caller not found", status: "failed" };
  }
  const hosts = findHostsForTool(input.tool_name);
  if (hosts.length === 0) {
    return {
      ok: false,
      reason: `no agent hosts tool "${input.tool_name}"`,
      status: "failed",
    };
  }
  const reachable = hosts.filter((h) => canRouteTo(caller, h));
  if (reachable.length === 0) {
    return {
      ok: false,
      reason: `none of the ${hosts.length} hosts of "${input.tool_name}" are reachable from caller`,
      status: "failed",
    };
  }
  // Pick the first reachable host. v0.13 could load-balance / pick by latency.
  const target = reachable[0];

  const id = newRpcCallId();
  const now = Date.now();
  db()
    .prepare(
      `INSERT INTO tool_call_requests
       (id, caller_agent_id, target_agent_id, tool_name, args_json,
        status, result_json, error, task_id, created_at, delivered_at, finished_at)
       VALUES (?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?, NULL, NULL)`,
    )
    .run(
      id,
      caller.id,
      target.id,
      input.tool_name,
      JSON.stringify(input.args),
      input.task_id ?? null,
      now,
    );

  logAudit("rpc.dispatch", {
    agentId: caller.id,
    detail: {
      rpc_id: id,
      tool: input.tool_name,
      target: target.id,
      task_id: input.task_id ?? null,
    },
  });

  const timeoutMs = Math.min(
    MAX_TIMEOUT_MS,
    Math.max(1000, input.timeout_ms ?? DEFAULT_TIMEOUT_MS),
  );
  return new Promise<RpcResolution>((resolve) => {
    const timeoutHandle = setTimeout(() => {
      pendingCalls.delete(id);
      const row = db()
        .prepare("SELECT status FROM tool_call_requests WHERE id = ?")
        .get(id) as { status: RpcCallStatus } | undefined;
      // If the call is still pending, mark as timeout. If something else
      // resolved it concurrently, leave the recorded outcome alone.
      if (row?.status === "pending") {
        db()
          .prepare(
            `UPDATE tool_call_requests
             SET status = 'timeout', error = ?, finished_at = ?
             WHERE id = ? AND status = 'pending'`,
          )
          .run(`no result within ${timeoutMs}ms`, Date.now(), id);
        logAudit("rpc.timeout", {
          agentId: caller.id,
          detail: { rpc_id: id, target: target.id },
        });
      }
      resolve({
        ok: false,
        reason: `tool call timed out after ${timeoutMs}ms`,
        status: "timeout",
      });
    }, timeoutMs);

    pendingCalls.set(id, { resolve, timeoutHandle });
  });
}

// -------------------------------------------------------------------------
// Agent posts back
// -------------------------------------------------------------------------

export type ReportInput = {
  rpc_id: string;
  reporter_agent_id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
};

export function reportToolResult(input: ReportInput): {
  ok: boolean;
  status: RpcCallStatus;
} {
  const row = db()
    .prepare(
      `SELECT id, caller_agent_id, target_agent_id, status
       FROM tool_call_requests WHERE id = ?`,
    )
    .get(input.rpc_id) as
    | { id: string; caller_agent_id: string; target_agent_id: string; status: RpcCallStatus }
    | undefined;
  if (!row) throw new Error("rpc id not found");
  if (row.target_agent_id !== input.reporter_agent_id) {
    throw new Error("reporter is not the target of this rpc");
  }
  if (row.status !== "pending") {
    return { ok: false, status: row.status };
  }
  const now = Date.now();
  if (input.ok) {
    const info = db()
      .prepare(
        `UPDATE tool_call_requests SET status = 'completed', result_json = ?,
                                       finished_at = ? WHERE id = ? AND status = 'pending'`,
      )
      .run(JSON.stringify(input.result ?? null), now, input.rpc_id);
    // Race: timeout / cancel could have moved the row out of 'pending'
    // between our SELECT above and this UPDATE. info.changes === 0 means
    // we're too late — surface the actual final status without writing a
    // false rpc.completed audit and without resolving any (already-gone)
    // pending Promise.
    if (info.changes === 0) {
      const cur = (
        db()
          .prepare("SELECT status FROM tool_call_requests WHERE id = ?")
          .get(input.rpc_id) as { status: RpcCallStatus } | undefined
      )?.status ?? "pending";
      return { ok: false, status: cur };
    }
    logAudit("rpc.completed", {
      agentId: input.reporter_agent_id,
      detail: { rpc_id: input.rpc_id, caller: row.caller_agent_id },
    });
    const pending = pendingCalls.get(input.rpc_id);
    if (pending) {
      clearTimeout(pending.timeoutHandle);
      pendingCalls.delete(input.rpc_id);
      const created = (
        db()
          .prepare("SELECT created_at FROM tool_call_requests WHERE id = ?")
          .get(input.rpc_id) as { created_at: number }
      ).created_at;
      pending.resolve({
        ok: true,
        result: input.result ?? null,
        duration_ms: now - created,
      });
    }
    return { ok: true, status: "completed" };
  }
  const info = db()
    .prepare(
      `UPDATE tool_call_requests SET status = 'failed', error = ?,
                                     finished_at = ? WHERE id = ? AND status = 'pending'`,
    )
    .run((input.error ?? "agent error").slice(0, 4000), now, input.rpc_id);
  if (info.changes === 0) {
    const cur = (
      db()
        .prepare("SELECT status FROM tool_call_requests WHERE id = ?")
        .get(input.rpc_id) as { status: RpcCallStatus } | undefined
    )?.status ?? "pending";
    return { ok: false, status: cur };
  }
  logAudit("rpc.failed", {
    agentId: input.reporter_agent_id,
    detail: { rpc_id: input.rpc_id, err: input.error },
  });
  const pending = pendingCalls.get(input.rpc_id);
  if (pending) {
    clearTimeout(pending.timeoutHandle);
    pendingCalls.delete(input.rpc_id);
    pending.resolve({
      ok: false,
      reason: input.error ?? "agent error",
      status: "failed",
    });
  }
  return { ok: true, status: "failed" };
}

// -------------------------------------------------------------------------
// Query helpers (for SSE / polling streams)
// -------------------------------------------------------------------------

/** Pending calls the agent must execute, oldest first. */
export function listPendingForAgent(agentId: string, limit = 20): RpcCall[] {
  return db()
    .prepare(
      `SELECT id, caller_agent_id, target_agent_id, tool_name, args_json,
              status, result_json, error, task_id,
              created_at, delivered_at, finished_at
       FROM tool_call_requests
       WHERE target_agent_id = ? AND status = 'pending'
       ORDER BY created_at ASC LIMIT ?`,
    )
    .all(agentId, limit) as RpcCall[];
}

/** Mark a batch as delivered. SSE/heartbeat calls this so the agent can
 *  see "you've seen this one" stamps without affecting status. */
export function markCallsDelivered(ids: string[]): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(",");
  const now = Date.now();
  db()
    .prepare(
      `UPDATE tool_call_requests
       SET delivered_at = ?
       WHERE delivered_at IS NULL AND id IN (${placeholders})`,
    )
    .run(now, ...ids);
}

export function getCall(id: string): RpcCall | null {
  return (
    (db()
      .prepare(
        `SELECT id, caller_agent_id, target_agent_id, tool_name, args_json,
                status, result_json, error, task_id,
                created_at, delivered_at, finished_at
         FROM tool_call_requests WHERE id = ?`,
      )
      .get(id) as RpcCall | undefined) ?? null
  );
}

/** Caller-side: cancel an outstanding RPC the caller initiated. */
export function cancelCall(id: string, callerAgentId: string): void {
  const row = getCall(id);
  if (!row) throw new Error("rpc id not found");
  if (row.caller_agent_id !== callerAgentId) {
    throw new Error("not the caller of this rpc");
  }
  if (row.status !== "pending") return;
  db()
    .prepare(
      `UPDATE tool_call_requests SET status = 'cancelled',
                                     finished_at = ?
       WHERE id = ? AND status = 'pending'`,
    )
    .run(Date.now(), id);
  logAudit("rpc.cancelled", {
    agentId: callerAgentId,
    detail: { rpc_id: id },
  });
  const pending = pendingCalls.get(id);
  if (pending) {
    clearTimeout(pending.timeoutHandle);
    pendingCalls.delete(id);
    pending.resolve({ ok: false, reason: "cancelled", status: "cancelled" });
  }
}

/** Test-only: resolve any orphaned pending Promises (after timeout map clear)
 *  so the test process can exit cleanly. */
export function _drainPendingForTests(): number {
  let n = 0;
  for (const [, p] of pendingCalls) {
    clearTimeout(p.timeoutHandle);
    p.resolve({
      ok: false,
      reason: "test drain",
      status: "cancelled",
    });
    n++;
  }
  pendingCalls.clear();
  return n;
}
