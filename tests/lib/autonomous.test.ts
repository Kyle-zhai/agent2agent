import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestDb, teardownTestDb, resetTables } from "../helpers/setup";
import { _resetDbForTests, db } from "../../lib/db";
import { createAgentForUser, setAgentCapabilities } from "../../lib/agents";
import { spawnManagedAgent } from "../../lib/managed-agents";
import { createWorkspace, subscribeAgent } from "../../lib/workspaces";
import { createTask, getTask } from "../../lib/tasks";
import { listMessages } from "../../lib/conversations";
import { newConversationId } from "../../lib/ids";
import {
  runAutonomousTask,
  findActionableAutonomousWork,
  tickAutonomousAgents,
  type AutonomyBrainStep,
} from "../../lib/autonomous";

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
  NOW = 1_700_000_000_000;
  resetTables(db());
});

function seedUser(userId: string, handle: string) {
  db()
    .prepare(
      "INSERT INTO users (id, email, display_name, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(userId, `${handle}@t.test`, handle, "x".repeat(128), "y".repeat(32), NOW);
}

function addMember(conversationId: string, agentId: string) {
  db()
    .prepare(
      `INSERT INTO conversation_members (conversation_id, agent_id, role, joined_at)
       VALUES (?, ?, 'member', ?)`,
    )
    .run(conversationId, agentId, NOW);
}

function makeConversation(memberIds: string[]) {
  const id = newConversationId();
  db()
    .prepare(
      `INSERT INTO conversations (id, type, title, created_by_agent_id, created_at)
       VALUES (?, 'group', 'proj', ?, ?)`,
    )
    .run(id, memberIds[0], NOW);
  for (const m of memberIds) addMember(id, m);
  return id;
}

/** A managed worker + a human-owned owner agent, a group they share, and a
 *  workspace bound to it with the worker subscribed as writer. */
function scenario() {
  seedUser("usr_o", "owner");
  const owner = createAgentForUser("usr_o", { handle: "owner", display_name: "Owner" }).agent;
  const worker = spawnManagedAgent("usr_o", {
    handle: "worker",
    display_name: "Worker",
    persona: "You do the work.",
    capabilities: [{ name: "workspace.write", version: "1" }],
  });
  setAgentCapabilities(worker.id, "usr_o", [{ name: "workspace.write", version: "1" }]);
  const convId = makeConversation([owner.id, worker.id]);
  const conv = { id: convId };
  const ws = createWorkspace({
    name: "ws",
    conversation_id: conv.id,
    created_by_agent_id: owner.id,
  });
  subscribeAgent(ws.id, worker.id, "writer");
  return { owner, worker, conv, ws };
}

describe("runAutonomousTask — bounded ReAct loop", () => {
  it("writes a file, submits, and reaches done when criteria pass (test_command)", async () => {
    const { owner, worker, conv, ws } = scenario();
    const task = createTask({
      title: "Create ok.sh",
      description: "write ok.sh that exits 0",
      owner_agent_id: owner.id,
      assigned_to_agent_id: worker.id,
      conversation_id: conv.id,
      workspace_id: ws.id,
      success_criteria: [{ type: "test_command", cmd: "bash ok.sh" }],
    });

    // Brain: step 1 writes the file and submits.
    const brainStep: AutonomyBrainStep = async () => ({
      text: 'Here you go. <write path="ok.sh" commit="add ok.sh">exit 0</write> <submit/>',
      thinking: "",
      artifacts: [{ path: "ok.sh", commit_message: "add ok.sh", content: "exit 0\n" }],
    });

    const r = await runAutonomousTask(worker.id, task.id, { brainStep });
    assert.equal(r.outcome, "completed");
    assert.equal(getTask(task.id)!.status, "done");
    // The worker posted a closing note to the room.
    assert.ok(
      listMessages(conv.id, { limit: 20 }).some((m) => m.from_agent_id === worker.id),
    );
  });

  it("feeds criteria failures back, then completes on the corrected attempt", async () => {
    const { owner, worker, conv, ws } = scenario();
    const task = createTask({
      title: "Make tests pass",
      description: "ship run.sh exiting 0",
      owner_agent_id: owner.id,
      assigned_to_agent_id: worker.id,
      conversation_id: conv.id,
      workspace_id: ws.id,
      success_criteria: [{ type: "test_command", cmd: "bash run.sh" }],
    });

    const seenFailures: string[][] = [];
    let call = 0;
    const brainStep: AutonomyBrainStep = async ({ lastFailures }) => {
      seenFailures.push(lastFailures);
      call += 1;
      // First attempt: a script that FAILS (exit 1). Second: fixed (exit 0).
      const content = call === 1 ? "exit 1\n" : "exit 0\n";
      return {
        text: `<write path="run.sh" commit="attempt ${call}">${content.trim()}</write> <submit/>`,
        thinking: "",
        artifacts: [{ path: "run.sh", commit_message: `attempt ${call}`, content }],
      };
    };

    const r = await runAutonomousTask(worker.id, task.id, { brainStep, maxSteps: 4 });
    assert.equal(r.outcome, "completed");
    assert.equal(getTask(task.id)!.status, "done");
    // The SECOND brain turn saw the first attempt's failure fed back.
    assert.equal(seenFailures[0].length, 0);
    assert.ok(seenFailures[1].length > 0, "second attempt must receive failures");
    assert.ok(seenFailures[1].some((f) => /test_command/.test(f)));
  });

  it("resumes a review-bounced task WITH the reviewer's comment in context", async () => {
    const { owner, worker, conv, ws } = scenario();
    const task = createTask({
      title: "Revise on feedback",
      owner_agent_id: owner.id,
      assigned_to_agent_id: worker.id,
      conversation_id: conv.id,
      workspace_id: ws.id,
    });
    // Simulate a prior review bounce: a reviewer requested changes with a reason,
    // and the task is back in changes_requested for the writer to address.
    db()
      .prepare(
        `INSERT INTO task_events (task_id, actor_agent_id, kind, payload_json, created_at)
         VALUES (?, ?, 'changes_requested', ?, ?)`,
      )
      .run(task.id, owner.id, JSON.stringify({ comment: "TAM figure has no source; add a citation." }), NOW);
    db().prepare("UPDATE tasks SET status = 'changes_requested' WHERE id = ?").run(task.id);

    let seen: string[] = [];
    const brainStep: AutonomyBrainStep = async ({ lastFailures }) => {
      seen = lastFailures;
      return { text: "<blocked>ack</blocked>", thinking: "", artifacts: [] };
    };
    await runAutonomousTask(worker.id, task.id, { brainStep, maxSteps: 1 });
    assert.ok(
      seen.some((f) => /TAM figure has no source/.test(f)),
      "the writer must resume with the reviewer's feedback, not blind",
    );
  });

  it("stops and posts when the agent declares itself blocked", async () => {
    const { owner, worker, conv, ws } = scenario();
    const task = createTask({
      title: "Impossible",
      owner_agent_id: owner.id,
      assigned_to_agent_id: worker.id,
      conversation_id: conv.id,
      workspace_id: ws.id,
    });
    const brainStep: AutonomyBrainStep = async () => ({
      text: "<blocked>need the API key from a human</blocked>",
      thinking: "",
      artifacts: [],
    });
    const r = await runAutonomousTask(worker.id, task.id, { brainStep });
    assert.equal(r.outcome, "blocked");
    // Task is in_progress (started) but not done; a blocker message was posted.
    assert.notEqual(getTask(task.id)!.status, "done");
    assert.ok(
      listMessages(conv.id, { limit: 20 }).some((m) => /Blocked:/.test(m.text)),
    );
  });

  it("bails as 'stuck' when the brain repeats byte-identical artifacts", async () => {
    const { owner, worker, conv, ws } = scenario();
    const task = createTask({
      title: "Loopy",
      owner_agent_id: owner.id,
      assigned_to_agent_id: worker.id,
      conversation_id: conv.id,
      workspace_id: ws.id,
      success_criteria: [{ type: "test_command", cmd: "bash never.sh" }],
    });
    // Always writes the SAME failing file, never fixes it.
    const brainStep: AutonomyBrainStep = async () => ({
      text: '<write path="never.sh" commit="same">exit 1</write> <submit/>',
      thinking: "",
      artifacts: [{ path: "never.sh", commit_message: "same", content: "exit 1\n" }],
    });
    const r = await runAutonomousTask(worker.id, task.id, { brainStep, maxSteps: 6 });
    assert.equal(r.outcome, "stuck");
    assert.notEqual(getTask(task.id)!.status, "done");
  });

  it("respects the step cap", async () => {
    const { owner, worker, conv, ws } = scenario();
    const task = createTask({
      title: "Endless chatter",
      owner_agent_id: owner.id,
      assigned_to_agent_id: worker.id,
      conversation_id: conv.id,
      workspace_id: ws.id,
      success_criteria: [{ type: "test_command", cmd: "bash x.sh" }],
    });
    let n = 0;
    // Writes a DIFFERENT failing file each step (so not "stuck") and submits —
    // never passes, so it must hit the step cap.
    const brainStep: AutonomyBrainStep = async () => {
      n += 1;
      return {
        text: `<write path="x.sh" commit="v${n}">exit ${n}</write> <submit/>`,
        thinking: "",
        artifacts: [{ path: "x.sh", commit_message: `v${n}`, content: `exit ${n}\n` }],
      };
    };
    const r = await runAutonomousTask(worker.id, task.id, { brainStep, maxSteps: 3 });
    assert.equal(r.outcome, "capped");
    assert.equal(r.steps, 3);
  });

  it("review-gated tasks stop at awaiting_review (no self-approve)", async () => {
    const { owner, worker, conv, ws } = scenario();
    const task = createTask({
      title: "Needs review",
      owner_agent_id: owner.id,
      assigned_to_agent_id: worker.id,
      conversation_id: conv.id,
      workspace_id: ws.id,
      success_criteria: [{ type: "diff_review", reviewer_agent_id: owner.id }],
    });
    const brainStep: AutonomyBrainStep = async () => ({
      text: '<write path="draft.md" commit="draft">hello</write> <submit/>',
      thinking: "",
      artifacts: [{ path: "draft.md", commit_message: "draft", content: "hello\n" }],
    });
    const r = await runAutonomousTask(worker.id, task.id, { brainStep });
    assert.equal(r.outcome, "submitted");
    assert.equal(getTask(task.id)!.status, "awaiting_review");
  });

  it("is a noop for an external (non-managed) agent", async () => {
    const { owner, conv, ws } = scenario();
    seedUser("usr_x", "ext");
    const ext = createAgentForUser("usr_x", { handle: "ext", display_name: "Ext" }).agent;
    addMember(conv.id, ext.id);
    const task = createTask({
      title: "x",
      owner_agent_id: owner.id,
      assigned_to_agent_id: ext.id,
      conversation_id: conv.id,
      workspace_id: ws.id,
    });
    const r = await runAutonomousTask(ext.id, task.id, {
      brainStep: async () => ({ text: "<submit/>", thinking: "", artifacts: [] }),
    });
    assert.equal(r.outcome, "noop");
  });
});

describe("autonomous tick — self-enqueue", () => {
  it("finds only actionable managed tasks and drives them", async () => {
    const { owner, worker, conv, ws } = scenario();
    const task = createTask({
      title: "Tick me",
      owner_agent_id: owner.id,
      assigned_to_agent_id: worker.id,
      conversation_id: conv.id,
      workspace_id: ws.id,
      success_criteria: [{ type: "test_command", cmd: "bash go.sh" }],
    });
    // A done task and an open (unassigned) task must NOT be picked up.
    createTask({
      title: "already done",
      owner_agent_id: owner.id,
      assigned_to_agent_id: worker.id,
      conversation_id: conv.id,
    });

    const actionable = findActionableAutonomousWork();
    assert.ok(actionable.some((w) => w.task_id === task.id && w.agent_id === worker.id));

    const results = await tickAutonomousAgents({
      brainStep: async () => ({
        text: '<write path="go.sh" commit="go">exit 0</write> <submit/>',
        thinking: "",
        artifacts: [{ path: "go.sh", commit_message: "go", content: "exit 0\n" }],
      }),
    });
    assert.ok(results.some((r) => r.task_id === task.id && r.outcome === "completed"));
    assert.equal(getTask(task.id)!.status, "done");
  });
});
