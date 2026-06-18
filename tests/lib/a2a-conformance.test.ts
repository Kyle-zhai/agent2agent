// v0.21 A2A protocol conformance (TCK alignment):
//   A1 — tasks/get historyLength (most-recent-N trim, -32602 on bad input)
//   A2 — application/a2a+json media type on the JSON-RPC endpoint
//   A3 — platform-level origin AgentCard at /.well-known/agent-card.json
//   A4 — task-state snapshot locks for BOTH wire dialects
//   C2 — inbound size caps on message/send (reject before any DB write)
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { setupTestDb, teardownTestDb, resetTables } from "../helpers/setup";
import { _resetDbForTests, db } from "../../lib/db";
import { createAgentForUser, getAgent, type Agent } from "../../lib/agents";
import { spawnManagedAgent } from "../../lib/managed-agents";
import {
  createDirectConversation,
  listMessages,
  sendMessage,
} from "../../lib/conversations";
import { acceptFriendRequest, sendFriendRequest } from "../../lib/friends";
import { TASK_STATUSES } from "../../lib/types";
import {
  A2A_MAX_PARTS,
  A2A_MAX_TEXT_CHARS,
  A2A_TASK_STATES,
  A2AInvalidParamsError,
  PLATFORM_DIRECTORY_EXTENSION_URI,
  TASK_STATE_MAP,
  buildPlatformAgentCard,
  handleGetTask,
  handleSendMessage,
  parseHistoryLength,
  publicDirectoryAgents,
  taskStateToV1,
  type A2APart,
  type A2ATaskState,
} from "../../lib/a2a";
import {
  _resetSigningKeyForTests,
  verifyAgentCardSignature,
} from "../../lib/card-signing";
import { POST as a2aPost } from "../../app/api/v1/agents/[id]/a2a/route";
import { GET as platformCardGet } from "../../app/.well-known/agent-card.json/route";
import type { NextRequest } from "next/server";

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
  delete process.env.A2A_CARD_SIGNING_KEY;
  delete process.env.A2A_PUBLIC_AGENT_IDS;
  _resetSigningKeyForTests();
});

beforeEach(() => {
  NOW = 1_700_000_000_000;
  resetTables(db());
  delete process.env.A2A_CARD_SIGNING_KEY;
  delete process.env.A2A_PUBLIC_AGENT_IDS;
  _resetSigningKeyForTests();
});

