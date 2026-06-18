import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestDb, teardownTestDb, resetTables } from "../helpers/setup";
import { _resetDbForTests, db } from "../../lib/db";
import { createAgentForUser } from "../../lib/agents";
import { consume, RATE_LIMITS } from "../../lib/rate-limit";
import { GET as getConversations } from "../../app/api/v1/conversations/route";
import { GET as getTasks } from "../../app/api/v1/tasks/route";
import { GET as getAvatar } from "../../app/api/v1/blobs/avatar/[agent_id]/route";

// v0.21 Group C security hardening (C1 device-code lookup throttle,
// C3 list-endpoint caps, C6 avatar agent_id validation). C4 lives in
// maintenance.test.ts and C5 in handoffs.test.ts next to their peers.

before(() => {
  setupTestDb();
  _resetDbForTests();
});

after(() => {
  _resetDbForTests();
  teardownTestDb();
});

beforeEach(() => {
  resetTables(db());
});

function seedUserAgent(userId: string, handle: string) {
  db()
    .prepare(
      "INSERT INTO users (id, email, display_name, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(userId, `${handle}@t.test`, handle, "x".repeat(128), "y".repeat(32), Date.now());
  return createAgentForUser(userId, { handle, display_name: handle });
}

function authedGet(url: string, apiKey: string): Request {
  return new Request(url, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
}

// ---------------------------------------------------------------------------
// C1 — device user_code lookup throttle (per-IP, 10/min)
// ---------------------------------------------------------------------------

describe("C1: deviceLookup rate-limit bucket", () => {
  it("is configured at 10 per minute", () => {
    assert.equal(RATE_LIMITS.deviceLookup.capacity, 10);
    assert.equal(RATE_LIMITS.deviceLookup.refillPerSecond, 10 / 60);
  });

  it("allows 10 lookups then denies the 11th with a retry hint", () => {
    const key = "device.lookup:ip:203.0.113.7";
    for (let i = 0; i < 10; i++) {
      const r = consume(key, RATE_LIMITS.deviceLookup);
      assert.equal(r.allowed, true, `lookup ${i + 1} should pass`);
    }
    const eleventh = consume(key, RATE_LIMITS.deviceLookup);
    assert.equal(eleventh.allowed, false);
    assert.ok(eleventh.retryAfterSeconds > 0);
  });

  it("keeps per-IP buckets independent — one abuser cannot starve others", () => {
    const abuser = "device.lookup:ip:198.51.100.1";
    for (let i = 0; i < 11; i++) consume(abuser, RATE_LIMITS.deviceLookup);
    assert.equal(consume(abuser, RATE_LIMITS.deviceLookup).allowed, false);
    const normal = consume(
      "device.lookup:ip:198.51.100.2",
      RATE_LIMITS.deviceLookup,
    );
    assert.equal(normal.allowed, true);
  });

  it("global backstop caps lookups across ALL IPs — rotation doesn't help", () => {
    // 60/min constant-key bucket, same shape as signinGlobal: an enumerator
    // rotating x-forwarded-for burns the global budget even though every
    // per-IP bucket stays fresh.
    const key = "device.lookup:global";
    for (let i = 0; i < 60; i++) {
      const r = consume(key, RATE_LIMITS.deviceLookupGlobal);
      assert.equal(r.allowed, true, `global lookup ${i + 1} should pass`);
    }
    const over = consume(key, RATE_LIMITS.deviceLookupGlobal);
    assert.equal(over.allowed, false);
    assert.ok(over.retryAfterSeconds > 0);
  });
});

// ---------------------------------------------------------------------------
// C3 — GET /api/v1/conversations cap (200, ?limit clamped to [1,200])
// ---------------------------------------------------------------------------

function seedConversations(agentId: string, count: number) {
  const insConv = db().prepare(
    "INSERT INTO conversations (id, type, title, created_by_agent_id, created_at) VALUES (?, 'group', ?, ?, ?)",
  );
  const insMem = db().prepare(
    "INSERT INTO conversation_members (conversation_id, agent_id, role, joined_at) VALUES (?, ?, 'owner', ?)",
  );
  for (let i = 0; i < count; i++) {
    insConv.run(`cnv_t${i}`, `room ${i}`, agentId, 1_000 + i);
    insMem.run(`cnv_t${i}`, agentId, 1_000 + i);
  }
}

describe("C3: GET /api/v1/conversations list cap", () => {
  it("caps an unbounded listing at 200 rows", async () => {
    const { agent, apiKey } = seedUserAgent("usr_c3a", "capper");
    seedConversations(agent.id, 205);
    const res = await getConversations(
      authedGet("http://test.local/api/v1/conversations", apiKey),
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { conversations: Array<{ id: string }> };
    assert.equal(body.conversations.length, 200);
    // Newest-first ordering survives the cap.
    assert.equal(body.conversations[0].id, "cnv_t204");
  });

  it("honors ?limit= within range and clamps 0 / oversize / junk", async () => {
    const { agent, apiKey } = seedUserAgent("usr_c3b", "clamper");
    seedConversations(agent.id, 205);

    const five = await getConversations(
      authedGet("http://test.local/api/v1/conversations?limit=5", apiKey),
    );
    assert.equal(
      ((await five.json()) as { conversations: unknown[] }).conversations.length,
      5,
    );

    const zero = await getConversations(
      authedGet("http://test.local/api/v1/conversations?limit=0", apiKey),
    );
    assert.equal(
      ((await zero.json()) as { conversations: unknown[] }).conversations.length,
      1, // clamped up to 1, not unbounded and not empty
    );

    const huge = await getConversations(
      authedGet("http://test.local/api/v1/conversations?limit=99999", apiKey),
    );
    assert.equal(
      ((await huge.json()) as { conversations: unknown[] }).conversations.length,
      200, // clamped down to the hard cap
    );

    const junk = await getConversations(
      authedGet("http://test.local/api/v1/conversations?limit=abc", apiKey),
    );
    assert.equal(
      ((await junk.json()) as { conversations: unknown[] }).conversations.length,
      200, // non-numeric falls back to the default cap
    );
  });
});

// ---------------------------------------------------------------------------
// C3 — GET /api/v1/tasks cap (same clamp, default 100)
// ---------------------------------------------------------------------------

function seedAssignedTasks(agentId: string, count: number) {
  const ins = db().prepare(
    `INSERT INTO tasks (id, title, owner_agent_id, assigned_to_agent_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'assigned', ?, ?)`,
  );
  for (let i = 0; i < count; i++) {
    ins.run(`tsk_t${i}`, `task ${i}`, agentId, agentId, 1_000 + i, 1_000 + i);
  }
}

describe("C3: GET /api/v1/tasks list cap", () => {
  it("caps oversize ?limit= at 200 and defaults to 100", async () => {
    const { agent, apiKey } = seedUserAgent("usr_c3c", "tasker");
    seedAssignedTasks(agent.id, 205);

    const huge = await getTasks(
      authedGet("http://test.local/api/v1/tasks?limit=99999", apiKey),
    );
    assert.equal(huge.status, 200);
    assert.equal(
      ((await huge.json()) as { tasks: unknown[] }).tasks.length,
      200,
    );

    const noParam = await getTasks(
      authedGet("http://test.local/api/v1/tasks", apiKey),
    );
    assert.equal(
      ((await noParam.json()) as { tasks: unknown[] }).tasks.length,
      100, // historical default preserved
    );
  });

  it("honors a small ?limit= and clamps 0 up to 1", async () => {
    const { agent, apiKey } = seedUserAgent("usr_c3d", "smalltask");
    seedAssignedTasks(agent.id, 5);

    const three = await getTasks(
      authedGet("http://test.local/api/v1/tasks?limit=3", apiKey),
    );
    assert.equal(((await three.json()) as { tasks: unknown[] }).tasks.length, 3);

    const zero = await getTasks(
      authedGet("http://test.local/api/v1/tasks?limit=0", apiKey),
    );
    assert.equal(((await zero.json()) as { tasks: unknown[] }).tasks.length, 1);
  });
});

// ---------------------------------------------------------------------------
// C6 — avatar agent_id validation (404 before any storage access)
// ---------------------------------------------------------------------------

function avatarReq(agentIdParam: string) {
  return getAvatar(new Request("http://test.local/api/v1/blobs/avatar/x"), {
    params: Promise.resolve({ agent_id: agentIdParam }),
  });
}

describe("C6: avatar agent_id format validation", () => {
  it("404s a path-traversal id (raw)", async () => {
    const res = await avatarReq("../../etc/passwd");
    assert.equal(res.status, 404);
  });

  it("404s a path-traversal id (percent-encoded slashes)", async () => {
    const res = await avatarReq("..%2F..%2Fetc%2Fpasswd");
    assert.equal(res.status, 404);
  });

  it("404s an over-length id (>80 chars)", async () => {
    const res = await avatarReq("a".repeat(81));
    assert.equal(res.status, 404);
  });

  it("404s malformed percent-encoding instead of throwing", async () => {
    const res = await avatarReq("%E0%A4%A");
    assert.equal(res.status, 404);
  });

  it("404s a well-formed id that matches no agent", async () => {
    const res = await avatarReq("ghost.abcd");
    assert.equal(res.status, 404);
  });

  it("still 404s a real agent without an avatar (regression)", async () => {
    const { agent } = seedUserAgent("usr_c6", "noavatar");
    const res = await avatarReq(agent.id);
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "No avatar.");
  });
});
