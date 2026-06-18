// approveTask only records the approval event; the assignee still has to
// transition awaiting_review -> done, which re-evaluates success_criteria
// (diff_review now has the reviewer's approval + test_command passes).
import { transitionTaskStatus, getTask } from "../lib/tasks";
import { getWorkspace } from "../lib/workspaces";

void (async () => {
  const t = getTask("tsk_hohofze3")!;
  const head = getWorkspace(t.workspace_id!)!.head_snapshot_id!;
  const res = await transitionTaskStatus({
    task_id: "tsk_hohofze3",
    to_status: "done",
    actor_agent_id: "coder.izmm",
    result_snapshot_id: head,
  });
  console.log(`final status: ${getTask("tsk_hohofze3")!.status}`);
  console.log(
    "criteria_failures:",
    JSON.stringify(res.criteria_failures ?? "none"),
  );
})();
