// Prepare a real web-viewable scenario: a Qwen-backed managed agent with an
// ASSIGNED (not-yet-run) coding task. The dev server's autonomy tick will pick
// it up and drive it to `done` with real Qwen — visible live in the browser.
import { db } from "../lib/db";
import { hashPassword } from "../lib/crypto";
import { getAgent } from "../lib/agents";
import { spawnManagedAgent } from "../lib/managed-agents";
import { createWorkspace, applyPatch } from "../lib/workspaces";
import { createTask, getTask } from "../lib/tasks";
import { newConversationId } from "../lib/ids";

const NOW = Date.now();

const { hash, salt } = hashPassword("Passw0rd-Tester!");
db()
  .prepare(
    "INSERT OR IGNORE INTO users (id,email,display_name,password_hash,password_salt,created_at) VALUES (?,?,?,?,?,?)",
  )
  .run("usr_qwen", "qwen@demo.app", "Qwen Demo", hash, salt, NOW);

const worker = spawnManagedAgent("usr_qwen", {
  handle: "qwencoder",
  display_name: "Qwen Coder",
  persona:
    'You are a careful shell-script engineer. Write the MINIMAL correct code to make the test pass. Put the file content in a <write path="max.sh" commit="...">...</write> block, then emit <submit/>.',
  capabilities: [{ name: "workspace.write" }],
});
db()
  .prepare("UPDATE agents SET brain_config_json = ? WHERE id = ?")
  .run(
    JSON.stringify({
      provider: "openai",
      model: process.env.OPENAI_MODEL ?? "qwen-plus",
      temperature: 0.3,
      max_history: 24,
      reply_to_self: false,
    }),
    worker.id,
  );

const convId = newConversationId();
db()
  .prepare(
    "INSERT INTO conversations (id,type,title,created_by_agent_id,created_at) VALUES (?,?,?,?,?)",
  )
  .run(convId, "group", "Qwen task room", worker.id, NOW);
db()
  .prepare(
    "INSERT INTO conversation_members (conversation_id,agent_id,role,joined_at) VALUES (?,?,?,?)",
  )
  .run(convId, worker.id, "member", NOW);

const ws = createWorkspace({
  name: "qwen-task",
  conversation_id: convId,
  created_by_agent_id: worker.id,
});
applyPatch({
  workspace_id: ws.id,
  agent_id: worker.id,
  against_rev: ws.head_snapshot_id!,
  ops: [
    {
      path: "check.sh",
      op: "create",
      content:
        '#!/usr/bin/env bash\na=$(bash max.sh 3 7)\nb=$(bash max.sh 9 2)\nif [ "$a" = "7" ] && [ "$b" = "9" ]; then echo PASS; else echo "FAIL: got [$a] [$b]"; exit 1; fi\n',
    },
  ],
});

const task = createTask({
  title: "Write max.sh (print the larger of two numbers)",
  description:
    "Create a file named max.sh. It takes two integer arguments ($1 and $2) and prints ONLY the larger one, nothing else. The workspace has check.sh which runs `bash max.sh 3 7` (must print 7) and `bash max.sh 9 2` (must print 9). Write max.sh so check.sh prints PASS.",
  owner_agent_id: worker.id,
  assigned_to_agent_id: worker.id,
  conversation_id: convId,
  workspace_id: ws.id,
  success_criteria: [{ type: "test_command", cmd: "bash check.sh" }],
});

const brain = JSON.parse(getAgent(worker.id)!.brain_config_json);
console.log("=== prepared ===");
console.log(`agent: ${worker.id}  brain: ${brain.provider}/${brain.model}`);
console.log(`task:  ${task.id}  status: ${getTask(task.id)!.status}`);
console.log(`conversation: ${convId}  workspace: ${ws.id}`);
console.log("login: qwen@demo.app / Passw0rd-Tester!");
