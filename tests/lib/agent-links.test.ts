import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestDb, teardownTestDb, resetTables } from "../helpers/setup";
import { _resetDbForTests, db } from "../../lib/db";
import { createAgentForUser } from "../../lib/agents";
import {
  addOwnAgentToGroup,
  createGroupConversation,
} from "../../lib/conversations";
import {
  areInterconnected,
  findLink,
  listLinksForConversation,
  requestAgentLink,
  respondAgentLink,
  revokeAgentLink,
} from "../../lib/agent-links";

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

function seedUserAgent(uid: string, handle: string) {
  db()
    .prepare(
      "INSERT INTO users (id, email, display_name, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(uid, `${handle}@t.test`, handle, "x".repeat(128), "y".repeat(32), NOW);
  return createAgentForUser(uid, { handle, display_name: handle }).agent;
}

function befriend(a: string, b: string) {
  if (a === b) return;
  const [x, y] = a < b ? [a, b] : [b, a];
  db()
    .prepare(
      "INSERT OR IGNORE INTO friendships (agent_a, agent_b, created_at) VALUES (?, ?, ?)",
    )
    .run(x, y, NOW);
}

function setupTwoUserGroup() {
  const alice = seedUserAgent("usr_a", "alpha");
  const bob = seedUserAgent("usr_b", "bravo");
  befriend(alice.id, bob.id);
  const conv = createGroupConversation(
    "usr_a",
    alice.id,
    "test group",
    [bob.id],
  );
  return { alice, bob, conv };
}

describe("agent_links — request + accept + decline + revoke", () => {
  it("alice requests, bob accepts → status accepted", () => {
    const { alice, bob, conv } = setupTwoUserGroup();
    const link = requestAgentLink({
      conversation_id: conv.id,
      my_agent_id: alice.id,
      their_agent_id: bob.id,
      initiating_user_id: "usr_a",
    });
    assert.equal(link.status, "pending");
    assert.equal(areInterconnected(alice.id, bob.id, conv.id), false);

    const after = respondAgentLink({
      link_id: link.id,
      responding_user_id: "usr_b",
      decision: "accept",
    });
    assert.equal(after.status, "accepted");
    assert.equal(areInterconnected(alice.id, bob.id, conv.id), true);
    assert.equal(areInterconnected(bob.id, alice.id, conv.id), true);
  });

  it("declined link → not interconnected; can be re-requested", () => {
    const { alice, bob, conv } = setupTwoUserGroup();
    const r1 = requestAgentLink({
      conversation_id: conv.id,
      my_agent_id: alice.id,
      their_agent_id: bob.id,
      initiating_user_id: "usr_a",
    });
    respondAgentLink({
      link_id: r1.id,
      responding_user_id: "usr_b",
      decision: "decline",
    });
    assert.equal(areInterconnected(alice.id, bob.id, conv.id), false);

    const r2 = requestAgentLink({
      conversation_id: conv.id,
      my_agent_id: alice.id,
      their_agent_id: bob.id,
      initiating_user_id: "usr_a",
    });
    assert.equal(r2.status, "pending");
    assert.notEqual(r2.id, r1.id);
  });

  it("initiator cannot respond to their own request", () => {
    const { alice, bob, conv } = setupTwoUserGroup();
    const r = requestAgentLink({
      conversation_id: conv.id,
      my_agent_id: alice.id,
      their_agent_id: bob.id,
      initiating_user_id: "usr_a",
    });
    assert.throws(
      () =>
        respondAgentLink({
          link_id: r.id,
          responding_user_id: "usr_a",
          decision: "accept",
        }),
      /initiator/,
    );
  });

  it("stranger user cannot respond", () => {
    const { alice, bob, conv } = setupTwoUserGroup();
    seedUserAgent("usr_x", "stranger");
    const r = requestAgentLink({
      conversation_id: conv.id,
      my_agent_id: alice.id,
      their_agent_id: bob.id,
      initiating_user_id: "usr_a",
    });
    assert.throws(
      () =>
        respondAgentLink({
          link_id: r.id,
          responding_user_id: "usr_x",
          decision: "accept",
        }),
      /don't own/,
    );
  });

  it("revoke flips accepted → revoked; areInterconnected false", () => {
    const { alice, bob, conv } = setupTwoUserGroup();
    const r = requestAgentLink({
      conversation_id: conv.id,
      my_agent_id: alice.id,
      their_agent_id: bob.id,
      initiating_user_id: "usr_a",
    });
    respondAgentLink({
      link_id: r.id,
      responding_user_id: "usr_b",
      decision: "accept",
    });
    revokeAgentLink({ link_id: r.id, user_id: "usr_a" });
    assert.equal(areInterconnected(alice.id, bob.id, conv.id), false);
    const after = findLink(alice.id, bob.id, conv.id);
    assert.equal(after?.status, "revoked");
  });

  it("same-user agents can't interconnect — they already cooperate", () => {
    const alice = seedUserAgent("usr_a", "alpha");
    const aliceBot = createAgentForUser("usr_a", {
      handle: "abot",
      display_name: "alice bot",
    }).agent;
    befriend(alice.id, aliceBot.id);
    const conv = createGroupConversation("usr_a", alice.id, "solo", [aliceBot.id]);
    assert.throws(
      () =>
        requestAgentLink({
          conversation_id: conv.id,
          my_agent_id: alice.id,
          their_agent_id: aliceBot.id,
          initiating_user_id: "usr_a",
        }),
      /both yours/,
    );
  });

  it("requires both agents to be conv members", () => {
    const { alice, bob, conv } = setupTwoUserGroup();
    const carol = seedUserAgent("usr_c", "carol");
    void carol;
    assert.throws(
      () =>
        requestAgentLink({
          conversation_id: conv.id,
          my_agent_id: alice.id,
          their_agent_id: "nonmember",
          initiating_user_id: "usr_a",
        }),
      /Target agent not found|members/,
    );
  });

  it("listLinksForConversation returns all rows ordered by created_at", () => {
    const { alice, bob, conv } = setupTwoUserGroup();
    const carol = seedUserAgent("usr_c", "carol");
    befriend(alice.id, carol.id);
    befriend(bob.id, carol.id);
    // add carol to the group via owner
    db()
      .prepare(
        "INSERT INTO conversation_members (conversation_id, agent_id, role, joined_at) VALUES (?, ?, 'member', ?)",
      )
      .run(conv.id, carol.id, NOW);

    requestAgentLink({
      conversation_id: conv.id,
      my_agent_id: alice.id,
      their_agent_id: bob.id,
      initiating_user_id: "usr_a",
    });
    NOW += 100;
    requestAgentLink({
      conversation_id: conv.id,
      my_agent_id: alice.id,
      their_agent_id: carol.id,
      initiating_user_id: "usr_a",
    });
    const list = listLinksForConversation(conv.id);
    assert.equal(list.length, 2);
    assert.ok(list[0].created_at <= list[1].created_at);
  });
});

describe("addOwnAgentToGroup", () => {
  it("member-user can add their second agent", () => {
    const alice = seedUserAgent("usr_a", "alpha");
    const aliceBot = createAgentForUser("usr_a", {
      handle: "abot",
      display_name: "alice-bot",
    }).agent;
    const bob = seedUserAgent("usr_b", "bravo");
    befriend(alice.id, bob.id);
    const conv = createGroupConversation(
      "usr_a",
      alice.id,
      "team",
      [bob.id],
    );
    // Bob's user — not the owner — adds his own second agent.
    const bobBot = createAgentForUser("usr_b", {
      handle: "bbot",
      display_name: "bob-bot",
    }).agent;
    addOwnAgentToGroup({
      conversation_id: conv.id,
      user_id: "usr_b",
      agent_id: bobBot.id,
    });
    const members = db()
      .prepare(
        "SELECT agent_id FROM conversation_members WHERE conversation_id = ?",
      )
      .all(conv.id) as Array<{ agent_id: string }>;
    assert.ok(members.some((m) => m.agent_id === bobBot.id));
  });

  it("refuses to add an agent not owned by the caller", () => {
    const alice = seedUserAgent("usr_a", "alpha");
    const bob = seedUserAgent("usr_b", "bravo");
    befriend(alice.id, bob.id);
    const conv = createGroupConversation(
      "usr_a",
      alice.id,
      "team",
      [bob.id],
    );
    assert.throws(
      () =>
        addOwnAgentToGroup({
          conversation_id: conv.id,
          user_id: "usr_a",
          agent_id: bob.id,
        }),
      /isn't your agent/,
    );
  });

  it("refuses when caller has no existing agent in the room", () => {
    const alice = seedUserAgent("usr_a", "alpha");
    const bob = seedUserAgent("usr_b", "bravo");
    const carol = seedUserAgent("usr_c", "carol");
    befriend(alice.id, bob.id);
    const conv = createGroupConversation(
      "usr_a",
      alice.id,
      "team",
      [bob.id],
    );
    void carol;
    assert.throws(
      () =>
        addOwnAgentToGroup({
          conversation_id: conv.id,
          user_id: "usr_c",
          agent_id: carol.id,
        }),
      /not in this group/,
    );
  });
});
