// Real LLM end-to-end demo: a managed agent backed by Qwen autonomously
// completes a coding task — write sum.sh so the pre-seeded check.sh passes —
// driven all the way to task `done` by the deterministic test_command gate.
//
// Run:
//   TSX_TSCONFIG_PATH=tsconfig.test.json node --env-file=.env.local \
//     --import tsx scripts/demo-qwen.ts
import { db } from "../lib/db";
import { hashPassword } from "../lib/crypto";
import { getAgent } from "../lib/agents";
import { spawnManagedAgent } from "../lib/managed-agents";
import {
  createWorkspace,
  applyPatch,
  getWorkspace,
  listFiles,
  readFileAt,
} from "../lib/workspaces";
import { createTask, getTask } from "../lib/tasks";
import { runAutonomousTask } from "../lib/autonomous";
import { newConversationId } from "../lib/ids";

void (async () => {
const NOW = Date.now();

// 1. A user + a managed agent whose brain is the Qwen (OpenAI-compatible) key.
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
    'You are a careful shell-script engineer. Write the MINIMAL correct code to make the test pass. Put the file content in a <write path="sum.sh" commit="...">...</write> block, then emit <submit/>.',
  capabilities: [{ name: "workspace.write" }],
});
// Pin the Qwen brain explicitly (spawn-time default may have been mock).
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

// 2. A conversation + a workspace seeded with the acceptance test.
const convId = newConversationId();
db()
  .prepare(
    "INSERT INTO conversations (id,type,title,created_by_agent_id,created_at) VALUES (?,?,?,?,?)",
  )
  .run(convId, "group", "Qwen demo", worker.id, NOW);
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
        '#!/usr/bin/env bash\nout=$(bash sum.sh 2 3)\nif [ "$out" = "5" ]; then echo PASS; else echo "FAIL: got [$out]"; exit 1; fi\n',
    },
  ],
});

// 3. The task: write sum.sh; done == test_command (bash check.sh) passes.
const task = createTask({
  title: "Write sum.sh",
  description:
    "Create a file named sum.sh. It takes two integer arguments ($1 and $2) and prints ONLY their sum, nothing else. The workspace already has check.sh which runs `bash sum.sh 2 3` and requires the output to be exactly 5. Write sum.sh so the check passes.",
  owner_agent_id: worker.id,
  assigned_to_agent_id: worker.id,
  conversation_id: convId,
  workspace_id: ws.id,
  success_criteria: [{ type: "test_command", cmd: "bash check.sh" }],
});

const brain = JSON.parse(getAgent(worker.id)!.brain_config_json);
console.log(`agent brain: ${brain.provider} / ${brain.model}`);
console.log("running autonomous task with REAL Qwen…\n");

const t0 = Date.now();
const result = await runAutonomousTask(worker.id, task.id, { maxSteps: 5 });

console.log(`=== RESULT (${((Date.now() - t0) / 1000).toFixed(1)}s) ===`);
console.log(`outcome: ${result.outcome} | steps: ${result.steps}`);
console.log(`detail:  ${result.detail}`);
console.log(`task status: ${getTask(task.id)!.status}`);

const head = getWorkspace(ws.id)!.head_snapshot_id!;
console.log("\n=== workspace files (sum.sh written by Qwen) ===");
for (const f of listFiles(head)) {
  const r = readFileAt(head, f.path);
  console.log(`\n--- ${f.path} ---\n${r ? r.content.toString("utf8") : "(missing)"}`);
}

const events = db()
  .prepare("SELECT kind FROM task_events WHERE task_id=? ORDER BY created_at")
  .all(task.id) as Array<{ kind: string }>;
console.log(`\n=== task state transitions ===\n  ${events.map((e) => e.kind).join(" → ")}`);
console.log(`\nWeb 端: 起 npm run dev 后登录 qwen@demo.app / Passw0rd-Tester! 查看`);
})();
