import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { setupTestDb, teardownTestDb, resetTables } from "../helpers/setup";
import { _resetDbForTests, db } from "../../lib/db";
import { createAgentForUser, getAgent } from "../../lib/agents";
import { createDirectConversation, listMessages } from "../../lib/conversations";
import { acceptFriendRequest, sendFriendRequest } from "../../lib/friends";
import { createTask } from "../../lib/tasks";
import {
  buildAgentCard,
  handleSendMessage,
  listTasksPageV1,
  messageToV1,
  projectTaskV1,
  resolveMethod,
  taskStateToV1,
  type A2APart,
} from "../../lib/a2a";
import {
  _resetSigningKeyForTests,
  canonicalizeJson,
  verifyAgentCardSignature,
} from "../../lib/card-signing";

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
  _resetSigningKeyForTests();
});

beforeEach(() => {
  NOW = 1_700_000_000_000;
  resetTables(db());
  delete process.env.A2A_CARD_SIGNING_KEY;
  _resetSigningKeyForTests();
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
  const bOwner = getAgent(b.id)!.owner_user_id;
  acceptFriendRequest(bOwner, req.id);
}

describe("v1.0 dual-advertised AgentCard", () => {
  it("keeps every v0.3 field AND adds supportedInterfaces for both versions", () => {
    const a = seedUser("usr_a", "alice");
    const card = buildAgentCard(getAgent(a.id)!, "https://example.test");
    // v0.3 surface unchanged (real 0.3.x SDKs depend on these).
    assert.equal(card.protocolVersion, "0.3.0");
    assert.equal(card.preferredTransport, "JSONRPC");
    assert.ok(card.additionalInterfaces?.length);
    assert.equal(card.supportsAuthenticatedExtendedCard, true);
    // v1.0 discovery: per-interface protocolVersion, both dialects, same url.
    const versions = (card.supportedInterfaces ?? []).map((i) => i.protocolVersion);
    assert.deepEqual(versions.sort(), ["0.3.0", "1.0.0"]);
    for (const i of card.supportedInterfaces ?? []) {
      assert.equal(i.url, card.url);
      assert.equal(i.protocolBinding, "JSONRPC");
    }
    assert.equal(card.capabilities.extendedAgentCard, true);
    // Unsigned without a key.
    assert.equal(card.signatures, undefined);
  });
});

describe("JWS-signed AgentCard (JCS canonical form)", () => {
  it("signs when A2A_CARD_SIGNING_KEY is set and verifies against the public key", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", {
      namedCurve: "P-256",
    });
    process.env.A2A_CARD_SIGNING_KEY = privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString();
    _resetSigningKeyForTests();

    const a = seedUser("usr_a", "alice");
    const card = buildAgentCard(getAgent(a.id)!, "https://example.test");
    assert.ok(card.signatures && card.signatures.length === 1);
    const { signatures, ...unsigned } = card;

    const pubPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    assert.equal(
      verifyAgentCardSignature(unsigned, signatures![0], pubPem),
      true,
    );
    // Any tampering breaks the signature.
    const tampered = { ...unsigned, name: "evil-impostor" };
    assert.equal(
      verifyAgentCardSignature(tampered, signatures![0], pubPem),
      false,
    );
  });

  it("canonicalization is key-order independent and drops undefined", () => {
    const a = canonicalizeJson({ b: 1, a: { d: true, c: "x" }, z: undefined });
    const b = canonicalizeJson({ a: { c: "x", d: true }, b: 1 });
    assert.equal(a, b);
    assert.equal(a, '{"a":{"c":"x","d":true},"b":1}');
  });
});

