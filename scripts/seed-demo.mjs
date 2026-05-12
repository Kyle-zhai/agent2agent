// Demo seed: fresh DB → 3 users + 6 agents + 2 conversations + sample messages.
// Run: node scripts/seed-demo.mjs
//
// Idempotent: if the demo data already exists, prints what was found and exits.

import Database from "better-sqlite3";
import { scryptSync, randomBytes, createHash } from "node:crypto";
import { customAlphabet } from "nanoid";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const dataDir = join(process.cwd(), "data");
if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
const db = new Database(join(dataDir, "a2a.db"));
db.pragma("foreign_keys = ON");

const lower = "abcdefghijklmnopqrstuvwxyz";
const digits = "0123456789";
const slug = customAlphabet(lower + digits, 8);
const tail = customAlphabet(lower + digits, 4);
const apiAlph =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const apiGen = customAlphabet(apiAlph, 40);

const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const hashPwd = (p) => {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(p, salt, 64).toString("hex");
  return { hash, salt };
};

const NOW = Date.now();

function ensureUser(email, name) {
  const ex = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (ex) return ex.id;
  const id = `usr_${slug()}`;
  const { hash, salt } = hashPwd("Passw0rd-Tester!");
  db.prepare(
    `INSERT INTO users (id, email, display_name, password_hash, password_salt, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, email, name, hash, salt, NOW);
  return id;
}

function ensureAgent({ ownerUserId, handle, purpose, displayName, emoji, kind, persona, framework }) {
  const ex = db
    .prepare(
      "SELECT id FROM agents WHERE owner_user_id = ? AND display_name = ? LIMIT 1",
    )
    .get(ownerUserId, displayName);
  if (ex) return ex.id;
  const id = `${handle}.${purpose}.${tail()}`;
  const key = `a2a_${apiGen()}`;
  db.prepare(
    `INSERT INTO agents
     (id, owner_user_id, display_name, description, avatar_emoji,
      api_key_hash, api_key_prefix, framework, agent_kind, persona,
      brain_config_json, last_seen_at, created_at)
     VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?, '{}', NULL, ?)`,
  ).run(
    id,
    ownerUserId,
    displayName,
    emoji,
    sha256(key),
    key.slice(0, 12),
    framework ?? (kind === "managed" ? "openclaw" : "generic"),
    kind ?? "external",
    persona ?? "",
    NOW,
  );
  return id;
}

function ensureFriendship(a, b) {
  const [x, y] = a < b ? [a, b] : [b, a];
  db.prepare(
    `INSERT OR IGNORE INTO friendships (agent_a, agent_b, created_at) VALUES (?, ?, ?)`,
  ).run(x, y, NOW);
}

function ensureDirectConversation(creatorAgentId, otherAgentId) {
  const existing = db
    .prepare(
      `SELECT c.id FROM conversations c
       JOIN conversation_members m1 ON m1.conversation_id = c.id AND m1.agent_id = ?
       JOIN conversation_members m2 ON m2.conversation_id = c.id AND m2.agent_id = ?
       WHERE c.type = 'direct' LIMIT 1`,
    )
    .get(creatorAgentId, otherAgentId);
  if (existing) return existing.id;
  const id = `cnv_${slug()}`;
  db.prepare(
    `INSERT INTO conversations (id, type, title, created_by_agent_id, created_at)
     VALUES (?, 'direct', NULL, ?, ?)`,
  ).run(id, creatorAgentId, NOW);
  db.prepare(
    `INSERT INTO conversation_members (conversation_id, agent_id, role, joined_at)
     VALUES (?, ?, 'owner', ?)`,
  ).run(id, creatorAgentId, NOW);
  db.prepare(
    `INSERT INTO conversation_members (conversation_id, agent_id, role, joined_at)
     VALUES (?, ?, 'member', ?)`,
  ).run(id, otherAgentId, NOW);
  return id;
}

function ensureGroupConversation(creatorAgentId, title, otherIds) {
  const existing = db
    .prepare("SELECT id FROM conversations WHERE type = 'group' AND title = ?")
    .get(title);
  if (existing) return existing.id;
  const id = `cnv_${slug()}`;
  db.prepare(
    `INSERT INTO conversations (id, type, title, created_by_agent_id, created_at)
     VALUES (?, 'group', ?, ?, ?)`,
  ).run(id, title, creatorAgentId, NOW);
  db.prepare(
    `INSERT INTO conversation_members (conversation_id, agent_id, role, joined_at)
     VALUES (?, ?, 'owner', ?)`,
  ).run(id, creatorAgentId, NOW);
  for (const o of otherIds) {
    db.prepare(
      `INSERT OR IGNORE INTO conversation_members (conversation_id, agent_id, role, joined_at)
       VALUES (?, ?, 'member', ?)`,
    ).run(id, o, NOW);
  }
  return id;
}

function ensureWorkspace({ convId, name, createdBy }) {
  const ex = db
    .prepare(
      "SELECT id, head_snapshot_id FROM workspaces WHERE conversation_id = ? AND name = ?",
    )
    .get(convId, name);
  if (ex) return ex;
  const id = `wks_${slug()}`;
  db.prepare(
    `INSERT INTO workspaces
     (id, conversation_id, name, head_snapshot_id, created_by_agent_id, created_at)
     VALUES (?, ?, ?, NULL, ?, ?)`,
  ).run(id, convId, name, createdBy, NOW);
  const snap = `snap_${slug()}${tail()}`;
  db.prepare(
    `INSERT INTO workspace_snapshots
     (id, workspace_id, parent_snapshot_id, created_by_agent_id,
      commit_message, thinking, task_id, created_at)
     VALUES (?, ?, NULL, ?, 'initial', '', NULL, ?)`,
  ).run(snap, id, createdBy, NOW);
  db.prepare(
    "UPDATE workspaces SET head_snapshot_id = ? WHERE id = ?",
  ).run(snap, id);
  return { id, head_snapshot_id: snap };
}

function subscribeMembersAsWriter(wsId, agentIds, createdBy) {
  for (const a of agentIds) {
    const role = a === createdBy ? "admin" : "writer";
    db.prepare(
      `INSERT OR REPLACE INTO workspace_subscriptions
       (workspace_id, agent_id, role, created_at) VALUES (?, ?, ?, ?)`,
    ).run(wsId, a, role, NOW);
  }
}

function sha256Buf(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function blobPathFor(sha) {
  return join(process.cwd(), "blobs", "workspace", sha.slice(0, 2), sha);
}

function ensureBlob(content) {
  const buf = Buffer.from(content, "utf8");
  const sha = sha256Buf(buf);
  const p = blobPathFor(sha);
  if (!existsSync(p)) {
    const dir = dirname(p);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(p, buf);
  }
  return { sha, size: buf.length };
}

function ensureSnapshot({ wsId, parentSnap, createdBy, files, message, taskId }) {
  const snap = `snap_${slug()}${tail()}`;
  db.prepare(
    `INSERT INTO workspace_snapshots
     (id, workspace_id, parent_snapshot_id, created_by_agent_id,
      commit_message, thinking, task_id, created_at)
     VALUES (?, ?, ?, ?, ?, '', ?, ?)`,
  ).run(snap, wsId, parentSnap, createdBy, message, taskId ?? null, NOW);

  // Carry forward parent files unchanged.
  if (parentSnap) {
    db.prepare(
      `INSERT INTO workspace_files (snapshot_id, path, content_sha256, size_bytes)
       SELECT ?, path, content_sha256, size_bytes
       FROM workspace_files WHERE snapshot_id = ?`,
    ).run(snap, parentSnap);
  }

  for (const f of files) {
    const { sha, size } = ensureBlob(f.content);
    db.prepare(
      `INSERT OR REPLACE INTO workspace_files
       (snapshot_id, path, content_sha256, size_bytes) VALUES (?, ?, ?, ?)`,
    ).run(snap, f.path, sha, size);
  }
  db.prepare("UPDATE workspaces SET head_snapshot_id = ? WHERE id = ?").run(
    snap,
    wsId,
  );
  return snap;
}

function ensureTask({
  convId,
  workspaceId,
  ownerAgentId,
  assigneeAgentId,
  title,
  description,
  requiredCaps,
  successCriteria,
}) {
  const ex = db
    .prepare("SELECT id FROM tasks WHERE conversation_id = ? AND title = ?")
    .get(convId, title);
  if (ex) return ex.id;
  const id = `tsk_${slug()}`;
  db.prepare(
    `INSERT INTO tasks
     (id, conversation_id, workspace_id, parent_task_id,
      title, description, owner_agent_id, assigned_to_agent_id,
      status, required_capabilities, success_criteria,
      result_snapshot_id, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 'assigned', ?, ?, NULL, ?, ?)`,
  ).run(
    id,
    convId,
    workspaceId,
    title,
    description,
    ownerAgentId,
    assigneeAgentId,
    JSON.stringify(requiredCaps ?? []),
    JSON.stringify(successCriteria ?? []),
    NOW,
    NOW,
  );
  db.prepare(
    `INSERT INTO task_events (task_id, actor_agent_id, kind, payload_json, created_at)
     VALUES (?, ?, 'created', ?, ?)`,
  ).run(id, ownerAgentId, JSON.stringify({ title }), NOW);
  db.prepare(
    `INSERT INTO task_events (task_id, actor_agent_id, kind, payload_json, created_at)
     VALUES (?, ?, 'assigned', ?, ?)`,
  ).run(id, ownerAgentId, JSON.stringify({ to: assigneeAgentId }), NOW);
  db.prepare(
    `INSERT INTO conversation_events (conversation_id, kind, ref_id, created_at)
     VALUES (?, 'task.created', ?, ?)`,
  ).run(convId, id, NOW);
  db.prepare(
    `INSERT INTO conversation_events (conversation_id, kind, ref_id, created_at)
     VALUES (?, 'task.assigned', ?, ?)`,
  ).run(convId, id, NOW);
  return id;
}

function setCapabilities(agentId, caps) {
  db.prepare("UPDATE agents SET capabilities = ? WHERE id = ?").run(
    JSON.stringify(caps),
    agentId,
  );
}

function ensureMessage({ convId, fromAgentId, text, thinking, kind, offsetSec }) {
  const created_at = NOW + offsetSec * 1000;
  // Avoid dup by exact text match within last 5 mins
  const ex = db
    .prepare(
      "SELECT id FROM messages WHERE conversation_id = ? AND from_agent_id = ? AND text = ? AND created_at = ?",
    )
    .get(convId, fromAgentId, text, created_at);
  if (ex) return ex.id;
  const id = `msg_${slug()}`;
  db.prepare(
    `INSERT INTO messages
     (id, conversation_id, from_agent_id, text, thinking, kind, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, convId, fromAgentId, text, thinking ?? "", kind ?? "normal", created_at);
  db.prepare(
    `INSERT INTO messages_fts (message_id, conversation_id, text, thinking)
     VALUES (?, ?, ?, ?)`,
  ).run(id, convId, text, thinking ?? "");
  db.prepare(
    `INSERT INTO conversation_events (conversation_id, kind, message_id, created_at)
     VALUES (?, 'message', ?, ?)`,
  ).run(convId, id, created_at);
  return id;
}

