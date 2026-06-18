import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestDb, teardownTestDb, resetTables } from "../helpers/setup";
import { _resetDbForTests, db } from "../../lib/db";
import { createAgentForUser, getAgent, setAgentCapabilities } from "../../lib/agents";
import {
  createDirectConversation,
  listMessages,
} from "../../lib/conversations";
import { acceptFriendRequest, sendFriendRequest } from "../../lib/friends";
import {
  buildAgentCard,
  buildExtendedAgentCard,
  firePushForTask,
  handleSendMessage,
  handleGetTask,
  handleCancelTask,
  rpcError,
  rpcOk,
  setPushConfig,
} from "../../lib/a2a";
import { signWebhookDelivery } from "../../lib/crypto";

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

function seedUser(userId: string, handle: string) {
  db()
    .prepare(
      "INSERT INTO users (id, email, display_name, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(userId, `${handle}@t.test`, handle, "x".repeat(128), "y".repeat(32), NOW);
  return createAgentForUser(userId, { handle, display_name: handle }).agent;
}

function connect(aUser: string, a: { id: string }, b: { id: string }) {
  const req = sendFriendRequest(aUser, a.id, b.id);
  // responder is b's owner — derive from agent row.
  const bOwner = getAgent(b.id)!.owner_user_id;
  acceptFriendRequest(bOwner, req.id);
}

describe("buildAgentCard — A2A v0.3.0 JSON-RPC conformance", () => {
  it("uses spec-correct field names and lowercase values", () => {
    const a0 = seedUser("usr_a", "alice");
    setAgentCapabilities(a0.id, "usr_a", [
      {
        name: "code.review",
        description: "Reviews pull requests for bugs.",
        examples: ["Review the auth refactor in PR 42."],
      },
    ]);
    const a = getAgent(a0.id)!;
    const card = buildAgentCard(a, "https://example.test");

    // v0.3.0 required top-level fields.
    assert.equal(card.protocolVersion, "0.3.0");
    assert.equal(card.name, a.display_name); // human label, NOT the id
    assert.equal(card.preferredTransport, "JSONRPC");
    assert.match(card.url, /\/api\/v1\/agents\/.+\/a2a$/);
    assert.equal(card.additionalInterfaces?.[0].transport, "JSONRPC");
    assert.equal(card.provider.organization, "Agent2Agent");
    assert.equal(card.capabilities.streaming, true);
    assert.equal(card.capabilities.pushNotifications, true);
    assert.equal(card.supportsAuthenticatedExtendedCard, true);

    // Skills synthesized from capabilities (+ built-in chat).
    assert.ok(card.skills.some((s) => s.id === "chat"));
    const review = card.skills.find((s) => s.id === "code.review");
    assert.ok(review, "declared capability should appear in skills[]");
    assert.equal(review!.examples[0], "Review the auth refactor in PR 42.");
  });

  it("extended card adds the scoped-handoff skill", () => {
    const a = seedUser("usr_a", "alice");
    const ext = buildExtendedAgentCard(getAgent(a.id)!, "https://example.test");
    assert.ok(ext.skills.some((s) => s.id === "handoff"));
  });
});

describe("handleSendMessage — JSON-RPC message/send", () => {
  it("sends the message AND opens a real task that tasks/get round-trips", () => {
    const alice = seedUser("usr_a", "alice");
    const bob = seedUser("usr_b", "bob");
    connect("usr_a", alice, bob);
    const conv = createDirectConversation("usr_a", alice.id, bob.id);

    const before = listMessages(conv.id, { limit: 50 }).length;
    const out = handleSendMessage(alice, bob, {
      message: {
        kind: "message",
        messageId: "m_1",
        role: "user",
        parts: [{ kind: "text", text: "Ping from A2A bridge." }],
        contextId: conv.id,
      },
    });
    const after = listMessages(conv.id, { limit: 50 });
    assert.equal(after.length, before + 1);
    assert.equal(after[after.length - 1].text, "Ping from A2A bridge.");

    // Conformant task projection.
    assert.equal(out.task.kind, "task");
    assert.equal(out.task.contextId, conv.id);
    assert.equal(out.task.status.state, "submitted"); // assigned → submitted

    // THE round-trip that used to 404: tasks/get on the returned id works
    // for the owner (alice).
    const fetched = handleGetTask(out.task.id, alice.id);
    assert.equal(fetched.id, out.task.id);
    assert.equal(fetched.contextId, conv.id);
  });

  it("replaying the same messageId is idempotent — one message, one task", () => {
    const alice = seedUser("usr_a", "alice");
    const bob = seedUser("usr_b", "bob");
    connect("usr_a", alice, bob);
    const conv = createDirectConversation("usr_a", alice.id, bob.id);

    const params = {
      message: {
        kind: "message" as const,
        messageId: "retry-me-123",
        role: "user" as const,
        parts: [{ kind: "text" as const, text: "Only once please." }],
        contextId: conv.id,
      },
    };
    const before = listMessages(conv.id, { limit: 50 }).length;
    const first = handleSendMessage(alice, bob, params);
    const replay = handleSendMessage(alice, bob, params);

    // Same task back, and the conversation got exactly ONE new message.
    assert.equal(replay.task.id, first.task.id);
    assert.equal(listMessages(conv.id, { limit: 50 }).length, before + 1);

    // A DIFFERENT messageId from the same pair opens a fresh task.
    const fresh = handleSendMessage(alice, bob, {
      message: { ...params.message, messageId: "retry-me-456" },
    });
    assert.notEqual(fresh.task.id, first.task.id);
  });

  it("scopes idempotency per (caller, target) — same messageId from another caller is a new task", () => {
    const alice = seedUser("usr_a", "alice");
    const bob = seedUser("usr_b", "bob");
    const cara = seedUser("usr_c", "cara");
    connect("usr_a", alice, bob);
    connect("usr_c", cara, bob);
    const convAB = createDirectConversation("usr_a", alice.id, bob.id);
    const convCB = createDirectConversation("usr_c", cara.id, bob.id);

    const fromAlice = handleSendMessage(alice, bob, {
      message: {
        kind: "message",
        messageId: "shared-uuid",
        role: "user",
        parts: [{ kind: "text", text: "From Alice." }],
        contextId: convAB.id,
      },
    });
    const fromCara = handleSendMessage(cara, bob, {
      message: {
        kind: "message",
        messageId: "shared-uuid",
        role: "user",
        parts: [{ kind: "text", text: "From Cara." }],
        contextId: convCB.id,
      },
    });
    assert.notEqual(fromAlice.task.id, fromCara.task.id);
  });

  it("maps an inline file part to an attachment", () => {
    const alice = seedUser("usr_a", "alice");
    const bob = seedUser("usr_b", "bob");
    connect("usr_a", alice, bob);
    const conv = createDirectConversation("usr_a", alice.id, bob.id);

    const out = handleSendMessage(alice, bob, {
      message: {
        kind: "message",
        messageId: "m_file",
        role: "user",
        parts: [
          { kind: "text", text: "Here's the spec." },
          {
            kind: "file",
            file: {
              bytes: Buffer.from("hello spec").toString("base64"),
              name: "spec.txt",
              mimeType: "text/plain",
            },
          },
        ],
        contextId: conv.id,
      },
    });
    assert.equal(out.task.kind, "task");
    const msgs = listMessages(conv.id, { limit: 50 });
    const last = msgs[msgs.length - 1];
    assert.equal(last.attachments.length, 1);
    assert.equal(last.attachments[0].filename, "spec.txt");
  });

  it("rejects when contextId is missing", () => {
    const alice = seedUser("usr_a", "alice");
    const bob = seedUser("usr_b", "bob");
    assert.throws(
      () =>
        handleSendMessage(alice, bob, {
          message: {
            kind: "message",
            messageId: "m_2",
            role: "user",
            parts: [{ kind: "text", text: "no context" }],
          },
        }),
      /contextId/,
    );
  });

  it("rejects when the target agent is not a member of contextId", () => {
    const alice = seedUser("usr_a", "alice");
    const bob = seedUser("usr_b", "bob");
    const carol = seedUser("usr_c", "carol");
    connect("usr_a", alice, bob);
    const conv = createDirectConversation("usr_a", alice.id, bob.id);
    // carol is not in the alice↔bob conversation.
    assert.throws(
      () =>
        handleSendMessage(alice, carol, {
          message: {
            kind: "message",
            messageId: "m_x",
            role: "user",
            parts: [{ kind: "text", text: "hi carol" }],
            contextId: conv.id,
          },
        }),
      /not a member of contextId/,
    );
  });

  it("rejects when no text part or file is supplied", () => {
    const alice = seedUser("usr_a", "alice");
    const bob = seedUser("usr_b", "bob");
    connect("usr_a", alice, bob);
    const conv = createDirectConversation("usr_a", alice.id, bob.id);
    assert.throws(
      () =>
        handleSendMessage(alice, bob, {
          message: {
            kind: "message",
            messageId: "m_3",
            role: "user",
            parts: [],
            contextId: conv.id,
          },
        }),
      /text part or inline file/,
    );
  });
});

describe("handleCancelTask — tasks/cancel", () => {
  it("cancels a task the caller owns and reflects 'canceled' state", async () => {
    const alice = seedUser("usr_a", "alice");
    const bob = seedUser("usr_b", "bob");
    connect("usr_a", alice, bob);
    const conv = createDirectConversation("usr_a", alice.id, bob.id);
    const out = handleSendMessage(alice, bob, {
      message: {
        kind: "message",
        messageId: "m_c",
        role: "user",
        parts: [{ kind: "text", text: "work please" }],
        contextId: conv.id,
      },
    });
    const cancelled = await handleCancelTask(alice.id, out.task.id);
    assert.equal(cancelled.status.state, "canceled");
  });

  it("refuses cancel from an unrelated agent", async () => {
    const alice = seedUser("usr_a", "alice");
    const bob = seedUser("usr_b", "bob");
    const carol = seedUser("usr_c", "carol");
    connect("usr_a", alice, bob);
    const conv = createDirectConversation("usr_a", alice.id, bob.id);
    const out = handleSendMessage(alice, bob, {
      message: {
        kind: "message",
        messageId: "m_c2",
        role: "user",
        parts: [{ kind: "text", text: "work" }],
        contextId: conv.id,
      },
    });
    await assert.rejects(
      () => handleCancelTask(carol.id, out.task.id),
      /owner or assignee/,
    );
  });
});

describe("handleGetTask", () => {
  it("throws when the task does not exist", () => {
    assert.throws(() => handleGetTask("task_missing", "agt_whoever"), /not found/);
  });

  it("hides a task from an agent who isn't owner/assignee/member (IDOR)", () => {
    const alice = seedUser("usr_a", "alice");
    const bob = seedUser("usr_b", "bob");
    const carol = seedUser("usr_c", "carol");
    connect("usr_a", alice, bob);
    const conv = createDirectConversation("usr_a", alice.id, bob.id);
    const out = handleSendMessage(alice, bob, {
      message: {
        kind: "message",
        messageId: "m_idor",
        role: "user",
        parts: [{ kind: "text", text: "private work" }],
        contextId: conv.id,
      },
    });
    // Owner + assignee can read it.
    assert.equal(handleGetTask(out.task.id, alice.id).id, out.task.id);
    assert.equal(handleGetTask(out.task.id, bob.id).id, out.task.id);
    // Carol (not owner/assignee/member) gets the same "not found" — no leak.
    assert.throws(() => handleGetTask(out.task.id, carol.id), /not found/);
  });
});

describe("JSON-RPC envelope helpers", () => {
  it("rpcOk + rpcError preserve id and shape", () => {
    const ok = rpcOk("req-1", { id: "x" });
    assert.equal("result" in ok && ok.result ? ok.id : null, "req-1");
    const err = rpcError("req-2", -32601, "Method not found");
    assert.ok("error" in err);
    assert.equal(err.error.code, -32601);
  });
});

describe("firePushForTask — signed webhook delivery", () => {
  it("sends timestamp + request-id + HMAC signature headers when a token is set", async () => {
    const alice = seedUser("usr_a", "alice");
    const bob = seedUser("usr_b", "bob");
    connect("usr_a", alice, bob);
    const conv = createDirectConversation("usr_a", alice.id, bob.id);
    const out = handleSendMessage(alice, bob, {
      message: {
        kind: "message",
        messageId: "m_push",
        role: "user",
        parts: [{ kind: "text", text: "Push me." }],
        contextId: conv.id,
      },
    });
    // Public literal IP → passes the SSRF check without a DNS lookup.
    setPushConfig({
      task_id: out.task.id,
      registering_agent_id: alice.id,
      url: "https://93.184.216.34/hook",
      token: "shh-secret",
    });

    const realFetch = globalThis.fetch;
    const captured: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    globalThis.fetch = (async (url: unknown, init?: { headers?: Record<string, string>; body?: string }) => {
      captured.push({
        url: String(url),
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: String(init?.body ?? ""),
      });
      return new Response("ok");
    }) as typeof fetch;
    try {
      await firePushForTask(out.task.id);
    } finally {
      globalThis.fetch = realFetch;
    }

    assert.equal(captured.length, 1);
    const h = captured[0].headers;
    assert.equal(h["x-a2a-notification-token"], "shh-secret");
    assert.ok(h["x-a2a-timestamp"]);
    assert.ok(h["x-a2a-request-id"]);
    // Receiver-side verification: recompute the HMAC over ts.reqId.body.
    const expected = signWebhookDelivery(
      "shh-secret",
      h["x-a2a-timestamp"],
      h["x-a2a-request-id"],
      captured[0].body,
    );
    assert.equal(h["x-a2a-signature"], expected);
  });

  it("omits the signature (but keeps timestamp/request-id) without a token", async () => {
    const alice = seedUser("usr_a", "alice");
    const bob = seedUser("usr_b", "bob");
    connect("usr_a", alice, bob);
    const conv = createDirectConversation("usr_a", alice.id, bob.id);
    const out = handleSendMessage(alice, bob, {
      message: {
        kind: "message",
        messageId: "m_push2",
        role: "user",
        parts: [{ kind: "text", text: "Push me too." }],
        contextId: conv.id,
      },
    });
    setPushConfig({
      task_id: out.task.id,
      registering_agent_id: alice.id,
      url: "https://93.184.216.34/hook2",
    });

    const realFetch = globalThis.fetch;
    const captured: Array<{ headers: Record<string, string> }> = [];
    globalThis.fetch = (async (_url: unknown, init?: { headers?: Record<string, string> }) => {
      captured.push({ headers: (init?.headers ?? {}) as Record<string, string> });
      return new Response("ok");
    }) as typeof fetch;
    try {
      await firePushForTask(out.task.id);
    } finally {
      globalThis.fetch = realFetch;
    }

    assert.equal(captured.length, 1);
    const h = captured[0].headers;
    assert.ok(h["x-a2a-timestamp"]);
    assert.ok(h["x-a2a-request-id"]);
    assert.equal(h["x-a2a-signature"], undefined);
    assert.equal(h["x-a2a-notification-token"], undefined);
  });
});
