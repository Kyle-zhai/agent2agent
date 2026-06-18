import "server-only";
import { db } from "./db";
import { newAgentId, newApiKey } from "./ids";
import { sha256Hex } from "./crypto";
import {
  SUPPORTED_FRAMEWORKS,
  type Agent,
  type AgentFramework,
} from "./types";

export type { Agent, AgentFramework } from "./types";
export { SUPPORTED_FRAMEWORKS } from "./types";

export const MAX_AGENTS_PER_USER = 10;

const AGENT_COLUMNS =
  "id, owner_user_id, display_name, description, avatar_emoji, avatar_blob_path, api_key_prefix, framework, agent_kind, persona, brain_config_json, parent_agent_id, capabilities, last_seen_at, last_message_at, created_at, a2a_card_verified";

export function listAgentsForUser(userId: string): Agent[] {
  return db()
    .prepare(
      `SELECT ${AGENT_COLUMNS}
       FROM agents WHERE owner_user_id = ? ORDER BY created_at DESC`,
    )
    .all(userId) as Agent[];
}

export function getAgent(id: string): Agent | null {
  const row = db()
    .prepare(`SELECT ${AGENT_COLUMNS} FROM agents WHERE id = ?`)
    .get(id);
  return (row as Agent) ?? null;
}

export function getAgentOwnedBy(id: string, userId: string): Agent | null {
  const a = getAgent(id);
  return a && a.owner_user_id === userId ? a : null;
}

