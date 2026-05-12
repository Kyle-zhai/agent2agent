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
import {
  agentKey,
  consume,
  RATE_LIMITS,
  rateLimitResponse,
} from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const auth = authenticateRequest(req);
  if (!auth.ok) return jsonError(auth.status, auth.error);

  const rl = consume(agentKey(auth.agent.id, "task.list"), RATE_LIMITS.apiGeneric);
  if (!rl.allowed) return rateLimitResponse(rl);

  const url = new URL(req.url);
  const conv = url.searchParams.get("conversation_id");
  const scope = url.searchParams.get("scope") ?? "assigned"; // assigned|owned|conversation

  let tasks;
  if (conv) {
    if (!listMembers(conv).some((m) => m.agent_id === auth.agent.id)) {
      return jsonError(403, "Not a member of conversation.");
    }
    tasks = listTasksForConversation(conv);
  } else if (scope === "owned") {
    tasks = listTasksOwnedBy(auth.agent.id);
  } else {
    tasks = listTasksAssignedTo(auth.agent.id);
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
