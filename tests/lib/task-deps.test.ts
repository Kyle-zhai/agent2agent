import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestDb, teardownTestDb, resetTables } from "../helpers/setup";
import { _resetDbForTests, db } from "../../lib/db";
import { createAgentForUser } from "../../lib/agents";
import {
  addTaskDependency,
  createSubtask,
  createTask,
  getTask,
  isTaskBlocked,
  listBlockers,
  listBlocking,
  listChildren,
  removeTaskDependency,
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

function seedAgent(uid: string, handle: string) {
  db()
    .prepare(
      "INSERT INTO users (id, email, display_name, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(uid, `${handle}@t.test`, handle, "x".repeat(128), "y".repeat(32), NOW);
  return createAgentForUser(uid, { handle, display_name: handle }).agent;
}

describe("task_dependencies", () => {
  it("blocker → blocked: blocked can't transition to in_progress until blocker is done", async () => {
    const owner = seedAgent("usr_o", "owner");
    const bob = seedAgent("usr_b", "bob");
    const a = createTask({
      title: "first",
      owner_agent_id: owner.id,
      assigned_to_agent_id: bob.id,
    });
    const b = createTask({
      title: "second",
      owner_agent_id: owner.id,
      assigned_to_agent_id: bob.id,
    });
    addTaskDependency({
      blocker_task_id: a.id,
      blocked_task_id: b.id,
      actor_agent_id: owner.id,
    });
    const state = isTaskBlocked(b.id);
    assert.equal(state.blocked, true);
    assert.deepEqual(state.unmet_blockers, [a.id]);

    // try to move b → in_progress without finishing a
    await assert.rejects(
      transitionTaskStatus({
        task_id: b.id,
        to_status: "in_progress",
        actor_agent_id: bob.id,
      }),
      /blocked by/,
    );

    // finish a
    await transitionTaskStatus({
      task_id: a.id,
      to_status: "in_progress",
      actor_agent_id: bob.id,
    });
    await transitionTaskStatus({
      task_id: a.id,
      to_status: "awaiting_review",
      actor_agent_id: bob.id,
    });
    // mark a done via bypass (no criteria here)
    await transitionTaskStatus({
      task_id: a.id,
      to_status: "done",
      actor_agent_id: bob.id,
    });

    // now b can start
    await transitionTaskStatus({
      task_id: b.id,
      to_status: "in_progress",
      actor_agent_id: bob.id,
    });
    assert.equal(getTask(b.id)!.status, "in_progress");
  });

  it("rejects self-loop and cycle", () => {
    const owner = seedAgent("usr_o", "owner");
    const a = createTask({ title: "a", owner_agent_id: owner.id });
    const b = createTask({ title: "b", owner_agent_id: owner.id });
    const c = createTask({ title: "c", owner_agent_id: owner.id });

    assert.throws(
      () =>
        addTaskDependency({
          blocker_task_id: a.id,
          blocked_task_id: a.id,
          actor_agent_id: owner.id,
        }),
      /can't block itself/,
    );

    // a blocks b, b blocks c — adding c blocks a is a cycle
    addTaskDependency({
      blocker_task_id: a.id,
      blocked_task_id: b.id,
      actor_agent_id: owner.id,
    });
    addTaskDependency({
      blocker_task_id: b.id,
      blocked_task_id: c.id,
      actor_agent_id: owner.id,
    });
    assert.throws(
      () =>
        addTaskDependency({
          blocker_task_id: c.id,
          blocked_task_id: a.id,
          actor_agent_id: owner.id,
        }),
      /cycle/,
    );
  });

  it("rejects duplicate dependency", () => {
    const owner = seedAgent("usr_o", "owner");
    const a = createTask({ title: "a", owner_agent_id: owner.id });
    const b = createTask({ title: "b", owner_agent_id: owner.id });
    addTaskDependency({
      blocker_task_id: a.id,
      blocked_task_id: b.id,
      actor_agent_id: owner.id,
    });
    assert.throws(
      () =>
        addTaskDependency({
          blocker_task_id: a.id,
          blocked_task_id: b.id,
          actor_agent_id: owner.id,
        }),
      /already exists/,
    );
  });

  it("only blocked.owner can add or remove a dependency", () => {
    const owner = seedAgent("usr_o", "owner");
    const other = seedAgent("usr_x", "other");
    const a = createTask({ title: "a", owner_agent_id: owner.id });
    const b = createTask({ title: "b", owner_agent_id: owner.id });
    assert.throws(
      () =>
        addTaskDependency({
          blocker_task_id: a.id,
          blocked_task_id: b.id,
          actor_agent_id: other.id,
        }),
      /Only the blocked task's owner/,
    );
    addTaskDependency({
      blocker_task_id: a.id,
      blocked_task_id: b.id,
      actor_agent_id: owner.id,
    });
    assert.throws(
      () =>
        removeTaskDependency({
          blocker_task_id: a.id,
          blocked_task_id: b.id,
          actor_agent_id: other.id,
        }),
      /Only the blocked task's owner/,
    );
  });
});

describe("subtask 派生", () => {
  it("creates child + auto-blocks parent", () => {
    const owner = seedAgent("usr_o", "owner");
    const parent = createTask({ title: "parent", owner_agent_id: owner.id });
    const child = createSubtask({
      parent_task_id: parent.id,
      title: "child a",
      owner_agent_id: owner.id,
    });
    assert.equal(child.parent_task_id, parent.id);
    const kids = listChildren(parent.id);
    assert.equal(kids.length, 1);
    const blocking = listBlocking(child.id);
    assert.equal(blocking.length, 1);
    assert.equal(blocking[0].blocked_task_id, parent.id);
  });

  it("parent done is blocked until child done", async () => {
    const owner = seedAgent("usr_o", "owner");
    const parent = createTask({ title: "p", owner_agent_id: owner.id });
    const child = createSubtask({
      parent_task_id: parent.id,
      title: "c",
      owner_agent_id: owner.id,
    });

    // parent moves open → assigned ok (assigned has no dep gate)
    await transitionTaskStatus({
      task_id: parent.id,
      to_status: "assigned",
      actor_agent_id: owner.id,
    });

    // parent → in_progress is blocked
    await assert.rejects(
      transitionTaskStatus({
        task_id: parent.id,
        to_status: "in_progress",
        actor_agent_id: owner.id,
      }),
      /blocked by/,
    );

    // finish child end-to-end (no auto-criteria)
    await transitionTaskStatus({
      task_id: child.id,
      to_status: "assigned",
      actor_agent_id: owner.id,
    });
    // child has no assignee — owner can move it
    await transitionTaskStatus({
      task_id: child.id,
      to_status: "in_progress",
      actor_agent_id: owner.id,
    });
    await transitionTaskStatus({
      task_id: child.id,
      to_status: "awaiting_review",
      actor_agent_id: owner.id,
    });
    await transitionTaskStatus({
      task_id: child.id,
      to_status: "done",
      actor_agent_id: owner.id,
    });

    // now parent → in_progress works
    await transitionTaskStatus({
      task_id: parent.id,
      to_status: "in_progress",
      actor_agent_id: owner.id,
    });
    assert.equal(getTask(parent.id)!.status, "in_progress");
  });

  it("only parent.owner / assignee can spawn subtasks", () => {
    const owner = seedAgent("usr_o", "owner");
    const other = seedAgent("usr_x", "other");
    const parent = createTask({ title: "p", owner_agent_id: owner.id });
    assert.throws(
      () =>
        createSubtask({
          parent_task_id: parent.id,
          title: "c",
          owner_agent_id: other.id,
        }),
      /owner or assignee/,
    );
  });

  it("assignee can spawn subtask and parent IS auto-blocked (audit fix)", () => {
    const owner = seedAgent("usr_o", "owner");
    const assignee = seedAgent("usr_a", "assignee");
    const parent = createTask({
      title: "p",
      owner_agent_id: owner.id,
      assigned_to_agent_id: assignee.id,
    });
    const child = createSubtask({
      parent_task_id: parent.id,
      title: "c",
      owner_agent_id: assignee.id, // assignee, not owner
    });
    const blockers = listBlocking(child.id).map((d) => d.blocked_task_id);
    assert.deepEqual(
      blockers,
      [parent.id],
      "parent must be blocked by child even when subtask spawned by assignee",
    );
  });
});

describe("listBlockers / listBlocking", () => {
  it("returns correct edges", () => {
    const owner = seedAgent("usr_o", "owner");
    const a = createTask({ title: "a", owner_agent_id: owner.id });
    const b = createTask({ title: "b", owner_agent_id: owner.id });
    const c = createTask({ title: "c", owner_agent_id: owner.id });
    addTaskDependency({
      blocker_task_id: a.id,
      blocked_task_id: c.id,
      actor_agent_id: owner.id,
    });
    addTaskDependency({
      blocker_task_id: b.id,
      blocked_task_id: c.id,
      actor_agent_id: owner.id,
    });
    const bl = listBlockers(c.id).map((d) => d.blocker_task_id);
    assert.equal(bl.length, 2);
    assert.ok(bl.includes(a.id));
    assert.ok(bl.includes(b.id));
    const blkg = listBlocking(a.id).map((d) => d.blocked_task_id);
    assert.deepEqual(blkg, [c.id]);
  });
});
