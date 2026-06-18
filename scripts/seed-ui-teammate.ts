// Stage-set a SECOND loggable user (a teammate from another "team") + an agent,
// befriended with the audit user's coder agent — so the cross-team handoff (XT)
// can be driven through the real UI (collab/new + the Handoff panel).
import { db } from "../lib/db";
import { hashPassword } from "../lib/crypto";
import { createAgentForUser } from "../lib/agents";

const NOW = Date.now();
const TAG = NOW.toString(36).slice(-4);
const PW = "Passw0rd-Tester!";

// Find the audit user + its coder agent from the prior seed.
const auditUser = db()
  .prepare("SELECT id FROM users WHERE email LIKE 'audit-%@demo.app' ORDER BY created_at DESC LIMIT 1")
  .get() as { id: string } | undefined;
if (!auditUser) throw new Error("No audit user found — run seed-ui-audit.ts first");
const auditCoder = db()
  .prepare("SELECT id FROM agents WHERE owner_user_id=? AND id LIKE 'auditcoder%' LIMIT 1")
  .get(auditUser.id) as { id: string } | undefined;
if (!auditCoder) throw new Error("No audit coder agent found");

// Create the teammate user + agent.
const TEAM_UID = `usr_team_${TAG}`;
const TEAM_EMAIL = `teammate-${TAG}@demo.app`;
const { hash, salt } = hashPassword(PW);
db()
  .prepare(
    "INSERT INTO users (id,email,display_name,password_hash,password_salt,created_at) VALUES (?,?,?,?,?,?)",
  )
  .run(TEAM_UID, TEAM_EMAIL, "Team Mate", hash, salt, NOW);
const { agent: mate } = createAgentForUser(TEAM_UID, { handle: `teammate${TAG}`, display_name: "TeamMate" });

// Befriend the audit coder ↔ teammate agent (so collab/new can add them).
const [a, b] = auditCoder.id < mate.id ? [auditCoder.id, mate.id] : [mate.id, auditCoder.id];
db()
  .prepare("INSERT OR IGNORE INTO friendships (agent_a, agent_b, created_at) VALUES (?,?,?)")
  .run(a, b, NOW);

console.log("=== TEAMMATE SEED READY ===");
console.log(`TEAMMATE LOGIN: ${TEAM_EMAIL} / ${PW}`);
console.log(`teammate agent: ${mate.id}  (befriended with audit coder ${auditCoder.id})`);
console.log(`audit user: ${auditUser.id}`);
