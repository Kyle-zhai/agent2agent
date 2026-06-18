import { NextRequest } from "next/server";
import { authenticateRequest, jsonError } from "@/lib/api-auth";
import { getAgent } from "@/lib/agents";
import { logAudit } from "@/lib/audit";
import { listMessages } from "@/lib/conversations";
import { getTask } from "@/lib/tasks";
import {
  RATE_LIMITS,
  agentKey,
  consume,
  rateLimitResponse,
} from "@/lib/rate-limit";
import {
  A2A_METHODS,
  A2AInvalidParamsError,
  buildAgentCard,
  buildExtendedAgentCard,
  canAccessTask,
  canManageTask,
  deletePushConfig,
  firePushForTask,
  getPushConfig,
  handleCancelTask,
  handleGetTask,
  handleSendMessage,
  listPushConfigs,
  listTasksPageV1,
  messageToV1,
  parseHistoryLength,
  projectTask,
  projectTaskV1,
  resolveMethod,
  rpcError,
  rpcOk,
  setPushConfig,
  taskStateToV1,
  type A2ADialect,
  type A2ATask,
  type A2ATaskState,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type SendMessageParams,
} from "@/lib/a2a";

export const dynamic = "force-dynamic";

// A2A JSON-RPC 2.0 bridge — per the v0.3.0 spec at https://a2a-protocol.org.
// The agent at [id] is the target (receiver). The caller authenticates with
// Bearer <api_key> using their OWN agent's key — that's how we know the
// "from" side. Both must be members of the conversation passed as
// message.contextId (enforced in handleSendMessage).
//
// Methods: message/send, message/stream (SSE), tasks/get, tasks/cancel,
// tasks/resubscribe (SSE), tasks/pushNotificationConfig/{set,get,list,delete},
// agent/getAuthenticatedExtendedCard. Unknown methods → JSON-RPC -32601.

