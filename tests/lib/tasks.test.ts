import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestDb, teardownTestDb, resetTables } from "../helpers/setup";
import { _resetDbForTests, db } from "../../lib/db";
import {
  createAgentForUser,
  setAgentCapabilities,
} from "../../lib/agents";
import {
  approveTask,
  assignTask,
  createTask,
  getTask,
  isTransitionAllowed,
  listTaskEvents,
  parseSuccessCriteria,
  transitionTaskStatus,
} from "../../lib/tasks";
import {
  applyPatch,
  createWorkspace,
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

describe("task state machine", () => {
  it("allows expected transitions and rejects invalid ones", () => {
    assert.equal(isTransitionAllowed("open", "assigned"), true);
    assert.equal(isTransitionAllowed("open", "in_progress"), false);
    assert.equal(isTransitionAllowed("done", "open"), false);
    assert.equal(
      isTransitionAllowed("awaiting_review", "changes_requested"),
      true,
    );
    assert.equal(isTransitionAllowed("in_progress", "done"), false);
  });

  it("rejects illegal transition through the public API", () => {
    const owner = seedAgent("usr_o", "owner");
    const t = createTask({ title: "x", owner_agent_id: owner.id });
    assert.throws(
      () =>
        transitionTaskStatus({
          task_id: t.id,
          to_status: "done",
          actor_agent_id: owner.id,
        }),
      /Illegal status transition/,
    );
  });
});

describe("capability gating", () => {
  it("rejects assigning an agent missing required capabilities", () => {
    const owner = seedAgent("usr_o", "owner");
    const bob = seedAgent("usr_b", "bob");
    assert.throws(
      () =>
        createTask({
          title: "task",
          owner_agent_id: owner.id,
          assigned_to_agent_id: bob.id,
          required_capabilities: ["workspace.write"],
        }),
      /missing capabilities/,
    );
  });

  it("accepts after capabilities are set", () => {
    const owner = seedAgent("usr_o", "owner");
    const bob = seedAgent("usr_b", "bob");
    setAgentCapabilities(bob.id, "usr_b", [
      { name: "workspace.write", version: "1" },
    ]);
    const t = createTask({
      title: "task",
      owner_agent_id: owner.id,
      assigned_to_agent_id: bob.id,
      required_capabilities: ["workspace.write"],
    });
    assert.equal(t.status, "assigned");
    assert.equal(t.assigned_to_agent_id, bob.id);
  });
});

describe("comments + events", () => {
  it("records created + assigned + comment events", () => {
    const owner = seedAgent("usr_o", "owner");
    const bob = seedAgent("usr_b", "bob");
    const t = createTask({
      title: "x",
      owner_agent_id: owner.id,
      assigned_to_agent_id: bob.id,
    });
    transitionTaskStatus({
      task_id: t.id,
      to_status: "in_progress",
      actor_agent_id: bob.id,
      comment: "starting",
    });
    const events = listTaskEvents(t.id);
    const kinds = events.map((e) => e.kind);
    assert.ok(kinds.includes("created"));
    assert.ok(kinds.includes("assigned"));
    assert.ok(kinds.includes("status_change"));
    assert.ok(kinds.includes("comment"));
  });
});

describe("success_criteria — capability_check", () => {
  it("downgrades 'done' to 'changes_requested' if criteria fail", () => {
    const owner = seedAgent("usr_o", "owner");
    const bob = seedAgent("usr_b", "bob");
    setAgentCapabilities(bob.id, "usr_b", [
      { name: "workspace.write", version: "1" },
    ]);
    const t = createTask({
      title: "x",
      owner_agent_id: owner.id,
      assigned_to_agent_id: bob.id,
      required_capabilities: ["workspace.write"],
      success_criteria: [
        { type: "capability_check", must_include: ["shell.run"] },
      ],
    });
    transitionTaskStatus({
      task_id: t.id,
      to_status: "in_progress",
      actor_agent_id: bob.id,
    });
    transitionTaskStatus({
      task_id: t.id,
      to_status: "awaiting_review",
      actor_agent_id: bob.id,
    });
    const res = transitionTaskStatus({
      task_id: t.id,
      to_status: "done",
      actor_agent_id: bob.id,
    });
    const after = getTask(t.id)!;
    assert.equal(after.status, "changes_requested");
    assert.ok(res.criteria_failures && res.criteria_failures.length > 0);
  });

  it("passes 'done' when capability_check is satisfied", () => {
    const owner = seedAgent("usr_o", "owner");
    const bob = seedAgent("usr_b", "bob");
    setAgentCapabilities(bob.id, "usr_b", [
      { name: "workspace.write", version: "1" },
      { name: "shell.run", version: "1" },
    ]);
    const t = createTask({
      title: "x",
      owner_agent_id: owner.id,
      assigned_to_agent_id: bob.id,
      required_capabilities: ["workspace.write"],
      success_criteria: [
        { type: "capability_check", must_include: ["shell.run"] },
      ],
    });
    transitionTaskStatus({
      task_id: t.id,
      to_status: "in_progress",
      actor_agent_id: bob.id,
    });
    transitionTaskStatus({
      task_id: t.id,
      to_status: "awaiting_review",
      actor_agent_id: bob.id,
    });
    transitionTaskStatus({
      task_id: t.id,
      to_status: "done",
      actor_agent_id: bob.id,
    });
    assert.equal(getTask(t.id)!.status, "done");
  });
});

describe("success_criteria — diff_pattern", () => {
  it("blocks done when forbidden pattern present, accepts when removed", () => {
    const owner = seedAgent("usr_o", "owner");
    const bob = seedAgent("usr_b", "bob");
    const ws = createWorkspace({
      name: "w",
      conversation_id: null,
      created_by_agent_id: owner.id,
    });
    // give bob writer + needed cap
    setAgentCapabilities(bob.id, "usr_b", [
      { name: "workspace.write", version: "1" },
    ]);
    db()
      .prepare(
        "INSERT INTO workspace_subscriptions (workspace_id, agent_id, role, created_at) VALUES (?, ?, 'writer', ?)",
      )
      .run(ws.id, bob.id, NOW);
    const r = applyPatch({
      workspace_id: ws.id,
      agent_id: bob.id,
      against_rev: ws.head_snapshot_id!,
      ops: [{ path: "src/a.ts", op: "create", content: "console.log('debug')" }],
    });
    if (!r.ok) return assert.fail("patch should succeed");

    const t = createTask({
      title: "ship",
      owner_agent_id: owner.id,
      assigned_to_agent_id: bob.id,
      workspace_id: ws.id,
      required_capabilities: ["workspace.write"],
      success_criteria: [{ type: "diff_pattern", forbidden: ["console\\.log"] }],
    });
    transitionTaskStatus({ task_id: t.id, to_status: "in_progress", actor_agent_id: bob.id });
    transitionTaskStatus({
      task_id: t.id,
      to_status: "awaiting_review",
      actor_agent_id: bob.id,
    });
    const blocked = transitionTaskStatus({
      task_id: t.id,
      to_status: "done",
      actor_agent_id: bob.id,
      result_snapshot_id: r.snapshot_id,
    });
    assert.equal(blocked.task.status, "changes_requested");

    // bob fixes it
    const fix = applyPatch({
      workspace_id: ws.id,
      agent_id: bob.id,
      against_rev: r.snapshot_id,
      ops: [{ path: "src/a.ts", op: "modify", content: "// clean code" }],
    });
    if (!fix.ok) return assert.fail("fix patch should succeed");
    transitionTaskStatus({
      task_id: t.id,
      to_status: "in_progress",
      actor_agent_id: bob.id,
    });
    transitionTaskStatus({
      task_id: t.id,
      to_status: "awaiting_review",
      actor_agent_id: bob.id,
    });
    transitionTaskStatus({
      task_id: t.id,
      to_status: "done",
      actor_agent_id: bob.id,
      result_snapshot_id: fix.snapshot_id,
    });
    assert.equal(getTask(t.id)!.status, "done");
  });
});

describe("approveTask", () => {
  it("owner cannot self-approve", () => {
    const owner = seedAgent("usr_o", "owner");
    const t = createTask({ title: "x", owner_agent_id: owner.id });
    transitionTaskStatus({ task_id: t.id, to_status: "assigned", actor_agent_id: owner.id });
    // Can't transition further without assignee, but we want to test approval path
    // Manually mark as awaiting_review via legitimate path:
    db()
      .prepare("UPDATE tasks SET status = 'awaiting_review' WHERE id = ?")
      .run(t.id);
    assert.throws(
      () => approveTask(t.id, owner.id),
      /self-approve/,
    );
  });
});

describe("parseSuccessCriteria robustness", () => {
  it("returns [] on malformed JSON", () => {
    const owner = seedAgent("usr_o", "owner");
    const t = createTask({ title: "x", owner_agent_id: owner.id });
    db()
      .prepare("UPDATE tasks SET success_criteria = ? WHERE id = ?")
      .run("not json", t.id);
    const after = getTask(t.id)!;
    assert.deepEqual(parseSuccessCriteria(after), []);
  });
});
