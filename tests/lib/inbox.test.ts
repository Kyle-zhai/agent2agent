import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestDb, teardownTestDb, resetTables } from "../helpers/setup";
import { _resetDbForTests, db } from "../../lib/db";
import { createAgentForUser } from "../../lib/agents";
import { createGroupConversation } from "../../lib/conversations";
import { acceptFriendRequest, sendFriendRequest } from "../../lib/friends";
import { requestAgentLink, respondAgentLink } from "../../lib/agent-links";
import { createTask } from "../../lib/tasks";
import {
  approveDeviceAuth,
  createDeviceAuthRequest,
  DEVICE_AUTH_TTL_MS,
} from "../../lib/device-auth";
import { proposeHandoff, respondHandoff } from "../../lib/handoffs";
import { countInboxItems, listInboxItems } from "../../lib/inbox";

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
  // Friend the agents so createGroupConversation accepts bob.
  const req = sendFriendRequest("usr_alice", alice.id, bob.id);
  acceptFriendRequest("usr_bob", req.id);
  const conv = createGroupConversation("usr_alice", alice.id, "Project X", [
    bob.id,
  ]);
  return { alice, bob, conv };
}

/** Force a task into awaiting_review without invoking the auto-reviewer. */
function forceAwaitingReview(taskId: string) {
  db()
    .prepare("UPDATE tasks SET status = 'awaiting_review', updated_at = ? WHERE id = ?")
    .run(NOW, taskId);
}