export function createAgentForUser(
  userId: string,
  input: {
    handle: string;
    purpose?: string | null;
    display_name: string;
    description?: string;
    avatar_emoji?: string;
    framework?: AgentFramework;
  },
): { agent: Agent; apiKey: string } {
  const display = input.display_name.trim();
  if (display.length < 1 || display.length > 60) {
    throw new Error("Display name must be 1-60 characters.");
  }
  const count = (
    db()
      .prepare("SELECT COUNT(*) AS n FROM agents WHERE owner_user_id = ?")
      .get(userId) as { n: number }
  ).n;
  if (count >= MAX_AGENTS_PER_USER) {
    throw new Error(
      `Agent limit reached (${MAX_AGENTS_PER_USER} per account).`,
    );
  }
  const declared = (input.framework ?? "generic") as AgentFramework;
  const framework: AgentFramework = SUPPORTED_FRAMEWORKS.includes(declared)
    ? declared
    : "generic";
  const id = newAgentId(input.handle, input.purpose ?? null);
  const { key, prefix } = newApiKey();
  const keyHash = sha256Hex(key);
  const now = Date.now();
  const description = (input.description ?? "").trim().slice(0, 280);
  const emoji = (input.avatar_emoji ?? "🤖").slice(0, 4);

  try {
    db()
      .prepare(
        `INSERT INTO agents
         (id, owner_user_id, display_name, description, avatar_emoji,
          api_key_hash, api_key_prefix, framework, last_seen_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      )
      .run(id, userId, display, description, emoji, keyHash, prefix, framework, now);
  } catch (err) {
    if (err instanceof Error && err.message.includes("UNIQUE")) {
      throw new Error(
        "Random suffix collision — try again (extremely rare).",
      );
    }
    throw err;
  }
  const agent = getAgent(id)!;
  return { agent, apiKey: key };
}

export function deleteAgentForUser(id: string, userId: string): void {
  const a = getAgentOwnedBy(id, userId);
  if (!a) throw new Error("Agent not found.");
  // 11 agents(id) FKs have NO `ON DELETE` clause, so a bare DELETE throws
  // SQLITE_CONSTRAINT_FOREIGNKEY the moment the agent has any content. Clear
  // every unguarded reference in ONE transaction, then delete the agent.
  //   - nullable author refs → SET NULL (keep the row, drop attribution)
  //   - NOT NULL author rows  → DELETE (the content goes with its author)
  //   - conversations it created → hand off to another member, or delete if
  //     it's the only member (don't nuke a shared room out from under peers)
  // FKs WITH ON DELETE CASCADE/SET NULL (friend_requests, agent_links,
  // handoffs, grants, sessions, reply_jobs, tool_*, invite_*, …) clean
  // themselves up when the agent row finally goes.
  const d = db();
  const tx = d.transaction(() => {
    for (const stmt of [
      "UPDATE workspaces SET created_by_agent_id = NULL WHERE created_by_agent_id = ?",
      "UPDATE workspace_snapshots SET created_by_agent_id = NULL WHERE created_by_agent_id = ?",
      "UPDATE task_events SET actor_agent_id = NULL WHERE actor_agent_id = ?",
      "UPDATE task_dependencies SET created_by_agent_id = NULL WHERE created_by_agent_id = ?",
      "UPDATE task_artifacts SET added_by_agent_id = NULL WHERE added_by_agent_id = ?",
      "UPDATE sandbox_runs SET initiated_by_agent_id = NULL WHERE initiated_by_agent_id = ?",
    ]) {
      d.prepare(stmt).run(id);
    }
    // Reassign or delete conversations this agent created.
    const myConvs = d
      .prepare("SELECT id FROM conversations WHERE created_by_agent_id = ?")
      .all(id) as Array<{ id: string }>;
    for (const c of myConvs) {
      const other = d
        .prepare(
          "SELECT agent_id FROM conversation_members WHERE conversation_id = ? AND agent_id != ? LIMIT 1",
        )
        .get(c.id, id) as { agent_id: string } | undefined;
      if (other) {
        d.prepare("UPDATE conversations SET created_by_agent_id = ? WHERE id = ?").run(
          other.agent_id,
          c.id,
        );
      } else {
        d.prepare("DELETE FROM conversations WHERE id = ?").run(c.id);
      }
    }
    // NOT NULL author rows the agent owns (each cascades its own children).
    for (const stmt of [
      "DELETE FROM messages WHERE from_agent_id = ?",
      "DELETE FROM attachments WHERE uploaded_by_agent_id = ?",
      "DELETE FROM context_notes WHERE from_agent_id = ?",
      "DELETE FROM tasks WHERE owner_agent_id = ?",
    ]) {
      d.prepare(stmt).run(id);
    }
    d.prepare("DELETE FROM agents WHERE id = ?").run(id);
  });
  tx();
}

export function rotateApiKey(
  id: string,
  userId: string,
): { agent: Agent; apiKey: string } {
  const a = getAgentOwnedBy(id, userId);
  if (!a) throw new Error("Agent not found.");
  const { key, prefix } = newApiKey();
  const keyHash = sha256Hex(key);
  db()
    .prepare(
      "UPDATE agents SET api_key_hash = ?, api_key_prefix = ? WHERE id = ?",
    )
    .run(keyHash, prefix, id);
  return { agent: getAgent(id)!, apiKey: key };
}

export function authenticateAgent(rawKey: string): Agent | null {
  if (!rawKey || !rawKey.startsWith("a2a_")) return null;
  const hash = sha256Hex(rawKey);
  const row = db()
    .prepare(`SELECT ${AGENT_COLUMNS} FROM agents WHERE api_key_hash = ?`)
    .get(hash);
  if (!row) return null;
  db()
    .prepare("UPDATE agents SET last_seen_at = ? WHERE id = ?")
    .run(Date.now(), (row as Agent).id);
  return row as Agent;
}

export function searchAgentsByPrefix(query: string, limit = 10): Agent[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  return db()
    .prepare(
      `SELECT ${AGENT_COLUMNS}
       FROM agents
       WHERE id LIKE ? OR LOWER(display_name) LIKE ?
       ORDER BY id ASC LIMIT ?`,
    )
    .all(`%${q}%`, `%${q}%`, limit) as Agent[];
}

export function getAgentsByIds(ids: string[]): Agent[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  return db()
    .prepare(
      `SELECT ${AGENT_COLUMNS}
       FROM agents WHERE id IN (${placeholders})`,
    )
    .all(...ids) as Agent[];
}

export function setAgentAvatar(
  id: string,
  userId: string,
  blobPath: string | null,
): void {
  const a = getAgentOwnedBy(id, userId);
  if (!a) throw new Error("Agent not found.");
  db()
    .prepare("UPDATE agents SET avatar_blob_path = ? WHERE id = ?")
    .run(blobPath, id);
}

const MAX_CAPABILITIES = 32;
const CAPABILITY_NAME_RE = /^[a-z][a-z0-9_.-]{1,40}$/i;

export function setAgentCapabilities(
  id: string,
  userId: string,
  capabilities: unknown,
): void {
  const a = getAgentOwnedBy(id, userId);
  if (!a) throw new Error("Agent not found.");
  if (!Array.isArray(capabilities)) {
    throw new Error("capabilities must be a JSON array.");
  }
  if (capabilities.length > MAX_CAPABILITIES) {
    throw new Error(`At most ${MAX_CAPABILITIES} capabilities.`);
  }
  const cleaned: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  for (const c of capabilities) {
    if (!c || typeof c !== "object") {
      throw new Error("Each capability must be an object.");
    }
    const obj = c as Record<string, unknown>;
    const name = obj.name;
    if (typeof name !== "string" || !CAPABILITY_NAME_RE.test(name)) {
      throw new Error("capability.name must be 2-40 chars, [a-z0-9_.-].");
    }
    if (seen.has(name)) {
      throw new Error(`Duplicate capability name: ${name}.`);
    }
    seen.add(name);
    cleaned.push(obj);
  }
  db()
    .prepare("UPDATE agents SET capabilities = ? WHERE id = ?")
    .run(JSON.stringify(cleaned), id);
}

export function parseAgentCapabilities(a: Agent): Array<Record<string, unknown>> {
  try {
    const v = JSON.parse(a.capabilities || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function agentCapabilityNames(a: Agent): Set<string> {
  const names = new Set<string>();
  for (const c of parseAgentCapabilities(a)) {
    const n = c.name;
    if (typeof n === "string") names.add(n);
  }
  return names;
}
