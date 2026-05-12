import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let SCRATCH: string | null = null;

export function setupTestDb(): { scratch: string; dbPath: string } {
  SCRATCH = mkdtempSync(join(tmpdir(), "a2a-test-"));
  const dbPath = join(SCRATCH, "test.db");
  process.env.A2A_DB_PATH = dbPath;
  return { scratch: SCRATCH, dbPath };
}

export function teardownTestDb(): void {
  if (SCRATCH) {
    rmSync(SCRATCH, { recursive: true, force: true });
    SCRATCH = null;
  }
  delete process.env.A2A_DB_PATH;
}

export function resetTables(db: { prepare: (sql: string) => { run: () => void } }): void {
  const tables = [
    "invite_redemptions",
    "invite_links",
    "oauth_identities",
    "sandbox_runs",
    "tool_invocations",
    "agent_sessions",
    "task_artifacts",
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
