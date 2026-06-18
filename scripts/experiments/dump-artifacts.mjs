// Inspect the artifacts produced by the most recent collab experiment.
// Re-runs the experiment but inlines file dumps so the user can read what
// the agents actually wrote.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRATCH = mkdtempSync(join(tmpdir(), "a2a-exp-"));
process.env.A2A_DB_PATH = join(SCRATCH, "exp.db");
process.env.A2A_BLOB_DIR = join(SCRATCH, "blobs");

const { _resetDbForTests, db } = await import("../../lib/db.ts");
const { createAgentForUser } = await import("../../lib/agents.ts");
const { spawnManagedAgent, PERSONA_TEMPLATES } = await import(
  "../../lib/managed-agents.ts"
);
const { ensureManagedAgentHooks } = await import(
  "../../lib/managed-agents-init.ts"
);
const { createGroupConversation, sendMessage, listMessages } = await import(
  "../../lib/conversations.ts"
);
const { sendFriendRequest, acceptFriendRequest } = await import(
  "../../lib/friends.ts"
);
const {
  createWorkspace,
  subscribeAgent,
  listFiles,
  readFileAt,
  listSnapshotsForWorkspace,
} = await import("../../lib/workspaces.ts");

_resetDbForTests();
ensureManagedAgentHooks();

const NOW = Date.now();
db()
  .prepare(
    `INSERT INTO users (id, email, display_name, password_hash, password_salt, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
  .run("usr_alice", "alice@exp.local", "Alice", "x".repeat(128), "y".repeat(32), NOW);
db()
  .prepare(
    `INSERT INTO users (id, email, display_name, password_hash, password_salt, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
  .run("usr_bob", "bob@exp.local", "Bob", "x".repeat(128), "y".repeat(32), NOW);

const aliceMe = createAgentForUser("usr_alice", {
  handle: "alice",
  purpose: "human",
  display_name: "Alice",
  avatar_emoji: "🧑‍🎨",
}).agent;
const bobMe = createAgentForUser("usr_bob", {
  handle: "bob",
  purpose: "human",
  display_name: "Bob",
  avatar_emoji: "🧑‍💻",
}).agent;

const writerTpl = PERSONA_TEMPLATES.find((t) => t.key === "openclaw-coding");
const reviewerTpl = PERSONA_TEMPLATES.find((t) => t.key === "openclaw-reviewer");
const writer = spawnManagedAgent("usr_alice", {
  handle: "writer",
  purpose: "agent",
  display_name: writerTpl.display_name,
  persona: writerTpl.persona,
  avatar_emoji: writerTpl.emoji,
  framework: "openclaw",
});
const reviewer = spawnManagedAgent("usr_bob", {
  handle: "reviewer",
  purpose: "agent",
  display_name: reviewerTpl.display_name,
  persona: reviewerTpl.persona,
  avatar_emoji: reviewerTpl.emoji,
  framework: "openclaw",
});

for (const [a, b] of [
  [aliceMe.id, reviewer.id],
  [writer.id, bobMe.id],
  [writer.id, reviewer.id],
]) {
  const r = sendFriendRequest("usr_alice", a, b);
  acceptFriendRequest("usr_bob", r.id);
}

const conv = createGroupConversation("usr_alice", aliceMe.id, "Launch email", [
  writer.id,
  reviewer.id,
]);
const ws = createWorkspace({
  name: "launch",
  conversation_id: conv.id,
  created_by_agent_id: aliceMe.id,
});
subscribeAgent(ws.id, writer.id, "writer");
subscribeAgent(ws.id, reviewer.id, "writer");

sendMessage(conv.id, aliceMe.id, {
  text:
    "Draft a 120-word launch email for our new AI gateway — tone: warm and " +
    "factual. Mention: live now, 30% latency drop on cached calls, free " +
    "credits for the first month. Audience: existing Pro-plan customers.",
});

// Wait for both agents to finish their first artifact-producing turn.
await new Promise((r) => setTimeout(r, 1500));

const head = listSnapshotsForWorkspace(ws.id, 20)[0];
const files = listFiles(head.id);

console.log(`\n========== Workspace HEAD (${head.id}) ==========`);
console.log(`Files at HEAD: ${files.length}`);
for (const f of files) {
  const r = readFileAt(head.id, f.path);
  console.log(`\n--- ${f.path} (${f.size_bytes} B) ---`);
  console.log(r ? r.content.toString("utf8") : "(missing)");
}

const snaps = listSnapshotsForWorkspace(ws.id, 20);
console.log(`\n========== Commit log (${snaps.length} snapshots) ==========`);
for (const s of snaps.slice().reverse()) {
  console.log(
    `  ${s.id}  by ${s.created_by_agent_id ?? "—"}: ${s.commit_message || "(no message)"}`,
  );
}

rmSync(SCRATCH, { recursive: true, force: true });
