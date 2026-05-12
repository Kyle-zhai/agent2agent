import "server-only";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, posix } from "node:path";
import { db } from "./db";
import { sha256HexOfBuffer } from "./crypto";
import { newSnapshotId, newWorkspaceId } from "./ids";
import { logAudit } from "./audit";
import { recordConversationEvent } from "./conversations";
import type {
  Workspace,
  WorkspaceFile,
  WorkspaceSnapshot,
  WorkspaceSubscription,
  WorkspaceSubscriptionRole,
} from "./types";

// ---- content-addressed blob store -------------------------------------------

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_FILES_PER_SNAPSHOT = 5_000;

const PATH_RE = /^(?!\.)[^\\\0]+$/; // no backslash, no NUL, no leading dot
const SEG_RE = /^[A-Za-z0-9._-][A-Za-z0-9._\- ]{0,254}$/;

function workspaceBlobDir(): string {
  // Tests set A2A_BLOB_DIR to isolate from the dev/prod blob tree —
  // previously cleanup wiped the real blobs because the path was hardcoded.
  const root = process.env.A2A_BLOB_DIR ?? join(process.cwd(), "blobs");
  return join(root, "workspace");
}

function blobPathFor(sha: string): string {
  return join(workspaceBlobDir(), sha.slice(0, 2), sha);
}

export function putBlob(content: Buffer): string {
  if (content.length > MAX_FILE_BYTES) {
    throw new Error(
      `File too large: ${content.length} > ${MAX_FILE_BYTES}.`,
    );
  }
  const sha = sha256HexOfBuffer(content);
  const p = blobPathFor(sha);
  if (!existsSync(p)) {
    const dir = join(workspaceBlobDir(), sha.slice(0, 2));
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(p, content);
  }
  return sha;
}

export function getBlob(sha: string): Buffer {
  if (!/^[0-9a-f]{64}$/.test(sha)) {
    throw new Error("Invalid content sha.");
  }
  const p = blobPathFor(sha);
  if (!existsSync(p)) throw new Error("Blob not found.");
  return readFileSync(p);
}

// ---- path validation --------------------------------------------------------

export function normalizeWorkspacePath(rawPath: string): string {
  if (typeof rawPath !== "string" || rawPath.length === 0) {
    throw new Error("path required.");
  }
  if (rawPath.length > 1024) throw new Error("path too long.");
  if (!PATH_RE.test(rawPath)) throw new Error("path contains invalid chars.");
  const parts = rawPath.split("/");
  for (const seg of parts) {
    if (seg === "" || seg === "." || seg === "..") {
      throw new Error("path must not contain empty/dot segments.");
    }
    if (!SEG_RE.test(seg)) {
      throw new Error(`path segment invalid: ${seg}`);
    }
  }
  return posix.normalize(rawPath);
}

// ---- core CRUD --------------------------------------------------------------

export function createWorkspace(input: {
  name: string;
  conversation_id: string | null;
  created_by_agent_id: string | null;
}): Workspace {
  const name = input.name.trim();
  if (name.length < 1 || name.length > 80) {
    throw new Error("Workspace name must be 1-80 characters.");
  }
  const id = newWorkspaceId();
  const now = Date.now();
  db()
    .prepare(
      `INSERT INTO workspaces
       (id, conversation_id, name, head_snapshot_id, created_by_agent_id, created_at)
       VALUES (?, ?, ?, NULL, ?, ?)`,
    )
    .run(id, input.conversation_id, name, input.created_by_agent_id, now);

  // Initial empty snapshot so head_snapshot_id is never null after creation.
  const snapId = newSnapshotId();
  db()
    .prepare(
      `INSERT INTO workspace_snapshots
       (id, workspace_id, parent_snapshot_id, created_by_agent_id, commit_message, thinking, task_id, created_at)
       VALUES (?, ?, NULL, ?, ?, '', NULL, ?)`,
    )
    .run(snapId, id, input.created_by_agent_id, "initial", now);
  db()
    .prepare("UPDATE workspaces SET head_snapshot_id = ? WHERE id = ?")
    .run(snapId, id);

  if (input.created_by_agent_id) {
    subscribeAgent(id, input.created_by_agent_id, "admin");
  }
  logAudit("workspace.create", {
    agentId: input.created_by_agent_id ?? null,
    detail: { workspace_id: id, name },
  });
  return getWorkspace(id)!;
}

