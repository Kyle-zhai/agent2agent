import "server-only";
import { agentMayUseResource } from "./grants";
import type { GrantScope } from "./types";

// Shared task-authz helper used by BOTH the task detail route (PATCH/GET) and
// the task comments route (POST). Lives in its own module rather than in
// lib/tasks.ts because lib/grants.ts already imports lib/tasks.ts (getTask) —
// putting this in lib/tasks.ts would make tasks.ts import grants.ts and close
// a cycle. This module is a leaf: task-access -> grants -> tasks (a DAG).

/** Owner/assignee bypass OR an active task grant at the required scope.
 *  Lets a handoff/grant recipient read & comment on a task they don't own —
 *  state-machine transitions (assign/approve/status) keep their own domain
 *  authz and are deliberately NOT loosened by a grant. */
export function mayUseTask(
  task: { owner_agent_id: string; assigned_to_agent_id: string | null },
  agentId: string,
  scope: GrantScope,
  taskId: string,
): boolean {
  if (task.owner_agent_id === agentId || task.assigned_to_agent_id === agentId) {
    return true;
  }
  return agentMayUseResource({
    using_agent_id: agentId,
    resource_type: "task",
    resource_id: taskId,
    required_scope: scope,
  });
}
