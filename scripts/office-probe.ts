// Multi-party "office scenario" integration probe. Runs against an ISOLATED
// temp DB (never touches data/a2a.db) and ASSERTS exact behavior across the
// party configurations a real office exercises:
//   NN  — group of multiple humans + multiple agents (fan-out, @mention, caps, unread, membership)
//   1N  — one human delegating to many agents (parallel autonomy, workspace merge, deps)
//   N1  — many humans + one agent (multi-human review min_approvers=2, owner-only assign, self-approve guards)
//   XT  — cross-team grant enforcement (grant vs subscription, revoke, expiry)
//   CC  — concurrency / idempotency (reply-job lease + dedup)
// Each check records PASS / ANOMALY; the summary is the test report data.
//
// Run: node --import tsx scripts/office-probe.ts   (no API key needed — deterministic)
import { setupTestDb, teardownTestDb, resetTables } from "../tests/helpers/setup";
import { _resetDbForTests, db } from "../lib/db";
import { createAgentForUser, setAgentCapabilities } from "../lib/agents";
import { spawnManagedAgent, enqueueRepliesForMessage, claimNextJob } from "../lib/managed-agents";
import { sendMessage, markRead } from "../lib/conversations";
import {
  createWorkspace,
  applyPatch,
  subscribeAgent,
  getWorkspace,
  listFiles,
  readFileAt,
  canRead,
  canWrite,
} from "../lib/workspaces";
import {
  createTask,
  getTask,
  assignTask,
  transitionTaskStatus,
  approveTask,
  requestChanges,
  addTaskDependency,
} from "../lib/tasks";
import { runAutonomousTask, type AutonomyBrainStep } from "../lib/autonomous";
import { createGrant, agentMayUseResource, revokeGrant } from "../lib/grants";
import { newConversationId } from "../lib/ids";

