import {
  authenticateRequest,
  jsonError,
  jsonOk,
} from "@/lib/api-auth";
import { listMembers } from "@/lib/conversations";
import {
  createTask,
  listTasksAssignedTo,
  listTasksForConversation,
  listTasksOwnedBy,
  parseRequiredCapabilities,
  parseSuccessCriteria,
} from "@/lib/tasks";
import { canRead, getWorkspace } from "@/lib/workspaces";
import { agentMayUseResource } from "@/lib/grants";
import {
  agentKey,
  consume,
  RATE_LIMITS,
  rateLimitResponse,
} from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/** Parse ?limit= and clamp to [1, 200]; non-numeric falls back to the
 *  default. Same unconditional cap as GET /api/v1/conversations — list
 *  endpoints must never return unbounded result sets. */
function clampLimit(url: URL, fallback: number): number {
  const raw = url.searchParams.get("limit");
  if (raw === null) return fallback;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(200, Math.max(1, n));
}

export async function GET(req: Request): Promise<Response> {
  const auth = authenticateRequest(req);
  if (!auth.ok) return jsonError(auth.status, auth.error);

  const rl = consume(agentKey(auth.agent.id, "task.list"), RATE_LIMITS.apiGeneric);
  if (!rl.allowed) return rateLimitResponse(rl);

  const url = new URL(req.url);
  const conv = url.searchParams.get("conversation_id");
  const scope = url.searchParams.get("scope") ?? "assigned"; // assigned|owned|conversation
  // Default mirrors the listing helpers' historical 100; ?limit= can raise
  // it to at most 200.
  const limit = clampLimit(url, 100);

  let tasks;
  if (conv) {
    if (!listMembers(conv).some((m) => m.agent_id === auth.agent.id)) {
      return jsonError(403, "Not a member of conversation.");
    }
    tasks = listTasksForConversation(conv, limit);
  } else if (scope === "owned") {
    tasks = listTasksOwnedBy(auth.agent.id, limit);
  } else {
    tasks = listTasksAssignedTo(auth.agent.id, limit);
  }
  return jsonOk({
    tasks: tasks.map((t) => ({
      ...t,
      required_capabilities: parseRequiredCapabilities(t),
      success_criteria: parseSuccessCriteria(t),
    })),
  });
}

type CreateBody = {
  title?: string;
  description?: string;
  conversation_id?: string | null;
  workspace_id?: string | null;
  assigned_to_agent_id?: string | null;
  parent_task_id?: string | null;
  required_capabilities?: string[];
  success_criteria?: unknown;
};

export async function POST(req: Request): Promise<Response> {
  const auth = authenticateRequest(req);
  if (!auth.ok) return jsonError(auth.status, auth.error);

  const rl = consume(
    agentKey(auth.agent.id, "task.write"),
    RATE_LIMITS.apiTaskWrite,
  );
  if (!rl.allowed) return rateLimitResponse(rl);

  let body: CreateBody;
  try {
    body = (await req.json()) as CreateBody;
  } catch {
    return jsonError(400, "Invalid JSON body.");
  }
  if (!body.title) return jsonError(400, "title is required.");
  if (body.conversation_id) {
    if (!listMembers(body.conversation_id).some((m) => m.agent_id === auth.agent.id)) {
      return jsonError(403, "Not a member of conversation.");
    }
  }
  // Keep task creation inside the collaboration boundary. createTask validates
  // existence + capability matches; these checks bind the task's resources to
  // the creator's authority so an agent can't attach a foreign workspace or
  // assign work to someone outside the conversation.
  if (body.workspace_id) {
    const ws = getWorkspace(body.workspace_id);
    if (!ws) return jsonError(400, "workspace_id not found.");
    // (a) A conversation-bound workspace can't be wired to a different
    // conversation's task.
    if (ws.conversation_id && body.conversation_id && ws.conversation_id !== body.conversation_id) {
      return jsonError(400, "workspace belongs to a different conversation.");
    }
    // (b) The creator must actually have access to that workspace —
    // subscription OR an active read grant.
    const mayUseWorkspace =
      canRead(ws.id, auth.agent.id) ||
      agentMayUseResource({
        using_agent_id: auth.agent.id,
        resource_type: "workspace",
        resource_id: ws.id,
        required_scope: "read",
      });
    if (!mayUseWorkspace) return jsonError(403, "no access to that workspace.");
  }
  // (c) Assignment must stay inside a collaboration boundary. Assigning work
  // requires a conversation, and the assignee must be a member of it —
  // otherwise an agent could push a task onto ANY agent in the system by
  // omitting conversation_id (the membership check below was previously
  // skipped when conversation_id was absent).
  if (body.assigned_to_agent_id) {
    if (!body.conversation_id) {
      return jsonError(400, "Assigning a task requires a conversation_id.");
    }
    if (
      !listMembers(body.conversation_id).some(
        (m) => m.agent_id === body.assigned_to_agent_id,
      )
    ) {
      return jsonError(400, "assignee is not a member of this conversation.");
    }
  }
  try {
    const t = createTask({
      title: body.title,
      description: body.description,
      owner_agent_id: auth.agent.id,
      assigned_to_agent_id: body.assigned_to_agent_id ?? null,
      conversation_id: body.conversation_id ?? null,
      workspace_id: body.workspace_id ?? null,
      parent_task_id: body.parent_task_id ?? null,
      required_capabilities: body.required_capabilities,
      success_criteria: body.success_criteria,
    });
    return jsonOk(
      {
        task: {
          ...t,
          required_capabilities: parseRequiredCapabilities(t),
          success_criteria: parseSuccessCriteria(t),
        },
      },
      201,
    );
  } catch (err) {
    return jsonError(400, err instanceof Error ? err.message : "Create failed.");
  }
}
