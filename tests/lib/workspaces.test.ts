import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestDb, teardownTestDb, resetTables } from "../helpers/setup";
import { _resetDbForTests, db } from "../../lib/db";
import { createAgentForUser, setAgentCapabilities } from "../../lib/agents";
import {
  applyPatch,
  createWorkspace,
  fileDiffSummary,
  getBlob,
  getWorkspace,
  listFiles,
  putBlob,
  readFileAt,
  recentWorkspaceChangesForAgent,
  subscribeAgent,
} from "../../lib/workspaces";
import { invokeTool } from "../../lib/tools";

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
  // teardownTestDb() also wipes the per-test A2A_BLOB_DIR scratch tree,
  // so no manual blob cleanup needed here. Previously this hardcoded
  // `process.cwd()/blobs/workspace` and clobbered the real dev/prod tree.
  teardownTestDb();
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

  it("rejects with 409 conflict when against_rev != head AND same file changed", () => {
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

  it("trivially rebases a stale patch when it touches DIFFERENT files", () => {
    // Two agents editing different files off the same base must NOT 409 —
    // the concurrent change touched another path, so replaying on head is
    // safe and loses no work.
    const a = seedAgent("usr_test_a", "alpha");
    const b = seedAgent("usr_test_b", "bravo");
    const ws = createWorkspace({
      name: "w",
      conversation_id: null,
      created_by_agent_id: a.id,
    });
    db()
      .prepare(
        "INSERT INTO workspace_subscriptions (workspace_id, agent_id, role, created_at) VALUES (?, ?, 'writer', ?)",
      )
      .run(ws.id, b.id, NOW);
    const base = ws.head_snapshot_id!;
    // A advances head by writing a.txt.
    const ra = applyPatch({
      workspace_id: ws.id,
      agent_id: a.id,
      against_rev: base,
      ops: [{ path: "a.txt", op: "create", content: "from alpha" }],
    });
    assert.ok(ra.ok);
    // B patches b.txt against the now-stale base — should auto-rebase.
    const rb = applyPatch({
      workspace_id: ws.id,
      agent_id: b.id,
      against_rev: base,
      ops: [{ path: "b.txt", op: "create", content: "from bravo" }],
    });
    assert.equal(rb.ok, true);
    if (!rb.ok) return;
    assert.equal(rb.rebased_from, base);
    // Both files survive at the new head.
    assert.equal(
      readFileAt(rb.snapshot_id, "a.txt")?.content.toString("utf8"),
      "from alpha",
    );
    assert.equal(
      readFileAt(rb.snapshot_id, "b.txt")?.content.toString("utf8"),
      "from bravo",
    );
  });

  it("auto-MERGES same-file edits on different lines (v0.20 three-way merge)", () => {
    const a = seedAgent("usr_test_a", "alpha");
    const b = seedAgent("usr_test_b", "bravo");
    const ws = createWorkspace({ name: "w", conversation_id: null, created_by_agent_id: a.id });
    db()
      .prepare(
        "INSERT INTO workspace_subscriptions (workspace_id, agent_id, role, created_at) VALUES (?, ?, 'writer', ?)",
      )
      .run(ws.id, b.id, NOW);
    // Seed a shared file.
    const seed = applyPatch({
      workspace_id: ws.id, agent_id: a.id, against_rev: ws.head_snapshot_id!,
      ops: [{ path: "doc.md", op: "create", content: "line1\nline2\nline3\n" }],
    });
    assert.ok(seed.ok);
    if (!seed.ok) return;
    const base = seed.snapshot_id;
    // A edits line 1 → advances head.
    const ra = applyPatch({
      workspace_id: ws.id, agent_id: a.id, against_rev: base,
      ops: [{ path: "doc.md", op: "modify", content: "LINE1\nline2\nline3\n" }],
    });
    assert.ok(ra.ok);
    // B edits line 3 against the now-stale base — SAME file, different line.
    // Pre-v0.20 this hard-409'd; now it three-way merges.
    const rb = applyPatch({
      workspace_id: ws.id, agent_id: b.id, against_rev: base,
      ops: [{ path: "doc.md", op: "modify", content: "line1\nline2\nLINE3\n" }],
    });
    assert.equal(rb.ok, true);
    if (!rb.ok) return;
    assert.equal(rb.rebased_from, base);
    // Both edits survive in the merged head.
    assert.equal(
      readFileAt(rb.snapshot_id, "doc.md")?.content.toString("utf8"),
      "LINE1\nline2\nLINE3\n",
    );
  });

  it("still 409s a same-file SAME-LINE clash (real conflict → /resolve)", () => {
    const a = seedAgent("usr_test_a", "alpha");
    const b = seedAgent("usr_test_b", "bravo");
    const ws = createWorkspace({ name: "w", conversation_id: null, created_by_agent_id: a.id });
    db()
      .prepare(
        "INSERT INTO workspace_subscriptions (workspace_id, agent_id, role, created_at) VALUES (?, ?, 'writer', ?)",
      )
      .run(ws.id, b.id, NOW);
    const seed = applyPatch({
      workspace_id: ws.id, agent_id: a.id, against_rev: ws.head_snapshot_id!,
      ops: [{ path: "x.md", op: "create", content: "top\nshared\nbottom\n" }],
    });
    assert.ok(seed.ok);
    if (!seed.ok) return;
    const base = seed.snapshot_id;
    applyPatch({
      workspace_id: ws.id, agent_id: a.id, against_rev: base,
      ops: [{ path: "x.md", op: "modify", content: "top\nALPHA-WINS\nbottom\n" }],
    });
    const rb = applyPatch({
      workspace_id: ws.id, agent_id: b.id, against_rev: base,
      ops: [{ path: "x.md", op: "modify", content: "top\nBRAVO-WINS\nbottom\n" }],
    });
    assert.equal(rb.ok, false);
    if (rb.ok) return;
    assert.deepEqual(rb.conflicting_paths, ["x.md"]);
    // Alpha's content is intact at head — merge didn't clobber.
    assert.equal(
      readFileAt(getWorkspace(ws.id)!.head_snapshot_id!, "x.md")?.content.toString("utf8"),
      "top\nALPHA-WINS\nbottom\n",
    );
  });

  it("does NOT auto-rebase a create-vs-create on the SAME new path (must 409, no clobber)", () => {
    // The dangerous interleaving: both agents create the same brand-new path
    // off a base that lacks it. against_rev has no sha for the path, head has
    // one — these differ, so it must conflict, never silently overwrite.
    const a = seedAgent("usr_test_a", "alpha");
    const b = seedAgent("usr_test_b", "bravo");
    const ws = createWorkspace({ name: "w", conversation_id: null, created_by_agent_id: a.id });
    db()
      .prepare(
        "INSERT INTO workspace_subscriptions (workspace_id, agent_id, role, created_at) VALUES (?, ?, 'writer', ?)",
      )
      .run(ws.id, b.id, NOW);
    const base = ws.head_snapshot_id!;
    const ra = applyPatch({
      workspace_id: ws.id, agent_id: a.id, against_rev: base,
      ops: [{ path: "shared.txt", op: "create", content: "alpha's version" }],
    });
    assert.ok(ra.ok);
    const rb = applyPatch({
      workspace_id: ws.id, agent_id: b.id, against_rev: base,
      ops: [{ path: "shared.txt", op: "create", content: "bravo's version" }],
    });
    assert.equal(rb.ok, false);
    if (rb.ok) return;
    assert.deepEqual(rb.conflicting_paths, ["shared.txt"]);
    // alpha's content is intact at head — not clobbered.
    assert.equal(
      readFileAt(getWorkspace(ws.id)!.head_snapshot_id!, "shared.txt")?.content.toString("utf8"),
      "alpha's version",
    );
  });

  it("does NOT auto-rebase a modify against a path the peer deleted (must 409)", () => {
    const a = seedAgent("usr_test_a", "alpha");
    const b = seedAgent("usr_test_b", "bravo");
    const ws = createWorkspace({ name: "w", conversation_id: null, created_by_agent_id: a.id });
    db()
      .prepare(
        "INSERT INTO workspace_subscriptions (workspace_id, agent_id, role, created_at) VALUES (?, ?, 'writer', ?)",
      )
      .run(ws.id, b.id, NOW);
    const seed = applyPatch({
      workspace_id: ws.id, agent_id: a.id, against_rev: ws.head_snapshot_id!,
      ops: [{ path: "doc.md", op: "create", content: "original" }],
    });
    assert.ok(seed.ok);
    if (!seed.ok) return;
    const base = seed.snapshot_id;
    // A deletes doc.md → head no longer has it.
    const del = applyPatch({
      workspace_id: ws.id, agent_id: a.id, against_rev: base,
      ops: [{ path: "doc.md", op: "delete" }],
    });
    assert.ok(del.ok);
    // B modifies doc.md against the pre-delete base — must conflict.
    const rb = applyPatch({
      workspace_id: ws.id, agent_id: b.id, against_rev: base,
      ops: [{ path: "doc.md", op: "modify", content: "edited" }],
    });
    assert.equal(rb.ok, false);
    if (rb.ok) return;
    assert.deepEqual(rb.conflicting_paths, ["doc.md"]);
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

describe("diff awareness — workspace.diff tool + change feed", () => {
  it("recentWorkspaceChangesForAgent surfaces a PEER's snapshot, not my own", () => {
    const a = seedAgent("usr_test_a", "alpha");
    const b = seedAgent("usr_test_b", "bravo");
    const ws = createWorkspace({
      name: "w",
      conversation_id: null,
      created_by_agent_id: a.id,
    });
    subscribeAgent(ws.id, b.id, "writer");
    const base = ws.head_snapshot_id!;
    NOW += 1000;
    const ra = applyPatch({
      workspace_id: ws.id,
      agent_id: a.id,
      against_rev: base,
      ops: [{ path: "spec.md", op: "create", content: "v1" }],
    });
    assert.ok(ra.ok);

    // B sees A's change…
    const forB = recentWorkspaceChangesForAgent(b.id, base ? NOW - 5000 : 0);
    assert.equal(forB.length, 1);
    assert.equal(forB[0].created_by_agent_id, a.id);
    assert.deepEqual(
      forB[0].files.map((f) => `${f.status}:${f.path}`),
      ["added:spec.md"],
    );
    // …but A does NOT see their own change in the feed.
    const forA = recentWorkspaceChangesForAgent(a.id, NOW - 5000);
    assert.equal(forA.length, 0);
  });

  it("workspace.diff returns per-file status + line detail for the head change", async () => {
    const a = seedAgent("usr_test_a", "alpha");
    setAgentCapabilities(a.id, "usr_test_a", [
      { name: "workspace.read", version: "1" },
    ]);
    const ws = createWorkspace({
      name: "w",
      conversation_id: null,
      created_by_agent_id: a.id,
    });
    const base = ws.head_snapshot_id!;
    const r1 = applyPatch({
      workspace_id: ws.id,
      agent_id: a.id,
      against_rev: base,
      ops: [{ path: "f.txt", op: "create", content: "line1\nline2\n" }],
    });
    assert.ok(r1.ok);
    if (!r1.ok) return;
    const r2 = applyPatch({
      workspace_id: ws.id,
      agent_id: a.id,
      against_rev: r1.snapshot_id,
      ops: [{ path: "f.txt", op: "modify", content: "line1\nLINE2\nline3\n" }],
    });
    assert.ok(r2.ok);

    const out = await invokeTool(a.id, "workspace.diff", { workspace_id: ws.id }, null);
    assert.equal(out.ok, true);
    if (!out.ok) return;
    const res = out.result as {
      total_changed: number;
      files: Array<{ path: string; status: string; diff?: string }>;
    };
    assert.equal(res.total_changed, 1);
    assert.equal(res.files[0].path, "f.txt");
    assert.equal(res.files[0].status, "modified");
    assert.match(res.files[0].diff!, /- line2/);
    assert.match(res.files[0].diff!, /\+ LINE2/);
  });

  it("workspace.diff refuses a snapshot from another workspace (IDOR)", async () => {
    const a = seedAgent("usr_test_a", "alpha");
    setAgentCapabilities(a.id, "usr_test_a", [
      { name: "workspace.read", version: "1" },
    ]);
    const wsA = createWorkspace({ name: "a", conversation_id: null, created_by_agent_id: a.id });
    const wsB = createWorkspace({ name: "b", conversation_id: null, created_by_agent_id: a.id });
    const out = await invokeTool(
      a.id,
      "workspace.diff",
      { workspace_id: wsA.id, to_rev: wsB.head_snapshot_id },
      null,
    );
    assert.equal(out.ok, false);
  });
});
