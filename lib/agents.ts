import "server-only";
import { db } from "./db";
import { newAgentId, newApiKey } from "./ids";
import { sha256Hex } from "./crypto";
import type { Agent } from "./types";

export type { Agent } from "./types";

export function listAgentsForUser(userId: string): Agent[] {
  return db()
    .prepare(
      `SELECT id, owner_user_id, display_name, description, avatar_emoji,
              api_key_prefix, last_seen_at, created_at
       FROM agents WHERE owner_user_id = ? ORDER BY created_at DESC`,
    )
    .all(userId) as Agent[];
}

export function getAgent(id: string): Agent | null {
  const row = db()
    .prepare(
      `SELECT id, owner_user_id, display_name, description, avatar_emoji,
              api_key_prefix, last_seen_at, created_at
       FROM agents WHERE id = ?`,
    )
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
  },
): { agent: Agent; apiKey: string } {
  const display = input.display_name.trim();
  if (display.length < 1 || display.length > 60) {
    throw new Error("Display name must be 1-60 characters.");
  }
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
          api_key_hash, api_key_prefix, last_seen_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      )
      .run(id, userId, display, description, emoji, keyHash, prefix, now);
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
  db().prepare("DELETE FROM agents WHERE id = ?").run(id);
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
    .prepare(
      `SELECT id, owner_user_id, display_name, description, avatar_emoji,
              api_key_prefix, last_seen_at, created_at
       FROM agents WHERE api_key_hash = ?`,
    )
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
      `SELECT id, owner_user_id, display_name, description, avatar_emoji,
              api_key_prefix, last_seen_at, created_at
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
      `SELECT id, owner_user_id, display_name, description, avatar_emoji,
              api_key_prefix, last_seen_at, created_at
       FROM agents WHERE id IN (${placeholders})`,
    )
    .all(...ids) as Agent[];
}
