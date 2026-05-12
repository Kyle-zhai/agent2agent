import "server-only";
import Database from "better-sqlite3";
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

// Tests point at a throwaway SQLite file by setting A2A_DB_PATH before
// the first db() call. Production / dev fall back to ./data/a2a.db. We
// resolve at call time (not module-load) so tests can set the env after
// importing this module.

let _db: Database.Database | null = null;

function resolveDataDir(): string {
  return process.env.A2A_DB_PATH
    ? join(process.env.A2A_DB_PATH, "..")
    : join(process.cwd(), "data");
}

function resolveDbPath(): string {
  return process.env.A2A_DB_PATH ?? join(resolveDataDir(), "a2a.db");
}

export function db(): Database.Database {
  if (_db) return _db;
  const dataDir = resolveDataDir();
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  _db = new Database(resolveDbPath());
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  init(_db);
  migrate(_db);
  return _db;
}

/** TEST ONLY — drop the cached singleton so a subsequent db() call
 *  reopens against the current A2A_DB_PATH. */
export function _resetDbForTests(): void {
  if (_db) {
    try { _db.close(); } catch { /* ignore */ }
  }
  _db = null;
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
    avatar_blob_path TEXT,
    failed_login_count INTEGER NOT NULL DEFAULT 0,
    locked_until INTEGER,
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
    avatar_blob_path TEXT,
    api_key_hash TEXT NOT NULL,
    api_key_prefix TEXT NOT NULL,
    framework TEXT NOT NULL DEFAULT 'generic',
    agent_kind TEXT NOT NULL DEFAULT 'external'
      CHECK (agent_kind IN ('external','managed')),
    persona TEXT NOT NULL DEFAULT '',
    brain_config_json TEXT NOT NULL DEFAULT '{}',
    parent_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
    last_seen_at INTEGER,
    last_message_at INTEGER,
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
    thinking TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT 'normal' CHECK (kind IN ('normal','agent_to_agent','system')),
    context_note_id TEXT REFERENCES context_notes(id),
    reply_to_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
    edited_at INTEGER,
    deleted_at INTEGER,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_reply ON messages(reply_to_message_id)`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    message_id UNINDEXED, conversation_id UNINDEXED, text, thinking
  )`,

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

  `CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    detail_json TEXT NOT NULL DEFAULT '{}',
    ip TEXT,
    user_agent TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action, created_at DESC)`,

  `CREATE TABLE IF NOT EXISTS rate_limit_buckets (
    bucket_key TEXT PRIMARY KEY,
    tokens REAL NOT NULL,
    last_refill_at INTEGER NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS conversation_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    message_id TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_conv_events
    ON conversation_events(conversation_id, id DESC)`,

  `CREATE TABLE IF NOT EXISTS reply_jobs (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    trigger_message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending','running','done','failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    started_at INTEGER,
    finished_at INTEGER,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_reply_jobs_pending
    ON reply_jobs(status, created_at)`,

  `CREATE TABLE IF NOT EXISTS message_reactions (
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    emoji TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (message_id, agent_id, emoji)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_reactions_msg ON message_reactions(message_id)`,

  `CREATE TABLE IF NOT EXISTS conversation_state (
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    pinned_at INTEGER,
    muted_at INTEGER,
    archived_at INTEGER,
    PRIMARY KEY (conversation_id, agent_id)
  )`,

  `CREATE TABLE IF NOT EXISTS conversation_personas (
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    persona TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (conversation_id, agent_id)
  )`,

  // v0.5 autonomous-collab tables -----------------------------------------

  `CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    head_snapshot_id TEXT,
    created_by_agent_id TEXT REFERENCES agents(id),
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_workspaces_conv ON workspaces(conversation_id)`,

  `CREATE TABLE IF NOT EXISTS workspace_snapshots (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    parent_snapshot_id TEXT REFERENCES workspace_snapshots(id),
    created_by_agent_id TEXT REFERENCES agents(id),
    commit_message TEXT NOT NULL DEFAULT '',
    thinking TEXT NOT NULL DEFAULT '',
    task_id TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ws_snap_ws
    ON workspace_snapshots(workspace_id, created_at DESC)`,

  `CREATE TABLE IF NOT EXISTS workspace_files (
    snapshot_id TEXT NOT NULL REFERENCES workspace_snapshots(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    content_sha256 TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    PRIMARY KEY (snapshot_id, path)
  )`,

  `CREATE TABLE IF NOT EXISTS workspace_subscriptions (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('reader','writer','admin')),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, agent_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ws_subs_agent
    ON workspace_subscriptions(agent_id)`,

  `CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
    workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
    parent_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    owner_agent_id TEXT NOT NULL REFERENCES agents(id),
    assigned_to_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
    status TEXT NOT NULL CHECK (status IN
      ('open','assigned','in_progress','awaiting_review','changes_requested','done','cancelled')),
    required_capabilities TEXT NOT NULL DEFAULT '[]',
    success_criteria TEXT NOT NULL DEFAULT '[]',
    result_snapshot_id TEXT REFERENCES workspace_snapshots(id),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_conv ON tasks(conversation_id, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_assignee
    ON tasks(assigned_to_agent_id, status, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_owner
    ON tasks(owner_agent_id, status, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_workspace
    ON tasks(workspace_id, status)`,

  `CREATE TABLE IF NOT EXISTS task_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    actor_agent_id TEXT REFERENCES agents(id),
    kind TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_task_events_task
    ON task_events(task_id, id)`,

  `CREATE TABLE IF NOT EXISTS task_artifacts (
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    ref_id TEXT NOT NULL,
    added_by_agent_id TEXT REFERENCES agents(id),
    added_at INTEGER NOT NULL,
    PRIMARY KEY (task_id, kind, ref_id)
  )`,
];

function ensureColumn(
  d: Database.Database,
  table: string,
  column: string,
  ddl: string,
): void {
  const cols = d
    .prepare(`PRAGMA table_info(${table})`)
    .all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === column)) return;
  d.prepare(`ALTER TABLE ${table} ADD COLUMN ${ddl}`).run();
}

export function migrate(d: Database.Database): void {
  ensureColumn(d, "users", "avatar_blob_path", "avatar_blob_path TEXT");
  ensureColumn(d, "users", "failed_login_count", "failed_login_count INTEGER NOT NULL DEFAULT 0");
  ensureColumn(d, "users", "locked_until", "locked_until INTEGER");
  ensureColumn(d, "agents", "avatar_blob_path", "avatar_blob_path TEXT");
  ensureColumn(d, "agents", "framework", "framework TEXT NOT NULL DEFAULT 'generic'");
  ensureColumn(d, "agents", "last_message_at", "last_message_at INTEGER");
  ensureColumn(d, "agents", "agent_kind", "agent_kind TEXT NOT NULL DEFAULT 'external'");
  ensureColumn(d, "agents", "persona", "persona TEXT NOT NULL DEFAULT ''");
  ensureColumn(d, "agents", "brain_config_json", "brain_config_json TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(d, "agents", "parent_agent_id", "parent_agent_id TEXT");
  ensureColumn(d, "messages", "thinking", "thinking TEXT NOT NULL DEFAULT ''");
  ensureColumn(d, "messages", "kind", "kind TEXT NOT NULL DEFAULT 'normal'");
  ensureColumn(d, "messages", "reply_to_message_id", "reply_to_message_id TEXT");
  ensureColumn(d, "messages", "edited_at", "edited_at INTEGER");
  ensureColumn(d, "messages", "deleted_at", "deleted_at INTEGER");
  ensureColumn(d, "agents", "capabilities", "capabilities TEXT NOT NULL DEFAULT '[]'");
}
