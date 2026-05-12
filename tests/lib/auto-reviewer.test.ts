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
  transitionTaskStatus,
} from "../../lib/tasks";
import {
  buildReviewPrompt,
  listEligibleReviewers,
  parseDecision,
  runAutoReview,
} from "../../lib/auto-reviewer";

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

function seedUserWithAgent(uid: string, handle: string) {
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

describe("parseDecision", () => {
  it("recognises a pure JSON approve", () => {
    const d = parseDecision('{"decision":"approve","reason":"looks fine"}');
    assert.equal(d.decision, "approve");
  });

  it("extracts JSON wrapped in prose", () => {
    const d = parseDecision(
      'After reading the diff: {"decision":"request_changes","reason":"missing CHECK"} — please fix.',
    );
    assert.equal(d.decision, "request_changes");
    assert.equal(d.reason, "missing CHECK");
  });

  it("falls back to request_changes when no JSON", () => {
    const d = parseDecision("looks good to me");
    assert.equal(d.decision, "request_changes");
  });

  it("falls back to request_changes on malformed JSON", () => {
    const d = parseDecision('{"decision": broken');
    assert.equal(d.decision, "request_changes");
  });
});

describe("listEligibleReviewers", () => {
  it("excludes owner / assignee / non-managed / no-capability agents", () => {
    const ownerUser = seedUserWithAgent("usr_o", "owner");
    const assigneeUser = seedUserWithAgent("usr_b", "bob");
    const reviewerOwner = seedUserWithAgent("usr_r", "reviewer-owner");

    // managed reviewer with cap
    const reviewer = spawnManagedAgent("usr_r", {
      handle: "rev",
      display_name: "Reviewer",
      persona: "auto reviewer",
      capabilities: [{ name: "task.review", version: "1" }],
    });
    // managed agent WITHOUT cap (should be excluded)
    const noCapAgent = spawnManagedAgent("usr_r", {
      handle: "noop",
      display_name: "Noop",
      persona: "",
    });

    for (const a of [ownerUser, assigneeUser, reviewer, noCapAgent]) {
      befriend(ownerUser.id, a.id);
    }
    // Build a group conv with all of them
    befriend(assigneeUser.id, reviewer.id);
    befriend(assigneeUser.id, noCapAgent.id);
    befriend(reviewer.id, noCapAgent.id);
    befriend(ownerUser.id, reviewerOwner.id);
    befriend(reviewerOwner.id, reviewer.id);

    const conv = createGroupConversation(
      "usr_o",
      ownerUser.id,
      "team",
      [assigneeUser.id, reviewer.id, noCapAgent.id],
    );

    setAgentCapabilities(assigneeUser.id, "usr_b", []);
    const t = createTask({
      title: "x",
      owner_agent_id: ownerUser.id,
      assigned_to_agent_id: assigneeUser.id,
      conversation_id: conv.id,
      success_criteria: [{ type: "diff_review", min_approvers: 1 }],
    });

    const list = listEligibleReviewers(t);
    const ids = list.map((a) => a.id);
    assert.ok(ids.includes(reviewer.id));
    assert.ok(!ids.includes(ownerUser.id));
    assert.ok(!ids.includes(assigneeUser.id));
    assert.ok(!ids.includes(noCapAgent.id));
  });

  it("excludes already-reviewed agents", () => {
    const ownerUser = seedUserWithAgent("usr_o", "owner");
    const assigneeUser = seedUserWithAgent("usr_b", "bob");
    const reviewer = spawnManagedAgent("usr_o", {
      handle: "rev",
      display_name: "Reviewer",
      persona: "auto reviewer",
      capabilities: [{ name: "task.review", version: "1" }],
    });
    befriend(ownerUser.id, assigneeUser.id);
    befriend(ownerUser.id, reviewer.id);
    befriend(assigneeUser.id, reviewer.id);
    const conv = createGroupConversation(
      "usr_o",
      ownerUser.id,
      "team",
      [assigneeUser.id, reviewer.id],
    );
    const t = createTask({
      title: "y",
      owner_agent_id: ownerUser.id,
      assigned_to_agent_id: assigneeUser.id,
      conversation_id: conv.id,
      success_criteria: [{ type: "diff_review", min_approvers: 1 }],
    });
    // Seed a prior "approved" event from reviewer
    db()
      .prepare(
        `INSERT INTO task_events (task_id, actor_agent_id, kind, payload_json, created_at)
         VALUES (?, ?, 'approved', '{}', ?)`,
      )
      .run(t.id, reviewer.id, NOW);
    const list = listEligibleReviewers(t).map((a) => a.id);
    assert.ok(!list.includes(reviewer.id));
  });
});

describe("buildReviewPrompt", () => {
  it("contains title + diff summary + changed file content", () => {
    const ownerUser = seedUserWithAgent("usr_o", "owner");
    const ws = createWorkspace({
      name: "w",
      conversation_id: null,
      created_by_agent_id: ownerUser.id,
    });
    const r = applyPatch({
      workspace_id: ws.id,
      agent_id: ownerUser.id,
      against_rev: ws.head_snapshot_id!,
      ops: [{ path: "schema.sql", op: "create", content: "CHECK (a < b)" }],
    });
    if (!r.ok) return assert.fail("seed patch");
    const t = createTask({
      title: "Add CHECK",
      description: "ensure ordering",
      owner_agent_id: ownerUser.id,
      workspace_id: ws.id,
    });
    db()
      .prepare("UPDATE tasks SET result_snapshot_id = ? WHERE id = ?")
      .run(r.snapshot_id, t.id);
    const prompt = buildReviewPrompt(getTask(t.id)!);
    assert.ok(prompt.includes("Add CHECK"));
    assert.ok(prompt.includes("schema.sql"));
    assert.ok(prompt.includes("CHECK (a < b)"));
    assert.ok(prompt.includes('"decision"'));
  });
});

describe("runAutoReview (mock brain)", () => {
  it("approves a task whose diff matches the mock decision JSON", async () => {
    const ownerUser = seedUserWithAgent("usr_o", "owner");
    const assigneeUser = seedUserWithAgent("usr_b", "bob");
    const reviewer = spawnManagedAgent("usr_o", {
      handle: "rev",
      display_name: "Reviewer",
      persona:
        'Always reply with {"decision":"approve","reason":"mock auto-approve"}',
      capabilities: [{ name: "task.review", version: "1" }],
    });

    befriend(ownerUser.id, assigneeUser.id);
    befriend(ownerUser.id, reviewer.id);
    befriend(assigneeUser.id, reviewer.id);
    const conv = createGroupConversation(
      "usr_o",
      ownerUser.id,
      "review-team",
      [assigneeUser.id, reviewer.id],
    );

    const ws = createWorkspace({
      name: "w",
      conversation_id: conv.id,
      created_by_agent_id: ownerUser.id,
    });
    subscribeAgent(ws.id, assigneeUser.id, "writer");
    subscribeAgent(ws.id, reviewer.id, "reader");
    setAgentCapabilities(assigneeUser.id, "usr_b", [
      { name: "workspace.write", version: "1" },
    ]);
    const r = applyPatch({
      workspace_id: ws.id,
      agent_id: assigneeUser.id,
      against_rev: ws.head_snapshot_id!,
      ops: [{ path: "a.txt", op: "create", content: "approve-please" }],
    });
    if (!r.ok) return assert.fail("seed");

    const t = createTask({
      title: "auto-review me",
      owner_agent_id: ownerUser.id,
      assigned_to_agent_id: assigneeUser.id,
      conversation_id: conv.id,
      workspace_id: ws.id,
      required_capabilities: ["workspace.write"],
      success_criteria: [{ type: "diff_review", min_approvers: 1 }],
    });
    db()
      .prepare("UPDATE tasks SET result_snapshot_id = ? WHERE id = ?")
      .run(r.snapshot_id, t.id);

    // We bypass transitionTaskStatus's auto-dispatch and run runAutoReview
    // directly so the test is deterministic.
    db()
      .prepare("UPDATE tasks SET status = 'awaiting_review' WHERE id = ?")
      .run(t.id);
    db()
      .prepare(
        `INSERT INTO task_events (task_id, actor_agent_id, kind, payload_json, created_at)
         VALUES (?, ?, 'status_change', '{}', ?)`,
      )
      .run(t.id, assigneeUser.id, NOW);

    const result = await runAutoReview(
      {
        task_id: t.id,
        reviewer_agent_id: reviewer.id,
      },
      async () => ({ text: '{"decision":"approve","reason":"mock"}' }),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    // Should have left an 'approved' event from the reviewer
    const events = listTaskEvents(t.id);
    const approvedBy = events
      .filter((e) => e.kind === "approved")
      .map((e) => e.actor_agent_id);
    assert.ok(approvedBy.includes(reviewer.id));
  });

  it("requests changes when persona never produces JSON", async () => {
    const ownerUser = seedUserWithAgent("usr_o", "owner");
    const assigneeUser = seedUserWithAgent("usr_b", "bob");
    const reviewer = spawnManagedAgent("usr_o", {
      handle: "rev",
      display_name: "Reviewer",
      persona: "Reply with prose only, no JSON.",
      capabilities: [{ name: "task.review", version: "1" }],
    });
    befriend(ownerUser.id, assigneeUser.id);
    befriend(ownerUser.id, reviewer.id);
    befriend(assigneeUser.id, reviewer.id);
    const conv = createGroupConversation(
      "usr_o",
      ownerUser.id,
      "team",
      [assigneeUser.id, reviewer.id],
    );
    const t = createTask({
      title: "x",
      owner_agent_id: ownerUser.id,
      assigned_to_agent_id: assigneeUser.id,
      conversation_id: conv.id,
      success_criteria: [{ type: "diff_review", min_approvers: 1 }],
    });
    db()
      .prepare("UPDATE tasks SET status = 'awaiting_review' WHERE id = ?")
      .run(t.id);
    const res = await runAutoReview(
      {
        task_id: t.id,
        reviewer_agent_id: reviewer.id,
      },
      async () => ({ text: "looks fine to me, no JSON though" }),
    );
    if (res.ok) {
      assert.equal(res.decision.decision, "request_changes");
    }
    // After requestChanges fires, status moves to changes_requested
    assert.equal(getTask(t.id)!.status, "changes_requested");
  });
});
