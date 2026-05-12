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
  createGroupConversation,
} from "../../lib/conversations";
import {
  applyPatch,
  createWorkspace,
  subscribeAgent,
} from "../../lib/workspaces";
import {
  createTask,
  getTask,
  listTaskEvents,
  splitTask,
  transitionTaskStatus,
} from "../../lib/tasks";
import {
  parseArbiterDecision,
  runDebate,
  type DebateBrainStep,
} from "../../lib/debate";

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

function seedUserAgent(uid: string, handle: string) {
  db()
    .prepare(
      "INSERT INTO users (id, email, display_name, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(uid, `${handle}@t.test`, handle, "x".repeat(128), "y".repeat(32), NOW);
  return createAgentForUser(uid, { handle, display_name: handle }).agent;
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

describe("parseArbiterDecision", () => {
  it("returns approve on clean JSON approve", () => {
    const d = parseArbiterDecision('{"decision":"approve","reason":"clear"}');
    assert.equal(d.decision, "approve");
    assert.equal(d.reason, "clear");
  });
  it("treats anything non-approve as request_changes", () => {
    const d = parseArbiterDecision('{"decision":"meh","reason":"no opinion"}');
    assert.equal(d.decision, "request_changes");
  });
  it("malformed JSON → request_changes with reason", () => {
    const d = parseArbiterDecision("approve i guess");
    assert.equal(d.decision, "request_changes");
    assert.ok(d.reason.includes("JSON"));
  });
  it("clamps reason to 300 chars", () => {
    const long = "x".repeat(2000);
    const d = parseArbiterDecision(
      `{"decision":"approve","reason":"${long}"}`,
    );
    assert.ok(d.reason.length <= 300);
  });
});

describe("runDebate happy path", () => {
  it("with stubbed brain: pro+con+arbiter run; arbiter approve closes ok", async () => {
    const owner = seedUserAgent("usr_o", "owner");
    const proU = seedUserAgent("usr_p", "pro");
    const conU = seedUserAgent("usr_c", "con");
    const arb = spawnManagedAgent("usr_o", {
      handle: "arb",
      display_name: "Arbiter",
      persona: "fair arbiter",
    });
    befriend(owner.id, proU.id);
    befriend(owner.id, conU.id);
    befriend(owner.id, arb.id);
    befriend(proU.id, conU.id);
    befriend(proU.id, arb.id);
    befriend(conU.id, arb.id);
    const conv = createGroupConversation(
      "usr_o",
      owner.id,
      "panel",
      [proU.id, conU.id, arb.id],
    );

    const ws = createWorkspace({
      name: "w",
      conversation_id: conv.id,
      created_by_agent_id: owner.id,
    });
    subscribeAgent(ws.id, owner.id, "admin");
    const r = applyPatch({
      workspace_id: ws.id,
      agent_id: owner.id,
      against_rev: ws.head_snapshot_id!,
      ops: [{ path: "a.txt", op: "create", content: "needs debate" }],
    });
    if (!r.ok) return assert.fail("seed");

    const t = createTask({
      title: "ship-it",
      owner_agent_id: owner.id,
      conversation_id: conv.id,
      workspace_id: ws.id,
      success_criteria: [
        {
          type: "debate_panel",
          pro_agent_id: proU.id,
          con_agent_id: conU.id,
          arbiter_agent_id: arb.id,
        },
      ],
    });
    db()
      .prepare("UPDATE tasks SET result_snapshot_id = ? WHERE id = ?")
      .run(r.snapshot_id, t.id);

    const brainStep: DebateBrainStep = async ({ role }) => {
      if (role === "pro") return { text: "we should ship — the change is minimal" };
      if (role === "con") return { text: "no objection: change is benign" };
      return { text: '{"decision":"approve","reason":"both agree"}' };
    };
    const fresh = getTask(t.id)!;
    const result = await runDebate(
      fresh,
      {
        pro_agent_id: proU.id,
        con_agent_id: conU.id,
        arbiter_agent_id: arb.id,
      },
      brainStep,
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.decision, "approve");
    assert.equal(result.arguments.length, 3);

    const events = listTaskEvents(t.id);
    const kinds = events.map((e) => e.kind);
    const argCount = kinds.filter((k) => k === "debate_argument").length;
    assert.equal(argCount, 3);
    assert.ok(kinds.includes("debate_finished"));
  });

  it("re-running on same snapshot is idempotent (returns prior outcome, no new events)", async () => {
    const owner = seedUserAgent("usr_o", "owner");
    const proU = seedUserAgent("usr_p", "pro");
    const conU = seedUserAgent("usr_c", "con");
    const arb = spawnManagedAgent("usr_o", {
      handle: "arb",
      display_name: "Arbiter",
      persona: "",
    });
    befriend(owner.id, proU.id);
    befriend(owner.id, conU.id);
    befriend(owner.id, arb.id);
    befriend(proU.id, conU.id);
    befriend(proU.id, arb.id);
    befriend(conU.id, arb.id);
    const conv = createGroupConversation(
      "usr_o",
      owner.id,
      "panel",
      [proU.id, conU.id, arb.id],
    );
    const ws = createWorkspace({
      name: "w",
      conversation_id: conv.id,
      created_by_agent_id: owner.id,
    });
    const r = applyPatch({
      workspace_id: ws.id,
      agent_id: owner.id,
      against_rev: ws.head_snapshot_id!,
      ops: [{ path: "a.txt", op: "create", content: "x" }],
    });
    if (!r.ok) return assert.fail("seed");
    const t = createTask({
      title: "y",
      owner_agent_id: owner.id,
      conversation_id: conv.id,
      workspace_id: ws.id,
      success_criteria: [
        {
          type: "debate_panel",
          pro_agent_id: proU.id,
          con_agent_id: conU.id,
          arbiter_agent_id: arb.id,
        },
      ],
    });
    db()
      .prepare("UPDATE tasks SET result_snapshot_id = ? WHERE id = ?")
      .run(r.snapshot_id, t.id);

    let calls = 0;
    const step: DebateBrainStep = async () => {
      calls++;
      return { text: '{"decision":"approve","reason":"agree"}' };
    };
    const first = await runDebate(
      getTask(t.id)!,
      {
        pro_agent_id: proU.id,
        con_agent_id: conU.id,
        arbiter_agent_id: arb.id,
      },
      step,
    );
    assert.equal(first.ok, true);
    const second = await runDebate(
      getTask(t.id)!,
      {
        pro_agent_id: proU.id,
        con_agent_id: conU.id,
        arbiter_agent_id: arb.id,
      },
      step,
    );
    assert.equal(second.ok, true);
    // Second call must NOT have triggered more brain invocations.
    assert.equal(calls, 3);
  });
});

describe("runDebate validation", () => {
  it("requires result_snapshot_id", async () => {
    const owner = seedUserAgent("usr_o", "owner");
    const t = createTask({ title: "x", owner_agent_id: owner.id });
    const res = await runDebate(t, {
      pro_agent_id: owner.id,
      con_agent_id: owner.id,
      arbiter_agent_id: owner.id,
    });
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.ok(res.reason.includes("result_snapshot_id"));
  });

  it("rejects arbiter == pro or con", async () => {
    const owner = seedUserAgent("usr_o", "owner");
    const a = seedUserAgent("usr_a", "alpha");
    const b = seedUserAgent("usr_b", "bravo");
    befriend(owner.id, a.id);
    befriend(owner.id, b.id);
    befriend(a.id, b.id);
    const conv = createGroupConversation(
      "usr_o",
      owner.id,
      "panel",
      [a.id, b.id],
    );
    const ws = createWorkspace({
      name: "w",
      conversation_id: conv.id,
      created_by_agent_id: owner.id,
    });
    const r = applyPatch({
      workspace_id: ws.id,
      agent_id: owner.id,
      against_rev: ws.head_snapshot_id!,
      ops: [{ path: "x", op: "create", content: "x" }],
    });
    if (!r.ok) return assert.fail();
    const t = createTask({
      title: "y",
      owner_agent_id: owner.id,
      conversation_id: conv.id,
      workspace_id: ws.id,
    });
    db()
      .prepare("UPDATE tasks SET result_snapshot_id = ? WHERE id = ?")
      .run(r.snapshot_id, t.id);

    const res = await runDebate(getTask(t.id)!, {
      pro_agent_id: a.id,
      con_agent_id: b.id,
      arbiter_agent_id: a.id,
    });
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.ok(res.reason.includes("independent"));
  });

  it("rejects when an agent is not a conv member", async () => {
    const owner = seedUserAgent("usr_o", "owner");
    const a = seedUserAgent("usr_a", "alpha");
    const b = seedUserAgent("usr_b", "bravo");
    const stranger = seedUserAgent("usr_s", "stranger");
    befriend(owner.id, a.id);
    befriend(owner.id, b.id);
    befriend(a.id, b.id);
    const conv = createGroupConversation(
      "usr_o",
      owner.id,
      "panel",
      [a.id, b.id],
    );
    const ws = createWorkspace({
      name: "w",
      conversation_id: conv.id,
      created_by_agent_id: owner.id,
    });
    const r = applyPatch({
      workspace_id: ws.id,
      agent_id: owner.id,
      against_rev: ws.head_snapshot_id!,
      ops: [{ path: "x", op: "create", content: "x" }],
    });
    if (!r.ok) return assert.fail();
    const t = createTask({
      title: "y",
      owner_agent_id: owner.id,
      conversation_id: conv.id,
      workspace_id: ws.id,
    });
    db()
      .prepare("UPDATE tasks SET result_snapshot_id = ? WHERE id = ?")
      .run(r.snapshot_id, t.id);

    const res = await runDebate(getTask(t.id)!, {
      pro_agent_id: a.id,
      con_agent_id: stranger.id,
      arbiter_agent_id: b.id,
    });
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.ok(res.reason.includes("member"));
  });
});

describe("splitTask (Hub & Spoke)", () => {
  it("atomically creates N subtasks with assignees + parent blocked by all", async () => {
    const owner = seedUserAgent("usr_o", "owner");
    const a = seedUserAgent("usr_a", "alpha");
    const b = seedUserAgent("usr_b", "bravo");
    const c = seedUserAgent("usr_c", "carol");
    const parent = createTask({
      title: "research",
      owner_agent_id: owner.id,
    });
    const children = splitTask({
      parent_task_id: parent.id,
      actor_agent_id: owner.id,
      branches: [
        { title: "market", assigned_to_agent_id: a.id },
        { title: "competitors", assigned_to_agent_id: b.id },
        { title: "tech", assigned_to_agent_id: c.id },
      ],
    });
    assert.equal(children.length, 3);
    // Parent should be blocked by all 3
    const blockers = db()
      .prepare(
        "SELECT blocker_task_id FROM task_dependencies WHERE blocked_task_id = ?",
      )
      .all(parent.id) as Array<{ blocker_task_id: string }>;
    assert.equal(blockers.length, 3);
  });

  it("rejects > 12 branches", () => {
    const owner = seedUserAgent("usr_o", "owner");
    const parent = createTask({ title: "x", owner_agent_id: owner.id });
    const branches = Array.from({ length: 13 }, (_, i) => ({
      title: `b${i}`,
    }));
    assert.throws(
      () =>
        splitTask({
          parent_task_id: parent.id,
          actor_agent_id: owner.id,
          branches,
        }),
      /At most 12/,
    );
  });

  it("only parent owner / assignee can split", () => {
    const owner = seedUserAgent("usr_o", "owner");
    const stranger = seedUserAgent("usr_x", "stranger");
    const parent = createTask({ title: "x", owner_agent_id: owner.id });
    assert.throws(
      () =>
        splitTask({
          parent_task_id: parent.id,
          actor_agent_id: stranger.id,
          branches: [{ title: "a" }],
        }),
      /owner or assignee/,
    );
  });
});

describe("debate_panel through evaluateSuccessCriteria", () => {
  it("blocks done when arbiter says request_changes", async () => {
    const owner = seedUserAgent("usr_o", "owner");
    const proU = seedUserAgent("usr_p", "pro");
    const conU = seedUserAgent("usr_c", "con");
    const arb = spawnManagedAgent("usr_o", {
      handle: "arb",
      display_name: "Arbiter",
      persona: "",
    });
    befriend(owner.id, proU.id);
    befriend(owner.id, conU.id);
    befriend(owner.id, arb.id);
    befriend(proU.id, conU.id);
    befriend(proU.id, arb.id);
    befriend(conU.id, arb.id);
    const conv = createGroupConversation(
      "usr_o",
      owner.id,
      "panel",
      [proU.id, conU.id, arb.id],
    );
    const ws = createWorkspace({
      name: "w",
      conversation_id: conv.id,
      created_by_agent_id: owner.id,
    });
    const r = applyPatch({
      workspace_id: ws.id,
      agent_id: owner.id,
      against_rev: ws.head_snapshot_id!,
      ops: [{ path: "a.txt", op: "create", content: "needs work" }],
    });
    if (!r.ok) return assert.fail();
    const t = createTask({
      title: "evaluate this",
      owner_agent_id: owner.id,
      conversation_id: conv.id,
      workspace_id: ws.id,
      success_criteria: [
        {
          type: "debate_panel",
          pro_agent_id: proU.id,
          con_agent_id: conU.id,
          arbiter_agent_id: arb.id,
        },
      ],
    });

    // Pre-seed a debate_finished event for this snapshot so the brain isn't
    // actually called (we're testing the criterion gate, not brain integration).
    db()
      .prepare(
        `INSERT INTO task_events (task_id, actor_agent_id, kind, payload_json, created_at)
         VALUES (?, ?, 'debate_finished', ?, ?)`,
      )
      .run(
        t.id,
        arb.id,
        JSON.stringify({
          ok: true,
          decision: "request_changes",
          reason: "looks bad",
          arguments: [],
          snapshot_id: r.snapshot_id,
        }),
        NOW,
      );

    await transitionTaskStatus({
      task_id: t.id,
      to_status: "assigned",
      actor_agent_id: owner.id,
    });
    await transitionTaskStatus({
      task_id: t.id,
      to_status: "in_progress",
      actor_agent_id: owner.id,
    });
    await transitionTaskStatus({
      task_id: t.id,
      to_status: "awaiting_review",
      actor_agent_id: owner.id,
    });
    const res = await transitionTaskStatus({
      task_id: t.id,
      to_status: "done",
      actor_agent_id: owner.id,
      result_snapshot_id: r.snapshot_id,
    });
    assert.equal(res.task.status, "changes_requested");
    assert.ok(res.criteria_failures && res.criteria_failures.length > 0);
  });
});