function originOf(req: NextRequest): string {
  return process.env.NEXT_PUBLIC_APP_URL ?? new URL(req.url).origin;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  // GET on /a2a returns the public AgentCard, matching inspectors that probe
  // the rpc URL directly.
  const { id } = await params;
  const agent = getAgent(id);
  if (!agent) return jsonError(404, "agent not found");
  return new Response(JSON.stringify(buildAgentCard(agent, originOf(req)), null, 2), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id: targetId } = await params;
  const target = getAgent(targetId);
  if (!target) return jsonError(404, "agent not found");

  const auth = authenticateRequest(req);
  if (!auth.ok) return jsonError(auth.status, auth.error);
  const caller = auth.agent;

  // Per-key rate limit: the send path writes rows + fans out auto-replies.
  const rl = consume(agentKey(caller.id, "a2a"), RATE_LIMITS.apiMessage);
  if (!rl.allowed) return rateLimitResponse(rl);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonRpc({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return jsonRpc(
      rpcError(null, -32600, "Invalid Request (batch not yet supported)"),
    );
  }
  const rpc = body as JsonRpcRequest;
  if (rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") {
    return jsonRpc(rpcError(rpc.id ?? null, -32600, "Invalid Request"));
  }

  // v1.0 PascalCase methods alias onto the same handlers; responses are
  // projected per dialect (v0.3 lowercase vs v1.0 ProtoJSON shapes).
  const { canonical, dialect } = resolveMethod(rpc.method);

  logAudit("a2a.rpc", {
    agentId: caller.id,
    detail: { target: target.id, method: rpc.method },
  });

  // Project a v0.3 A2ATask result into the response dialect. For v1.0 we
  // re-read the raw task (createdAt/lastModified) and carry over the
  // already-built history/artifacts.
  const taskForDialect = (t03: A2ATask): unknown => {
    if (dialect === "v0.3") return t03;
    const raw = getTask(t03.id);
    if (!raw) return t03;
    const v1 = projectTaskV1(raw, t03.history);
    v1.artifacts = t03.artifacts;
    return v1;
  };

  try {
    switch (canonical) {
      case A2A_METHODS.SEND_MESSAGE: {
        const result = handleSendMessage(
          caller,
          target,
          (rpc.params ?? {}) as SendMessageParams,
        );
        // Best-effort push fan-out for the freshly-opened task.
        void firePushForTask(result.task.id);
        return jsonRpc(rpcOk(rpc.id, taskForDialect(result.task)));
      }

      case A2A_METHODS.STREAM_MESSAGE: {
        const result = handleSendMessage(
          caller,
          target,
          (rpc.params ?? {}) as SendMessageParams,
        );
        void firePushForTask(result.task.id);
        return streamTask(req, rpc.id, result.task.id, target.id, dialect);
      }

      case A2A_METHODS.GET_TASK: {
        const p = (rpc.params ?? {}) as {
          id?: string;
          taskId?: string;
          historyLength?: unknown;
        };
        const taskId = p.id ?? p.taskId;
        if (!taskId) {
          return jsonRpc(rpcError(rpc.id, -32602, "params.id required"));
        }
        // historyLength (a2a-tck's most-missed param): trim history to the
        // most recent N entries. Invalid values throw → -32602 below. Both
        // dialects share this — taskForDialect carries history into v1.0.
        const historyLength = parseHistoryLength(p.historyLength);
        return jsonRpc(
          rpcOk(
            rpc.id,
            taskForDialect(handleGetTask(taskId, caller.id, historyLength)),
          ),
        );
      }

      case A2A_METHODS.LIST_TASKS: {
        // v1.0-only method (ListTasks): cursor-paginated tasks for the caller.
        const p = (rpc.params ?? {}) as { pageSize?: unknown; cursor?: unknown };
        return jsonRpc(rpcOk(rpc.id, listTasksPageV1(caller.id, p)));
      }

      case A2A_METHODS.CANCEL_TASK: {
        const p = (rpc.params ?? {}) as { id?: string; taskId?: string };
        const taskId = p.id ?? p.taskId;
        if (!taskId) {
          return jsonRpc(rpcError(rpc.id, -32602, "params.id required"));
        }
        const task = await handleCancelTask(caller.id, taskId);
        void firePushForTask(taskId);
        return jsonRpc(rpcOk(rpc.id, taskForDialect(task)));
      }

      case A2A_METHODS.RESUBSCRIBE: {
        const p = (rpc.params ?? {}) as { id?: string; taskId?: string };
        const taskId = p.id ?? p.taskId;
        if (!taskId) {
          return jsonRpc(rpcError(rpc.id, -32602, "params.id required"));
        }
        const t = getTask(taskId);
        // Same "not found" for missing AND unauthorized — never stream a
        // conversation the caller isn't party to (IDOR / message-leak).
        if (!t || !canAccessTask(t, caller.id)) {
          return jsonRpc(rpcError(rpc.id, -32001, "task not found"));
        }
        return streamTask(req, rpc.id, taskId, target.id, dialect);
      }

      case A2A_METHODS.PUSH_SET: {
        const p = (rpc.params ?? {}) as {
          taskId?: string;
          pushNotificationConfig?: { id?: string; url?: string; token?: string };
        };
        const cfg = p.pushNotificationConfig;
        if (!p.taskId || !cfg?.url) {
          return jsonRpc(
            rpcError(rpc.id, -32602, "taskId and pushNotificationConfig.url required"),
          );
        }
        const saved = setPushConfig({
          task_id: p.taskId,
          registering_agent_id: caller.id,
          url: cfg.url,
          token: cfg.token,
          config_id: cfg.id,
        });
        return jsonRpc(
          rpcOk(rpc.id, {
            taskId: saved.taskId,
            pushNotificationConfig: {
              id: saved.id,
              url: saved.url,
              token: saved.token,
            },
          }),
        );
      }

      case A2A_METHODS.PUSH_GET: {
        const p = (rpc.params ?? {}) as { taskId?: string; pushNotificationConfigId?: string };
        if (!p.taskId || !p.pushNotificationConfigId) {
          return jsonRpc(
            rpcError(rpc.id, -32602, "taskId and pushNotificationConfigId required"),
          );
        }
        const pgTask = getTask(p.taskId);
        if (!pgTask || !canManageTask(pgTask, caller.id)) {
          return jsonRpc(rpcError(rpc.id, -32001, "config not found"));
        }
        const cfg = getPushConfig(p.taskId, p.pushNotificationConfigId);
        if (!cfg) return jsonRpc(rpcError(rpc.id, -32001, "config not found"));
        // Do NOT echo the secret token back — the registrant already has it,
        // and returning it widens the disclosure surface.
        return jsonRpc(
          rpcOk(rpc.id, {
            taskId: cfg.taskId,
            pushNotificationConfig: { id: cfg.id, url: cfg.url },
          }),
        );
      }

      case A2A_METHODS.PUSH_LIST: {
        const p = (rpc.params ?? {}) as { taskId?: string; id?: string };
        const taskId = p.taskId ?? p.id;
        if (!taskId) return jsonRpc(rpcError(rpc.id, -32602, "taskId required"));
        const plTask = getTask(taskId);
        if (!plTask || !canManageTask(plTask, caller.id)) {
          return jsonRpc(rpcError(rpc.id, -32001, "task not found"));
        }
        return jsonRpc(
          rpcOk(
            rpc.id,
            listPushConfigs(taskId).map((c) => ({
              taskId: c.taskId,
              pushNotificationConfig: { id: c.id, url: c.url },
            })),
          ),
        );
      }

      case A2A_METHODS.PUSH_DELETE: {
        const p = (rpc.params ?? {}) as { taskId?: string; pushNotificationConfigId?: string };
        if (!p.taskId || !p.pushNotificationConfigId) {
          return jsonRpc(
            rpcError(rpc.id, -32602, "taskId and pushNotificationConfigId required"),
          );
        }
        const pdTask = getTask(p.taskId);
        if (!pdTask || !canManageTask(pdTask, caller.id)) {
          return jsonRpc(rpcError(rpc.id, -32001, "config not found"));
        }
        deletePushConfig(p.taskId, p.pushNotificationConfigId);
        return jsonRpc(rpcOk(rpc.id, null));
      }

      case A2A_METHODS.GET_EXTENDED_CARD: {
        // The caller is already authenticated above, so we may reveal the
        // extended card (extra non-anonymous skills like scoped handoffs).
        return jsonRpc(rpcOk(rpc.id, buildExtendedAgentCard(target, originOf(req))));
      }

      default:
        return jsonRpc(
          rpcError(rpc.id, -32601, `Method "${rpc.method}" not found`),
        );
    }
  } catch (err) {
    // Caller-input errors (size caps, malformed historyLength, missing
    // message) are -32602 Invalid params; everything else is -32603.
    if (err instanceof A2AInvalidParamsError) {
      return jsonRpc(rpcError(rpc.id, -32602, err.message));
    }
    const msg = err instanceof Error ? err.message : "internal error";
    return jsonRpc(rpcError(rpc.id, -32603, msg));
  }
}

// JSON-RPC responses from this endpoint use the IANA-registered A2A media
// type (registered in spec v1.0.1, CHANGELOG #1753). Requests may send
// either application/json or application/a2a+json — req.json() never
// dispatches on the content-type header, so both parse identically. Only
// JSON-RPC envelopes get this type: SSE streams stay text/event-stream and
// REST-style errors (auth/404/rate-limit) stay application/json.
function jsonRpc(payload: JsonRpcResponse): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/a2a+json" },
  });
}

