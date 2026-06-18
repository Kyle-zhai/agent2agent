// Stage-set participants for the live-UI audit run. Creates ONE loggable user
// + the managed Qwen agents / conversations / workspaces the scenarios need.
// The HUMAN ACTIONS (create task, send message, approve, view) are then done
// manually in the browser. Run: node --env-file=.env.local --import tsx scripts/seed-ui-audit.ts
import { db } from "../lib/db";
import { hashPassword } from "../lib/crypto";
import { setAgentCapabilities } from "../lib/agents";
import { spawnManagedAgent } from "../lib/managed-agents";
import { createWorkspace, applyPatch, subscribeAgent, getWorkspace } from "../lib/workspaces";
import { newConversationId } from "../lib/ids";

const NOW = Date.now();
const TAG = NOW.toString(36).slice(-4);
const UID = `usr_audit_${TAG}`;
const EMAIL = `audit-${TAG}@demo.app`;
const PW = "Passw0rd-Tester!";

const qwen = JSON.stringify({
  provider: "openai",
  model: process.env.OPENAI_MODEL ?? "qwen-plus",
  temperature: 0.3,
  max_history: 24,
  reply_to_self: false,
});

const { hash, salt } = hashPassword(PW);
db()
  .prepare(
    "INSERT INTO users (id,email,display_name,password_hash,password_salt,created_at) VALUES (?,?,?,?,?,?)",
  )
  .run(UID, EMAIL, "Audit Human", hash, salt, NOW);

function bot(handle: string, persona: string, caps: string[]) {
  const a = spawnManagedAgent(UID, {
    handle: `${handle}${TAG}`,
    display_name: handle,
    persona,
    capabilities: caps.map((name) => ({ name })),
  });
  db().prepare("UPDATE agents SET brain_config_json=? WHERE id=?").run(qwen, a.id);
  setAgentCapabilities(a.id, UID, caps.map((name) => ({ name })));
  return a;
}

const coder = bot(
  "AuditCoder",
  'You are a careful engineer. Do EXACTLY what the task says with minimal code. Emit files as <write path="..." commit="...">...</write> then emit <submit/>.',
  ["workspace.write"],
);
const rev1 = bot(
  "AuditRev1",
  'You are a reviewer. Judge the diff against the task. Reply ONE JSON object: {"decision":"approve"|"request_changes","reason":"..."}. If the deterministic acceptance tests pass, approve.',
  ["task.review"],
);
const rev2 = bot(
  "AuditRev2",
  'You are a second independent reviewer. Same protocol: ONE JSON {"decision":"approve"|"request_changes","reason":"..."}. If the tests pass, approve.',
  ["task.review"],
);
// a capability-less helper, to demonstrate capability-gated assignment in the UI
const helper = bot("AuditHelper", "You are a helper with no write capability.", []);

const conv = newConversationId();
db()
  .prepare(
    "INSERT INTO conversations (id,type,title,created_by_agent_id,created_at) VALUES (?,?,?,?,?)",
  )
  .run(conv, "group", `Audit room ${TAG}`, coder.id, NOW);
for (const a of [coder.id, rev1.id, rev2.id, helper.id]) {
  db()
    .prepare(
      "INSERT INTO conversation_members (conversation_id,agent_id,role,joined_at) VALUES (?,?,?,?)",
    )
    .run(conv, a, "member", NOW);
}

const ws = createWorkspace({ name: "audit-ws", conversation_id: conv, created_by_agent_id: coder.id });
subscribeAgent(ws.id, rev1.id, "reader");
subscribeAgent(ws.id, rev2.id, "reader");
applyPatch({
  workspace_id: ws.id,
  agent_id: coder.id,
  against_rev: getWorkspace(ws.id)!.head_snapshot_id!,
  ops: [
    {
      path: "check.sh",
      op: "create",
      content: "#!/usr/bin/env bash\ngrep -q DONE out.txt 2>/dev/null && echo PASS || { echo FAIL; exit 1; }\n",
    },
  ],
});

console.log("=== UI AUDIT SEED READY ===");
console.log(`LOGIN: ${EMAIL} / ${PW}`);
console.log(`conv=${conv}  ws=${ws.id}`);
console.log(`coder=${coder.id}  rev1=${rev1.id}  rev2=${rev2.id}  helper=${helper.id}`);
console.log(`open: /app/c/${conv}/tasks`);
