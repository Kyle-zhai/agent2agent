// Multi-agent collaboration vs single-agent baseline.
//
// Usage:  node --import tsx scripts/experiments/collab-vs-solo.mjs
//
// We use tsx to load the TS lib modules directly, point A2A_DB_PATH at a
// throwaway sqlite file, and skip the "server-only" guard by aliasing it
// to a no-op module via Node's --experimental-loader… actually tsx does this
// for us when paired with our existing tests/shims/server-only.ts pattern.
//
// The script:
//   1. Sets up 2 users (alice/bob) and 3 managed agents (writer/reviewer/pm)
//   2. SOLO setup — alice 1:1 with her writer; posts a brief; logs replies
//   3. COLLAB setup — group with writer + reviewer; posts the same brief;
//      logs all replies
//   4. Prints a comparison: # messages, distinct voices, body length sums
//
// Output is printed; nothing is left in the repo's main DB.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRATCH = mkdtempSync(join(tmpdir(), "a2a-exp-"));
process.env.A2A_DB_PATH = join(SCRATCH, "exp.db");
process.env.A2A_BLOB_DIR = join(SCRATCH, "blobs");

const { db, _resetDbForTests } = await import("../../lib/db.ts");
const { createAgentForUser } = await import("../../lib/agents.ts");
const { spawnManagedAgent, PERSONA_TEMPLATES } = await import(
  "../../lib/managed-agents.ts"
);
const { ensureManagedAgentHooks } = await import(
  "../../lib/managed-agents-init.ts"
);
const {
  createDirectConversation,
  createGroupConversation,
  listMessages,
  sendMessage,
} = await import("../../lib/conversations.ts");
const { sendFriendRequest, acceptFriendRequest } = await import(
  "../../lib/friends.ts"
);
const {
  createWorkspace,
  subscribeAgent,
  listFiles,
  listSnapshotsForWorkspace,
} = await import("../../lib/workspaces.ts");

_resetDbForTests();
ensureManagedAgentHooks();

// ---- helpers --------------------------------------------------------------

const NOW = Date.now();

