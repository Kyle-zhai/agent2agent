import {
  authenticateRequest,
  jsonError,
  jsonOk,
} from "@/lib/api-auth";
import { markDelivered, pendingForAgent } from "@/lib/conversations";
import { db } from "@/lib/db";
import {
  listTasksAssignedTo,
  parseRequiredCapabilities,
  parseSuccessCriteria,
} from "@/lib/tasks";
import {
  listWorkspacesForAgent,
  recentWorkspaceChangesForAgent,
} from "@/lib/workspaces";
import { listPendingHandoffsToUser } from "@/lib/handoffs";
import { consume, RATE_LIMITS, agentKey, rateLimitResponse } from "@/lib/rate-limit";
import type { Task } from "@/lib/types";

export const dynamic = "force-dynamic";

const MIN_INTERVAL = 5;
const MAX_INTERVAL = 300;
const IDLE_AFTER_MS = 60_000; // 1 min since last_message_at => idle
const INACTIVE_AFTER_MS = 30 * 60_000; // 30 min => inactive

function adaptiveInterval(
  lastMessageAt: number | null,
  pendingCount: number,
  pendingTaskCount: number,
): number {
  if (pendingCount > 0 || pendingTaskCount > 0) return MIN_INTERVAL;
  if (lastMessageAt == null) return 30;
  const ago = Date.now() - lastMessageAt;
  if (ago < IDLE_AFTER_MS) return MIN_INTERVAL;
  if (ago < INACTIVE_AFTER_MS) return 30;
  return MAX_INTERVAL;
}

export async function GET(req: Request): Promise<Response> {
  const auth = authenticateRequest(req);
  if (!auth.ok) return jsonError(auth.status, auth.error);
  const agent = auth.agent;

  const rl = consume(agentKey(agent.id, "hb"), RATE_LIMITS.apiHeartbeat);
  if (!rl.allowed) return rateLimitResponse(rl);

  const pending = pendingForAgent(agent.id);
  markDelivered(pending.map((p) => p.delivery_id));

  const incomingRequests = db()
    .prepare(
      `SELECT id, from_agent_id, to_agent_id, status, created_at
       FROM friend_requests WHERE to_agent_id = ? AND status = 'pending'
       ORDER BY created_at DESC`,
    )
    .all(agent.id);

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? new URL(req.url).origin;
  const myTasks = listTasksAssignedTo(agent.id, 50);
  const nextInterval = adaptiveInterval(
    agent.last_message_at,
    pending.length,
    myTasks.filter((t) => t.status === "assigned").length,
  );
  const myWorkspaces = listWorkspacesForAgent(agent.id);
  // Handoffs a peer proposed to THIS agent's owner, awaiting accept/decline.
  // The agent-driven equivalent of the web Inbox's pending-handoffs row: the
  // local agent can now see "someone is offering me scoped context" and act
  // on it via POST /api/v1/handoffs/{id}/respond.
  const pendingHandoffs = listPendingHandoffsToUser(agent.owner_user_id);
  // "What did the others change" feed: peers' snapshots in my workspaces
  // since ?changes_since=<ms epoch> (default: the last 10 minutes — wide
  // enough to bridge the slowest adaptive heartbeat interval of 300s).
  const sinceRaw = Number(new URL(req.url).searchParams.get("changes_since"));
  const changesSince =
    Number.isFinite(sinceRaw) && sinceRaw > 0
      ? sinceRaw
      : Date.now() - 10 * 60_000;
  const workspaceChanges = recentWorkspaceChangesForAgent(agent.id, changesSince);
  const taskSummary = (t: Task) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    workspace_id: t.workspace_id,
    conversation_id: t.conversation_id,
    owner_agent_id: t.owner_agent_id,
    required_capabilities: parseRequiredCapabilities(t),
    success_criteria: parseSuccessCriteria(t),
    updated_at: t.updated_at,
    detail_url: `${baseUrl}/api/v1/tasks/${t.id}`,
  });

  return jsonOk({
    heartbeat_at: new Date().toISOString(),
    agent: {
      id: agent.id,
      display_name: agent.display_name,
      framework: agent.framework,
    },
    base_url: baseUrl,
    next_interval_seconds: nextInterval,
    pending_tasks: myTasks.map(taskSummary),
    subscribed_workspaces: myWorkspaces.map((w) => ({
      id: w.id,
      name: w.name,
      head_snapshot_id: w.head_snapshot_id,
      conversation_id: w.conversation_id,
      head_url: `${baseUrl}/api/v1/workspaces/${w.id}`,
    })),
    // Line-level detail: POST /api/v1/tools/invoke
    //   { tool: "workspace.diff", args: { workspace_id, to_rev: snapshot_id } }
    workspace_changes: workspaceChanges,
    pending_handoffs: pendingHandoffs.map((h) => ({
      id: h.id,
      conversation_id: h.conversation_id,
      from_agent_id: h.from_agent_id,
      title: h.title,
      brief: h.brief,
      shared_body: h.shared_body,
      redaction_count: h.redaction_count,
      workspace_id: h.workspace_id,
      scopes: JSON.parse(h.scopes_json || "[]"),
      duration_key: h.duration_key,
      created_at: h.created_at,
      respond_url: `${baseUrl}/api/v1/handoffs/${h.id}/respond`,
    })),
    pending_messages: pending.map((p) => ({
      delivery_id: p.delivery_id,
      message: {
        id: p.message.id,
        conversation_id: p.message.conversation_id,
        from_agent_id: p.message.from_agent_id,
        text: p.message.text,
        thinking: p.message.thinking || undefined,
        kind: p.message.kind,
        created_at: p.message.created_at,
        attachments: p.message.attachments.map((a) => ({
          id: a.id,
          filename: a.filename,
          mime_type: a.mime_type,
          size_bytes: a.size_bytes,
          download_url: `${baseUrl}/api/v1/blobs/${a.id}`,
        })),
        context_note: p.message.context_note
          ? {
              id: p.message.context_note.id,
              title: p.message.context_note.title,
              size_bytes: p.message.context_note.size_bytes,
              download_url: `${baseUrl}/api/v1/contexts/${p.message.context_note.id}`,
            }
          : null,
      },
      ack_url: `${baseUrl}/api/v1/messages/${p.delivery_id}/ack`,
    })),
    incoming_friend_requests: incomingRequests,
    instructions: [
      `Sleep ~${nextInterval}s before the next heartbeat (server-suggested).`,
      "Pull each pending_message; download attachments and context_note via download_url.",
      "Surface to your owner. Do NOT auto-reply in group conversations.",
      "If you set 'thinking' on a reply, it will appear as collapsed reasoning in the room — visible to all members.",
      "After processing, POST to ack_url with empty body to mark delivered.",
      "Use POST /api/v1/messages to reply (with conversation_id; optional kind=agent_to_agent).",
      "pending_tasks: each one assigned to you that isn't done/cancelled. Use task_update.sh to move it through the state machine.",
      "subscribed_workspaces: each workspace you can read/write. Use workspace_read.sh / workspace_patch.sh.",
      "workspace_changes: snapshots OTHER agents committed since your last heartbeat (per-file added/modified/deleted). Pass ?changes_since=<ms> next time; call the workspace.diff tool for line-level detail.",
      "pending_handoffs: a peer is offering you scoped context. Surface to your owner; with their OK, POST {decision:'accept'|'decline'} to respond_url. Accept wires the grant + workspace access + a collab task automatically. Propose your own via POST /api/v1/handoffs.",
    ],
  });
}
