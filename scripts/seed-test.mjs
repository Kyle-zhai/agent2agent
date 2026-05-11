// Quick e2e seed: create bob, add as friend with alice via direct SQL.
// Run: node scripts/seed-test.mjs

import Database from "better-sqlite3";
import { scryptSync, randomBytes, createHash } from "node:crypto";
import { customAlphabet } from "nanoid";
import { join } from "node:path";

const db = new Database(join(process.cwd(), "data/a2a.db"));
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

const now = Date.now();

let bobUserId;
const exBob = db.prepare("SELECT id FROM users WHERE email = ?").get("bob@test.app");
if (exBob) {
  bobUserId = exBob.id;
  console.log(`bob exists: ${bobUserId}`);
} else {
  bobUserId = `usr_${slug()}`;
  const { hash, salt } = hashPwd("passw0rd-test");
  db.prepare(
    `INSERT INTO users (id, email, display_name, password_hash, password_salt, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(bobUserId, "bob@test.app", "Bob Wu", hash, salt, now);
  console.log(`created bob user: ${bobUserId}`);
}

let bobAgentId, bobApiKey;
const exBobAg = db
  .prepare(
    "SELECT id, api_key_prefix FROM agents WHERE owner_user_id = ? LIMIT 1",
  )
  .get(bobUserId);
if (exBobAg) {
  bobAgentId = exBobAg.id;
  console.log(`bob agent exists: ${bobAgentId} (key prefix ${exBobAg.api_key_prefix})`);
} else {
  bobAgentId = `bob.review.${tail()}`;
  bobApiKey = `a2a_${apiGen()}`;
  const prefix = bobApiKey.slice(0, 12);
  db.prepare(
    `INSERT INTO agents
     (id, owner_user_id, display_name, description, avatar_emoji,
      api_key_hash, api_key_prefix, last_seen_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
  ).run(
    bobAgentId,
    bobUserId,
    "Bob's review agent",
    "Code review + architecture critique.",
    "🔬",
    sha256(bobApiKey),
    prefix,
    now,
  );
  console.log(`created bob agent: ${bobAgentId}`);
  console.log(`bob api key: ${bobApiKey}`);
}

const aliceAgent = db
  .prepare(
    `SELECT a.id FROM agents a
     JOIN users u ON u.id = a.owner_user_id
     WHERE u.email = 'alice@test.app'
     ORDER BY a.created_at DESC LIMIT 1`,
  )
  .get();
if (!aliceAgent) {
  console.error("no alice agent — create one in the UI first");
  process.exit(1);
}
const aliceAgentId = aliceAgent.id;

const [a, b] =
  aliceAgentId < bobAgentId
    ? [aliceAgentId, bobAgentId]
    : [bobAgentId, aliceAgentId];
db.prepare(
  `INSERT OR IGNORE INTO friendships (agent_a, agent_b, created_at) VALUES (?, ?, ?)`,
).run(a, b, now);
console.log(`friendship: ${a} ↔ ${b}`);

console.log(`
Useful:
  ALICE_AGENT_ID=${aliceAgentId}
  BOB_AGENT_ID=${bobAgentId}
${bobApiKey ? `  BOB_API_KEY=${bobApiKey}` : "  (BOB_API_KEY: re-run after rotating, or grab from UI)"}
`);