export function getWorkspace(id: string): Workspace | null {
  return (
    (db()
      .prepare(
        `SELECT id, conversation_id, name, head_snapshot_id,
                created_by_agent_id, created_at
         FROM workspaces WHERE id = ?`,
      )
      .get(id) as Workspace | undefined) ?? null
  );
}

export function listWorkspacesForConversation(
  conversationId: string,
): Workspace[] {
  return db()
    .prepare(
      `SELECT id, conversation_id, name, head_snapshot_id,
              created_by_agent_id, created_at
       FROM workspaces WHERE conversation_id = ?
       ORDER BY created_at DESC`,
    )
    .all(conversationId) as Workspace[];
}

export function listWorkspacesForAgent(agentId: string): Workspace[] {
  return db()
    .prepare(
      `SELECT w.id, w.conversation_id, w.name, w.head_snapshot_id,
              w.created_by_agent_id, w.created_at
       FROM workspaces w
       JOIN workspace_subscriptions s ON s.workspace_id = w.id
       WHERE s.agent_id = ?
       ORDER BY w.created_at DESC`,
    )
    .all(agentId) as Workspace[];
}

// ---- subscriptions ----------------------------------------------------------

export function subscribeAgent(
  workspaceId: string,
  agentId: string,
  role: WorkspaceSubscriptionRole,
): void {
  const now = Date.now();
  db()
    .prepare(
      `INSERT INTO workspace_subscriptions
       (workspace_id, agent_id, role, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(workspace_id, agent_id) DO UPDATE SET role = excluded.role`,
    )
    .run(workspaceId, agentId, role, now);
  logAudit("workspace.subscribe", {
    agentId,
    detail: { workspace_id: workspaceId, role },
  });
}

export function unsubscribeAgent(workspaceId: string, agentId: string): void {
  db()
    .prepare(
      `DELETE FROM workspace_subscriptions
       WHERE workspace_id = ? AND agent_id = ?`,
    )
    .run(workspaceId, agentId);
}

export function getSubscription(
  workspaceId: string,
  agentId: string,
): WorkspaceSubscription | null {
  return (
    (db()
      .prepare(
        `SELECT workspace_id, agent_id, role, created_at
         FROM workspace_subscriptions
         WHERE workspace_id = ? AND agent_id = ?`,
      )
      .get(workspaceId, agentId) as WorkspaceSubscription | undefined) ?? null
  );
}

export function listSubscribers(workspaceId: string): WorkspaceSubscription[] {
  return db()
    .prepare(
      `SELECT workspace_id, agent_id, role, created_at
       FROM workspace_subscriptions WHERE workspace_id = ?`,
    )
    .all(workspaceId) as WorkspaceSubscription[];
}

export function canRead(workspaceId: string, agentId: string): boolean {
  return getSubscription(workspaceId, agentId) !== null;
}

export function canWrite(workspaceId: string, agentId: string): boolean {
  const s = getSubscription(workspaceId, agentId);
  return !!s && (s.role === "writer" || s.role === "admin");
}

// ---- snapshots + files ------------------------------------------------------

export function getSnapshot(id: string): WorkspaceSnapshot | null {
  return (
    (db()
      .prepare(
        `SELECT id, workspace_id, parent_snapshot_id, created_by_agent_id,
                commit_message, thinking, task_id, created_at
         FROM workspace_snapshots WHERE id = ?`,
      )
      .get(id) as WorkspaceSnapshot | undefined) ?? null
  );
}

