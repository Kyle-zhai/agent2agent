import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestDb, teardownTestDb, resetTables } from "../helpers/setup";
import { _resetDbForTests, db } from "../../lib/db";
import { runMaintenanceSweep, RETENTION } from "../../lib/maintenance";
import { createAgentForUser } from "../../lib/agents";
import { createTask } from "../../lib/tasks";

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

/** Real parent rows so FK constraints on a2a_idempotency / conversation_events
 *  / sessions are satisfied while we test the sweep's deletion logic. */
function seedParents() {
  db()
    .prepare("INSERT INTO users (id, email, display_name, password_hash, password_salt, created_at) VALUES ('u','u@t.test','u','x','y',?)")
    .run(NOW);
  const agent = createAgentForUser("u", { handle: "worker", display_name: "W" }).agent;
  db()
    .prepare("INSERT INTO conversations (id, type, title, created_by_agent_id, created_at) VALUES ('c','group','g',?,?)")
    .run(agent.id, NOW);
  const task = createTask({ title: "t", owner_agent_id: agent.id, conversation_id: "c" });
  return { agent, task };
}

describe("runMaintenanceSweep — retention on unbounded tables", () => {
  it("deletes aged rows and keeps fresh ones", () => {
    const { task } = seedParents();
    const old = NOW - RETENTION.idempotency - 1000;
    const fresh = NOW - 1000;

    db().prepare("INSERT INTO a2a_idempotency (idem_key, task_id, created_at) VALUES ('old', ?, ?)").run(task.id, old);
    db().prepare("INSERT INTO a2a_idempotency (idem_key, task_id, created_at) VALUES ('new', ?, ?)").run(task.id, fresh);

    db().prepare("INSERT INTO rate_limit_buckets (bucket_key, tokens, last_refill_at) VALUES ('stale', 5, ?)").run(NOW - RETENTION.rateLimit - 1000);
    db().prepare("INSERT INTO rate_limit_buckets (bucket_key, tokens, last_refill_at) VALUES ('active', 5, ?)").run(fresh);

    db().prepare("INSERT INTO conversation_events (conversation_id, kind, created_at) VALUES ('c', 'message', ?)").run(NOW - RETENTION.conversationEvents - 1000);
    db().prepare("INSERT INTO conversation_events (conversation_id, kind, created_at) VALUES ('c', 'message', ?)").run(fresh);

    db().prepare("INSERT INTO device_auth_requests (id, device_code, user_code, status, created_at, expires_at) VALUES ('d1','dc1','UC1','expired',?,?)").run(old, NOW - RETENTION.deviceAuth - 1000);
    db().prepare("INSERT INTO device_auth_requests (id, device_code, user_code, status, created_at, expires_at) VALUES ('d2','dc2','UC2','pending',?,?)").run(NOW, NOW + 600_000);

    db().prepare("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES ('s_old','u',?,?)").run(NOW - 1000, NOW - 100000);
    db().prepare("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES ('s_live','u',?,?)").run(NOW + 1_000_000, NOW);

    const r = runMaintenanceSweep(NOW);

    assert.equal(r.idempotency, 1);
    assert.equal(r.rateLimit, 1);
    assert.equal(r.conversationEvents, 1);
    assert.equal(r.deviceAuth, 1);
    assert.equal(r.webSessions, 1);

    assert.ok(db().prepare("SELECT 1 FROM a2a_idempotency WHERE idem_key = 'new'").get());
    assert.ok(db().prepare("SELECT 1 FROM rate_limit_buckets WHERE bucket_key = 'active'").get());
    assert.ok(db().prepare("SELECT 1 FROM device_auth_requests WHERE id = 'd2'").get());
    assert.ok(db().prepare("SELECT 1 FROM sessions WHERE id = 's_live'").get());
  });

  it("sweeps acked delivery_queue rows older than 7d, keeps fresh acks (v0.21 C4)", () => {
    const { agent } = seedParents();
    // Real message parents for the delivery FK; UNIQUE(target, message)
    // means each delivery row gets its own message.
    for (const m of ["m1", "m2"]) {
      db().prepare("INSERT INTO messages (id, conversation_id, from_agent_id, text, created_at) VALUES (?,'c',?,?,?)").run(m, agent.id, "hi", NOW);
    }
    const oldAck = NOW - RETENTION.deliveryAcked - 1000;
    db().prepare("INSERT INTO delivery_queue (id, target_agent_id, message_id, delivered_at, ack_at, created_at) VALUES ('dq_ack_old',?,'m1',?,?,?)").run(agent.id, oldAck, oldAck, oldAck);
    db().prepare("INSERT INTO delivery_queue (id, target_agent_id, message_id, delivered_at, ack_at, created_at) VALUES ('dq_ack_new',?,'m2',?,?,?)").run(agent.id, NOW - 1000, NOW - 1000, NOW - 1000);

    const r = runMaintenanceSweep(NOW);
    assert.equal(r.deliveryAcked, 1);
    assert.equal(r.deliveryUnacked, 0);
    assert.equal(db().prepare("SELECT 1 FROM delivery_queue WHERE id = 'dq_ack_old'").get(), undefined);
    assert.ok(db().prepare("SELECT 1 FROM delivery_queue WHERE id = 'dq_ack_new'").get());
  });

  it("sweeps un-acked delivery_queue rows older than 30d, keeps recent pending ones (v0.21 C4)", () => {
    const { agent } = seedParents();
    for (const m of ["m1", "m2", "m3"]) {
      db().prepare("INSERT INTO messages (id, conversation_id, from_agent_id, text, created_at) VALUES (?,'c',?,?,?)").run(m, agent.id, "hi", NOW);
    }
    const ancient = NOW - RETENTION.deliveryUnacked - 1000;
    // Un-acked + ancient → swept. Un-acked + merely 8 days old → kept (the
    // 7d cutoff applies only to ACKED rows). Un-acked + fresh → kept.
    db().prepare("INSERT INTO delivery_queue (id, target_agent_id, message_id, created_at) VALUES ('dq_pending_ancient',?,'m1',?)").run(agent.id, ancient);
    db().prepare("INSERT INTO delivery_queue (id, target_agent_id, message_id, created_at) VALUES ('dq_pending_8d',?,'m2',?)").run(agent.id, NOW - 8 * 86_400_000);
    db().prepare("INSERT INTO delivery_queue (id, target_agent_id, message_id, created_at) VALUES ('dq_pending_fresh',?,'m3',?)").run(agent.id, NOW - 1000);

    const r = runMaintenanceSweep(NOW);
    assert.equal(r.deliveryUnacked, 1);
    assert.equal(r.deliveryAcked, 0);
    assert.equal(db().prepare("SELECT 1 FROM delivery_queue WHERE id = 'dq_pending_ancient'").get(), undefined);
    assert.ok(db().prepare("SELECT 1 FROM delivery_queue WHERE id = 'dq_pending_8d'").get());
    assert.ok(db().prepare("SELECT 1 FROM delivery_queue WHERE id = 'dq_pending_fresh'").get());
  });

  it("sweeps terminal reply_jobs but keeps in-flight ones", () => {
    const { agent } = seedParents();
    const oldFinish = NOW - RETENTION.replyJobs - 1000;
    db().prepare("INSERT INTO reply_jobs (id, conversation_id, agent_id, status, attempts, finished_at, created_at) VALUES ('done_old','c',?,'done',1,?,?)").run(agent.id, oldFinish, oldFinish);
    db().prepare("INSERT INTO reply_jobs (id, conversation_id, agent_id, status, attempts, finished_at, created_at) VALUES ('done_new','c',?,'done',1,?,?)").run(agent.id, NOW - 1000, NOW);
    db().prepare("INSERT INTO reply_jobs (id, conversation_id, agent_id, status, attempts, created_at) VALUES ('pending','c',?,'pending',0,?)").run(agent.id, oldFinish);

    const r = runMaintenanceSweep(NOW);
    assert.equal(r.replyJobs, 1);
    assert.ok(db().prepare("SELECT 1 FROM reply_jobs WHERE id = 'done_new'").get());
    assert.ok(db().prepare("SELECT 1 FROM reply_jobs WHERE id = 'pending'").get());
    assert.equal(db().prepare("SELECT 1 FROM reply_jobs WHERE id = 'done_old'").get(), undefined);
  });
});