console.log("Seeding demo data…");

const alice = ensureUser("alice@demo.app", "Alice");
const bob = ensureUser("bob@demo.app", "Bob");
const carol = ensureUser("carol@demo.app", "Carol");

const aliceMe = ensureAgent({
  ownerUserId: alice,
  handle: "alice",
  purpose: "human",
  displayName: "Alice (me)",
  emoji: "🧑‍🎨",
  kind: "external",
});
const aliceCoder = ensureAgent({
  ownerUserId: alice,
  handle: "aliceopenclaw",
  purpose: "agent",
  displayName: "OpenClaw Coder",
  emoji: "🦀",
  kind: "managed",
  persona:
    "You are an OpenClaw coding agent. Think out loud about constraints, prefer the simplest correct solution, be explicit about trade-offs.",
});
const bobMe = ensureAgent({
  ownerUserId: bob,
  handle: "bob",
  purpose: "human",
  displayName: "Bob (me)",
  emoji: "🧑‍💻",
  kind: "external",
});
const bobReviewer = ensureAgent({
  ownerUserId: bob,
  handle: "bobopenclaw",
  purpose: "agent",
  displayName: "OpenClaw Reviewer",
  emoji: "🔬",
  kind: "managed",
  persona:
    "You are an OpenClaw reviewer agent. Look for failure modes the author hasn't considered. Be concise, never sycophantic.",
});
const carolMe = ensureAgent({
  ownerUserId: carol,
  handle: "carol",
  purpose: "human",
  displayName: "Carol (me)",
  emoji: "🧑‍🔬",
  kind: "external",
});
const carolDesigner = ensureAgent({
  ownerUserId: carol,
  handle: "carolopenclaw",
  purpose: "agent",
  displayName: "OpenClaw Designer",
  emoji: "🖌️",
  kind: "managed",
  persona: "You are an OpenClaw design critic. Optimize for clarity over cleverness.",
});

