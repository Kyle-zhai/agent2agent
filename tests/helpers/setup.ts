import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let SCRATCH: string | null = null;

export function setupTestDb(): { scratch: string; dbPath: string } {
  SCRATCH = mkdtempSync(join(tmpdir(), "a2a-test-"));
  const dbPath = join(SCRATCH, "test.db");
  process.env.A2A_DB_PATH = dbPath;
  // Isolate workspace blob storage so test cleanup never touches the
  // dev/prod `./blobs/` tree — without this, running the suite once
  // wiped the demo seed's workspace blobs and "Files" pages broke with
  // "Blob not found" in the browser.
  process.env.A2A_BLOB_DIR = join(SCRATCH, "blobs");
  return { scratch: SCRATCH, dbPath };
}

export function teardownTestDb(): void {
  if (SCRATCH) {
    rmSync(SCRATCH, { recursive: true, force: true });
    SCRATCH = null;
  }
  delete process.env.A2A_DB_PATH;
  delete process.env.A2A_BLOB_DIR;
}

export function resetTables(db: { prepare: (sql: string) => { run: () => void } }): void {
  const tables = [
    "a2a_idempotency",
    "device_auth_requests",
    "password_reset_tokens",
    "email_verification_tokens",
    "a2a_push_configs",
    "shared_grants",
    "handoffs",
    "agent_links",
    "tool_call_requests",
    "invite_redemptions",
    "invite_links",
    "oauth_identities",
    "sandbox_runs",
    "tool_invocations",
    "agent_sessions",
    "task_artifacts",
    "task_dependencies",
    "task_events",
    "tasks",
    "workspace_files",
    "workspace_subscriptions",
    "workspace_snapshots",
    "workspaces",
    "message_reactions",
    "delivery_queue",
    "messages_fts",
    "message_attachments",
    "messages",
    "context_notes",
    "attachments",
    "conversation_events",
    "conversation_state",
    "conversation_personas",
    "conversation_members",
    "conversations",
    "friendships",
    "friend_requests",
    "agents",
    "sessions",
    "users",
    "audit_log",
    "rate_limit_buckets",
    "reply_jobs",
  ];
  for (const t of tables) {
    try {
      db.prepare(`DELETE FROM ${t}`).run();
    } catch {
      // ignore — table may not exist yet
    }
  }
}
