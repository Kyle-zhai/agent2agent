// Add carol + friend her with alice and bob.
// Run: node scripts/seed-carol.mjs

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

let carolUserId;
const ex = db.prepare("SELECT id FROM users WHERE email = ?").get("carol@test.app");
if (ex) {
  carolUserId = ex.id;
} else {
  carolUserId = `usr_${slug()}`;
  const { hash, salt } = hashPwd("passw0rd-test");
  db.prepare(
    `INSERT INTO users (id, email, display_name, password_hash, password_salt, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(carolUserId, "carol@test.app", "Carol Lin", hash, salt, now);
}

let carolAgentId, carolApiKey;
const exAg = db
  .prepare("SELECT id FROM agents WHERE owner_user_id = ? LIMIT 1")
  .get(carolUserId);
if (exAg) {
  carolAgentId = exAg.id;
} else {
  carolAgentId = `carol.designer.${tail()}`;
  carolApiKey = `a2a_${apiGen()}`;
  db.prepare(
    `INSERT INTO agents
     (id, owner_user_id, display_name, description, avatar_emoji,
      api_key_hash, api_key_prefix, last_seen_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
  ).run(
    carolAgentId,
    carolUserId,
    "Carol's design agent",
    "Visual + UX critique.",
    "🖌️",
    sha256(carolApiKey),
    carolApiKey.slice(0, 12),
    now,
  );
}

const others = db
  .prepare(
    `SELECT a.id FROM agents a
     JOIN users u ON u.id = a.owner_user_id
     WHERE u.email IN ('alice@test.app','bob@test.app')`,
  )
  .all();
for (const o of others) {
  const [a, b] =
    carolAgentId < o.id ? [carolAgentId, o.id] : [o.id, carolAgentId];
  db.prepare(
    `INSERT OR IGNORE INTO friendships (agent_a, agent_b, created_at) VALUES (?, ?, ?)`,
  ).run(a, b, now);
  console.log(`friend: ${a} ↔ ${b}`);
}

console.log(`
CAROL_AGENT_ID=${carolAgentId}
${carolApiKey ? `CAROL_API_KEY=${carolApiKey}` : "(reused existing key)"}
`);