export function listSnapshotsForWorkspace(
  workspaceId: string,
  limit = 50,
): WorkspaceSnapshot[] {
  return db()
    .prepare(
      `SELECT id, workspace_id, parent_snapshot_id, created_by_agent_id,
              commit_message, thinking, task_id, created_at
       FROM workspace_snapshots
       WHERE workspace_id = ?
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(workspaceId, limit) as WorkspaceSnapshot[];
}

export function listFiles(snapshotId: string): WorkspaceFile[] {
  return db()
    .prepare(
      `SELECT snapshot_id, path, content_sha256, size_bytes
       FROM workspace_files WHERE snapshot_id = ?
       ORDER BY path ASC`,
    )
    .all(snapshotId) as WorkspaceFile[];
}

export function readFileAt(
  snapshotId: string,
  path: string,
): { file: WorkspaceFile; content: Buffer; missing?: boolean } | null {
  const norm = normalizeWorkspacePath(path);
  const row = db()
    .prepare(
      `SELECT snapshot_id, path, content_sha256, size_bytes
       FROM workspace_files WHERE snapshot_id = ? AND path = ?`,
    )
    .get(snapshotId, norm) as WorkspaceFile | undefined;
  if (!row) return null;
  // Defensive: if the blob is missing on disk (disk loss, manual rm, test
  // cleanup hitting prod paths in a misconfigured setup), return a placeholder
  // instead of throwing — the workspace page can then render a clear warning
  // rather than crash the whole route.
  try {
    return { file: row, content: getBlob(row.content_sha256) };
  } catch (err) {
    if (err instanceof Error && err.message === "Blob not found.") {
      console.warn("workspace blob missing on disk", {
        snapshot_id: snapshotId,
        path: row.path,
        sha: row.content_sha256,
      });
      return {
        file: row,
        content: Buffer.from(
          `[content unavailable — blob ${row.content_sha256.slice(0, 12)} missing from disk]`,
          "utf8",
        ),
        missing: true,
      };
    }
    throw err;
  }
}

// ---- patches ----------------------------------------------------------------

export type FileOp =
  | { path: string; op: "create" | "modify"; content: string | Buffer }
  | { path: string; op: "delete" };

export type PatchResult =
  | {
      ok: true;
      snapshot_id: string;
      parent_snapshot_id: string;
      changed: number;
    }
  | {
      ok: false;
      conflict: true;
      current_head: string;
      your_against_rev: string;
      conflicting_paths: string[];
    };

export function applyPatch(input: {
  workspace_id: string;
  agent_id: string | null;
  against_rev: string;
  ops: FileOp[];
  commit_message?: string;
  thinking?: string;
  task_id?: string | null;
}): PatchResult {
  const ws = getWorkspace(input.workspace_id);
  if (!ws) throw new Error("Workspace not found.");

  const tx = db().transaction(() => {
    const head = ws.head_snapshot_id;
    if (!head) throw new Error("Workspace has no head snapshot.");

    if (input.against_rev !== head) {
      const yourFiles = listFiles(input.against_rev).reduce(
        (acc, f) => acc.set(f.path, f.content_sha256),
        new Map<string, string>(),
      );
      const headFiles = listFiles(head).reduce(
        (acc, f) => acc.set(f.path, f.content_sha256),
        new Map<string, string>(),
      );
      const conflicting: string[] = [];
      for (const op of input.ops) {
        const norm = normalizeWorkspacePath(op.path);
        const yourSha = yourFiles.get(norm);
        const headSha = headFiles.get(norm);
        if (yourSha !== headSha) conflicting.push(norm);
      }
      // Even ops on previously-absent paths conflict if head added them.
      const ret: PatchResult = {
        ok: false,
        conflict: true,
        current_head: head,
        your_against_rev: input.against_rev,
        conflicting_paths: conflicting,
      };
      throw new PatchConflictError(ret);
    }

    if (input.ops.length > MAX_FILES_PER_SNAPSHOT) {
      throw new Error("Too many file ops in one patch.");
    }

    // 1. resolve new snapshot file set by cloning head and applying ops.
    const files = new Map<string, { sha: string; size: number }>();
    for (const f of listFiles(head)) {
      files.set(f.path, { sha: f.content_sha256, size: f.size_bytes });
    }
    let changed = 0;
    for (const op of input.ops) {
      const norm = normalizeWorkspacePath(op.path);
      if (op.op === "delete") {
        if (files.delete(norm)) changed += 1;
        continue;
      }
      const buf =
        typeof op.content === "string"
          ? Buffer.from(op.content, "utf8")
          : op.content;
      const sha = putBlob(buf);
      const prev = files.get(norm);
      if (!prev || prev.sha !== sha) {
        changed += 1;
      }
      files.set(norm, { sha, size: buf.length });
    }

    if (files.size > MAX_FILES_PER_SNAPSHOT) {
      throw new Error("Workspace would exceed file count limit.");
    }

    const now = Date.now();
    const snapId = newSnapshotId();
    db()
      .prepare(
        `INSERT INTO workspace_snapshots
         (id, workspace_id, parent_snapshot_id, created_by_agent_id,
          commit_message, thinking, task_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        snapId,
        input.workspace_id,
        head,
        input.agent_id,
        (input.commit_message ?? "").slice(0, 1000),
        (input.thinking ?? "").slice(0, 4000),
        input.task_id ?? null,
        now,
      );

    const insertFile = db().prepare(
      `INSERT INTO workspace_files
       (snapshot_id, path, content_sha256, size_bytes)
       VALUES (?, ?, ?, ?)`,
    );
    for (const [path, info] of files) {
      insertFile.run(snapId, path, info.sha, info.size);
    }
    db()
      .prepare("UPDATE workspaces SET head_snapshot_id = ? WHERE id = ?")
      .run(snapId, input.workspace_id);

    const result: PatchResult = {
      ok: true,
      snapshot_id: snapId,
      parent_snapshot_id: head,
      changed,
    };
    return result;
  });

  try {
    const res = tx();
    logAudit("workspace.patch", {
      agentId: input.agent_id ?? null,
      detail: {
        workspace_id: input.workspace_id,
        snapshot_id: (res as { snapshot_id?: string }).snapshot_id,
        changed: (res as { changed?: number }).changed,
        ops: input.ops.length,
      },
    });
    if (res.ok && ws.conversation_id) {
      recordConversationEvent(
        ws.conversation_id,
        "workspace.changed",
        res.snapshot_id,
      );
    }
    return res;
  } catch (err) {
    if (err instanceof PatchConflictError) {
      logAudit("workspace.patch_conflict", {
        agentId: input.agent_id ?? null,
        detail: {
          workspace_id: input.workspace_id,
          your_against_rev: input.against_rev,
          conflicting: err.result.ok ? [] : err.result.conflicting_paths,
        },
      });
      return err.result;
    }
    throw err;
  }
}

