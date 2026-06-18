// Two-Qwen-agent collaboration scenario: a coder writes stats.sh, a reviewer
// (real Qwen, task.review capability) judges the diff. Task is review-gated
// (diff_review) AND test-gated (test_command), so the autonomy loop drives:
//   coder writes -> awaiting_review -> reviewer judges -> approve -> test -> done
// (request_changes bounces back to the coder for another round).
import { db } from "../lib/db";
import { hashPassword } from "../lib/crypto";
import { setAgentCapabilities } from "../lib/agents";
import { spawnManagedAgent } from "../lib/managed-agents";
import { createWorkspace, applyPatch } from "../lib/workspaces";
import { createTask, getTask } from "../lib/tasks";
import { newConversationId } from "../lib/ids";

const NOW = Date.now();
const qwenBrain = JSON.stringify({
  provider: "openai",
  model: process.env.OPENAI_MODEL ?? "qwen-plus",
  temperature: 0.3,
  max_history: 24,
  reply_to_self: false,
});

const { hash, salt } = hashPassword("Passw0rd-Tester!");
db()
  .prepare(
    "INSERT OR IGNORE INTO users (id,email,display_name,password_hash,password_salt,created_at) VALUES (?,?,?,?,?,?)",
  )
  .run("usr_qwen", "qwen@demo.app", "Qwen Demo", hash, salt, NOW);

const coder = spawnManagedAgent("usr_qwen", {
  handle: "coder",
  display_name: "Qwen Coder",
  persona:
    'You are a careful shell-script engineer. Write MINIMAL correct code to make the test pass. Output the file as a <write path="stats.sh" commit="...">...</write> block, then emit <submit/>.',
  capabilities: [{ name: "workspace.write" }],
});
const reviewer = spawnManagedAgent("usr_qwen", {
  handle: "reviewer",
  display_name: "Qwen Reviewer",
  persona:
    'You are a strict but fair code reviewer. Judge whether the diff correctly and minimally solves the task. Reply with ONE-LINE JSON: {"decision":"approve"|"request_changes","reason":"..."}.',
  capabilities: [{ name: "task.review" }],
});
db()
  .prepare("UPDATE agents SET brain_config_json=? WHERE id IN (?,?)")
  .run(qwenBrain, coder.id, reviewer.id);
setAgentCapabilities(coder.id, "usr_qwen", [{ name: "workspace.write" }]);
setAgentCapabilities(reviewer.id, "usr_qwen", [{ name: "task.review" }]);

const convId = newConversationId();
db()
  .prepare(
    "INSERT INTO conversations (id,type,title,created_by_agent_id,created_at) VALUES (?,?,?,?,?)",
  )
  .run(convId, "group", "Qwen pair-programming", coder.id, NOW);
for (const a of [coder.id, reviewer.id]) {
  db()
    .prepare(
      "INSERT INTO conversation_members (conversation_id,agent_id,role,joined_at) VALUES (?,?,?,?)",
    )
    .run(convId, a, "member", NOW);
}

const ws = createWorkspace({
  name: "stats-task",
  conversation_id: convId,
  created_by_agent_id: coder.id,
});
applyPatch({
  workspace_id: ws.id,
  agent_id: coder.id,
  against_rev: ws.head_snapshot_id!,
  ops: [
    {
      path: "check.sh",
      op: "create",
      content:
        "#!/usr/bin/env bash\nout=$(bash stats.sh 3 1 4 1 5)\nexpected=$'count=5\\nsum=14\\nmin=1\\nmax=5'\nif [ \"$out\" = \"$expected\" ]; then echo PASS; else echo 'FAIL:'; echo \"$out\"; exit 1; fi\n",
    },
  ],
});

const task = createTask({
  title: "Implement stats.sh (count/sum/min/max)",
  description:
    "Create a file stats.sh. It reads all integer arguments and prints EXACTLY 4 lines in this order: count=N, sum=S, min=M, max=X. Example: `bash stats.sh 3 1 4 1 5` must print:\ncount=5\nsum=14\nmin=1\nmax=5\nThe workspace has check.sh which verifies exactly this. Write stats.sh so check.sh prints PASS.",
  owner_agent_id: coder.id,
  assigned_to_agent_id: coder.id,
  conversation_id: convId,
  workspace_id: ws.id,
  required_capabilities: ["workspace.write"],
  success_criteria: [{ type: "diff_review" }, { type: "test_command", cmd: "bash check.sh" }],
});

console.log(
  JSON.stringify(
    {
      coder: coder.id,
      reviewer: reviewer.id,
      conv: convId,
      ws: ws.id,
      task: task.id,
      status: getTask(task.id)!.status,
    },
    null,
    1,
  ),
);