// ---------------------------------------------------------------------------
// SSE streaming for message/stream + tasks/resubscribe. Each SSE `data:` is a
// JSON-RPC response object whose `result` is an A2A streaming event: first the
// Task snapshot, then Message events for each new reply from the target agent,
// then a final TaskStatusUpdateEvent on terminal state or timeout.
//
// Dialects: v0.3 frames are kind-discriminated and the closing status-update
// carries final:true. v1.0 frames are member-wrapped ({task} / {message} /
// {taskStatusUpdate}) with no final flag — stream closure signals the end.
// ---------------------------------------------------------------------------

const STREAM_MAX_MS = 60_000;
const POLL_MS = 1500;
const TERMINAL: A2ATaskState[] = ["completed", "canceled", "failed", "rejected"];

function streamTask(
  req: NextRequest,
  rpcId: string | number | null,
  taskId: string,
  targetAgentId: string,
  dialect: A2ADialect,
): Response {
  const task = getTask(taskId);
  if (!task) return jsonRpc(rpcError(rpcId, -32001, "task not found"));
  const conversationId = task.conversation_id;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const startedAt = Date.now();
      let closed = false;
      const seen = new Set<string>();
      let tick: NodeJS.Timeout | null = null;

      const close = () => {
        if (closed) return;
        closed = true;
        if (tick) clearInterval(tick);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      req.signal.addEventListener("abort", close);

      const emit = (result: unknown) => {
        if (closed) return;
        const frame = `data: ${JSON.stringify({ jsonrpc: "2.0", id: rpcId, result })}\n\n`;
        try {
          controller.enqueue(encoder.encode(frame));
        } catch {
          close();
        }
      };

      // 1. Initial Task snapshot.
      const t0 = getTask(taskId);
      if (t0) {
        emit(dialect === "v1.0" ? { task: projectTaskV1(t0) } : projectTask(t0));
      }

      // Seed seen-set with existing messages so we only stream NEW replies.
      if (conversationId) {
        for (const m of listMessages(conversationId, { limit: 100 })) {
          seen.add(m.id);
        }
      }

      tick = setInterval(() => {
        if (closed) return;
        try {
          // New replies from the target agent → Message events.
          if (conversationId) {
            const msgs = listMessages(conversationId, { limit: 100 });
            for (const m of msgs) {
              if (seen.has(m.id)) continue;
              seen.add(m.id);
              if (m.from_agent_id !== targetAgentId) continue;
              if (m.deleted_at) continue;
              const msg03 = {
                kind: "message" as const,
                messageId: m.id,
                role: "agent" as const,
                parts: [{ kind: "text" as const, text: m.text }],
                contextId: conversationId,
                taskId,
              };
              emit(dialect === "v1.0" ? { message: messageToV1(msg03) } : msg03);
            }
          }
          const t = getTask(taskId);
          const state = t ? projectTask(t).status.state : "unknown";
          const timedOut = Date.now() - startedAt > STREAM_MAX_MS;
          if ((t && TERMINAL.includes(state)) || timedOut) {
            const timestamp = new Date().toISOString();
            emit(
              dialect === "v1.0"
                ? {
                    taskStatusUpdate: {
                      taskId,
                      contextId: conversationId,
                      status: { state: taskStateToV1(state), timestamp },
                    },
                  }
                : {
                    taskId,
                    contextId: conversationId,
                    kind: "status-update",
                    status: { state, timestamp },
                    final: true,
                  },
            );
            close();
          }
        } catch {
          close();
        }
      }, POLL_MS);
    },
    cancel() {
      /* abort handler also closes */
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