describe("listInboxItems aggregation", () => {
  it("returns an empty list and zero count when nothing is pending", () => {
    seedUserAgent("usr_alice", "alice");
    assert.deepEqual(listInboxItems("usr_alice"), []);
    assert.equal(countInboxItems("usr_alice"), 0);
  });

  it("shows a proposed handoff to the recipient only, linking to the conversation", () => {
    const { alice, bob, conv } = setupTwoUsersInGroup();
    const h = proposeHandoff({
      conversation_id: conv.id,
      from_user_id: "usr_alice",
      from_agent_id: alice.id,
      to_agent_id: bob.id,
      title: "Draft the landing copy",
      brief: "",
      body: "hello",
    });
    const bobItems = listInboxItems("usr_bob");
    assert.equal(bobItems.length, 1);
    assert.equal(bobItems[0].kind, "handoff");
    assert.equal(bobItems[0].id, h.id);
    assert.equal(bobItems[0].title, "Draft the landing copy");
    assert.equal(bobItems[0].href, `/app/c/${encodeURIComponent(conv.id)}`);
    // The proposer has nothing to act on.
    assert.equal(
      listInboxItems("usr_alice").filter((i) => i.kind === "handoff").length,
      0,
    );
    // Resolving the handoff clears it (the acceptance task is 'assigned',
    // not 'awaiting_review', so nothing new appears either).
    respondHandoff({
      handoff_id: h.id,
      responding_user_id: "usr_bob",
      decision: "accept",
    });
    assert.equal(
      listInboxItems("usr_bob").filter((i) => i.kind === "handoff").length,
      0,
    );
  });

  it("shows a pending agent link only to the responding side", () => {
    const { alice, bob, conv } = setupTwoUsersInGroup();
    const link = requestAgentLink({
      conversation_id: conv.id,
      my_agent_id: alice.id,
      their_agent_id: bob.id,
      initiating_user_id: "usr_alice",
    });
    const bobItems = listInboxItems("usr_bob");
    assert.equal(bobItems.length, 1);
    assert.equal(bobItems[0].kind, "agent_link");
    assert.equal(bobItems[0].id, link.id);
    assert.equal(bobItems[0].href, `/app/c/${encodeURIComponent(conv.id)}`);
    // The initiator must NOT see their own request as "waiting on me" —
    // respondAgentLink refuses the initiator anyway.
    assert.equal(listInboxItems("usr_alice").length, 0);
    // Responding clears it.
    respondAgentLink({
      link_id: link.id,
      responding_user_id: "usr_bob",
      decision: "accept",
    });
    assert.equal(listInboxItems("usr_bob").length, 0);
  });

  it("shows a pending friend request to the target agent's owner only", () => {
    const carol = seedUserAgent("usr_carol", "carol");
    const dave = seedUserAgent("usr_dave", "dave");
    const req = sendFriendRequest("usr_carol", carol.id, dave.id);
    const daveItems = listInboxItems("usr_dave");
    assert.equal(daveItems.length, 1);
    assert.equal(daveItems[0].kind, "friend_request");
    assert.equal(daveItems[0].id, req.id);
    assert.equal(daveItems[0].href, "/app/contacts");
    // The sender is waiting on the OTHER human; not in their inbox.
    assert.equal(listInboxItems("usr_carol").length, 0);
    // Accepting clears it.
    acceptFriendRequest("usr_dave", req.id);
    assert.equal(listInboxItems("usr_dave").length, 0);
  });

  it("shows awaiting_review tasks to the owner agent's user with a task-detail link", () => {
    const { alice, bob, conv } = setupTwoUsersInGroup();
    const task = createTask({
      title: "Implement the parser",
      owner_agent_id: alice.id,
      assigned_to_agent_id: bob.id,
      conversation_id: conv.id,
    });
    // Not reviewable yet — nothing in the inbox.
    assert.equal(listInboxItems("usr_alice").length, 0);
    forceAwaitingReview(task.id);
    const items = listInboxItems("usr_alice");
    assert.equal(items.length, 1);
    assert.equal(items[0].kind, "task_review");
    assert.equal(items[0].id, task.id);
    assert.equal(
      items[0].href,
      `/app/c/${encodeURIComponent(conv.id)}/tasks/${encodeURIComponent(task.id)}`,
    );
    assert.match(items[0].subtitle, new RegExp(bob.id));
    // The assignee's user is not the reviewer.
    assert.equal(listInboxItems("usr_bob").length, 0);
    // Closing the review clears it.
    db()
      .prepare("UPDATE tasks SET status = 'done', updated_at = ? WHERE id = ?")
      .run(NOW, task.id);
    assert.equal(listInboxItems("usr_alice").length, 0);
  });

  it("shows pending device-auth requests platform-wide, without leaking the user code", () => {
    seedUserAgent("usr_alice", "alice");
    seedUserAgent("usr_bob", "bob");
    const { user_code } = createDeviceAuthRequest({
      agent_name: "My CLI agent",
      platform: "claude-code",
    });
    // Device pairing is unscoped pre-approval: any signed-in user may approve
    // on /app/device, so the item shows for everyone.
    for (const uid of ["usr_alice", "usr_bob"]) {
      const items = listInboxItems(uid);
      assert.equal(items.length, 1);
      assert.equal(items[0].kind, "device_auth");
      assert.equal(items[0].href, "/app/device");
      // Proof-of-possession: the typed code must never surface in the inbox.
      assert.ok(!items[0].title.includes(user_code));
      assert.ok(!items[0].subtitle.includes(user_code));
    }
    // Approving resolves it for everyone.
    approveDeviceAuth("usr_alice", user_code, {
      handle: "cli-agent",
      display_name: "CLI agent",
    });
    assert.equal(listInboxItems("usr_alice").length, 0);
    assert.equal(listInboxItems("usr_bob").length, 0);
  });

  it("drops expired device-auth requests from the inbox", () => {
    seedUserAgent("usr_alice", "alice");
    createDeviceAuthRequest({ agent_name: "stale", platform: "generic" });
    assert.equal(listInboxItems("usr_alice").length, 1);
    NOW += DEVICE_AUTH_TTL_MS + 1_000;
    assert.equal(listInboxItems("usr_alice").length, 0);
  });

  it("never shows one user's pending items to another user (cross-user isolation)", () => {
    const { alice, bob, conv } = setupTwoUsersInGroup();
    const carol = seedUserAgent("usr_carol", "carol");

    // All four user-scoped kinds, every one of them pending on BOB.
    const handoff = proposeHandoff({
      conversation_id: conv.id,
      from_user_id: "usr_alice",
      from_agent_id: alice.id,
      to_agent_id: bob.id,
      title: "For bob",
      brief: "",
      body: "x",
    });
    const link = requestAgentLink({
      conversation_id: conv.id,
      my_agent_id: alice.id,
      their_agent_id: bob.id,
      initiating_user_id: "usr_alice",
    });
    const friendReq = sendFriendRequest("usr_carol", carol.id, bob.id);
    const task = createTask({
      title: "Bob reviews this",
      owner_agent_id: bob.id,
      assigned_to_agent_id: alice.id,
      conversation_id: conv.id,
    });
    forceAwaitingReview(task.id);

    const bobIds = new Set(listInboxItems("usr_bob").map((i) => i.id));
    assert.equal(bobIds.size, 4);
    assert.ok(bobIds.has(handoff.id));
    assert.ok(bobIds.has(link.id));
    assert.ok(bobIds.has(friendReq.id));
    assert.ok(bobIds.has(task.id));

    // Neither alice (counterparty on three of them) nor carol (sender of the
    // friend request) sees ANY of bob's pending items.
    for (const uid of ["usr_alice", "usr_carol"]) {
      const ids = listInboxItems(uid).map((i) => i.id);
      for (const pendingId of [handoff.id, link.id, friendReq.id, task.id]) {
        assert.ok(
          !ids.includes(pendingId),
          `${uid} must not see ${pendingId}`,
        );
      }
    }
    // And a user with no relationship to any of it sees nothing at all.
    seedUserAgent("usr_mallory", "mallory");
    assert.equal(listInboxItems("usr_mallory").length, 0);
  });

  it("orders items newest first across sources and counts the total", () => {
    const { alice, bob, conv } = setupTwoUsersInGroup();
    const carol = seedUserAgent("usr_carol", "carol");

    NOW += 1_000;
    sendFriendRequest("usr_carol", carol.id, bob.id);
    NOW += 1_000;
    proposeHandoff({
      conversation_id: conv.id,
      from_user_id: "usr_alice",
      from_agent_id: alice.id,
      to_agent_id: bob.id,
      title: "Newer than the friend request",
      brief: "",
      body: "x",
    });
    NOW += 1_000;
    createDeviceAuthRequest({ agent_name: "newest", platform: "generic" });

    const items = listInboxItems("usr_bob");
    assert.equal(items.length, 3);
    assert.deepEqual(
      items.map((i) => i.kind),
      ["device_auth", "handoff", "friend_request"],
    );
    for (let i = 1; i < items.length; i++) {
      assert.ok(items[i - 1].created_at >= items[i].created_at);
    }
    // Badge count = total across all sources.
    assert.equal(countInboxItems("usr_bob"), 3);
  });
});
