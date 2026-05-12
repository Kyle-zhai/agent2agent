import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { setupTestDb, teardownTestDb, resetTables } from "../helpers/setup";
import { _resetDbForTests, db } from "../../lib/db";
import { createAgentForUser } from "../../lib/agents";
import {
  applyPatch,
  createWorkspace,
  fileDiffSummary,
  getBlob,
  getWorkspace,
  listFiles,
  putBlob,
  readFileAt,
  subscribeAgent,
} from "../../lib/workspaces";

let NOW = 1_700_000_000_000;
const RealDateNow = Date.now;

before(() => {
  setupTestDb();
  _resetDbForTests();
  Date.now = () => NOW;
});

after(() => {
  Date.now = RealDateNow;
  _resetDbForTests();
  teardownTestDb();
  // Best-effort: another test file may have written blobs concurrently.
  // We don't fail the suite on cleanup since blob contents are content-
  // addressed and harmless to leave between runs.
  const blobs = join(process.cwd(), "blobs", "workspace");
  if (existsSync(blobs)) {
    try {
      rmSync(blobs, { recursive: true, force: true });
    } catch {
      /* leave blobs for next test; they are content-addressed */
    }
  }
});

beforeEach(() => {
  resetTables(db());
});

function seedAgent(userId: string, handle: string) {
  db()
    .prepare(
      "INSERT INTO users (id, email, display_name, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(userId, `${handle}@t.test`, handle, "x".repeat(128), "y".repeat(32), NOW);
  return createAgentForUser(userId, {
    handle,
    display_name: handle,
  }).agent;
}

describe("content-addressed blob store", () => {
  it("dedups identical content", () => {
    const a = Buffer.from("hello world");
    const b = Buffer.from("hello world");
    const sha1 = putBlob(a);
    const sha2 = putBlob(b);
    assert.equal(sha1, sha2);
    assert.equal(sha1.length, 64);
    const round = getBlob(sha1);
    assert.equal(round.toString("utf8"), "hello world");
  });

  it("rejects invalid sha lookups", () => {
    assert.throws(() => getBlob("not-a-sha"), /Invalid content sha/);
  });
});

describe("createWorkspace + initial snapshot", () => {
  it("creates an empty workspace with head pointing at the initial snapshot", () => {
    const a = seedAgent("usr_test_a", "alpha");
    const ws = createWorkspace({
      name: "demo",
      conversation_id: null,
      created_by_agent_id: a.id,
    });
    assert.ok(ws.id.startsWith("wks_"));
    assert.ok(ws.head_snapshot_id?.startsWith("snap_"));
    const files = listFiles(ws.head_snapshot_id!);
    assert.equal(files.length, 0);
  });

  it("auto-subscribes the creator as admin", () => {
    const a = seedAgent("usr_test_a", "alpha");
    const ws = createWorkspace({
      name: "demo",
      conversation_id: null,
      created_by_agent_id: a.id,
    });
    const sub = db()
      .prepare(
        "SELECT role FROM workspace_subscriptions WHERE workspace_id = ? AND agent_id = ?",
      )
      .get(ws.id, a.id) as { role: string };
    assert.equal(sub.role, "admin");
  });
});

describe("applyPatch", () => {
  it("creates a new snapshot with the changes and advances head", () => {
    const a = seedAgent("usr_test_a", "alpha");
    const ws = createWorkspace({
      name: "w",
      conversation_id: null,
      created_by_agent_id: a.id,
    });
    const res = applyPatch({
      workspace_id: ws.id,
      agent_id: a.id,
      against_rev: ws.head_snapshot_id!,
      ops: [
        { path: "README.md", op: "create", content: "hello" },
        { path: "src/a.ts", op: "create", content: "export const x = 1;" },
      ],
      commit_message: "init",
    });
    assert.equal(res.ok, true);
    if (!res.ok) return;
    const newWs = getWorkspace(ws.id)!;
    assert.equal(newWs.head_snapshot_id, res.snapshot_id);

    const f = readFileAt(res.snapshot_id, "README.md");
    assert.equal(f?.content.toString("utf8"), "hello");
  });

  it("rejects with 409 conflict when against_rev != head", () => {
    const a = seedAgent("usr_test_a", "alpha");
    const ws = createWorkspace({
      name: "w",
      conversation_id: null,
      created_by_agent_id: a.id,
    });
    const stale = ws.head_snapshot_id!;
    applyPatch({
      workspace_id: ws.id,
      agent_id: a.id,
      against_rev: stale,
      ops: [{ path: "x.txt", op: "create", content: "a" }],
    });
    const conflict = applyPatch({
      workspace_id: ws.id,
      agent_id: a.id,
      against_rev: stale,
      ops: [{ path: "x.txt", op: "modify", content: "b" }],
    });
    assert.equal(conflict.ok, false);
    if (conflict.ok) return;
    assert.equal(conflict.conflict, true);
    assert.deepEqual(conflict.conflicting_paths, ["x.txt"]);
  });

  it("delete + create form fileDiffSummary correctly", () => {
    const a = seedAgent("usr_test_a", "alpha");
    const ws = createWorkspace({
      name: "w",
      conversation_id: null,
      created_by_agent_id: a.id,
    });
    const r1 = applyPatch({
      workspace_id: ws.id,
      agent_id: a.id,
      against_rev: ws.head_snapshot_id!,
      ops: [{ path: "a.txt", op: "create", content: "v1" }],
    });
    if (!r1.ok) return assert.fail("first patch should pass");
    const r2 = applyPatch({
      workspace_id: ws.id,
      agent_id: a.id,
      against_rev: r1.snapshot_id,
      ops: [
        { path: "a.txt", op: "modify", content: "v2" },
        { path: "b.txt", op: "create", content: "new" },
      ],
    });
    if (!r2.ok) return assert.fail("second patch should pass");
    const diff = fileDiffSummary(r1.snapshot_id, r2.snapshot_id);
    const byPath = new Map(diff.map((d) => [d.path, d.status]));
    assert.equal(byPath.get("a.txt"), "modified");
    assert.equal(byPath.get("b.txt"), "added");
  });

  it("rejects path traversal", () => {
    const a = seedAgent("usr_test_a", "alpha");
    const ws = createWorkspace({
      name: "w",
      conversation_id: null,
      created_by_agent_id: a.id,
    });
    assert.throws(
      () =>
        applyPatch({
          workspace_id: ws.id,
          agent_id: a.id,
          against_rev: ws.head_snapshot_id!,
          ops: [{ path: "../escape", op: "create", content: "x" }],
        }),
      /invalid|dot/i,
    );
  });
});

describe("subscriptions", () => {
  it("upserts role on duplicate subscribe", () => {
    const a = seedAgent("usr_test_a", "alpha");
    const b = seedAgent("usr_test_b", "bravo");
    const ws = createWorkspace({
      name: "w",
      conversation_id: null,
      created_by_agent_id: a.id,
    });
    subscribeAgent(ws.id, b.id, "reader");
    subscribeAgent(ws.id, b.id, "writer");
    const row = db()
      .prepare(
        "SELECT role FROM workspace_subscriptions WHERE workspace_id = ? AND agent_id = ?",
      )
      .get(ws.id, b.id) as { role: string };
    assert.equal(row.role, "writer");
  });
});
