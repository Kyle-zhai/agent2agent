import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestDb, teardownTestDb, resetTables } from "../helpers/setup";
import { _resetDbForTests, db } from "../../lib/db";
import { createAgentForUser } from "../../lib/agents";
import {
  claimNextJob,
  resumeOrphanedJobs,
  JOB_LEASE_MS,
  MAX_JOB_ATTEMPTS,
} from "../../lib/managed-agents";

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
  NOW = 1_700_000_000_000;
  resetTables(db());
});

function seedConvAndAgent() {
  db()
    .prepare(
      "INSERT INTO users (id, email, display_name, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run("usr_o", "o@t.test", "o", "x".repeat(128), "y".repeat(32), NOW);
  const agent = createAgentForUser("usr_o", { handle: "worker", display_name: "Worker" }).agent;
  const convId = "cnv_test";
  db()
    .prepare(
      `INSERT INTO conversations (id, type, title, created_by_agent_id, created_at)
       VALUES (?, 'group', 'g', ?, ?)`,
    )
    .run(convId, agent.id, NOW);
  return { agent, convId };
}

function enqueue(id: string, convId: string, agentId: string, createdAt = NOW) {
  db()
    .prepare(
      `INSERT INTO reply_jobs (id, conversation_id, agent_id, trigger_message_id, status, attempts, created_at)
       VALUES (?, ?, ?, NULL, 'pending', 0, ?)`,
    )
    .run(id, convId, agentId, createdAt);
}

function row(id: string) {
  return db()
    .prepare("SELECT status, attempts, lease_until FROM reply_jobs WHERE id = ?")
    .get(id) as { status: string; attempts: number; lease_until: number | null };
}

describe("reply_jobs lease-based claim (v0.20)", () => {
  it("claims a pending job atomically: running + attempts++ + lease stamped", () => {
    const { agent, convId } = seedConvAndAgent();
    enqueue("job_1", convId, agent.id);
    const claimed = claimNextJob(NOW);
    assert.ok(claimed);
    assert.equal(claimed!.id, "job_1");
    const r = row("job_1");
    assert.equal(r.status, "running");
    assert.equal(r.attempts, 1);
    assert.equal(r.lease_until, NOW + JOB_LEASE_MS);
  });

  it("does NOT re-claim a running job while its lease is valid", () => {
    const { agent, convId } = seedConvAndAgent();
    enqueue("job_1", convId, agent.id);
    assert.ok(claimNextJob(NOW));
    // A second worker an instant later sees nothing claimable.
    assert.equal(claimNextJob(NOW + 1000), null);
  });

  it("RE-claims a running job once its lease expires (crash recovery), bumping attempts", () => {
    const { agent, convId } = seedConvAndAgent();
    enqueue("job_1", convId, agent.id);
    claimNextJob(NOW); // attempts → 1, lease → NOW+60s
    // Worker crashed; lease expires.
    const after = NOW + JOB_LEASE_MS + 1;
    const reclaimed = claimNextJob(after);
    assert.ok(reclaimed);
    assert.equal(reclaimed!.id, "job_1");
    const r = row("job_1");
    assert.equal(r.attempts, 2);
    assert.equal(r.lease_until, after + JOB_LEASE_MS);
  });

  it("stops re-claiming after MAX_JOB_ATTEMPTS (dead-letter boundary)", () => {
    const { agent, convId } = seedConvAndAgent();
    enqueue("job_1", convId, agent.id);
    let t = NOW;
    for (let i = 0; i < MAX_JOB_ATTEMPTS; i++) {
      const c = claimNextJob(t);
      assert.ok(c, `attempt ${i + 1} should claim`);
      t += JOB_LEASE_MS + 1; // let the lease expire each round
    }
    assert.equal(row("job_1").attempts, MAX_JOB_ATTEMPTS);
    // Next claim must refuse it.
    assert.equal(claimNextJob(t), null);
  });

  it("claims oldest-first (FIFO by created_at)", () => {
    const { agent, convId } = seedConvAndAgent();
    enqueue("job_new", convId, agent.id, NOW + 5000);
    enqueue("job_old", convId, agent.id, NOW + 1000);
    assert.equal(claimNextJob(NOW + 6000)!.id, "job_old");
  });

  it("resumeOrphanedJobs expires live leases for fast recovery and dead-letters exhausted jobs", () => {
    const { agent, convId } = seedConvAndAgent();
    // job_a: running, attempts 1, lease far in the future (worker crashed).
    db()
      .prepare(
        `INSERT INTO reply_jobs (id, conversation_id, agent_id, status, attempts, lease_until, created_at)
         VALUES ('job_a', ?, ?, 'running', 1, ?, ?)`,
      )
      .run(convId, agent.id, NOW + 999_999, NOW);
    // job_b: running, attempts already at MAX (kept crashing the worker).
    db()
      .prepare(
        `INSERT INTO reply_jobs (id, conversation_id, agent_id, status, attempts, lease_until, created_at)
         VALUES ('job_b', ?, ?, 'running', ?, ?, ?)`,
      )
      .run(convId, agent.id, MAX_JOB_ATTEMPTS, NOW + 999_999, NOW);

    resumeOrphanedJobs();

    // job_a: lease pulled back so it's immediately re-claimable, still running.
    const a = row("job_a");
    assert.equal(a.status, "running");
    assert.ok(a.lease_until! < NOW);
    const reclaimed = claimNextJob(NOW);
    assert.equal(reclaimed!.id, "job_a");

    // job_b: dead-lettered (failed), never re-claimed.
    assert.equal(row("job_b").status, "failed");
  });
});

describe("reply_jobs idempotency (v0.20.1)", () => {
  it("a re-claimed job that already sent its message does NOT send a second", async () => {
    const { agent, convId } = seedConvAndAgent();
    // Simulate: a prior attempt sent a message and recorded sent_message_id,
    // but crashed before marking 'done' — left running with an expired lease.
    db()
      .prepare(
        `INSERT INTO messages (id, conversation_id, from_agent_id, text, kind, created_at)
         VALUES ('msg_already', ?, ?, 'already delivered', 'agent_to_agent', ?)`,
      )
      .run(convId, agent.id, NOW);
    db()
      .prepare(
        `INSERT INTO reply_jobs (id, conversation_id, agent_id, trigger_message_id, status, attempts, lease_until, sent_message_id, created_at)
         VALUES ('job_dup', ?, ?, NULL, 'running', 1, ?, 'msg_already', ?)`,
      )
      .run(convId, agent.id, NOW - 1, NOW); // lease already expired

    const before = (db().prepare("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?").get(convId) as { n: number }).n;
    // Re-claim + process: the idempotency guard must finalize without sending.
    const { runPendingJobs } = await import("../../lib/managed-agents");
    await runPendingJobs(5);
    const after = (db().prepare("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?").get(convId) as { n: number }).n;
    assert.equal(after, before, "no duplicate message");
    // Job finalized to done.
    assert.equal(
      (db().prepare("SELECT status FROM reply_jobs WHERE id = ?").get("job_dup") as { status: string }).status,
      "done",
    );
  });
})
