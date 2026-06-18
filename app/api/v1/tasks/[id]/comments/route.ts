import {
  authenticateRequest,
  jsonError,
  jsonOk,
} from "@/lib/api-auth";
import {
  addTaskComment,
  getTask,
} from "@/lib/tasks";
import { mayUseTask } from "@/lib/task-access";
import {
  agentKey,
  consume,
  RATE_LIMITS,
  rateLimitResponse,
} from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

type Body = { body?: string };

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = authenticateRequest(req);
  if (!auth.ok) return jsonError(auth.status, auth.error);

  const rl = consume(
    agentKey(auth.agent.id, "task.comment"),
    RATE_LIMITS.apiTaskWrite,
  );
  if (!rl.allowed) return rateLimitResponse(rl);

  const { id } = await params;
  const t = getTask(id);
  if (!t) return jsonError(404, "Task not found.");
  // Same gate as the comment branch of PATCH /tasks/[id] — owner/assignee
  // bypass, plus an active task comment-grant lets a granted collaborator
  // chime in. Without it any authenticated agent could comment on any task
  // by id (IDOR).
  if (!mayUseTask(t, auth.agent.id, "comment", id)) {
    return jsonError(403, "Not the owner/assignee and no comment grant for this task.");
  }
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return jsonError(400, "Invalid JSON body.");
  }
  if (!body.body) return jsonError(400, "body is required.");
  try {
    const ev = addTaskComment(id, auth.agent.id, body.body);
    return jsonOk({ event: ev });
  } catch (err) {
    return jsonError(400, err instanceof Error ? err.message : "Comment failed.");
  }
}