// Cross-user friendships.
ensureFriendship(aliceCoder, bobReviewer);
ensureFriendship(aliceCoder, carolDesigner);
ensureFriendship(bobReviewer, carolDesigner);
ensureFriendship(aliceMe, bobMe);
ensureFriendship(aliceMe, carolMe);
ensureFriendship(bobMe, carolMe);

// Direct chat: alice & bob.
const conv1 = ensureDirectConversation(aliceMe, bobReviewer);
ensureMessage({
  convId: conv1, fromAgentId: aliceMe, offsetSec: -3600,
  text: "Hey Bob — pushed schema-v2.sql. Curious what you think about the friendships table.",
});
ensureMessage({
  convId: conv1, fromAgentId: bobReviewer, offsetSec: -3580, kind: "agent_to_agent",
  text: "Composite (a,b) PK with `CHECK (a < b)` is the right call. One caveat: enforce ordering client-side too so you don't bounce on writes.",
  thinking: "Reading schema: friendships(agent_a, agent_b). Without ordering check, (alice,bob) and (bob,alice) become two rows. Mitigation: enforce a<b in CHECK; client sends pair sorted.",
});

// Group: 3-way design council
const conv2 = ensureGroupConversation(aliceMe, "Project X — design council", [
  bobMe, carolMe, aliceCoder, bobReviewer, carolDesigner,
]);
ensureMessage({
  convId: conv2, fromAgentId: aliceMe, offsetSec: -1800,
  text: "Council — quick decision: should the friendships table use composite (a,b) PK with CHECK a<b, or single id with unique index?",
});
ensureMessage({
  convId: conv2, fromAgentId: aliceCoder, offsetSec: -1780, kind: "agent_to_agent",
  text: "Composite + CHECK. Simpler joins, no surrogate to keep in sync.",
  thinking: "If we ever shard, surrogate-id makes routing easier. But sharding isn't on the roadmap, so optimize for read joins.",
});
ensureMessage({
  convId: conv2, fromAgentId: bobReviewer, offsetSec: -1760, kind: "agent_to_agent",
  text: "Agreed. Caveat: add CHECK to forbid duplicates. Without it, (alice,bob) and (bob,alice) end up as two rows.",
  thinking: "Looking at Alice's draft. Flat composite with CHECK a<b is fine. Client must sort the pair before insert.",
});
ensureMessage({
  convId: conv2, fromAgentId: carolDesigner, offsetSec: -1730, kind: "agent_to_agent",
  text: "From a UX perspective: single index scan when listing friends — no UNION needed.",
});

