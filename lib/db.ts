import "server-only";
import Database from "better-sqlite3";
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const DATA_DIR = join(process.cwd(), "data");
const DB_PATH = join(DATA_DIR, "a2a.db");

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

let _db: Database.Database | null = null;

export function db(): Database.Database {
  if (_db) return _db;
  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  init(_db);
  return _db;
}

export function init(database?: Database.Database): void {
  const d = database ?? db();
  for (const stmt of SCHEMA_STATEMENTS) {
    d.prepare(stmt).run();
  }
}

const SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`,

  `CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    display_name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    avatar_emoji TEXT NOT NULL DEFAULT '🤖',
    api_key_hash TEXT NOT NULL,
    api_key_prefix TEXT NOT NULL,
    last_seen_at INTEGER,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_agents_owner ON agents(owner_user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_agents_api_key_hash ON agents(api_key_hash)`,

  `CREATE TABLE IF NOT EXISTS friend_requests (
    id TEXT PRIMARY KEY,
    from_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    to_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('pending','accepted','rejected')),
    created_at INTEGER NOT NULL,
    responded_at INTEGER,
    UNIQUE (from_agent_id, to_agent_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_fr_to ON friend_requests(to_agent_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_fr_from ON friend_requests(from_agent_id, status)`,

  `CREATE TABLE IF NOT EXISTS friendships (
    agent_a TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    agent_b TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (agent_a, agent_b),
    CHECK (agent_a < agent_b)
  )`,

  `CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK (type IN ('direct','group')),
    title TEXT,
    created_by_agent_id TEXT NOT NULL REFERENCES agents(id),
    created_at INTEGER NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS conversation_members (
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','member')),
    joined_at INTEGER NOT NULL,
    last_read_message_id TEXT,
    PRIMARY KEY (conversation_id, agent_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_cm_agent ON conversation_members(agent_id)`,

  `CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    blob_path TEXT NOT NULL,
    uploaded_by_agent_id TEXT NOT NULL REFERENCES agents(id),
    created_at INTEGER NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS context_notes (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    from_agent_id TEXT NOT NULL REFERENCES agents(id),
    title TEXT NOT NULL,
    markdown_path TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    frontmatter_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    from_agent_id TEXT NOT NULL REFERENCES agents(id),
    text TEXT NOT NULL DEFAULT '',
    context_note_id TEXT REFERENCES context_notes(id),
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at)`,

  `CREATE TABLE IF NOT EXISTS message_attachments (
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
    PRIMARY KEY (message_id, attachment_id)
  )`,

  `CREATE TABLE IF NOT EXISTS delivery_queue (
    id TEXT PRIMARY KEY,
    target_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    delivered_at INTEGER,
    ack_at INTEGER,
    created_at INTEGER NOT NULL,
    UNIQUE (target_agent_id, message_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_dq_target_pending
    ON delivery_queue(target_agent_id, ack_at)`,
];
