import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestDb, teardownTestDb, resetTables } from "../helpers/setup";
import { _resetDbForTests, db } from "../../lib/db";
import { createAgentForUser } from "../../lib/agents";
import { createGroupConversation } from "../../lib/conversations";
import { acceptFriendRequest, sendFriendRequest } from "../../lib/friends";
import { getTask } from "../../lib/tasks";
import {
  tryCreateTaskFromChat,
  type ChatTaskResult,
} from "../../lib/task-command";

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

function seedUserAgent(userId: string, handle: string) {
  db()
    .prepare(
      "INSERT INTO users (id, email, display_name, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(userId, `${handle}@t.test`, handle, "x".repeat(128), "y".repeat(32), NOW);
  return createAgentForUser(userId, { handle, display_name: handle }).agent;
}

function setupTwoUsersInGroup() {
  const alice = seedUserAgent("usr_alice", "alice");
  const bob = seedUserAgent("usr_bob", "bob");
  const req = sendFriendRequest("usr_alice", alice.id, bob.id);
  acceptFriendRequest("usr_bob", req.id);
  const conv = createGroupConversation(
    "usr_alice",
    alice.id,
    "Project X",
    [bob.id],
  );
  return { alice, bob, conv };
}

function expectHandled(
  res: ChatTaskResult,
): asserts res is Extract<ChatTaskResult, { handled: true }> {
  assert.equal(res.handled, true);
}

describe("tryCreateTaskFromChat — command detection", () => {
  it("returns handled:false for non-command text", () => {
    const { alice, conv } = setupTwoUsersInGroup();
    for (const text of [
      "Just a normal message",
      "task: fix the build",
      "please /task this one", // not at the start
      "/tasks overview", // different word
      "/taskforce assemble", // keyword must be a whole token
    ]) {
      const res = tryCreateTaskFromChat({
        conversation_id: conv.id,
        author_agent_id: alice.id,
        text,
      });
      assert.equal(res.handled, false, `should not handle: ${text}`);
    }
  });

  it("returns handled:false for a bare '/task' with no content (never throws on typos)", () => {
    const { alice, conv } = setupTwoUsersInGroup();
    for (const text of ["/task", "/task   ", "/task \n  \n"]) {
      const res = tryCreateTaskFromChat({
        conversation_id: conv.id,
        author_agent_id: alice.id,
        text,
      });
      assert.equal(res.handled, false, `should not handle: ${JSON.stringify(text)}`);
    }
  });

  it("matches the keyword case-insensitively", () => {
    const { alice, conv } = setupTwoUsersInGroup();
    const res = tryCreateTaskFromChat({
      conversation_id: conv.id,
      author_agent_id: alice.id,
      text: "/TASK Fix the login flow",
    });
    expectHandled(res);
    assert.equal(res.task.title, "Fix the login flow");
  });

  it("tolerates leading whitespace before the command", () => {
    const { alice, conv } = setupTwoUsersInGroup();
    const res = tryCreateTaskFromChat({
      conversation_id: conv.id,
      author_agent_id: alice.id,
      text: "   /task Tidy the docs",
    });
    expectHandled(res);
    assert.equal(res.task.title, "Tidy the docs");
  });
});

describe("tryCreateTaskFromChat — @mention assignment", () => {
  it("assigns to a mentioned conversation member", () => {
    const { alice, bob, conv } = setupTwoUsersInGroup();
    const res = tryCreateTaskFromChat({
      conversation_id: conv.id,
      author_agent_id: alice.id,
      text: "/task Fix the build @bob",
    });
    expectHandled(res);
    assert.equal(res.task.assigned_to_agent_id, bob.id);
    assert.equal(res.task.status, "assigned");
    assert.equal(res.task.owner_agent_id, alice.id);
    assert.equal(res.task.conversation_id, conv.id);
    assert.equal(res.task.title, "Fix the build");
    assert.equal(
      res.confirmation,
      "✅ Task created: “Fix the build” — assigned to @bob. Track it in the Tasks tab.",
    );
    // Persisted, not just returned.
    const stored = getTask(res.task.id);
    assert.ok(stored);
    assert.equal(stored.assigned_to_agent_id, bob.id);
  });

  it("ignores a mention of an agent that exists but is NOT a member → unassigned", () => {
    const { alice, conv } = setupTwoUsersInGroup();
    // carol exists, but was never added to the conversation.
    seedUserAgent("usr_carol", "carol");
    const res = tryCreateTaskFromChat({
      conversation_id: conv.id,
      author_agent_id: alice.id,
      text: "/task Fix the build @carol",
    });
    expectHandled(res);
    assert.equal(res.task.assigned_to_agent_id, null);
    assert.equal(res.task.status, "open");
    assert.match(res.confirmation, /note for the humans/);
  });

  it("ignores a mention that matches nobody at all → unassigned", () => {
    const { alice, conv } = setupTwoUsersInGroup();
    const res = tryCreateTaskFromChat({
      conversation_id: conv.id,
      author_agent_id: alice.id,
      text: "/task Fix the build @ghost",
    });
    expectHandled(res);
    assert.equal(res.task.assigned_to_agent_id, null);
    assert.equal(res.task.status, "open");
  });

  it("no mention → unassigned, confirmation says it's a note for the humans", () => {
    const { alice, conv } = setupTwoUsersInGroup();
    const res = tryCreateTaskFromChat({
      conversation_id: conv.id,
      author_agent_id: alice.id,
      text: "/task Order more coffee for the office",
    });
    expectHandled(res);
    assert.equal(res.task.assigned_to_agent_id, null);
    assert.equal(res.task.status, "open");
    assert.equal(
      res.confirmation,
      "✅ Task created: “Order more coffee for the office”. No assistant was mentioned, so it's a note for the humans — assign it from the Tasks tab if you change your mind.",
    );
  });

  it("first of several resolving mentions wins", () => {
    const { alice, bob, conv } = setupTwoUsersInGroup();
    const res = tryCreateTaskFromChat({
      conversation_id: conv.id,
      author_agent_id: alice.id,
      text: "/task Pair on the release @bob @alice",
    });
    expectHandled(res);
    assert.equal(res.task.assigned_to_agent_id, bob.id);
    assert.match(res.confirmation, /@bob/);
  });

  it("skips non-resolving mentions and assigns the first one that resolves", () => {
    const { alice, bob, conv } = setupTwoUsersInGroup();
    const res = tryCreateTaskFromChat({
      conversation_id: conv.id,
      author_agent_id: alice.id,
      text: "/task @ghost should take this, otherwise @bob",
    });
    expectHandled(res);
    assert.equal(res.task.assigned_to_agent_id, bob.id);
  });
});

describe("tryCreateTaskFromChat — title shaping", () => {
  it("'/task @bob' (mention only) → fallback title 'Task for @bob'", () => {
    const { alice, bob, conv } = setupTwoUsersInGroup();
    const res = tryCreateTaskFromChat({
      conversation_id: conv.id,
      author_agent_id: alice.id,
      text: "/task @bob",
    });
    expectHandled(res);
    assert.equal(res.task.title, "Task for @bob");
    assert.equal(res.task.assigned_to_agent_id, bob.id);
  });

  it("mention-only command that resolves to nobody → 'Untitled task'", () => {
    const { alice, conv } = setupTwoUsersInGroup();
    const res = tryCreateTaskFromChat({
      conversation_id: conv.id,
      author_agent_id: alice.id,
      text: "/task @ghost",
    });
    expectHandled(res);
    assert.equal(res.task.title, "Untitled task");
    assert.equal(res.task.assigned_to_agent_id, null);
  });

  it("strips a leading standalone @handle from the title", () => {
    const { alice, bob, conv } = setupTwoUsersInGroup();
    const res = tryCreateTaskFromChat({
      conversation_id: conv.id,
      author_agent_id: alice.id,
      text: "/task @bob fix the parser",
    });
    expectHandled(res);
    assert.equal(res.task.title, "fix the parser");
    assert.equal(res.task.assigned_to_agent_id, bob.id);
  });

  it("keeps a mid-sentence @handle in the title", () => {
    const { alice, bob, conv } = setupTwoUsersInGroup();
    const res = tryCreateTaskFromChat({
      conversation_id: conv.id,
      author_agent_id: alice.id,
      text: "/task Ask @bob about the deploy window",
    });
    expectHandled(res);
    assert.equal(res.task.title, "Ask @bob about the deploy window");
    assert.equal(res.task.assigned_to_agent_id, bob.id);
  });

  it("collapses internal whitespace", () => {
    const { alice, conv } = setupTwoUsersInGroup();
    const res = tryCreateTaskFromChat({
      conversation_id: conv.id,
      author_agent_id: alice.id,
      text: "/task   Fix    the\t build  ",
    });
    expectHandled(res);
    assert.equal(res.task.title, "Fix the build");
  });

  it("caps the title at 200 characters", () => {
    const { alice, conv } = setupTwoUsersInGroup();
    const res = tryCreateTaskFromChat({
      conversation_id: conv.id,
      author_agent_id: alice.id,
      text: "/task " + "a".repeat(300),
    });
    expectHandled(res);
    assert.equal(res.task.title.length, 200);
    assert.equal(res.task.title, "a".repeat(200));
  });
});

describe("tryCreateTaskFromChat — description", () => {
  it("captures lines after the first as the description", () => {
    const { alice, bob, conv } = setupTwoUsersInGroup();
    const res = tryCreateTaskFromChat({
      conversation_id: conv.id,
      author_agent_id: alice.id,
      text: "/task Fix the build @bob\nSee CI run 42.\nAlso check the lockfile.",
    });
    expectHandled(res);
    assert.equal(res.task.title, "Fix the build");
    assert.equal(res.task.description, "See CI run 42.\nAlso check the lockfile.");
    assert.equal(res.task.assigned_to_agent_id, bob.id);
  });

  it("single-line command → empty description", () => {
    const { alice, conv } = setupTwoUsersInGroup();
    const res = tryCreateTaskFromChat({
      conversation_id: conv.id,
      author_agent_id: alice.id,
      text: "/task Fix the build",
    });
    expectHandled(res);
    assert.equal(res.task.description, "");
  });
});