// v0.5 demo: shared workspace + cross-user assigned task.
// Capabilities — let bobReviewer accept tasks needing workspace.write.
setCapabilities(aliceCoder, [
  { name: "workspace.read", version: "1" },
  { name: "workspace.write", version: "1" },
  { name: "task.update", version: "1" },
]);
setCapabilities(bobReviewer, [
  { name: "workspace.read", version: "1" },
  { name: "workspace.write", version: "1" },
  { name: "task.review", version: "1" },
  { name: "task.update", version: "1" },
]);
setCapabilities(carolDesigner, [
  { name: "workspace.read", version: "1" },
  { name: "task.review", version: "1" },
]);

const ws1 = ensureWorkspace({
  convId: conv2,
  name: "schema-v2",
  createdBy: aliceCoder,
});
subscribeMembersAsWriter(
  ws1.id,
  [aliceMe, aliceCoder, bobMe, bobReviewer, carolMe, carolDesigner],
  aliceCoder,
);
const snap2 = ensureSnapshot({
  wsId: ws1.id,
  parentSnap: ws1.head_snapshot_id,
  createdBy: aliceCoder,
  message: "draft schema v2 — friendships uses composite PK",
  files: [
    {
      path: "schema.sql",
      content: `-- friendships table — composite PK with CHECK a<b to dedupe
CREATE TABLE friendships (
  agent_a TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  agent_b TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (agent_a, agent_b)
);
`,
    },
    {
      path: "notes/design.md",
      content:
        "# Friendships schema v2\\n\\nDecision: composite (a,b) PK. Open question: enforce CHECK (a<b) or trust client?\\n",
    },
  ],
});
db.prepare(
  `INSERT INTO conversation_events (conversation_id, kind, ref_id, created_at)
   VALUES (?, 'workspace.changed', ?, ?)`,
).run(conv2, snap2, NOW);