function seedUser(userId: string, handle: string) {
  db()
    .prepare(
      "INSERT INTO users (id, email, display_name, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(userId, `${handle}@t.test`, handle, "x".repeat(128), "y".repeat(32), NOW);
  return createAgentForUser(userId, { handle, display_name: handle });
}

function connect(aUser: string, a: { id: string }, b: { id: string }) {
  const req = sendFriendRequest(aUser, a.id, b.id);
  const bOwner = getAgent(b.id)!.owner_user_id;
  acceptFriendRequest(bOwner, req.id);
}

/** alice ↔ bob direct conversation + one A2A message/send opening a task. */
function seedPair() {
  const { agent: alice, apiKey: aliceKey } = seedUser("usr_a", "alice");
  const { agent: bob, apiKey: bobKey } = seedUser("usr_b", "bob");
  connect("usr_a", alice, bob);
  const conv = createDirectConversation("usr_a", alice.id, bob.id);
  return { alice, aliceKey, bob, bobKey, conv };
}

function textMsg(
  messageId: string,
  contextId: string,
  text = "hello",
  parts?: A2APart[],
) {
  return {
    message: {
      kind: "message" as const,
      messageId,
      role: "user" as const,
      parts: parts ?? [{ kind: "text" as const, text }],
      contextId,
    },
  };
}

function countRows(table: string): number {
  return (db().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

// ---------------------------------------------------------------------------
// A1 — tasks/get historyLength
// ---------------------------------------------------------------------------

describe("A1 — tasks/get historyLength", () => {
  function seedTaskWithHistory() {
    const { alice, bob, conv } = seedPair();
    const out = handleSendMessage(alice, bob, textMsg("m_h1", conv.id, "one"));
    // Three more messages, strictly increasing timestamps so the tail order
    // is deterministic: one(alice) → two(bob) → three(alice) → four(bob).
    NOW += 1000;
    sendMessage(conv.id, bob.id, { text: "two", kind: "agent_to_agent" });
    NOW += 1000;
    sendMessage(conv.id, alice.id, { text: "three", kind: "agent_to_agent" });
    NOW += 1000;
    sendMessage(conv.id, bob.id, { text: "four", kind: "agent_to_agent" });
    return { alice, bob, conv, taskId: out.task.id };
  }

  it("historyLength: 2 returns exactly the MOST RECENT 2 entries (tail, chronological)", () => {
    const { alice, taskId } = seedTaskWithHistory();
    const t = handleGetTask(taskId, alice.id, 2);
    assert.equal(t.history.length, 2);
    assert.deepEqual(
      t.history.map((m) => m.parts.map((p) => (p.kind === "text" ? p.text : "")).join("")),
      ["three", "four"], // the tail — NOT ["one", "two"]
    );
    // Role mapping: task owner (alice) → "user", everyone else → "agent".
    assert.deepEqual(t.history.map((m) => m.role), ["user", "agent"]);
  });

  it("historyLength: 0 returns an empty history array", () => {
    const { alice, taskId } = seedTaskWithHistory();
    assert.deepEqual(handleGetTask(taskId, alice.id, 0).history, []);
  });

  it("historyLength greater than the total returns everything", () => {
    const { alice, taskId } = seedTaskWithHistory();
    const t = handleGetTask(taskId, alice.id, 99);
    assert.equal(t.history.length, 4);
    assert.equal(t.history[0].parts.map((p) => (p.kind === "text" ? p.text : "")).join(""), "one");
  });

  it("absent historyLength keeps the v0.20 projection (no history) — regression lock", () => {
    const { alice, taskId } = seedTaskWithHistory();
    assert.deepEqual(handleGetTask(taskId, alice.id).history, []);
  });

  it("parseHistoryLength rejects negative / fractional / non-number values with A2AInvalidParamsError", () => {
    for (const bad of [-1, 1.5, "2", null, Number.NaN, {}, true]) {
      assert.throws(
        () => parseHistoryLength(bad),
        A2AInvalidParamsError,
        `expected ${JSON.stringify(bad)} to be rejected`,
      );
    }
    // Valid values pass through; undefined means "not sent".
    assert.equal(parseHistoryLength(undefined), undefined);
    assert.equal(parseHistoryLength(0), 0);
    assert.equal(parseHistoryLength(7), 7);
  });
});

// ---------------------------------------------------------------------------
// C2 — inbound size caps on message/send
// ---------------------------------------------------------------------------

describe("C2 — message/send input caps", () => {
  it(`rejects more than ${A2A_MAX_PARTS} parts with invalid-params, writing NOTHING`, () => {
    const { alice, bob, conv } = seedPair();
    const msgsBefore = countRows("messages");
    const tasksBefore = countRows("tasks");
    const parts: A2APart[] = Array.from({ length: A2A_MAX_PARTS + 1 }, (_, i) => ({
      kind: "text" as const,
      text: `p${i}`,
    }));
    assert.throws(
      () => handleSendMessage(alice, bob, textMsg("m_caps1", conv.id, "", parts)),
      (err: unknown) =>
        err instanceof A2AInvalidParamsError && /at most 20 parts/.test(err.message),
    );
    assert.equal(countRows("messages"), msgsBefore);
    assert.equal(countRows("tasks"), tasksBefore);
    assert.equal(countRows("a2a_idempotency"), 0);
  });

  it(`rejects total text over ${A2A_MAX_TEXT_CHARS} chars, writing NOTHING`, () => {
    const { alice, bob, conv } = seedPair();
    const msgsBefore = countRows("messages");
    const tasksBefore = countRows("tasks");
    assert.throws(
      () =>
        handleSendMessage(
          alice,
          bob,
          textMsg("m_caps2", conv.id, "x".repeat(A2A_MAX_TEXT_CHARS + 1)),
        ),
      (err: unknown) =>
        err instanceof A2AInvalidParamsError && /total text length/.test(err.message),
    );
    assert.equal(countRows("messages"), msgsBefore);
    assert.equal(countRows("tasks"), tasksBefore);
  });

  it("accepts the exact boundaries: 20 parts, and exactly 8000 chars of text", () => {
    const { alice, bob, conv } = seedPair();
    const atPartsCap: A2APart[] = Array.from({ length: A2A_MAX_PARTS }, (_, i) => ({
      kind: "text" as const,
      text: `p${i}`,
    }));
    const ok1 = handleSendMessage(alice, bob, textMsg("m_caps3", conv.id, "", atPartsCap));
    assert.equal(ok1.task.kind, "task");
    const ok2 = handleSendMessage(
      alice,
      bob,
      textMsg("m_caps4", conv.id, "x".repeat(A2A_MAX_TEXT_CHARS)),
    );
    assert.equal(ok2.task.kind, "task");
  });
});

// ---------------------------------------------------------------------------
// A4 — task-state snapshot locks (both dialects)
// ---------------------------------------------------------------------------

describe("A4 — task state audit (spec v1.0.1)", () => {
  it("v0.3 dialect: full wire-value set + internal FSM mapping are locked", () => {
    // The complete v0.3 lowercase wire set — spec v1.0.1 changed nothing here.
    assert.deepEqual(
      [...A2A_TASK_STATES],
      [
        "submitted",
        "working",
        "input-required",
        "completed",
        "canceled",
        "failed",
        "rejected",
        "auth-required",
        "unknown",
      ],
    );
    // Internal FSM → wire mapping, snapshot-locked.
    assert.deepEqual(TASK_STATE_MAP, {
      open: "submitted",
      assigned: "submitted",
      in_progress: "working",
      awaiting_review: "input-required",
      changes_requested: "input-required",
      done: "completed",
      cancelled: "canceled",
    });
    // Our FSM NEVER produces failed/rejected/auth-required/unknown — those
    // exist on the wire enum for spec completeness only.
    const produced = new Set(TASK_STATUSES.map((s) => TASK_STATE_MAP[s]));
    assert.deepEqual(
      [...produced].sort(),
      ["canceled", "completed", "input-required", "submitted", "working"],
    );
    for (const never of ["failed", "rejected", "auth-required", "unknown"]) {
      assert.ok(!produced.has(never as A2ATaskState), `FSM must never emit ${never}`);
    }
  });

  it("v1.0 dialect: ProtoJSON enum spellings are locked (TASK_STATE_CANCELED, single L)", () => {
    // Verbatim from specification/a2a.proto (spec v1.0.1, post-#1801).
    const expected: Record<A2ATaskState, string> = {
      submitted: "TASK_STATE_SUBMITTED",
      working: "TASK_STATE_WORKING",
      "input-required": "TASK_STATE_INPUT_REQUIRED",
      completed: "TASK_STATE_COMPLETED",
      canceled: "TASK_STATE_CANCELED",
      failed: "TASK_STATE_FAILED",
      rejected: "TASK_STATE_REJECTED",
      "auth-required": "TASK_STATE_AUTH_REQUIRED",
      unknown: "TASK_STATE_UNSPECIFIED",
    };
    for (const s of A2A_TASK_STATES) {
      assert.equal(taskStateToV1(s), expected[s]);
    }
    // Out-of-domain input falls back to UNSPECIFIED, never garbage.
    assert.equal(taskStateToV1("bogus" as A2ATaskState), "TASK_STATE_UNSPECIFIED");
  });
});

// ---------------------------------------------------------------------------
// A3 — platform-level origin AgentCard
// ---------------------------------------------------------------------------

describe("A3 — platform origin AgentCard", () => {
  it("carries every v0.3 required field and an empty directory by default", () => {
    seedUser("usr_a", "alice"); // a user agent that must NOT leak
    const card = buildPlatformAgentCard("https://example.test");
    assert.equal(card.protocolVersion, "0.3.0");
    assert.equal(card.name, "Agent2Agent");
    assert.ok(card.description.length > 0);
    assert.ok(card.url.startsWith("https://example.test/api/v1/agents/"));
    assert.ok(card.version.length > 0);
    assert.ok(card.capabilities);
    assert.ok(card.defaultInputModes.length > 0);
    assert.ok(card.defaultOutputModes.length > 0);
    assert.ok(card.skills.length > 0);
    // supportedInterfaces advertise the per-agent pattern for both dialects.
    const versions = (card.supportedInterfaces ?? []).map((i) => i.protocolVersion);
    assert.deepEqual(versions.sort(), ["0.3.0", "1.0.0"]);
    // Directory extension present but EMPTY without an operator allowlist.
    const ext = card.capabilities.extensions?.find(
      (e) => e.uri === PLATFORM_DIRECTORY_EXTENSION_URI,
    );
    assert.ok(ext, "directory extension must exist");
    assert.deepEqual(ext!.params?.agents, []);
    assert.equal(card.signatures, undefined); // unsigned without a key
  });

  it("never leaks user agents: only allowlisted MANAGED agents are listed", () => {
    const { agent: userAgent } = seedUser("usr_a", "alice");
    const managed = spawnManagedAgent("usr_a", {
      handle: "demo",
      display_name: "Demo Helper",
      persona: "Platform demo agent.",
    });
    const hidden = spawnManagedAgent("usr_a", {
      handle: "hidden",
      display_name: "Hidden Managed",
      persona: "Managed but not allowlisted.",
    });

    // Default: nobody is discoverable.
    assert.deepEqual(publicDirectoryAgents(), []);

    // Allowlist the managed demo agent AND (maliciously) the external user
    // agent — only the managed one may appear.
    process.env.A2A_PUBLIC_AGENT_IDS = `${managed.id}, ${userAgent.id}, agt_missing`;
    const listed = publicDirectoryAgents();
    assert.deepEqual(listed.map((a: Agent) => a.id), [managed.id]);

    const card = buildPlatformAgentCard("https://example.test");
    const serialized = JSON.stringify(card);
    assert.ok(serialized.includes(managed.id), "allowlisted managed agent listed");
    assert.ok(
      serialized.includes(`/api/v1/agents/${managed.id}/.well-known/agent-card.json`),
      "directory entry points at the per-agent card URL",
    );
    assert.ok(!serialized.includes(userAgent.id), "external user agent must not leak");
    assert.ok(!serialized.includes(hidden.id), "non-allowlisted managed agent must not leak");
  });

  it("is JWS-signed when A2A_CARD_SIGNING_KEY is set, and tampering breaks verification", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    process.env.A2A_CARD_SIGNING_KEY = privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString();
    _resetSigningKeyForTests();

    const card = buildPlatformAgentCard("https://example.test");
    assert.ok(card.signatures && card.signatures.length === 1);
    const { signatures, ...unsigned } = card;
    const pubPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    assert.equal(verifyAgentCardSignature(unsigned, signatures![0], pubPem), true);
    const tampered = { ...unsigned, name: "evil-platform" };
    assert.equal(verifyAgentCardSignature(tampered, signatures![0], pubPem), false);
  });

  it("GET /.well-known/agent-card.json serves the card unauthenticated", async () => {
    const savedAppUrl = process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.NEXT_PUBLIC_APP_URL;
    try {
      const res = await platformCardGet(
        new Request("https://origin.test/.well-known/agent-card.json") as unknown as NextRequest,
      );
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "application/json");
      const card = (await res.json()) as { name: string; url: string; skills: unknown[] };
      assert.equal(card.name, "Agent2Agent");
      assert.ok(card.url.startsWith("https://origin.test/"));
      assert.ok(Array.isArray(card.skills) && card.skills.length > 0);
    } finally {
      if (savedAppUrl !== undefined) process.env.NEXT_PUBLIC_APP_URL = savedAppUrl;
    }
  });
});

// ---------------------------------------------------------------------------
// A2 — application/a2a+json media type (route layer)
// ---------------------------------------------------------------------------

function rpcRequest(
  apiKey: string,
  body: unknown,
  contentType = "application/json",
  signal?: AbortSignal,
): NextRequest {
  return new Request("https://origin.test/api/v1/agents/x/a2a", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": contentType,
    },
    body: JSON.stringify(body),
    signal,
  }) as unknown as NextRequest;
}