type Row = { scenario: string; check: string; ok: boolean; detail: string };
const results: Row[] = [];
const anomalies: string[] = [];
function check(scenario: string, name: string, ok: boolean, detail = "") {
  results.push({ scenario, check: name, ok, detail });
  const tag = ok ? "  ok " : "ANOM";
  console.log(`[${scenario}] ${tag}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) anomalies.push(`[${scenario}] ${name} — ${detail}`);
}
function aborts(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}
async function abortsAsync(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
}

let UID = 0;
function seedUser(handle: string): string {
  const uid = `u_${handle}_${UID++}`;
  db()
    .prepare(
      "INSERT INTO users (id,email,display_name,password_hash,password_salt,created_at) VALUES (?,?,?,?,?,?)",
    )
    .run(uid, `${handle}@t.test`, handle, "x".repeat(128), "y".repeat(32), Date.now());
  return uid;
}
function human(handle: string) {
  const uid = seedUser(handle);
  return { uid, agent: createAgentForUser(uid, { handle, display_name: handle }).agent };
}
function bot(handle: string, caps: string[]) {
  const uid = seedUser(handle);
  const a = spawnManagedAgent(uid, {
    handle,
    display_name: handle,
    persona: "p",
    capabilities: caps.map((name) => ({ name, version: "1" })),
  });
  setAgentCapabilities(a.id, uid, caps.map((name) => ({ name, version: "1" })));
  return { uid, agent: a };
}
function group(creatorId: string, title: string, memberIds: string[]): string {
  const id = newConversationId();
  db()
    .prepare(
      "INSERT INTO conversations (id,type,title,created_by_agent_id,created_at) VALUES (?,?,?,?,?)",
    )
    .run(id, "group", title, creatorId, Date.now());
  for (const m of memberIds) {
    db()
      .prepare(
        "INSERT INTO conversation_members (conversation_id,agent_id,role,joined_at) VALUES (?,?,?,?)",
      )
      .run(id, m, "member", Date.now());
  }
  return id;
}
function jobsFor(triggerId: string): string[] {
  return (
    db().prepare("SELECT agent_id FROM reply_jobs WHERE trigger_message_id=?").all(triggerId) as Array<{
      agent_id: string;
    }>
  ).map((r) => r.agent_id);
}
function clearJobs() {
  db().prepare("DELETE FROM reply_jobs").run();
}
function unread(conv: string, agentId: string): number {
  const lr = (
    db()
      .prepare("SELECT last_read_message_id FROM conversation_members WHERE conversation_id=? AND agent_id=?")
      .get(conv, agentId) as { last_read_message_id: string | null } | undefined
  )?.last_read_message_id;
  const at = lr
    ? ((db().prepare("SELECT created_at FROM messages WHERE id=?").get(lr) as { created_at: number } | undefined)
        ?.created_at ?? 0)
    : 0;
  return (
    db()
      .prepare("SELECT COUNT(*) n FROM messages WHERE conversation_id=? AND from_agent_id!=? AND created_at > ?")
      .get(conv, agentId, at) as { n: number }
  ).n;
}

// A brainStep that writes a fixed file then submits — lets us drive the
// autonomy loop deterministically for many agents.
function writerStep(path: string, content: string): AutonomyBrainStep {
  return async () => ({
    text: `<write path="${path}" commit="by step">${content}</write> <submit/>`,
    thinking: "",
    artifacts: [{ path, commit_message: "by step", content }],
  });
}

// ===========================================================================
function scenarioNN() {
  resetTables(db());
  const alice = human("alice"), bob = human("bob");
  const eng = bot("eng", ["workspace.write"]),
    qa = bot("qa", ["task.review"]),
    docs = bot("docs", ["workspace.write"]);
  const conv = group(alice.agent.id, "War room", [
    alice.agent.id, bob.agent.id, eng.agent.id, qa.agent.id, docs.agent.id,
  ]);

  // fan-out: a human message queues delivery to all 4 other members
  const m1 = sendMessage(conv, alice.agent.id, { text: "Kickoff: plan the Q3 launch." });
  const deliv = (
    db().prepare("SELECT target_agent_id FROM delivery_queue WHERE message_id=?").all(m1.id) as Array<{
      target_agent_id: string;
    }>
  ).map((r) => r.target_agent_id);
  check(
    "NN", "message fans out to all 4 other members",
    deliv.length === 4 && [bob, eng, qa, docs].every((x) => deliv.includes(x.agent.id)),
    `delivered=${deliv.length}`,
  );

  // reply jobs: the 3 managed agents get jobs; humans never do
  enqueueRepliesForMessage(conv, m1.id, alice.agent.id);
  let jobs = jobsFor(m1.id);
  check(
    "NN", "reply-jobs enqueued for managed agents only (humans excluded)",
    jobs.length === 3 && [eng, qa, docs].every((x) => jobs.includes(x.agent.id)) && !jobs.includes(bob.agent.id),
    `jobs=[${jobs.length}]`,
  );
  clearJobs();

  // human @mention lifts the per-minute cap for the mentioned bot
  for (let i = 0; i < 4; i++) sendMessage(conv, eng.agent.id, { text: `auto ${i}`, kind: "agent_to_agent" });
  const m2 = sendMessage(conv, alice.agent.id, { text: "@eng please own the API task" });
  enqueueRepliesForMessage(conv, m2.id, alice.agent.id);
  jobs = jobsFor(m2.id);
  check("NN", "human @mention bypasses base cap for the mentioned bot", jobs.includes(eng.agent.id),
    `eng got a job past 4/min: ${jobs.includes(eng.agent.id)}`);
  clearJobs();

  // managed→managed @mention does NOT bypass the cap
  for (let i = 0; i < 4; i++) sendMessage(conv, docs.agent.id, { text: `d ${i}`, kind: "agent_to_agent" });
  const m3 = sendMessage(conv, eng.agent.id, { text: "@docs take a look", kind: "agent_to_agent" });
  enqueueRepliesForMessage(conv, m3.id, eng.agent.id);
  jobs = jobsFor(m3.id);
  check("NN", "managed→managed @mention does NOT bypass cap", !jobs.includes(docs.agent.id),
    `docs job past cap (want false): ${jobs.includes(docs.agent.id)}`);
  clearJobs();

  // membership boundary: a non-member cannot post
  const carol = human("carol");
  check("NN", "non-member cannot post into the room", aborts(() => sendMessage(conv, carol.agent.id, { text: "hi" })));

  // unread bookkeeping for a human bystander
  const before = unread(conv, bob.agent.id);
  const m4 = sendMessage(conv, alice.agent.id, { text: "status?" });
  const mid = unread(conv, bob.agent.id);
  markRead(conv, bob.agent.id, m4.id);
  const after = unread(conv, bob.agent.id);
  check("NN", "unread rises on new message and clears on markRead", mid > before && after === 0,
    `before=${before} mid=${mid} after=${after}`);
}

// ===========================================================================
async function scenario1N() {
  resetTables(db());
  const carol = human("carol");
  const a = bot("wkr_a", ["workspace.write"]),
    b = bot("wkr_b", ["workspace.write"]),
    c = bot("wkr_c", ["workspace.write"]);
  const conv = group(carol.agent.id, "Solo founder + agent team", [
    carol.agent.id, a.agent.id, b.agent.id, c.agent.id,
  ]);
  const ws = createWorkspace({ name: "proj", conversation_id: conv, created_by_agent_id: carol.agent.id });
  for (const w of [a, b, c]) subscribeAgent(ws.id, w.agent.id, "writer");

  // 3 agents each own a task writing a DIFFERENT file → all should complete and
  // auto-rebase onto one head (non-overlapping files must not 409).
  const tasks = [a, b, c].map((w, i) =>
    createTask({
      title: `part ${i}`,
      owner_agent_id: carol.agent.id,
      assigned_to_agent_id: w.agent.id,
      conversation_id: conv,
      workspace_id: ws.id,
      required_capabilities: ["workspace.write"],
      success_criteria: [{ type: "test_command", cmd: "true" }],
    }),
  );
  await runAutonomousTask(a.agent.id, tasks[0].id, { brainStep: writerStep("a.txt", "AAA\n") });
  await runAutonomousTask(b.agent.id, tasks[1].id, { brainStep: writerStep("b.txt", "BBB\n") });
  await runAutonomousTask(c.agent.id, tasks[2].id, { brainStep: writerStep("c.txt", "CCC\n") });
  const head = getWorkspace(ws.id)!.head_snapshot_id!;
  const files = listFiles(head).map((f) => f.path).sort();
  check("1N", "3 agents writing different files all land on one head (auto-rebase)",
    ["a.txt", "b.txt", "c.txt"].every((p) => files.includes(p)),
    `head files=${JSON.stringify(files)}`);
  check("1N", "all 3 delegated tasks reached done",
    tasks.every((t) => getTask(t.id)!.status === "done"),
    tasks.map((t) => getTask(t.id)!.status).join(","));

  // same-file / same-line clash from two agents must 409 (no lost update)
  const h = getWorkspace(ws.id)!.head_snapshot_id!;
  const r1 = applyPatch({ workspace_id: ws.id, agent_id: a.agent.id, against_rev: h,
    ops: [{ path: "shared.txt", op: "create", content: "line-from-A\n" }] });
  const r2 = applyPatch({ workspace_id: ws.id, agent_id: b.agent.id, against_rev: h,
    ops: [{ path: "shared.txt", op: "create", content: "line-from-B\n" }] });
  check("1N", "concurrent create of SAME new path → exactly one wins, other 409s",
    r1.ok && !r2.ok,
    `A.ok=${r1.ok} B.ok=${r2.ok}`);

  // dependency gate: a blocked task cannot start until its blocker is done
  const blocker = createTask({ title: "blocker", owner_agent_id: carol.agent.id,
    assigned_to_agent_id: a.agent.id, conversation_id: conv, workspace_id: ws.id });
  const blocked = createTask({ title: "blocked", owner_agent_id: carol.agent.id,
    assigned_to_agent_id: b.agent.id, conversation_id: conv, workspace_id: ws.id });
  addTaskDependency({ blocker_task_id: blocker.id, blocked_task_id: blocked.id, actor_agent_id: carol.agent.id });
  const startBlocked = await abortsAsync(() =>
    transitionTaskStatus({ task_id: blocked.id, to_status: "in_progress", actor_agent_id: b.agent.id }),
  );
  check("1N", "dependency gate blocks the dependent task from starting until blocker done", startBlocked,
    startBlocked ? "rejected as expected" : "NOT blocked");
}

// ===========================================================================
async function scenarioN1() {
  resetTables(db());
  const dave = human("dave"), erin = human("erin"), frank = human("frank");
  const asst = bot("asst", ["workspace.write"]);
  const conv = group(dave.agent.id, "Stakeholder committee", [
    dave.agent.id, erin.agent.id, frank.agent.id, asst.agent.id,
  ]);
  const ws = createWorkspace({ name: "rfc", conversation_id: conv, created_by_agent_id: dave.agent.id });
  subscribeAgent(ws.id, asst.agent.id, "writer");

  // owner=dave, assignee=asst, two-of-the-humans must approve (min_approvers 2)
  const task = createTask({
    title: "Draft the RFC",
    owner_agent_id: dave.agent.id,
    assigned_to_agent_id: asst.agent.id,
    conversation_id: conv,
    workspace_id: ws.id,
    required_capabilities: ["workspace.write"],
    success_criteria: [{ type: "diff_review", min_approvers: 2 }],
  });

  // a non-owner human cannot reassign
  check("N1", "only the OWNER can reassign (non-owner human blocked)",
    aborts(() => assignTask({ task_id: task.id, assignee_agent_id: erin.agent.id, actor_agent_id: erin.agent.id })));

  // assistant does the work → awaiting_review
  await runAutonomousTask(asst.agent.id, task.id, { brainStep: writerStep("rfc.md", "# RFC\nbody\n") });
  check("N1", "review-gated task parks at awaiting_review (no self-approve)",
    getTask(task.id)!.status === "awaiting_review", getTask(task.id)!.status);

  // assignee cannot approve own work
  check("N1", "assignee cannot approve their own work", aborts(() => approveTask(task.id, asst.agent.id)));

  // one human approval is NOT enough for min_approvers=2. Closing with unmet
  // criteria does not throw — it bounces to changes_requested.
  approveTask(task.id, erin.agent.id);
  const afterOneRes = await transitionTaskStatus({ task_id: task.id, to_status: "done", actor_agent_id: dave.agent.id });
  const afterOne = afterOneRes.task.status;
  check("N1", "1 of 2 approvers is insufficient (does not reach done)",
    afterOne !== "done", `status after 1 approval+close=${afterOne}`);

  // second human approves → now it can close
  // (re-submit to awaiting_review first if it bounced)
  if (getTask(task.id)!.status === "changes_requested") {
    await transitionTaskStatus({ task_id: task.id, to_status: "in_progress", actor_agent_id: asst.agent.id });
    await transitionTaskStatus({ task_id: task.id, to_status: "awaiting_review", actor_agent_id: asst.agent.id,
      result_snapshot_id: getWorkspace(ws.id)!.head_snapshot_id });
  }
  approveTask(task.id, frank.agent.id);
  const closed = await transitionTaskStatus({ task_id: task.id, to_status: "done", actor_agent_id: dave.agent.id });
  check("N1", "2 distinct human approvers satisfy min_approvers=2 → done",
    closed.task.status === "done", `status=${closed.task.status} failures=${JSON.stringify(closed.criteria_failures ?? [])}`);
}

// ===========================================================================
function scenarioCrossTeam() {
  resetTables(db());
  // Team A (alice) owns a workspace; Team B (bob) is a different user.
  const alice = human("alice"), bob = human("bob"), mallory = human("mallory");
  const convA = group(alice.agent.id, "Team A", [alice.agent.id]);
  const ws = createWorkspace({ name: "secret", conversation_id: convA, created_by_agent_id: alice.agent.id });

  // Before any grant: bob's agent has no subscription and no grant.
  check("XT", "ungranted outsider cannot read (subscription)", !canRead(ws.id, bob.agent.id));
  check("XT", "ungranted outsider fails grant check",
    !agentMayUseResource({ using_agent_id: bob.agent.id, resource_type: "workspace", resource_id: ws.id, required_scope: "read" }));

  // Alice grants bob READ on the workspace.
  const grant = createGrant({
    from_user_id: alice.uid, from_agent_id: alice.agent.id, to_agent_id: bob.agent.id,
    resource_type: "workspace", resource_id: ws.id, scopes: ["read"], duration_key: "1h",
  });
  check("XT", "granted agent passes the grant check (read)",
    agentMayUseResource({ using_agent_id: bob.agent.id, resource_type: "workspace", resource_id: ws.id, required_scope: "read" }));
  check("XT", "read grant does NOT confer write",
    !agentMayUseResource({ using_agent_id: bob.agent.id, resource_type: "workspace", resource_id: ws.id, required_scope: "write" }));
  // A third party (mallory) still has nothing.
  check("XT", "an unrelated third party is unaffected by the grant",
    !agentMayUseResource({ using_agent_id: mallory.agent.id, resource_type: "workspace", resource_id: ws.id, required_scope: "read" }));

  // Revoke → access gone.
  revokeGrant({ grant_id: grant.id, user_id: alice.uid, reason: "done" });
  check("XT", "revoked grant no longer grants access",
    !agentMayUseResource({ using_agent_id: bob.agent.id, resource_type: "workspace", resource_id: ws.id, required_scope: "read" }));

  // Expiry: an already-expired grant is inert.
  const expired = createGrant({
    from_user_id: alice.uid, from_agent_id: alice.agent.id, to_agent_id: bob.agent.id,
    resource_type: "workspace", resource_id: ws.id, scopes: ["read"], expires_at: Date.now() - 1000,
  });
  check("XT", "expired grant is inert",
    !agentMayUseResource({ using_agent_id: bob.agent.id, resource_type: "workspace", resource_id: ws.id, required_scope: "read" }),
    `grant ${expired.id}`);
}

// ===========================================================================
function scenarioConcurrency() {
  resetTables(db());
  const alice = human("alice");
  const x = bot("agx", ["workspace.write"]), y = bot("agy", ["workspace.write"]);
  const conv = group(alice.agent.id, "Conc", [alice.agent.id, x.agent.id, y.agent.id]);

  // lease claim: two claims never grab the same job
  const m = sendMessage(conv, alice.agent.id, { text: "ping both" });
  enqueueRepliesForMessage(conv, m.id, alice.agent.id);
  const c1 = claimNextJob(Date.now());
  const c2 = claimNextJob(Date.now());
  check("CC", "two concurrent claims never grab the same job",
    !!c1 && !!c2 && c1!.id !== c2!.id, `c1=${c1?.id} c2=${c2?.id}`);

  // idempotency: a re-claimed job that already 'sent' is not re-sent. Simulate
  // by stamping sent_message_id and re-running the lease/idempotency path.
  if (c1) {
    db().prepare("UPDATE reply_jobs SET sent_message_id=?, status='running', lease_until=? WHERE id=?")
      .run("msg_fake", Date.now() - 1, c1.id); // lease already expired → re-claimable
    const reclaim = claimNextJob(Date.now());
    const sameAgain = reclaim?.id === c1.id;
    const stillStamped = (db().prepare("SELECT sent_message_id FROM reply_jobs WHERE id=?").get(c1.id) as { sent_message_id: string | null }).sent_message_id;
    check("CC", "a re-claimed job retains its sent_message_id (idempotency marker survives)",
      stillStamped === "msg_fake", `reclaimedSame=${sameAgain} stamp=${stillStamped}`);
  }
  clearJobs();
}

// ===========================================================================
async function scenarioEdge() {
  resetTables(db());
  const boss = human("boss");
  const dev = bot("dev", ["workspace.write"]);
  const ext = human("ext"); // a non-managed (human / external) member
  const conv = group(boss.agent.id, "Edge", [boss.agent.id, dev.agent.id, ext.agent.id]);
  const ws = createWorkspace({ name: "w", conversation_id: conv, created_by_agent_id: boss.agent.id });
  subscribeAgent(ws.id, dev.agent.id, "writer");

  // capability-gated assignment: a reviewer-only agent can't take a write task
  const rev = bot("rev", ["task.review"]);
  db().prepare("INSERT INTO conversation_members (conversation_id,agent_id,role,joined_at) VALUES (?,?,?,?)")
    .run(conv, rev.agent.id, "member", Date.now());
  const t = createTask({ title: "needs write", owner_agent_id: boss.agent.id, conversation_id: conv,
    workspace_id: ws.id, required_capabilities: ["workspace.write"] });
  check("EDGE", "assign rejected when assignee lacks the required capability",
    aborts(() => assignTask({ task_id: t.id, assignee_agent_id: rev.agent.id, actor_agent_id: boss.agent.id })));
  assignTask({ task_id: t.id, assignee_agent_id: dev.agent.id, actor_agent_id: boss.agent.id });
  check("EDGE", "assign succeeds for a capable agent", getTask(t.id)!.assigned_to_agent_id === dev.agent.id);

  // the autonomy loop must never drive a human (non-managed) assignee
  const t2 = createTask({ title: "human task", owner_agent_id: boss.agent.id, assigned_to_agent_id: ext.agent.id,
    conversation_id: conv, workspace_id: ws.id });
  const r = await runAutonomousTask(ext.agent.id, t2.id, { brainStep: writerStep("x.txt", "x") });
  check("EDGE", "autonomy loop is a noop for a human (non-managed) assignee", r.outcome === "noop", `outcome=${r.outcome}`);

  // IDOR: a result snapshot from a DIFFERENT workspace must be rejected by the gate
  const ws2 = createWorkspace({ name: "other", conversation_id: conv, created_by_agent_id: boss.agent.id });
  subscribeAgent(ws2.id, dev.agent.id, "writer");
  const foreign = applyPatch({ workspace_id: ws2.id, agent_id: dev.agent.id,
    against_rev: getWorkspace(ws2.id)!.head_snapshot_id!, ops: [{ path: "ok.sh", op: "create", content: "exit 0" }] });
  const t3 = createTask({ title: "idor", owner_agent_id: boss.agent.id, assigned_to_agent_id: dev.agent.id,
    conversation_id: conv, workspace_id: ws.id, required_capabilities: ["workspace.write"],
    success_criteria: [{ type: "test_command", cmd: "bash ok.sh" }] });
  await transitionTaskStatus({ task_id: t3.id, to_status: "in_progress", actor_agent_id: dev.agent.id });
  await transitionTaskStatus({ task_id: t3.id, to_status: "awaiting_review", actor_agent_id: dev.agent.id });
  const idor = await transitionTaskStatus({ task_id: t3.id, to_status: "done", actor_agent_id: dev.agent.id,
    result_snapshot_id: foreign.ok ? foreign.snapshot_id : null });
  check("EDGE", "cross-workspace result snapshot rejected by criteria (IDOR)",
    idor.task.status !== "done" && (idor.criteria_failures ?? []).some((f) => /workspace/.test(f)),
    `status=${idor.task.status} failures=${JSON.stringify(idor.criteria_failures ?? [])}`);

  // requestChanges by a non-participant must be rejected
  const stranger = human("stranger"); // not a member of conv
  const t4 = createTask({ title: "rc", owner_agent_id: boss.agent.id, assigned_to_agent_id: dev.agent.id,
    conversation_id: conv, workspace_id: ws.id, success_criteria: [{ type: "diff_review", min_approvers: 1 }] });
  await transitionTaskStatus({ task_id: t4.id, to_status: "in_progress", actor_agent_id: dev.agent.id });
  await transitionTaskStatus({ task_id: t4.id, to_status: "awaiting_review", actor_agent_id: dev.agent.id });
  check("EDGE", "requestChanges by a non-participant is rejected",
    await abortsAsync(() => requestChanges(t4.id, stranger.agent.id, "nope")));

  // a member removed mid-task must not crash the autonomy loop
  db().prepare("DELETE FROM conversation_members WHERE conversation_id=? AND agent_id=?").run(conv, dev.agent.id);
  const crashed = await abortsAsync(() => runAutonomousTask(dev.agent.id, t.id, { brainStep: writerStep("after-remove.txt", "y") }));
  check("EDGE", "autonomy does not crash when the assignee was removed from the conversation", !crashed);
}

// ===========================================================================
void (async () => {
  setupTestDb();
  _resetDbForTests();
  try {
    scenarioNN();
    await scenario1N();
    await scenarioN1();
    scenarioCrossTeam();
    scenarioConcurrency();
    await scenarioEdge();
  } catch (err) {
    console.error("PROBE CRASHED:", err);
    anomalies.push(`PROBE CRASHED: ${err instanceof Error ? err.stack : String(err)}`);
  } finally {
    const pass = results.filter((r) => r.ok).length;
    console.log(`\n================ PROBE SUMMARY ================`);
    console.log(`checks: ${results.length}  pass: ${pass}  anomalies: ${results.length - pass}`);
    if (anomalies.length) {
      console.log(`\nANOMALIES:`);
      for (const a of anomalies) console.log(`  ✗ ${a}`);
    } else {
      console.log(`all checks passed`);
    }
    teardownTestDb();
  }
})();