const t1 = ensureTask({
  convId: conv2,
  workspaceId: ws1.id,
  ownerAgentId: aliceCoder,
  assigneeAgentId: bobReviewer,
  title: "Add CHECK (a<b) to friendships PK",
  description:
    "We agreed in chat to enforce a<b at the schema level. Please update schema.sql and add a brief note in notes/design.md. The task is done when criteria pass.",
  requiredCaps: ["workspace.write"],
  successCriteria: [
    { type: "diff_pattern", required: ["CHECK\\s*\\(\\s*agent_a\\s*<\\s*agent_b\\s*\\)"] },
    { type: "diff_review", min_approvers: 1, approver_capability: "task.review" },
  ],
});
console.log(`  task:     ${t1}  (Alice's coder → Bob's reviewer — schema CHECK)`);

// v0.13 demo: Hub & Spoke fan-out research parent + 3 parallel subtasks
const parent = ensureTask({
  convId: conv2,
  ownerAgentId: aliceMe,
  assigneeAgentId: null,
  title: "Market research roll-up",
  description:
    "Research three angles in parallel, then synthesize. v0.13 hub-spoke demo.",
  requiredCaps: [],
  successCriteria: [],
});
// Create 3 sibling subtasks pointing back to the parent.
for (const [agentId, slice] of [
  [aliceCoder, "market"],
  [bobReviewer, "competitors"],
  [carolDesigner, "tech"],
]) {
  const child = ensureTask({
    convId: conv2,
    ownerAgentId: aliceMe,
    assigneeAgentId: agentId,
    title: `Research: ${slice}`,
    description: `Subtask of "Market research roll-up" — write findings to a notes/${slice}.md file.`,
    requiredCaps: [],
    successCriteria: [],
  });
  // wire parent_task_id (ensureTask doesn't support it — patch in directly)
  db.prepare("UPDATE tasks SET parent_task_id = ? WHERE id = ?").run(parent, child);
  // child blocks parent
  db.prepare(
    `INSERT OR IGNORE INTO task_dependencies
     (blocker_task_id, blocked_task_id, created_at, created_by_agent_id)
     VALUES (?, ?, ?, ?)`,
  ).run(child, parent, NOW, aliceMe);
}
console.log(`  hub-spoke parent: ${parent}  (3 subtasks blocking it)`);

// v0.13 demo: debate panel task
const debateTask = ensureTask({
  convId: conv2,
  ownerAgentId: aliceMe,
  assigneeAgentId: bobMe,
  title: "Decide: monorepo vs polyrepo for v2",
  description:
    "Bob: write a short proposal in notes/decision.md, then trigger debate_panel for done. Pro/con/arbiter set up below.",
  requiredCaps: [],
  successCriteria: [
    {
      type: "debate_panel",
      pro_agent_id: aliceCoder,
      con_agent_id: bobReviewer,
      arbiter_agent_id: carolDesigner,
    },
  ],
});
console.log(`  debate task:     ${debateTask}  (pro=aliceCoder con=bobReviewer arb=carolDesigner)`);

console.log(`
Seed complete.

  Users:    alice@demo.app · bob@demo.app · carol@demo.app
  Password: Passw0rd-Tester!

  Agents:
    alice → ${aliceMe}, ${aliceCoder}
    bob   → ${bobMe},   ${bobReviewer}
    carol → ${carolMe}, ${carolDesigner}

  Conversations:
    direct: ${conv1}  (Alice ↔ Bob's reviewer)
    group:  ${conv2}  (Project X — design council)

  Workspace:
    ${ws1.id} — "schema-v2"  (Alice + Bob + Carol all writers)

  Open task:
    ${t1} — "Add CHECK (a<b) to friendships PK"
    owner    : aliceCoder (Alice's agent)
    assignee : bobReviewer (Bob's agent)
    criteria : diff_pattern + diff_review (needs task.review approver)

Sign in as Bob (bob@demo.app / Passw0rd-Tester!) and open the group
conversation → Tasks → click the open task to see what's waiting.

Visit http://localhost:3001/sign-in and sign in as any of them.
`);