function seedUser(userId, email, displayName) {
  db()
    .prepare(
      `INSERT INTO users (id, email, display_name, password_hash, password_salt, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(userId, email, displayName, "x".repeat(128), "y".repeat(32), NOW);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForReplies(convId, expectedMin, timeoutMs = 10_000) {
  // Wait until BOTH conditions hold:
  //   (a) we have at least `expectedMin` messages
  //   (b) the count hasn't changed for ~1.2s (queue has drained)
  // Without (b) we'd snapshot mid-flight on a busy round.
  const t0 = Date.now();
  let lastCount = -1;
  let stableSince = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const count = listMessages(convId, { limit: 50 }).length;
    if (count !== lastCount) {
      lastCount = count;
      stableSince = Date.now();
    }
    if (count >= expectedMin && Date.now() - stableSince > 1200) break;
    await sleep(150);
  }
  return listMessages(convId, { limit: 50 });
}

function summary(label, messages, exclude) {
  const lines = [];
  lines.push(`\n========== ${label} ==========`);
  lines.push(`Total messages: ${messages.length}`);
  const fromAgents = new Set(messages.map((m) => m.from_agent_id));
  lines.push(`Distinct authors: ${fromAgents.size}`);
  const totalChars = messages
    .filter((m) => m.from_agent_id !== exclude)
    .reduce((s, m) => s + m.text.length, 0);
  lines.push(`Total agent-output chars: ${totalChars}`);
  lines.push("");
  for (const m of messages) {
    const who = m.from_agent_id === exclude ? "[user]" : `[${m.from_agent_id}]`;
    const tag = m.kind === "agent_to_agent" ? " (a2a)" : "";
    lines.push(`${who}${tag}: ${m.text}`);
    if (m.thinking) {
      lines.push(
        `         ↳ thinking: ${m.thinking.replace(/\n/g, " | ").slice(0, 200)}`,
      );
    }
  }
  console.log(lines.join("\n"));
  return { messages: messages.length, distinctAuthors: fromAgents.size, totalChars };
}

// ---- setup ---------------------------------------------------------------

seedUser("usr_alice", "alice@exp.local", "Alice");
seedUser("usr_bob", "bob@exp.local", "Bob");

// Each user gets one EXTERNAL agent (the "human typing") and one MANAGED
// agent (auto-replying brain) — same shape as the real product.
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
const reviewerTpl = PERSONA_TEMPLATES.find(
  (t) => t.key === "openclaw-reviewer",
);

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

// Friend the cross-user agents so the group conv accepts them.
const req1 = sendFriendRequest("usr_alice", aliceMe.id, reviewer.id);
acceptFriendRequest("usr_bob", req1.id);
const req2 = sendFriendRequest("usr_alice", writer.id, bobMe.id);
acceptFriendRequest("usr_bob", req2.id);
const req3 = sendFriendRequest("usr_alice", writer.id, reviewer.id);
acceptFriendRequest("usr_bob", req3.id);

const BRIEF =
  "Draft a 120-word launch email for our new AI gateway — tone: warm and " +
  "factual. Mention: live now, 30% latency drop on cached calls, free " +
  "credits for the first month. Audience: existing Pro-plan customers.";

// ============================================================================
// SOLO — alice (her external agent) ↔ writer (her managed agent)
// ============================================================================

console.log("\n# SOLO scenario\n  Alice ↔ Writer (one managed agent) + shared workspace");
const soloConv = createDirectConversation("usr_alice", aliceMe.id, writer.id);
const soloWs = createWorkspace({
  name: "solo-launch",
  conversation_id: soloConv.id,
  created_by_agent_id: aliceMe.id,
});
subscribeAgent(soloWs.id, writer.id, "writer");
sendMessage(soloConv.id, aliceMe.id, { text: BRIEF });
const soloMessages = await waitForReplies(soloConv.id, 2);
const soloStats = summary("SOLO output", soloMessages, aliceMe.id);
const soloSnaps = listSnapshotsForWorkspace(soloWs.id, 20);
const soloFiles = soloWs.head_snapshot_id ? listFiles(soloSnaps[0].id) : [];

// ============================================================================
// COLLAB — group with writer (alice) + reviewer (bob)
// Alice posts the same brief; both managed agents auto-reply.
// ============================================================================

console.log(
  "\n# COLLAB scenario\n  Group: Alice + Writer + Reviewer + shared workspace",
);
const collabConv = createGroupConversation(
  "usr_alice",
  aliceMe.id,
  "Launch email",
  [writer.id, reviewer.id],
);
const collabWs = createWorkspace({
  name: "collab-launch",
  conversation_id: collabConv.id,
  created_by_agent_id: aliceMe.id,
});
subscribeAgent(collabWs.id, writer.id, "writer");
subscribeAgent(collabWs.id, reviewer.id, "writer");
sendMessage(collabConv.id, aliceMe.id, { text: BRIEF });

// We expect at least 2 agent replies in the first round (writer + reviewer).
// Wait a bit longer because each managed agent's reply itself enqueues new
// reply_jobs for the OTHER managed agent → potential 2nd round.
const collabMessages = await waitForReplies(collabConv.id, 3, 8000);
const collabStats = summary("COLLAB output", collabMessages, aliceMe.id);

// ============================================================================
// Comparison
// ============================================================================

console.log("\n========== Comparison ==========");
console.log(
  `Messages       — solo: ${soloStats.messages.toString().padStart(2)}    collab: ${collabStats.messages}`,
);
console.log(
  `Distinct voices — solo: ${soloStats.distinctAuthors.toString().padStart(2)}    collab: ${collabStats.distinctAuthors}`,
);
console.log(
  `Agent chars    — solo: ${soloStats.totalChars.toString().padStart(2)}    collab: ${collabStats.totalChars}`,
);

const lift = (collabStats.totalChars / Math.max(1, soloStats.totalChars)).toFixed(2);
console.log(`Volume lift     — collab/solo = ${lift}×`);

// Gap diagnostics — did agents touch a workspace? create artifacts?
const collabSnaps = listSnapshotsForWorkspace(collabWs.id, 20);
const collabFiles = collabSnaps[0] ? listFiles(collabSnaps[0].id) : [];
const soloSnapsAfter = listSnapshotsForWorkspace(soloWs.id, 20);
const soloFilesAfter = soloSnapsAfter[0] ? listFiles(soloSnapsAfter[0].id) : [];

console.log("");
console.log("Concrete artifacts in the workspace:");
console.log(
  `  SOLO   — snapshots: ${soloSnapsAfter.length - 1}, files at HEAD: ${soloFilesAfter.length}`,
);
for (const f of soloFilesAfter) console.log(`           • ${f.path} (${f.size_bytes} B)`);
console.log(
  `  COLLAB — snapshots: ${collabSnaps.length - 1}, files at HEAD: ${collabFiles.length}`,
);
for (const f of collabFiles) console.log(`           • ${f.path} (${f.size_bytes} B)`);

// Cleanup
try {
  rmSync(SCRATCH, { recursive: true, force: true });
} catch {
  /* ignore */
}
