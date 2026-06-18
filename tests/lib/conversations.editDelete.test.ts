import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestDb, teardownTestDb, resetTables } from "../helpers/setup";
import { _resetDbForTests, db } from "../../lib/db";
import { createAgentForUser } from "../../lib/agents";
import {
  createDirectConversation,
  sendMessage,
  editMessage,
  deleteMessage,
  toggleReaction,
  EDIT_DELETE_WINDOW_MS,
} from "../../lib/conversations";

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

function seedTwoAgents() {
  const userA = "usr_test_a";
  const userB = "usr_test_b";
  db()
    .prepare(
      "INSERT INTO users (id, email, display_name, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(userA, "a@t.test", "A", "x".repeat(128), "y".repeat(32), NOW);
  db()
    .prepare(
      "INSERT INTO users (id, email, display_name, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(userB, "b@t.test", "B", "x".repeat(128), "y".repeat(32), NOW);

  const { agent: a } = createAgentForUser(userA, {
    handle: "alpha",
    display_name: "Alpha",
  });
  const { agent: b } = createAgentForUser(userB, {
    handle: "bravo",
    display_name: "Bravo",
  });
  const [x, y] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
  db()
    .prepare(
      "INSERT INTO friendships (agent_a, agent_b, created_at) VALUES (?, ?, ?)",
    )
    .run(x, y, NOW);
  return { userA, userB, agentA: a, agentB: b };
}

describe("editMessage authorization + window", () => {
  it("rejects edits by an agent other than the sender", () => {
    const { agentA, agentB } = seedTwoAgents();
    const conv = createDirectConversation("usr_test_a", agentA.id, agentB.id);
    const m = sendMessage(conv.id, agentA.id, { text: "hello" });

    assert.throws(
      () => editMessage(m.id, agentB.id, "muahaha"),
      /Can only edit your own messages/,
    );
    const row = db().prepare("SELECT text FROM messages WHERE id = ?").get(m.id) as { text: string };
    assert.equal(row.text, "hello");
  });

  it("rejects edits after the 5-minute window", () => {
    const { agentA, agentB } = seedTwoAgents();
    const conv = createDirectConversation("usr_test_a", agentA.id, agentB.id);
    const m = sendMessage(conv.id, agentA.id, { text: "hi" });

    NOW += EDIT_DELETE_WINDOW_MS + 1;
    assert.throws(
      () => editMessage(m.id, agentA.id, "edited"),
      /Edit window has passed/,
    );
    NOW = 1_700_000_000_000;
  });

  it("accepts edits at the boundary (window - 1ms)", () => {
    const { agentA, agentB } = seedTwoAgents();
    const conv = createDirectConversation("usr_test_a", agentA.id, agentB.id);
    const m = sendMessage(conv.id, agentA.id, { text: "hi" });

    NOW += EDIT_DELETE_WINDOW_MS - 1;
    const updated = editMessage(m.id, agentA.id, "edited at edge");
    assert.equal(updated.text, "edited at edge");
    assert.ok(updated.edited_at);
    NOW = 1_700_000_000_000;
  });

  it("updates messages_fts so the new text is searchable and the old is not", () => {
    const { agentA, agentB } = seedTwoAgents();
    const conv = createDirectConversation("usr_test_a", agentA.id, agentB.id);
    const m = sendMessage(conv.id, agentA.id, { text: "originalword" });

    editMessage(m.id, agentA.id, "replacedword");

    const oldHits = db()
      .prepare("SELECT COUNT(*) AS n FROM messages_fts WHERE text MATCH ?")
      .get("originalword") as { n: number };
    const newHits = db()
      .prepare("SELECT COUNT(*) AS n FROM messages_fts WHERE text MATCH ?")
      .get("replacedword") as { n: number };
    assert.equal(oldHits.n, 0);
    assert.equal(newHits.n, 1);
  });
});

describe("deleteMessage tombstone semantics", () => {
  it("drops all reactions when the message is deleted", () => {
    const { agentA, agentB } = seedTwoAgents();
    const conv = createDirectConversation("usr_test_a", agentA.id, agentB.id);
    const m = sendMessage(conv.id, agentA.id, { text: "react to me" });

    toggleReaction(m.id, agentB.id, "👍");
    toggleReaction(m.id, agentA.id, "✅");
    const before = db()
      .prepare("SELECT COUNT(*) AS n FROM message_reactions WHERE message_id = ?")
      .get(m.id) as { n: number };
    assert.equal(before.n, 2);

    deleteMessage(m.id, agentA.id);

    const after = db()
      .prepare("SELECT COUNT(*) AS n FROM message_reactions WHERE message_id = ?")
      .get(m.id) as { n: number };
    assert.equal(after.n, 0);
  });

  it("refuses reactions on a deleted message", () => {
    const { agentA, agentB } = seedTwoAgents();
    const conv = createDirectConversation("usr_test_a", agentA.id, agentB.id);
    const m = sendMessage(conv.id, agentA.id, { text: "x" });
    deleteMessage(m.id, agentA.id);
    assert.throws(
      () => toggleReaction(m.id, agentB.id, "👍"),
      /deleted message/,
    );
  });

  it("is idempotent — second delete returns row without duplicating events", () => {
    const { agentA, agentB } = seedTwoAgents();
    const conv = createDirectConversation("usr_test_a", agentA.id, agentB.id);
    const m = sendMessage(conv.id, agentA.id, { text: "tombstone me" });

    deleteMessage(m.id, agentA.id);
    const after1 = db()
      .prepare(
        "SELECT COUNT(*) AS n FROM conversation_events WHERE message_id = ? AND kind = 'delete'",
      )
      .get(m.id) as { n: number };

    deleteMessage(m.id, agentA.id);
    const after2 = db()
      .prepare(
        "SELECT COUNT(*) AS n FROM conversation_events WHERE message_id = ? AND kind = 'delete'",
      )
      .get(m.id) as { n: number };

    assert.equal(after1.n, 1);
    assert.equal(after2.n, 1);
  });
});

describe("toggleReaction allowlist", () => {
  it("rejects emojis outside the allowlist", () => {
    const { agentA, agentB } = seedTwoAgents();
    const conv = createDirectConversation("usr_test_a", agentA.id, agentB.id);
    const m = sendMessage(conv.id, agentA.id, { text: "hi" });
    assert.throws(() => toggleReaction(m.id, agentB.id, "💩"), /not allowed/);
    assert.throws(
      () => toggleReaction(m.id, agentB.id, "<script>"),
      /not allowed/,
    );
  });
});
