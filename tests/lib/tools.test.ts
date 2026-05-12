import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestDb, teardownTestDb, resetTables } from "../helpers/setup";
import { _resetDbForTests, db } from "../../lib/db";
import {
  createAgentForUser,
  setAgentCapabilities,
} from "../../lib/agents";
import {
  createWorkspace,
  applyPatch,
} from "../../lib/workspaces";
import {
  createTask,
  getTask,
} from "../../lib/tasks";
import { invokeTool, listToolsForAgent } from "../../lib/tools";
import {
  createDirectConversation,
} from "../../lib/conversations";

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

function befriend(a: string, b: string) {
  const [x, y] = a < b ? [a, b] : [b, a];
  db()
    .prepare(
      "INSERT INTO friendships (agent_a, agent_b, created_at) VALUES (?, ?, ?)",
    )
    .run(x, y, NOW);
}

describe("listToolsForAgent — gates by capability", () => {
  it("marks tools as allowed only when the agent has the capability", () => {
    const a = seedAgent("usr_a", "alpha");
    const list = listToolsForAgent(a);
    assert.equal(list.every((t) => !t.allowed), true);

    setAgentCapabilities(a.id, "usr_a", [
      { name: "workspace.read", version: "1" },
    ]);
    const a2 = require("../../lib/agents").getAgent(a.id);
    const list2 = listToolsForAgent(a2);
    const readTool = list2.find((t) => t.name === "workspace.read_file");
    const writeTool = list2.find((t) => t.name === "workspace.write_file");
    assert.equal(readTool?.allowed, true);
    assert.equal(writeTool?.allowed, false);
  });
});

describe("invokeTool — capability gate", () => {
  it("denies when capability missing and emits invoke_denied audit", async () => {
    const a = seedAgent("usr_a", "alpha");
    const ws = createWorkspace({
      name: "w",
      conversation_id: null,
      created_by_agent_id: a.id,
    });
    const r = await invokeTool(
      a.id,
      "workspace.read_file",
      { workspace_id: ws.id, path: "anything" },
      null,
    );
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.ok(r.error.includes("missing capability"));

    const audit = db()
      .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'tool.invoke_denied'")
      .get() as { n: number };
    assert.equal(audit.n, 1);
  });

  it("workspace.read_file returns file content when allowed", async () => {
    const a = seedAgent("usr_a", "alpha");
    setAgentCapabilities(a.id, "usr_a", [
      { name: "workspace.read", version: "1" },
      { name: "workspace.write", version: "1" },
    ]);
    const ws = createWorkspace({
      name: "w",
      conversation_id: null,
      created_by_agent_id: a.id,
    });
    const patch = applyPatch({
      workspace_id: ws.id,
      agent_id: a.id,
      against_rev: ws.head_snapshot_id!,
      ops: [{ path: "a.txt", op: "create", content: "hello" }],
    });
    if (!patch.ok) return assert.fail("seed patch failed");

    const r = await invokeTool(
      a.id,
      "workspace.read_file",
      { workspace_id: ws.id, path: "a.txt" },
      null,
    );
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const result = r.result as { content: string };
    assert.equal(result.content, "hello");
  });

  it("workspace.write_file returns conflict on stale against_rev", async () => {
    const a = seedAgent("usr_a", "alpha");
    setAgentCapabilities(a.id, "usr_a", [
      { name: "workspace.read", version: "1" },
      { name: "workspace.write", version: "1" },
    ]);
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
      ops: [{ path: "f.txt", op: "create", content: "1" }],
    });
    const r = await invokeTool(
      a.id,
      "workspace.write_file",
      {
        workspace_id: ws.id,
        path: "f.txt",
        content: "2",
        against_rev: stale,
      },
      null,
    );
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const result = r.result as { ok: boolean; conflict?: boolean };
    assert.equal(result.ok, false);
    assert.equal(result.conflict, true);
  });

  it("task.update_status transitions and persists", async () => {
    const owner = seedAgent("usr_o", "owner");
    const bob = seedAgent("usr_b", "bob");
    setAgentCapabilities(bob.id, "usr_b", [
      { name: "task.update", version: "1" },
    ]);
    const t = createTask({
      title: "x",
      owner_agent_id: owner.id,
      assigned_to_agent_id: bob.id,
    });
    const r = await invokeTool(
      bob.id,
      "task.update_status",
      { task_id: t.id, to_status: "in_progress" },
      null,
    );
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const after = getTask(t.id)!;
    assert.equal(after.status, "in_progress");
  });

  it("agent.send_message refuses non-members", async () => {
    const a = seedAgent("usr_a", "alpha");
    const b = seedAgent("usr_b", "bravo");
    const c = seedAgent("usr_c", "charlie");
    befriend(a.id, b.id);
    const conv = createDirectConversation("usr_a", a.id, b.id);
    setAgentCapabilities(c.id, "usr_c", [
      { name: "message.send", version: "1" },
    ]);
    const r = await invokeTool(
      c.id,
      "agent.send_message",
      { conversation_id: conv.id, text: "intrude" },
      null,
    );
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.ok(r.error.includes("not a member"));
  });

  it("records tool_invocations row with duration", async () => {
    const a = seedAgent("usr_a", "alpha");
    setAgentCapabilities(a.id, "usr_a", [
      { name: "workspace.read", version: "1" },
    ]);
    const ws = createWorkspace({
      name: "w",
      conversation_id: null,
      created_by_agent_id: a.id,
    });
    applyPatch({
      workspace_id: ws.id,
      agent_id: a.id,
      against_rev: ws.head_snapshot_id!,
      ops: [{ path: "a.txt", op: "create", content: "x" }],
    });
    await invokeTool(
      a.id,
      "workspace.read_file",
      { workspace_id: ws.id, path: "a.txt" },
      null,
    );
    const row = db()
      .prepare(
        "SELECT tool_name, duration_ms, error FROM tool_invocations WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(a.id) as {
      tool_name: string;
      duration_ms: number;
      error: string | null;
    };
    assert.equal(row.tool_name, "workspace.read_file");
    assert.ok(row.duration_ms != null);
    assert.equal(row.error, null);
  });
});