describe("A2 — JSON-RPC media type + route-level dialect coverage", () => {
  it("accepts content-type application/json and responds with application/a2a+json", async () => {
    const { aliceKey, bob, conv } = seedPair();
    const res = await a2aPost(
      rpcRequest(aliceKey, {
        jsonrpc: "2.0",
        id: 1,
        method: "message/send",
        params: textMsg("m_mt1", conv.id, "via application/json"),
      }),
      { params: Promise.resolve({ id: bob.id }) },
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/a2a+json");
    const rpc = (await res.json()) as { result?: { kind: string } };
    assert.equal(rpc.result?.kind, "task");
  });

  it("accepts content-type application/a2a+json equivalently", async () => {
    const { aliceKey, bob, conv } = seedPair();
    const res = await a2aPost(
      rpcRequest(
        aliceKey,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "message/send",
          params: textMsg("m_mt2", conv.id, "via a2a+json"),
        },
        "application/a2a+json",
      ),
      { params: Promise.resolve({ id: bob.id }) },
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/a2a+json");
    const rpc = (await res.json()) as { result?: { id: string; kind: string } };
    assert.equal(rpc.result?.kind, "task");
  });

  it("keeps SSE streams as text/event-stream (NOT a2a+json)", async () => {
    const { aliceKey, bob, conv } = seedPair();
    const ac = new AbortController();
    const res = await a2aPost(
      rpcRequest(
        aliceKey,
        {
          jsonrpc: "2.0",
          id: 3,
          method: "message/stream",
          params: textMsg("m_mt3", conv.id, "stream me"),
        },
        "application/a2a+json",
        ac.signal,
      ),
      { params: Promise.resolve({ id: bob.id }) },
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /^text\/event-stream/);
    // Tear the stream down so its poll interval doesn't outlive the test.
    ac.abort();
    await res.body?.cancel().catch(() => {});
  });

  it("tasks/get with an invalid historyLength returns JSON-RPC -32602 (v0.3 path)", async () => {
    const { alice, aliceKey, bob, conv } = seedPair();
    const out = handleSendMessage(alice, bob, textMsg("m_mt4", conv.id, "one"));
    const res = await a2aPost(
      rpcRequest(aliceKey, {
        jsonrpc: "2.0",
        id: 4,
        method: "tasks/get",
        params: { id: out.task.id, historyLength: -1 },
      }),
      { params: Promise.resolve({ id: bob.id }) },
    );
    assert.equal(res.headers.get("content-type"), "application/a2a+json");
    const rpc = (await res.json()) as { error?: { code: number; message: string } };
    assert.equal(rpc.error?.code, -32602);
    assert.match(rpc.error?.message ?? "", /historyLength/);
  });

  it("GetTask (v1.0 dialect) honors historyLength and projects ProtoJSON history", async () => {
    const { alice, aliceKey, bob, conv } = seedPair();
    const out = handleSendMessage(alice, bob, textMsg("m_mt5", conv.id, "first"));
    NOW += 1000;
    sendMessage(conv.id, bob.id, { text: "second", kind: "agent_to_agent" });
    const res = await a2aPost(
      rpcRequest(aliceKey, {
        jsonrpc: "2.0",
        id: 5,
        method: "GetTask",
        params: { id: out.task.id, historyLength: 1 },
      }),
      { params: Promise.resolve({ id: bob.id }) },
    );
    const rpc = (await res.json()) as {
      result?: {
        status: { state: string };
        history: Array<{ role: string; parts: Array<{ text?: string }> }>;
      };
    };
    assert.equal(rpc.result?.status.state, "TASK_STATE_SUBMITTED");
    assert.equal(rpc.result?.history.length, 1);
    // Most recent entry is bob's reply → agent side in ProtoJSON casing.
    assert.equal(rpc.result?.history[0].role, "ROLE_AGENT");
    assert.equal(rpc.result?.history[0].parts[0].text, "second");
  });

  it("message/send over the cap returns -32602 (not -32603) through the route", async () => {
    const { aliceKey, bob, conv } = seedPair();
    const res = await a2aPost(
      rpcRequest(aliceKey, {
        jsonrpc: "2.0",
        id: 6,
        method: "message/send",
        params: textMsg("m_mt6", conv.id, "y".repeat(A2A_MAX_TEXT_CHARS + 1)),
      }),
      { params: Promise.resolve({ id: bob.id }) },
    );
    const rpc = (await res.json()) as { error?: { code: number } };
    assert.equal(rpc.error?.code, -32602);
  });
});