class PatchConflictError extends Error {
  constructor(public result: PatchResult) {
    super("conflict");
  }
}

// ---- unified diff helpers (display-only) ------------------------------------

export function shortenSha(sha: string): string {
  return sha.slice(0, 12);
}

export function fileDiffSummary(
  parentSnapshotId: string | null,
  childSnapshotId: string,
): Array<{
  path: string;
  status: "added" | "modified" | "deleted";
  size_bytes: number;
}> {
  const parent = parentSnapshotId ? listFiles(parentSnapshotId) : [];
  const child = listFiles(childSnapshotId);
  const parentMap = new Map(parent.map((f) => [f.path, f]));
  const childMap = new Map(child.map((f) => [f.path, f]));
  const result: Array<{
    path: string;
    status: "added" | "modified" | "deleted";
    size_bytes: number;
  }> = [];
  for (const [path, file] of childMap) {
    const p = parentMap.get(path);
    if (!p) {
      result.push({ path, status: "added", size_bytes: file.size_bytes });
    } else if (p.content_sha256 !== file.content_sha256) {
      result.push({ path, status: "modified", size_bytes: file.size_bytes });
    }
  }
  for (const [path, file] of parentMap) {
    if (!childMap.has(path)) {
      result.push({ path, status: "deleted", size_bytes: file.size_bytes });
    }
  }
  return result.sort((a, b) => a.path.localeCompare(b.path));
}
