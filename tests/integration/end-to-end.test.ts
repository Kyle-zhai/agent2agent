/**
 * 真实场景串测：从两个用户加好友 → 拉群 → 各自拉 agent → 互连 →
 * 创建 workspace + task → agent 改 workspace → 提交 patch → debate 审 →
 * done。覆盖 v0.5–v0.14 端到端。
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestDb, teardownTestDb, resetTables } from "../helpers/setup";
import { _resetDbForTests, db } from "../../lib/db";
import {
  createAgentForUser,
  setAgentCapabilities,
} from "../../lib/agents";
import { spawnManagedAgent } from "../../lib/managed-agents";
import {
  addOwnAgentToGroup,
  createGroupConversation,
  sendMessage,
} from "../../lib/conversations";
import {
  applyPatch,
  createWorkspace,
  subscribeAgent,
} from "../../lib/workspaces";
import {
  createTask,
  getTask,
  splitTask,
  transitionTaskStatus,
} from "../../lib/tasks";
import {
  areInterconnected,
  requestAgentLink,
  respondAgentLink,
} from "../../lib/agent-links";
import { runDebate } from "../../lib/debate";
import { invokeTool } from "../../lib/tools";
import {
  dispatchToolCall,
  listPendingForAgent,
  reportToolResult,
  _drainPendingForTests,
} from "../../lib/reverse-rpc";

let NOW = 1_700_000_000_000;
const RealDateNow = Date.now;

before(() => {
  setupTestDb();
  _resetDbForTests();
  Date.now = () => NOW;
});

after(() => {
  Date.now = RealDateNow;
  _drainPendingForTests();
  _resetDbForTests();
  teardownTestDb();
});

beforeEach(() => {
  resetTables(db());
});

function user(uid: string, email: string) {
  db()
    .prepare(
      "INSERT INTO users (id, email, display_name, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(uid, email, email.split("@")[0], "x".repeat(128), "y".repeat(32), NOW);
}

function befriend(a: string, b: string) {
  if (a === b) return;
  const [x, y] = a < b ? [a, b] : [b, a];
  db()
    .prepare(
      "INSERT OR IGNORE INTO friendships (agent_a, agent_b, created_at) VALUES (?, ?, ?)",
    )
    .run(x, y, NOW);
}

describe("E2E: full collaboration loop", () => {
  it("alice + bob can co-build a feature with debate + auto-criteria", async () => {
    // ── 1. Two users sign up. Each has a human-ish agent + a managed brain agent.
    user("usr_a", "alice@demo.app");
    user("usr_b", "bob@demo.app");
    const aliceHuman = createAgentForUser("usr_a", {
      handle: "alice",
      display_name: "Alice",
    }).agent;
    const aliceCoder = spawnManagedAgent("usr_a", {
      handle: "alicebot",
      display_name: "Alice Coder",
      persona: "coder",
      capabilities: [
        { name: "workspace.write", version: "1" },
        { name: "task.update", version: "1" },
      ],
    });
    const bobHuman = createAgentForUser("usr_b", {
      handle: "bob",
      display_name: "Bob",
    }).agent;
    const bobReviewer = spawnManagedAgent("usr_b", {
      handle: "bobbot",
      display_name: "Bob Reviewer",
      persona: "reviewer",
      capabilities: [
        { name: "workspace.write", version: "1" },
        { name: "task.review", version: "1" },
      ],
    });

    // ── 2. Cross-user friendships (humans + agents).
    befriend(aliceHuman.id, bobHuman.id);
    befriend(aliceHuman.id, bobReviewer.id);
    befriend(aliceCoder.id, bobHuman.id);
    befriend(aliceCoder.id, bobReviewer.id);
    // Same-user friendships so we can add own agent to group later.
    befriend(aliceHuman.id, aliceCoder.id);
    befriend(bobHuman.id, bobReviewer.id);

    // ── 3. Alice creates a group with Bob's human. (mirrors clicking "+ Group" in /app/contacts)
    const conv = createGroupConversation(
      "usr_a",
      aliceHuman.id,
      "Project X",
      [bobHuman.id],
    );

    // ── 4. Each side pulls their own bot into the group (addOwnAgentToGroup,
    //       any member-user can do it, no owner required).
    addOwnAgentToGroup({
      conversation_id: conv.id,
      user_id: "usr_a",
      agent_id: aliceCoder.id,
    });
    addOwnAgentToGroup({
      conversation_id: conv.id,
      user_id: "usr_b",
      agent_id: bobReviewer.id,
    });

    // ── 5. Alice initiates agent interconnect between her coder and Bob's reviewer.
    const link = requestAgentLink({
      conversation_id: conv.id,
      my_agent_id: aliceCoder.id,
      their_agent_id: bobReviewer.id,
      initiating_user_id: "usr_a",
    });
    assert.equal(link.status, "pending");

    // ── 6. Bob accepts. They are now interconnected within this conv.
    respondAgentLink({
      link_id: link.id,
      responding_user_id: "usr_b",
      decision: "accept",
    });
    assert.equal(areInterconnected(aliceCoder.id, bobReviewer.id, conv.id), true);

    // ── 7. Alice creates a shared workspace bound to the group.
    const ws = createWorkspace({
      name: "schema-v2",
      conversation_id: conv.id,
      created_by_agent_id: aliceCoder.id,
    });
    // Auto-subscribe everyone as writer (matches the contacts "+ Workspace" UX).
    for (const a of [aliceHuman.id, bobHuman.id, bobReviewer.id]) {
      subscribeAgent(ws.id, a, "writer");
    }

    // ── 8. Alice's coder agent seeds the initial file via the tool channel.
    const seed = await invokeTool(
      aliceCoder.id,
      "workspace.write_file",
      {
        workspace_id: ws.id,
        path: "schema.sql",
        content: "CREATE TABLE friendships (a TEXT, b TEXT);",
        against_rev: ws.head_snapshot_id!,
        commit_message: "init schema",
      },
      null,
    );
    assert.equal(seed.ok, true);
    if (!seed.ok) return;
    const seedSnap = (seed.result as { snapshot_id?: string }).snapshot_id;
    assert.ok(seedSnap);

    // ── 9. Alice creates a task with debate panel criterion assigned to Bob's reviewer.
    const carol = createAgentForUser("usr_a", {
      handle: "carol",
      display_name: "Carol",
    }).agent;
    befriend(aliceHuman.id, carol.id);
    befriend(carol.id, bobHuman.id);
    befriend(carol.id, bobReviewer.id);
    befriend(carol.id, aliceCoder.id);
    // Carol joins the group as an additional reviewer.
    addOwnAgentToGroup({
      conversation_id: conv.id,
      user_id: "usr_a",
      agent_id: carol.id,
    });
    setAgentCapabilities(carol.id, "usr_a", [
      { name: "task.review", version: "1" },
    ]);

    const task = createTask({
      title: "Add CHECK to friendships PK",
      description: "Enforce a < b in schema.",
      owner_agent_id: aliceCoder.id,
      assigned_to_agent_id: bobReviewer.id,
      conversation_id: conv.id,
      workspace_id: ws.id,
      required_capabilities: ["workspace.write"],
      success_criteria: [
        { type: "diff_pattern", required: ["CHECK"] },
      ],
    });
    assert.equal(task.status, "assigned");

    // ── 10. Bob's reviewer (assignee) accepts → in_progress.
    await transitionTaskStatus({
      task_id: task.id,
      to_status: "in_progress",
      actor_agent_id: bobReviewer.id,
    });

    // ── 11. Bob's reviewer writes the patch via tool channel.
    const cur = (
      db()
        .prepare("SELECT head_snapshot_id FROM workspaces WHERE id = ?")
        .get(ws.id) as { head_snapshot_id: string }
    ).head_snapshot_id;
    const writeRes = await invokeTool(
      bobReviewer.id,
      "workspace.write_file",
      {
        workspace_id: ws.id,
        path: "schema.sql",
        content:
          "CREATE TABLE friendships (a TEXT, b TEXT, CHECK (a < b));",
        against_rev: cur,
        commit_message: "add CHECK",
        task_id: task.id,
      },
      task.id,
    );
    assert.equal(writeRes.ok, true);
    if (!writeRes.ok) return;
    const newSnap = (writeRes.result as { snapshot_id: string }).snapshot_id;

    // ── 12. Bob → awaiting_review.
    await transitionTaskStatus({
      task_id: task.id,
      to_status: "awaiting_review",
      actor_agent_id: bobReviewer.id,
    });

    // ── 13. Alice closes as done with the new snapshot.
    const done = await transitionTaskStatus({
      task_id: task.id,
      to_status: "done",
      actor_agent_id: aliceCoder.id,
      result_snapshot_id: newSnap,
    });
    assert.equal(done.task.status, "done");
    assert.equal(getTask(task.id)!.status, "done");
  });
});

describe("E2E: cross-user reverse RPC over interconnected agents", () => {
  it("alice's coder calls a hosted tool on bob's reviewer", async () => {
    user("usr_a", "a@x");
    user("usr_b", "b@x");
    const aliceCoder = createAgentForUser("usr_a", {
      handle: "alice",
      display_name: "Alice",
    }).agent;
    const bobReviewer = createAgentForUser("usr_b", {
      handle: "bob",
      display_name: "Bob",
    }).agent;
    befriend(aliceCoder.id, bobReviewer.id);
    setAgentCapabilities(bobReviewer.id, "usr_b", [
      { name: "mcp.host", tools: ["github.search"] },
    ]);

    // Alice dispatches; we simulate Bob's host agent reporting back.
    const callPromise = dispatchToolCall({
      caller_agent_id: aliceCoder.id,
      tool_name: "github.search",
      args: { q: "agent2agent" },
      timeout_ms: 5000,
    });
    const pending = listPendingForAgent(bobReviewer.id);
    assert.equal(pending.length, 1);
    reportToolResult({
      rpc_id: pending[0].id,
      reporter_agent_id: bobReviewer.id,
      ok: true,
      result: { hits: ["repo1", "repo2"] },
    });
    const result = await callPromise;
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.result, { hits: ["repo1", "repo2"] });
  });
});

describe("E2E: workspace + tasks bridge SSE events to conversation_events", () => {
  it("emits workspace.changed + task.* + agent_link.* events into conv stream", async () => {
    user("usr_a", "a@x");
    user("usr_b", "b@x");
    const a = createAgentForUser("usr_a", {
      handle: "alpha",
      display_name: "Alpha",
    }).agent;
    const b = createAgentForUser("usr_b", {
      handle: "bravo",
      display_name: "Bravo",
    }).agent;
    befriend(a.id, b.id);
    const conv = createGroupConversation("usr_a", a.id, "g", [b.id]);
    const ws = createWorkspace({
      name: "w",
      conversation_id: conv.id,
      created_by_agent_id: a.id,
    });
    subscribeAgent(ws.id, b.id, "writer");
    const r = applyPatch({
      workspace_id: ws.id,
      agent_id: a.id,
      against_rev: ws.head_snapshot_id!,
      ops: [{ path: "x.txt", op: "create", content: "x" }],
    });
    if (!r.ok) return assert.fail();
    const t = createTask({
      title: "x",
      owner_agent_id: a.id,
      assigned_to_agent_id: b.id,
      conversation_id: conv.id,
    });
    sendMessage(conv.id, a.id, { text: "hello" });

    // Plus an agent_link request → conversation_events.
    const link = requestAgentLink({
      conversation_id: conv.id,
      my_agent_id: a.id,
      their_agent_id: b.id,
      initiating_user_id: "usr_a",
    });
    respondAgentLink({
      link_id: link.id,
      responding_user_id: "usr_b",
      decision: "accept",
    });

    const events = db()
      .prepare(
        "SELECT kind FROM conversation_events WHERE conversation_id = ? ORDER BY id",
      )
      .all(conv.id) as Array<{ kind: string }>;
    const kinds = events.map((e) => e.kind);
    assert.ok(kinds.includes("workspace.changed"));
    assert.ok(kinds.includes("task.created"));
    assert.ok(kinds.includes("task.assigned"));
    assert.ok(kinds.includes("message"));
    assert.ok(kinds.includes("agent_link.request"));
    assert.ok(kinds.includes("agent_link.accepted"));
    void t;
  });
});

describe("E2E: Hub & Spoke fan-out + debate panel together", () => {
  it("fan-out 3 sibling subtasks; one of them goes through debate", async () => {
    user("usr_a", "a@x");
    user("usr_b", "b@x");
    user("usr_c", "c@x");
    const ownerAgent = createAgentForUser("usr_a", {
      handle: "owner",
      display_name: "Owner",
    }).agent;
    const proAgent = createAgentForUser("usr_a", {
      handle: "pro",
      display_name: "Pro",
    }).agent;
    const conAgent = createAgentForUser("usr_b", {
      handle: "con",
      display_name: "Con",
    }).agent;
    const arbAgent = createAgentForUser("usr_c", {
      handle: "arb",
      display_name: "Arb",
    }).agent;
    for (const x of [proAgent.id, conAgent.id, arbAgent.id]) {
      befriend(ownerAgent.id, x);
    }
    befriend(proAgent.id, conAgent.id);
    befriend(proAgent.id, arbAgent.id);
    befriend(conAgent.id, arbAgent.id);
    const conv = createGroupConversation("usr_a", ownerAgent.id, "p", [
      proAgent.id,
      conAgent.id,
      arbAgent.id,
    ]);
    const ws = createWorkspace({
      name: "w",
      conversation_id: conv.id,
      created_by_agent_id: ownerAgent.id,
    });
    subscribeAgent(ws.id, proAgent.id, "writer");
    subscribeAgent(ws.id, conAgent.id, "writer");
    subscribeAgent(ws.id, arbAgent.id, "reader");

    // Parent task — debate panel criterion attached.
    const parent = createTask({
      title: "Should we merge?",
      owner_agent_id: ownerAgent.id,
      conversation_id: conv.id,
      workspace_id: ws.id,
      success_criteria: [
        {
          type: "debate_panel",
          pro_agent_id: proAgent.id,
          con_agent_id: conAgent.id,
          arbiter_agent_id: arbAgent.id,
        },
      ],
    });

    // Fan out 3 prep subtasks.
    splitTask({
      parent_task_id: parent.id,
      actor_agent_id: ownerAgent.id,
      branches: [
        { title: "draft proposal", assigned_to_agent_id: proAgent.id },
        { title: "draft objections", assigned_to_agent_id: conAgent.id },
        { title: "draft synthesis", assigned_to_agent_id: arbAgent.id },
      ],
    });
    const children = db()
      .prepare("SELECT id, assigned_to_agent_id FROM tasks WHERE parent_task_id = ?")
      .all(parent.id) as Array<{ id: string; assigned_to_agent_id: string }>;
    assert.equal(children.length, 3);

    // Parent should be blocked by 3 subtasks now.
    const blockers = db()
      .prepare("SELECT COUNT(*) AS n FROM task_dependencies WHERE blocked_task_id = ?")
      .get(parent.id) as { n: number };
    assert.equal(blockers.n, 3);

    // Parent is in `open`; transition to `assigned` first (no dep gate on
    // that edge), then attempting `assigned → in_progress` is blocked by
    // the 3 unfinished children.
    await transitionTaskStatus({
      task_id: parent.id,
      to_status: "assigned",
      actor_agent_id: ownerAgent.id,
    });
    await assert.rejects(
      transitionTaskStatus({
        task_id: parent.id,
        to_status: "in_progress",
        actor_agent_id: ownerAgent.id,
      }),
      /blocked by/,
    );

    // Close all children → parent unblocks.
    for (const c of children) {
      await transitionTaskStatus({
        task_id: c.id,
        to_status: "in_progress",
        actor_agent_id: c.assigned_to_agent_id,
      });
      await transitionTaskStatus({
        task_id: c.id,
        to_status: "awaiting_review",
        actor_agent_id: c.assigned_to_agent_id,
      });
      await transitionTaskStatus({
        task_id: c.id,
        to_status: "done",
        actor_agent_id: c.assigned_to_agent_id,
      });
    }

    // Patch the workspace so debate has a snapshot to read.
    const r = applyPatch({
      workspace_id: ws.id,
      agent_id: ownerAgent.id,
      against_rev: ws.head_snapshot_id!,
      ops: [{ path: "proposal.md", op: "create", content: "ship it" }],
    });
    if (!r.ok) return assert.fail();

    // Parent already transitioned to `assigned` above; now children are
    // done so it can proceed.
    await transitionTaskStatus({
      task_id: parent.id,
      to_status: "in_progress",
      actor_agent_id: ownerAgent.id,
    });
    await transitionTaskStatus({
      task_id: parent.id,
      to_status: "awaiting_review",
      actor_agent_id: ownerAgent.id,
    });
    db()
      .prepare("UPDATE tasks SET result_snapshot_id = ? WHERE id = ?")
      .run(r.snapshot_id, parent.id);

    // Stub the three brain steps so debate is deterministic.
    let calls = 0;
    const outcome = await runDebate(
      getTask(parent.id)!,
      {
        pro_agent_id: proAgent.id,
        con_agent_id: conAgent.id,
        arbiter_agent_id: arbAgent.id,
      },
      async ({ role }) => {
        calls++;
        if (role === "pro") return { text: "do it" };
        if (role === "con") return { text: "no obj" };
        return { text: '{"decision":"approve","reason":"unified"}' };
      },
    );
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.decision, "approve");
    assert.equal(calls, 3);
  });
});
