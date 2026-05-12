import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestDb, teardownTestDb, resetTables } from "../helpers/setup";
import { _resetDbForTests, db } from "../../lib/db";
import {
  createAgentForUser,
  setAgentCapabilities,
} from "../../lib/agents";
import {
  applyPatch,
  createWorkspace,
} from "../../lib/workspaces";
import { runSandbox, listSandboxRunsForTask } from "../../lib/sandbox";
import {
  createTask,
  getTask,
  transitionTaskStatus,
} from "../../lib/tasks";

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
  return createAgentForUser(userId, { handle, display_name: handle }).agent;
}

describe("sandbox local runtime", () => {
  it("runs a successful command against a snapshot and persists the row", async () => {
    const a = seedAgent("usr_a", "alpha");
    const ws = createWorkspace({
      name: "w",
      conversation_id: null,
      created_by_agent_id: a.id,
    });
    const r = applyPatch({
      workspace_id: ws.id,
      agent_id: a.id,
      against_rev: ws.head_snapshot_id!,
      ops: [{ path: "README.md", op: "create", content: "hello" }],
    });
    if (!r.ok) return assert.fail("seed patch failed");
    // need a task to associate with
    const t = createTask({ title: "x", owner_agent_id: a.id });
    const run = await runSandbox({
      cmd: "cat README.md",
      snapshot_id: r.snapshot_id,
      task_id: t.id,
      initiated_by_agent_id: a.id,
      timeout_ms: 5000,
    });
    assert.equal(run.runtime, "local");
    assert.equal(run.exit_code, 0);
    assert.ok(run.stdout.includes("hello"));
    const rows = listSandboxRunsForTask(t.id);
    assert.equal(rows.length, 1);
  });

  it("non-zero exit produces non-zero exit_code", async () => {
    const a = seedAgent("usr_a", "alpha");
    const t = createTask({ title: "x", owner_agent_id: a.id });
    const run = await runSandbox({
      cmd: "exit 7",
      snapshot_id: null,
      task_id: t.id,
      initiated_by_agent_id: a.id,
      timeout_ms: 5000,
    });
    assert.equal(run.exit_code, 7);
  });

  it("test_command criterion blocks done when exit_code != 0", async () => {
    const owner = seedAgent("usr_o", "owner");
    const bob = seedAgent("usr_b", "bob");
    setAgentCapabilities(bob.id, "usr_b", [
      { name: "workspace.write", version: "1" },
    ]);
    const ws = createWorkspace({
      name: "w",
      conversation_id: null,
      created_by_agent_id: owner.id,
    });
    db()
      .prepare(
        "INSERT INTO workspace_subscriptions (workspace_id, agent_id, role, created_at) VALUES (?, ?, 'writer', ?)",
      )
      .run(ws.id, bob.id, NOW);
    const r = applyPatch({
      workspace_id: ws.id,
      agent_id: bob.id,
      against_rev: ws.head_snapshot_id!,
      ops: [{ path: "fail.sh", op: "create", content: "exit 1" }],
    });
    if (!r.ok) return assert.fail("seed patch");
    const t = createTask({
      title: "x",
      owner_agent_id: owner.id,
      assigned_to_agent_id: bob.id,
      workspace_id: ws.id,
      required_capabilities: ["workspace.write"],
      success_criteria: [{ type: "test_command", cmd: "bash fail.sh" }],
    });
    await transitionTaskStatus({
      task_id: t.id,
      to_status: "in_progress",
      actor_agent_id: bob.id,
    });
    await transitionTaskStatus({
      task_id: t.id,
      to_status: "awaiting_review",
      actor_agent_id: bob.id,
    });
    const res = await transitionTaskStatus({
      task_id: t.id,
      to_status: "done",
      actor_agent_id: bob.id,
      result_snapshot_id: r.snapshot_id,
    });
    assert.equal(res.task.status, "changes_requested");
    assert.ok(res.criteria_failures && res.criteria_failures.length > 0);
  });

  it("test_command criterion passes done when exit_code == 0", async () => {
    const owner = seedAgent("usr_o", "owner");
    const bob = seedAgent("usr_b", "bob");
    setAgentCapabilities(bob.id, "usr_b", [
      { name: "workspace.write", version: "1" },
    ]);
    const ws = createWorkspace({
      name: "w",
      conversation_id: null,
      created_by_agent_id: owner.id,
    });
    db()
      .prepare(
        "INSERT INTO workspace_subscriptions (workspace_id, agent_id, role, created_at) VALUES (?, ?, 'writer', ?)",
      )
      .run(ws.id, bob.id, NOW);
    const r = applyPatch({
      workspace_id: ws.id,
      agent_id: bob.id,
      against_rev: ws.head_snapshot_id!,
      ops: [{ path: "ok.sh", op: "create", content: "exit 0" }],
    });
    if (!r.ok) return assert.fail("seed patch");
    const t = createTask({
      title: "x",
      owner_agent_id: owner.id,
      assigned_to_agent_id: bob.id,
      workspace_id: ws.id,
      required_capabilities: ["workspace.write"],
      success_criteria: [{ type: "test_command", cmd: "bash ok.sh" }],
    });
    await transitionTaskStatus({
      task_id: t.id,
      to_status: "in_progress",
      actor_agent_id: bob.id,
    });
    await transitionTaskStatus({
      task_id: t.id,
      to_status: "awaiting_review",
      actor_agent_id: bob.id,
    });
    await transitionTaskStatus({
      task_id: t.id,
      to_status: "done",
      actor_agent_id: bob.id,
      result_snapshot_id: r.snapshot_id,
    });
    assert.equal(getTask(t.id)!.status, "done");
  });

  it("skipped runtime returns skipped when A2A_SANDBOX_DISABLE=1", async () => {
    process.env.A2A_SANDBOX_DISABLE = "1";
    try {
      const a = seedAgent("usr_a", "alpha");
      const t = createTask({ title: "x", owner_agent_id: a.id });
      const run = await runSandbox({
        cmd: "echo nope",
        snapshot_id: null,
        task_id: t.id,
        initiated_by_agent_id: a.id,
      });
      assert.equal(run.runtime, "skipped");
    } finally {
      delete process.env.A2A_SANDBOX_DISABLE;
    }
  });
});
