import {
  authenticateRequest,
  authenticateWithCapability,
  capabilityAuthorizes,
  jsonError,
  jsonOk,
} from "@/lib/api-auth";
import {
  approveTask,
  assignTask,
  getTask,
  listTaskArtifacts,
  listTaskEvents,
  parseRequiredCapabilities,
  parseSuccessCriteria,
  requestChanges,
  transitionTaskStatus,
} from "@/lib/tasks";
import {
  agentKey,
  consume,
  RATE_LIMITS,
  rateLimitResponse,
} from "@/lib/rate-limit";
import { mayUseTask } from "@/lib/task-access";
import type { TaskStatus } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = authenticateWithCapability(req);
  if (!auth.ok) return jsonError(auth.status, auth.error);

  const rl = consume(agentKey(auth.agent.id, "task.read"), RATE_LIMITS.apiGeneric);
  if (!rl.allowed) return rateLimitResponse(rl);

  const { id } = await params;
  const t = getTask(id);
  if (!t) return jsonError(404, "Task not found.");
  const authorized = auth.capability
    ? capabilityAuthorizes(auth, "task", id, "read")
    : mayUseTask(t, auth.agent.id, "read", id);
  if (!authorized) {
    return jsonError(403, "Not the owner/assignee and no read grant for this task.");
  }
  return jsonOk({
    task: {
      ...t,
      required_capabilities: parseRequiredCapabilities(t),
      success_criteria: parseSuccessCriteria(t),
    },
    events: listTaskEvents(t.id),
    artifacts: listTaskArtifacts(t.id),
  });
}

type PatchBody = {
  status?: TaskStatus;
  assigned_to_agent_id?: string | null;
  comment?: string;
  result_snapshot_id?: string | null;
  action?: "approve" | "request_changes";
};

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = authenticateRequest(req);
  if (!auth.ok) return jsonError(auth.status, auth.error);

  const rl = consume(
    agentKey(auth.agent.id, "task.write"),
    RATE_LIMITS.apiTaskWrite,
  );
  if (!rl.allowed) return rateLimitResponse(rl);

  const { id } = await params;
  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return jsonError(400, "Invalid JSON body.");
  }
  const t = getTask(id);
  if (!t) return jsonError(404, "Task not found.");

  try {
    if (body.action === "approve") {
      approveTask(id, auth.agent.id);
      return jsonOk({ ok: true, action: "approve" });
    }
    if (body.action === "request_changes") {
      if (!body.comment) {
        return jsonError(400, "request_changes requires comment.");
      }
      await requestChanges(id, auth.agent.id, body.comment);
      const after = getTask(id)!;
      return jsonOk({
        ok: true,
        action: "request_changes",
        task: {
          ...after,
          required_capabilities: parseRequiredCapabilities(after),
          success_criteria: parseSuccessCriteria(after),
        },
      });
    }

    if (body.assigned_to_agent_id !== undefined) {
      assignTask({
        task_id: id,
        assignee_agent_id: body.assigned_to_agent_id,
        actor_agent_id: auth.agent.id,
      });
    }
    let criteriaFailures: string[] | undefined;
    if (body.status) {
      const res = await transitionTaskStatus({
        task_id: id,
        to_status: body.status,
        actor_agent_id: auth.agent.id,
        comment: body.comment,
        result_snapshot_id: body.result_snapshot_id ?? null,
      });
      criteriaFailures = res.criteria_failures;
    } else if (body.comment) {
      // Same gate as POST /tasks/[id]/comments — without it any
      // authenticated agent could comment on any task by id (IDOR). A task
      // comment-grant also satisfies it (a granted collaborator can chime in).
      if (!mayUseTask(t, auth.agent.id, "comment", id)) {
        return jsonError(403, "Not the owner/assignee and no comment grant for this task.");
      }
      const { addTaskComment } = await import("@/lib/tasks");
      addTaskComment(id, auth.agent.id, body.comment);
    }
    const updated = getTask(id)!;
    return jsonOk({
      task: {
        ...updated,
        required_capabilities: parseRequiredCapabilities(updated),
        success_criteria: parseSuccessCriteria(updated),
      },
      criteria_failures: criteriaFailures,
    });
  } catch (err) {
    return jsonError(400, err instanceof Error ? err.message : "Update failed.");
  }
}
