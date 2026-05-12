import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestDb, teardownTestDb, resetTables } from "../helpers/setup";
import { _resetDbForTests, db } from "../../lib/db";
import {
  createAgentForUser,
  setAgentCapabilities,
} from "../../lib/agents";
import {
  createGroupConversation,
  listConversationEventsAfter,
} from "../../lib/conversations";
import {
  applyPatch,
  createWorkspace,
} from "../../lib/workspaces";
import {
  addTaskComment,
  createTask,
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
  return createAgentForUser(userId, {
    handle,
    display_name: handle,
  }).agent;
}

function befriend(a: string, b: string) {
  const [x, y] = a < b ? [a, b] : [b, a];
  db()
    .prepare(
      "INSERT INTO friendships (agent_a, agent_b, created_at) VALUES (?, ?, ?)",
    )
    .run(x, y, NOW);
}

function makeGroup(
  ownerUserId: string,
  ownerAgentId: string,
  otherAgentIds: string[],
) {
  for (const a of otherAgentIds) befriend(ownerAgentId, a);
  return createGroupConversation(
    ownerUserId,
    ownerAgentId,
    "demo group",
    otherAgentIds,
  );
}

describe("conversation_events bridges workspace + task into SSE", () => {
  it("emits workspace.changed when a patch lands on a conv-bound workspace", () => {
    const owner = seedAgent("usr_o", "owner");
    const bob = seedAgent("usr_b", "bob");
    const conv = makeGroup("usr_o", owner.id, [bob.id]);
    const ws = createWorkspace({
      name: "w",
      conversation_id: conv.id,
      created_by_agent_id: owner.id,
    });
    const r = applyPatch({
      workspace_id: ws.id,
      agent_id: owner.id,
      against_rev: ws.head_snapshot_id!,
      ops: [{ path: "a.txt", op: "create", content: "hi" }],
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const events = listConversationEventsAfter(conv.id, 0);
    const wsEvents = events.filter((e) => e.kind === "workspace.changed");
    assert.equal(wsEvents.length, 1);
    assert.equal(wsEvents[0].ref_id, r.snapshot_id);
  });

  it("emits task.created + task.assigned at creation and task.status_changed on transition", () => {
    const owner = seedAgent("usr_o", "owner");
    const bob = seedAgent("usr_b", "bob");
    setAgentCapabilities(bob.id, "usr_b", [
      { name: "workspace.write", version: "1" },
    ]);
    const conv = makeGroup("usr_o", owner.id, [bob.id]);
    const t = createTask({
      title: "x",
      owner_agent_id: owner.id,
      assigned_to_agent_id: bob.id,
      conversation_id: conv.id,
      required_capabilities: ["workspace.write"],
    });
    transitionTaskStatus({
      task_id: t.id,
      to_status: "in_progress",
      actor_agent_id: bob.id,
    });
    addTaskComment(t.id, bob.id, "WIP touching schema");
    const events = listConversationEventsAfter(conv.id, 0);
    const kinds = events.map((e) => e.kind);
    assert.ok(kinds.includes("task.created"));
    assert.ok(kinds.includes("task.assigned"));
    assert.ok(kinds.includes("task.status_changed"));
    assert.ok(kinds.includes("task.commented"));
    const created = events.find((e) => e.kind === "task.created");
    assert.equal(created?.ref_id, t.id);
  });

  it("does NOT emit conv events when the task has no conversation", () => {
    const owner = seedAgent("usr_o", "owner");
    const t = createTask({ title: "loose", owner_agent_id: owner.id });
    void t;
    const events = db()
      .prepare("SELECT COUNT(*) AS n FROM conversation_events")
      .get() as { n: number };
    assert.equal(events.n, 0);
  });
});
