import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestDb, teardownTestDb, resetTables } from "../helpers/setup";
import { _resetDbForTests, db } from "../../lib/db";
import {
  createAgentForUser,
  deleteAgentForUser,
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
  approveTask,
  createTask,
  getTask,
  listTaskEvents,
  transitionTaskStatus,
} from "../../lib/tasks";
import {
  buildReviewPrompt,
  listEligibleReviewers,
  parseDecision,
  resolveStalledReview,
  runAutoReview,
} from "../../lib/auto-reviewer";

let NOW = 1_700_000_000_000;
const RealDateNow = Date.now;

before(() => {
  setupTestDb();
  _resetDbForTests();
  Date.now = () => NOW;
  // test_command criteria need a sandbox runtime; the local one is opt-in
  // (security: unsandboxed host shell). Enable it for this suite only.
  process.env.A2A_SANDBOX_LOCAL = "1";
  delete process.env.VERCEL_SANDBOX_TOKEN;
});

after(() => {
  Date.now = RealDateNow;
  _resetDbForTests();
  teardownTestDb();
  delete process.env.A2A_SANDBOX_LOCAL;
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

// ---------------------------------------------------------------------------
// The deadlock fix: ground-truth anchoring + post-approval auto-close +
// one-shot-reviewer stall resolution (escalate / opt-in test-pass override).
// ---------------------------------------------------------------------------

describe("buildReviewPrompt — deterministic test prior", () => {
  function taskWithSnapshot() {
    const owner = seedUserWithAgent("usr_o", "owner");
    const ws = createWorkspace({
      name: "w",
      conversation_id: null,
      created_by_agent_id: owner.id,
    });
    const r = applyPatch({
      workspace_id: ws.id,
      agent_id: owner.id,
      against_rev: ws.head_snapshot_id!,
      ops: [{ path: "brief.md", op: "create", content: "hi" }],
    });
    if (!r.ok) throw new Error("seed");
    const t = createTask({ title: "X", owner_agent_id: owner.id, workspace_id: ws.id });
    db().prepare("UPDATE tasks SET result_snapshot_id = ? WHERE id = ?").run(r.snapshot_id, t.id);
    return getTask(t.id)!;
  }

  it("anchors the reviewer to a PASS result", () => {
    const prompt = buildReviewPrompt(taskWithSnapshot(), {
      ran: true,
      allPassed: true,
      lines: ['- "bash check.sh": PASS (exit=0)'],
    });
    assert.ok(prompt.includes("Deterministic acceptance tests"));
    assert.ok(prompt.includes("PASS"));
    assert.ok(prompt.includes("Do NOT claim the code is incomplete"));
  });

  it("tells the reviewer not to approve on a FAIL result", () => {
    const prompt = buildReviewPrompt(taskWithSnapshot(), {
      ran: true,
      allPassed: false,
      lines: ['- "bash check.sh": FAIL (exit=1)'],
    });
    assert.ok(prompt.includes("FAIL"));
    assert.ok(prompt.includes("Do NOT approve"));
  });

  it("omits the section entirely when no tests ran", () => {
    const prompt = buildReviewPrompt(taskWithSnapshot(), {
      ran: false,
      allPassed: false,
      lines: [],
    });
    assert.ok(!prompt.includes("Deterministic acceptance tests"));
  });
});

describe("review stall resolution (one-shot reviewer)", () => {
  // Build a task parked in awaiting_review, review-gated (diff_review needs a
  // market.feasibility approver) AND test-gated (bash check.sh). The single
  // reviewer is made ineligible (it already left an event), reproducing the
  // real deadlock: diff_review can never be satisfied autonomously.
  function seedStall(check: string, minApprovers = 1) {
    const ownerUser = seedUserWithAgent("usr_o", "owner");
    const writer = seedUserWithAgent("usr_b", "bob");
    setAgentCapabilities(writer.id, "usr_b", [
      { name: "workspace.write", version: "1" },
    ]);
    const reviewer = spawnManagedAgent("usr_o", {
      handle: "rev",
      display_name: "Reviewer",
      persona: "feasibility reviewer",
      capabilities: [
        { name: "task.review", version: "1" },
        { name: "market.feasibility", version: "1" },
      ],
    });
    befriend(ownerUser.id, writer.id);
    befriend(ownerUser.id, reviewer.id);
    befriend(writer.id, reviewer.id);
    const conv = createGroupConversation("usr_o", ownerUser.id, "team", [
      writer.id,
      reviewer.id,
    ]);
    const ws = createWorkspace({
      name: "w",
      conversation_id: conv.id,
      created_by_agent_id: ownerUser.id,
    });
    subscribeAgent(ws.id, writer.id, "writer");
    subscribeAgent(ws.id, reviewer.id, "reader");
    const r = applyPatch({
      workspace_id: ws.id,
      agent_id: writer.id,
      against_rev: ws.head_snapshot_id!,
      ops: [{ path: "check.sh", op: "create", content: check }],
    });
    if (!r.ok) throw new Error("seed patch");
    const t = createTask({
      title: "GTM",
      owner_agent_id: ownerUser.id,
      assigned_to_agent_id: writer.id,
      conversation_id: conv.id,
      workspace_id: ws.id,
      required_capabilities: ["workspace.write"],
      success_criteria: [
        { type: "test_command", cmd: "bash check.sh" },
        { type: "diff_review", min_approvers: minApprovers, approver_capability: "market.feasibility" },
      ],
    });
    db()
      .prepare("UPDATE tasks SET status = 'awaiting_review', result_snapshot_id = ? WHERE id = ?")
      .run(r.snapshot_id, t.id);
    return { ownerUser, writer, reviewer, conv, ws, t };
  }

  function seedReviewerEvent(taskId: string, reviewerId: string, kind: string) {
    db()
      .prepare(
        `INSERT INTO task_events (task_id, actor_agent_id, kind, payload_json, created_at)
         VALUES (?, ?, ?, '{}', ?)`,
      )
      .run(taskId, reviewerId, kind, NOW);
  }

  it("escalates to a human (default) when tests pass but no reviewer remains", async () => {
    delete process.env.A2A_REVIEW_TEST_OVERRIDE;
    const { reviewer, t } = seedStall("exit 0\n");
    seedReviewerEvent(t.id, reviewer.id, "changes_requested"); // one-shot → ineligible
    await resolveStalledReview(t.id);
    const events = listTaskEvents(t.id);
    assert.ok(events.some((e) => e.kind === "review_escalated"), "should escalate to human");
    assert.equal(getTask(t.id)!.status, "awaiting_review", "stays parked for a human");
    assert.ok(!events.some((e) => e.kind === "approved"), "must NOT auto-approve by default");
  });

  it("auto-completes under A2A_REVIEW_TEST_OVERRIDE when tests pass", async () => {
    process.env.A2A_REVIEW_TEST_OVERRIDE = "1";
    try {
      const { reviewer, t } = seedStall("exit 0\n");
      seedReviewerEvent(t.id, reviewer.id, "changes_requested");
      await resolveStalledReview(t.id);
      assert.equal(getTask(t.id)!.status, "done");
      const approved = listTaskEvents(t.id).find((e) => e.kind === "approved");
      assert.ok(approved, "override records an approval");
      assert.equal(JSON.parse(approved!.payload_json).override, true, "tagged as an override");
    } finally {
      delete process.env.A2A_REVIEW_TEST_OVERRIDE;
    }
  });

  it("NEVER overrides or escalates when the tests FAIL", async () => {
    process.env.A2A_REVIEW_TEST_OVERRIDE = "1";
    try {
      const { reviewer, t } = seedStall("exit 1\n");
      seedReviewerEvent(t.id, reviewer.id, "changes_requested");
      await resolveStalledReview(t.id);
      assert.equal(getTask(t.id)!.status, "awaiting_review");
      const events = listTaskEvents(t.id);
      assert.ok(!events.some((e) => e.kind === "approved"), "failing code is never approved");
      assert.ok(!events.some((e) => e.kind === "review_escalated"), "failing tests don't escalate as passing");
    } finally {
      delete process.env.A2A_REVIEW_TEST_OVERRIDE;
    }
  });

  it("advances an already-approved task to done (post-approval auto-close)", async () => {
    const { reviewer, t } = seedStall("exit 0\n");
    seedReviewerEvent(t.id, reviewer.id, "approved"); // approved, but nothing closed it
    await resolveStalledReview(t.id);
    assert.equal(getTask(t.id)!.status, "done");
  });

  it("approve via runAutoReview drives the task to done when tests pass", async () => {
    const { reviewer, t } = seedStall("exit 0\n");
    const res = await runAutoReview(
      { task_id: t.id, reviewer_agent_id: reviewer.id },
      async () => ({ text: '{"decision":"approve","reason":"tests pass, looks complete"}' }),
    );
    assert.equal(res.ok, true);
    assert.equal(getTask(t.id)!.status, "done", "auto-closes after approval");
  });

  it("a reviewer becomes eligible again after the author resubmits", () => {
    const { writer, reviewer, t } = seedStall("exit 0\n");
    const ins = (kind: string, at: number, actor: string) =>
      db()
        .prepare(
          `INSERT INTO task_events (task_id, actor_agent_id, kind, payload_json, created_at)
           VALUES (?, ?, ?, '{}', ?)`,
        )
        .run(t.id, actor, kind, at);
    ins("review_requested", NOW, writer.id);
    ins("changes_requested", NOW + 1, reviewer.id);
    // Having acted this round, the reviewer is consumed.
    assert.ok(
      !listEligibleReviewers(getTask(t.id)!).some((a) => a.id === reviewer.id),
      "ineligible right after acting",
    );
    // Author resubmits → a new round opens → the reviewer can review again.
    ins("review_requested", NOW + 2, writer.id);
    assert.ok(
      listEligibleReviewers(getTask(t.id)!).some((a) => a.id === reviewer.id),
      "eligible again for the new submission",
    );
  });

  it("escalates from runAutoReview when the round cap is hit and tests pass", async () => {
    process.env.A2A_REVIEW_MAX_ROUNDS = "2";
    delete process.env.A2A_REVIEW_TEST_OVERRIDE;
    try {
      const { reviewer, t } = seedStall("exit 0\n");
      seedReviewerEvent(t.id, reviewer.id, "changes_requested"); // round 1 on record
      const before = listTaskEvents(t.id).filter((e) => e.kind === "changes_requested").length;
      const res = await runAutoReview(
        { task_id: t.id, reviewer_agent_id: reviewer.id },
        async () => ({ text: '{"decision":"request_changes","reason":"still not convinced"}' }),
      );
      assert.equal(res.ok, false);
      if (!res.ok) assert.match(res.reason, /escalated/);
      assert.equal(getTask(t.id)!.status, "awaiting_review");
      const ev = listTaskEvents(t.id);
      assert.ok(ev.some((e) => e.kind === "review_escalated"), "records escalation");
      assert.equal(
        ev.filter((e) => e.kind === "changes_requested").length,
        before,
        "does NOT bounce the author again past the cap",
      );
    } finally {
      delete process.env.A2A_REVIEW_MAX_ROUNDS;
    }
  });

  // --- regressions found by the multi-party architecture audit -------------

  it("a 1-of-2 managed approval does NOT bounce the task (multi-approver review)", async () => {
    // Audit CRITICAL: tryAdvanceToDone after the first approval bounced a
    // min_approvers=2 task to changes_requested, locking out the 2nd reviewer.
    const { ownerUser, reviewer, conv, t } = seedStall("exit 0\n", 2);
    const rev2 = spawnManagedAgent("usr_o", {
      handle: "rev2",
      display_name: "Reviewer 2",
      persona: "second feasibility reviewer",
      capabilities: [
        { name: "task.review", version: "1" },
        { name: "market.feasibility", version: "1" },
      ],
    });
    befriend(ownerUser.id, rev2.id);
    db()
      .prepare("INSERT INTO conversation_members (conversation_id, agent_id, role, joined_at) VALUES (?, ?, 'member', ?)")
      .run(conv.id, rev2.id, NOW);

    await runAutoReview({ task_id: t.id, reviewer_agent_id: reviewer.id },
      async () => ({ text: '{"decision":"approve","reason":"lgtm"}' }));
    assert.equal(getTask(t.id)!.status, "awaiting_review", "1/2 approvals must stay awaiting_review");

    await runAutoReview({ task_id: t.id, reviewer_agent_id: rev2.id },
      async () => ({ text: '{"decision":"approve","reason":"lgtm too"}' }));
    assert.equal(getTask(t.id)!.status, "done", "2/2 approvals reach done");
  });

  it("override does NOT fire (escalates instead) when one approval can't meet min_approvers≥2", async () => {
    // Audit HIGH: completeViaTestOverride records a duplicate approval from the
    // sole reviewer; the Set dedups so the quorum is never met and the task
    // bounced. It must escalate instead.
    process.env.A2A_REVIEW_TEST_OVERRIDE = "1";
    try {
      const { reviewer, t } = seedStall("exit 0\n", 2);
      seedReviewerEvent(t.id, reviewer.id, "changes_requested"); // one-shot → ineligible
      await resolveStalledReview(t.id);
      const ev = listTaskEvents(t.id);
      assert.equal(getTask(t.id)!.status, "awaiting_review", "must not bounce or wrongly complete");
      assert.ok(ev.some((e) => e.kind === "review_escalated"), "escalates instead of wasting override");
      assert.ok(!ev.some((e) => e.kind === "approved"), "no wasted override approval recorded");
    } finally {
      delete process.env.A2A_REVIEW_TEST_OVERRIDE;
    }
  });
});

describe("diff_review — historical approval survives approver deletion (audit #8)", () => {
  it("a deleted approver's capability-snapshotted vote still satisfies diff_review", async () => {
    const owner = seedUserWithAgent("usr_o", "owner");
    const writer = seedUserWithAgent("usr_b", "bob");
    setAgentCapabilities(writer.id, "usr_b", [{ name: "workspace.write", version: "1" }]);
    const reviewer = spawnManagedAgent("usr_o", {
      handle: "rev",
      display_name: "Reviewer",
      persona: "r",
      capabilities: [
        { name: "task.review", version: "1" },
        { name: "market.feasibility", version: "1" },
      ],
    });
    befriend(owner.id, writer.id);
    befriend(owner.id, reviewer.id);
    befriend(writer.id, reviewer.id);
    const conv = createGroupConversation("usr_o", owner.id, "team", [writer.id, reviewer.id]);
    const ws = createWorkspace({ name: "w", conversation_id: conv.id, created_by_agent_id: owner.id });
    subscribeAgent(ws.id, writer.id, "writer");
    const r = applyPatch({
      workspace_id: ws.id,
      agent_id: writer.id,
      against_rev: ws.head_snapshot_id!,
      ops: [{ path: "a.txt", op: "create", content: "x" }],
    });
    if (!r.ok) return assert.fail("seed");
    const t = createTask({
      title: "x",
      owner_agent_id: owner.id,
      assigned_to_agent_id: writer.id,
      conversation_id: conv.id,
      workspace_id: ws.id,
      success_criteria: [{ type: "diff_review", min_approvers: 1, approver_capability: "market.feasibility" }],
    });
    db().prepare("UPDATE tasks SET status = 'awaiting_review', result_snapshot_id = ? WHERE id = ?").run(r.snapshot_id, t.id);

    approveTask(t.id, reviewer.id); // records { approver, capabilities } snapshot
    deleteAgentForUser(reviewer.id, "usr_o"); // NULLs the event's actor_agent_id

    const res = await transitionTaskStatus({ task_id: t.id, to_status: "done", actor_agent_id: owner.id });
    assert.equal(res.task.status, "done", "deleted approver's snapshot vote still counts");
  });
});

describe("buildReviewPrompt — cross-workspace IDOR guard", () => {
  it("refuses a result snapshot that belongs to a DIFFERENT workspace", () => {
    // Audit CRITICAL: buildReviewPrompt read any snapshot, leaking foreign
    // workspace file contents into the reviewer's prompt.
    const owner = seedUserWithAgent("usr_o", "owner");
    const ws1 = createWorkspace({ name: "w1", conversation_id: null, created_by_agent_id: owner.id });
    const ws2 = createWorkspace({ name: "w2", conversation_id: null, created_by_agent_id: owner.id });
    const foreign = applyPatch({
      workspace_id: ws2.id,
      agent_id: owner.id,
      against_rev: ws2.head_snapshot_id!,
      ops: [{ path: "secret.txt", op: "create", content: "TOPSECRET-XYZ" }],
    });
    if (!foreign.ok) return assert.fail("seed");
    const t = createTask({ title: "x", owner_agent_id: owner.id, workspace_id: ws1.id });
    // Poison: a W2 snapshot recorded as the result of a W1 task.
    db().prepare("UPDATE tasks SET result_snapshot_id = ? WHERE id = ?").run(foreign.snapshot_id, t.id);
    const prompt = buildReviewPrompt(getTask(t.id)!);
    assert.ok(!prompt.includes("TOPSECRET-XYZ"), "must not leak foreign workspace content");
    assert.ok(prompt.includes("not in the task's workspace"), "notes the refusal");
  });
});