describe("v1.0 wire dialect", () => {
  it("resolveMethod maps PascalCase aliases and passes v0.3 through", () => {
    assert.deepEqual(resolveMethod("SendMessage"), {
      canonical: "message/send",
      dialect: "v1.0",
    });
    assert.deepEqual(resolveMethod("GetTask"), {
      canonical: "tasks/get",
      dialect: "v1.0",
    });
    assert.deepEqual(resolveMethod("ListTasks"), {
      canonical: "tasks/list",
      dialect: "v1.0",
    });
    assert.deepEqual(resolveMethod("message/send"), {
      canonical: "message/send",
      dialect: "v0.3",
    });
  });

  it("projects tasks/messages in ProtoJSON casing with createdAt/lastModified", () => {
    const alice = seedUser("usr_a", "alice");
    const bob = seedUser("usr_b", "bob");
    const t = createTask({
      title: "t",
      description: "d",
      owner_agent_id: alice.id,
      assigned_to_agent_id: bob.id,
      conversation_id: null,
    });
    const v1 = projectTaskV1(t, [
      {
        kind: "message",
        messageId: "m1",
        role: "user",
        parts: [{ kind: "text", text: "hello" }],
      },
    ]);
    const status = v1.status as { state: string };
    assert.equal(status.state, "TASK_STATE_SUBMITTED");
    assert.equal(typeof v1.createdAt, "string");
    assert.equal(typeof v1.lastModified, "string");
    const history = v1.history as Array<{ role: string; parts: unknown[] }>;
    assert.equal(history[0].role, "ROLE_USER");
    assert.deepEqual(history[0].parts[0], { text: "hello" });
    assert.equal(taskStateToV1("input-required"), "TASK_STATE_INPUT_REQUIRED");
    assert.equal(taskStateToV1("canceled"), "TASK_STATE_CANCELED");
  });

  it("messageToV1 flattens file parts to raw/url with mediaType", () => {
    const v1 = messageToV1({
      kind: "message",
      messageId: "m2",
      role: "agent",
      parts: [
        { kind: "file", file: { bytes: "QUJD", mimeType: "text/plain", name: "a.txt" } },
        { kind: "file", file: { uri: "https://x.test/f.bin", mimeType: "application/octet-stream" } },
      ],
    });
    const parts = v1.parts as Array<Record<string, unknown>>;
    assert.deepEqual(parts[0], { raw: "QUJD", mediaType: "text/plain", filename: "a.txt" });
    assert.equal(parts[1].url, "https://x.test/f.bin");
    assert.equal(v1.role, "ROLE_AGENT");
  });

  it("accepts v1.0 member-discriminated parts inbound (text + raw + url)", () => {
    const alice = seedUser("usr_a", "alice");
    const bob = seedUser("usr_b", "bob");
    connect("usr_a", alice, bob);
    const conv = createDirectConversation("usr_a", alice.id, bob.id);

    const v1Parts = [
      { text: "From a v1.0 peer." },
      { raw: Buffer.from("v1 bytes").toString("base64"), mediaType: "text/plain", filename: "v1.txt" },
      { url: "https://elsewhere.test/big.bin" },
    ] as unknown as A2APart[];
    const out = handleSendMessage(alice, bob, {
      message: {
        kind: "message",
        messageId: "v1-msg",
        role: "user",
        parts: v1Parts,
        contextId: conv.id,
      },
    });
    const msgs = listMessages(conv.id, { limit: 50 });
    const last = msgs[msgs.length - 1];
    assert.equal(last.text, "From a v1.0 peer.");
    assert.equal(last.attachments.length, 1);
    assert.equal(last.attachments[0].filename, "v1.txt");
    // url part is policy-skipped and surfaced, not silently dropped.
    assert.ok(
      out.task.artifacts.some((a) => a.name === "unsupported-parts"),
    );
  });
});

describe("ListTasks — cursor pagination", () => {
  it("walks all tasks without duplicates and terminates", () => {
    const alice = seedUser("usr_a", "alice");
    const bob = seedUser("usr_b", "bob");
    for (let i = 0; i < 5; i++) {
      NOW += 1000;
      createTask({
        title: `t${i}`,
        description: "d",
        owner_agent_id: alice.id,
        assigned_to_agent_id: bob.id,
        conversation_id: null,
      });
    }
    const seen = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = listTasksPageV1(alice.id, { pageSize: 2, cursor });
      for (const t of page.tasks) {
        const id = (t as { id: string }).id;
        assert.ok(!seen.has(id), `duplicate ${id}`);
        seen.add(id);
      }
      cursor = page.nextCursor;
      pages += 1;
      assert.ok(pages < 10, "pagination must terminate");
    } while (cursor);
    assert.equal(seen.size, 5);

    // Bob (assignee) sees them too; a stranger sees none.
    assert.equal(listTasksPageV1(bob.id, {}).tasks.length, 5);
    const carol = seedUser("usr_c", "carol");
    assert.equal(listTasksPageV1(carol.id, {}).tasks.length, 0);
  });
});
