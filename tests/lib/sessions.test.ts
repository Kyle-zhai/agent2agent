import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestDb, teardownTestDb, resetTables } from "../helpers/setup";
import { _resetDbForTests, db } from "../../lib/db";
import { createAgentForUser } from "../../lib/agents";
import {
  createDirectConversation,
  sendMessage,
} from "../../lib/conversations";
import {
  createSession,
  pullEventsForSession,
} from "../../lib/sessions";
import { diffLines, collapseContext } from "../../lib/diff";

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

function seedAgent(userId: string, handle: string) {
  db()
    .prepare(
      "INSERT INTO users (id, email, display_name, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(userId, `${handle}@t.test`, handle, "x".repeat(128), "y".repeat(32), NOW);
  return createAgentForUser(userId, { handle, display_name: handle }).agent;
}

function befriend(a: string, b: string) {
  const [x, y] = a < b ? [a, b] : [b, a];
  db()
    .prepare(
      "INSERT INTO friendships (agent_a, agent_b, created_at) VALUES (?, ?, ?)",
    )
    .run(x, y, NOW);
}

describe("agent session — JOIN + PULL", () => {
  it("returns only events from conversations the agent is a member of", () => {
    const a = seedAgent("usr_a", "alpha");
    const b = seedAgent("usr_b", "bravo");
    const c = seedAgent("usr_c", "charlie");
    befriend(a.id, b.id);
    befriend(b.id, c.id);
    const conv_ab = createDirectConversation("usr_a", a.id, b.id);
    const conv_bc = createDirectConversation("usr_b", b.id, c.id);

    // Each conv gets one message.
    sendMessage(conv_ab.id, a.id, { text: "ab" });
    sendMessage(conv_bc.id, b.id, { text: "bc" });

    const sessA = createSession(a.id);
    const { events, cursor } = pullEventsForSession(sessA, 50);
    const convs = new Set(events.map((e) => e.conversation_id));
    assert.ok(convs.has(conv_ab.id), "A should see ab events");
    assert.ok(!convs.has(conv_bc.id), "A should NOT see bc events");
    assert.ok(cursor > 0);
  });

  it("advances cursor and second pull returns empty", () => {
    const a = seedAgent("usr_a", "alpha");
    const b = seedAgent("usr_b", "bravo");
    befriend(a.id, b.id);
    const conv = createDirectConversation("usr_a", a.id, b.id);
    sendMessage(conv.id, a.id, { text: "first" });
    const s = createSession(a.id);
    const first = pullEventsForSession(s, 50);
    assert.ok(first.events.length > 0);
    const second = pullEventsForSession(
      { ...s, cursor: first.cursor },
      50,
    );
    assert.equal(second.events.length, 0);
    assert.equal(second.cursor, first.cursor);
  });

  it("resume_cursor at MAX+1 gets clamped to head, not stuck", () => {
    const a = seedAgent("usr_a", "alpha");
    const b = seedAgent("usr_b", "bravo");
    befriend(a.id, b.id);
    const conv = createDirectConversation("usr_a", a.id, b.id);
    sendMessage(conv.id, a.id, { text: "x" });
    const s = createSession(a.id, 9_999_999_999);
    // Server should clamp cursor down to actual max so subsequent pull
    // doesn't sit at an unreachable future id.
    const r = pullEventsForSession(s, 50);
    assert.equal(r.events.length, 0);
  });
});

describe("unified diff — LCS line diff", () => {
  it("classifies add / delete / equal correctly", () => {
    const a = "one\ntwo\nthree";
    const b = "one\nzwo\nthree";
    const r = diffLines(a, b);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const kinds = r.lines.map((l) => l.kind);
    assert.deepEqual(kinds, ["equal", "del", "add", "equal"]);
    assert.equal(r.added, 1);
    assert.equal(r.deleted, 1);
  });

  it("collapses context blocks around changes", () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
    const after = before.replace("line 10", "LINE 10");
    const r = diffLines(before, after);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const c = collapseContext(r.lines, 2);
    const skips = c.filter((x) => "kind" in x && x.kind === "skip");
    assert.ok(skips.length >= 1, "should collapse far-from-change context");
  });

  it("flags binary as not ok", () => {
    const r = diffLines("hello\0world", "x");
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.reason, "binary");
  });
});
