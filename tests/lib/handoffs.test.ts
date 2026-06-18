import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestDb, teardownTestDb, resetTables } from "../helpers/setup";
import { _resetDbForTests, db } from "../../lib/db";
import { createAgentForUser, getAgent } from "../../lib/agents";
import { createGroupConversation, listMembers } from "../../lib/conversations";
import { createWorkspace, getSubscription } from "../../lib/workspaces";
import { acceptFriendRequest, sendFriendRequest } from "../../lib/friends";
import { findLink } from "../../lib/agent-links";
import { getTask } from "../../lib/tasks";
import {
  filterPrivateContent,
  getHandoff,
  listHandoffsForConversation,
  markHandoffCompleted,
  proposeHandoff,
  respondHandoff,
  withdrawHandoff,
} from "../../lib/handoffs";

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
  // Friend the agents so createGroupConversation accepts bob.
  const req = sendFriendRequest("usr_alice", alice.id, bob.id);
  acceptFriendRequest("usr_bob", req.id);
  const conv = createGroupConversation(
    "usr_alice",
    alice.id,
    "Project X",
    [bob.id],
  );
  const ws = createWorkspace({
    name: "shared",
    conversation_id: conv.id,
    created_by_agent_id: alice.id,
  });
  return { alice, bob, conv, ws };
}

describe("filterPrivateContent", () => {
  it("redacts [[private]] blocks and one-liners", () => {
    const out = filterPrivateContent(
      "share me\n[[private]] hide me [[/private]]\n[[private]] one liner\nfine",
    );
    assert.equal(out.redaction_count, 2);
    assert.ok(!out.shared_body.includes("hide me"));
    assert.ok(!out.shared_body.includes("one liner"));
    assert.ok(out.shared_body.includes("share me"));
    assert.ok(out.shared_body.includes("fine"));
  });

  it("redacts heuristic phrases", () => {
    const out = filterPrivateContent(
      "first line\nthis is confidential info\nnormal",
    );
    assert.equal(out.redaction_count, 1);
    assert.ok(!out.shared_body.includes("confidential"));
  });

  it("returns no redactions for clean text", () => {
    const out = filterPrivateContent("hello\nworld");
    assert.equal(out.redaction_count, 0);
    assert.equal(out.shared_body, "hello\nworld");
    assert.match(out.private_summary, /Nothing was filtered/);
  });
});

describe("proposeHandoff → respondHandoff lifecycle", () => {
  it("creates a proposed handoff and chat announcement", () => {
    const { alice, bob, conv, ws } = setupTwoUsersInGroup();
    const h = proposeHandoff({
      conversation_id: conv.id,
      from_user_id: "usr_alice",
      from_agent_id: alice.id,
      to_agent_id: bob.id,
      title: "Help me draft",
      brief: "Need a second pair of eyes.",
      body:
        "Public part.\n[[private]] secret salary numbers [[/private]]\nMore public.",
      workspace_id: ws.id,
    });
    assert.equal(h.status, "proposed");
    assert.equal(h.redaction_count, 1);
    assert.ok(!h.shared_body.includes("secret salary"));
    // Announcement message exists.
    const msgs = db()
      .prepare(
        "SELECT id, kind, from_agent_id FROM messages WHERE conversation_id = ?",
      )
      .all(conv.id) as Array<{ id: string; kind: string; from_agent_id: string }>;
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].from_agent_id, alice.id);
    // Listed for conversation.
    const list = listHandoffsForConversation(conv.id);
    assert.equal(list.length, 1);
    assert.equal(list[0].id, h.id);
  });

  it("blocks proposing to your own agent", () => {
    const { alice, conv } = setupTwoUsersInGroup();
    // Create a second alice-owned agent in the room (via own-add).
    const alice2 = createAgentForUser("usr_alice", {
      handle: "alice2",
      display_name: "Alice's second",
    }).agent;
    const { addOwnAgentToGroup } = require("../../lib/conversations");
    addOwnAgentToGroup({
      conversation_id: conv.id,
      user_id: "usr_alice",
      agent_id: alice2.id,
    });
    assert.throws(
      () =>
        proposeHandoff({
          conversation_id: conv.id,
          from_user_id: "usr_alice",
          from_agent_id: alice.id,
          to_agent_id: alice2.id,
          title: "x",
          brief: "",
          body: "y",
        }),
      /your own agents/i,
    );
  });

  it("accept wires workspace + interconnect + task", async () => {
    const { alice, bob, conv, ws } = setupTwoUsersInGroup();
    const h = proposeHandoff({
      conversation_id: conv.id,
      from_user_id: "usr_alice",
      from_agent_id: alice.id,
      to_agent_id: bob.id,
      title: "Rewrite landing copy",
      brief: "Help me with the hero section.",
      body: "Tone: warm, factual.",
      workspace_id: ws.id,
    });
    const accepted = respondHandoff({
      handoff_id: h.id,
      responding_user_id: "usr_bob",
      decision: "accept",
      note: "On it!",
    });
    assert.equal(accepted.status, "accepted");
    assert.ok(accepted.task_id);
    assert.ok(accepted.link_id);

    // v0.16: handoff acceptance no longer blanket-upgrades subscriptions.
    // Alice keeps her ADMIN role (created the workspace); Bob is admitted
    // as a READER. Actual write permission lives on a signed, scoped
    // grant we verify separately below.
    const subA = getSubscription(ws.id, alice.id);
    const subB = getSubscription(ws.id, bob.id);
    assert.ok(subA);
    assert.equal(subA.role, "admin");
    assert.ok(subB);
    assert.equal(subB.role, "reader");

    // The capability-scoped grants are what actually authorise Bob to
    // read or write. There should be one for the conversation and one
    // for the workspace.
    const { listGrantsToAgent } = await import("../../lib/grants");
    const bobGrants = listGrantsToAgent(bob.id);
    assert.equal(bobGrants.length, 2);
    const wsGrant = bobGrants.find((g) => g.resource_type === "workspace");
    assert.ok(wsGrant);
    assert.equal(wsGrant!.resource_id, ws.id);

    // Interconnect accepted.
    const link = findLink(alice.id, bob.id, conv.id);
    assert.ok(link);
    assert.equal(link.status, "accepted");

    // Task created and assigned to bob.
    const t = getTask(accepted.task_id!);
    assert.ok(t);
    assert.equal(t.owner_agent_id, alice.id);
    assert.equal(t.assigned_to_agent_id, bob.id);
    assert.equal(t.conversation_id, conv.id);
    assert.equal(t.workspace_id, ws.id);
  });

  it("decline records the reason and keeps shared state untouched", () => {
    const { alice, bob, conv, ws } = setupTwoUsersInGroup();
    const h = proposeHandoff({
      conversation_id: conv.id,
      from_user_id: "usr_alice",
      from_agent_id: alice.id,
      to_agent_id: bob.id,
      title: "Heavy lift",
      brief: "",
      body: "do everything",
      workspace_id: ws.id,
    });
    const declined = respondHandoff({
      handoff_id: h.id,
      responding_user_id: "usr_bob",
      decision: "decline",
      note: "Out of scope",
    });
    assert.equal(declined.status, "declined");
    assert.equal(declined.response_note, "Out of scope");
    assert.equal(declined.task_id, null);
    // No workspace subscription for bob.
    const subB = getSubscription(ws.id, bob.id);
    assert.equal(subB, null);
  });

  it("only the recipient can respond", () => {
    const { alice, bob, conv } = setupTwoUsersInGroup();
    const h = proposeHandoff({
      conversation_id: conv.id,
      from_user_id: "usr_alice",
      from_agent_id: alice.id,
      to_agent_id: bob.id,
      title: "x",
      brief: "",
      body: "y",
    });
    assert.throws(
      () =>
        respondHandoff({
          handoff_id: h.id,
          responding_user_id: "usr_alice",
          decision: "accept",
        }),
      /receiving user/i,
    );
  });

  it("rejects proposing a handoff on a workspace the proposer can't access (least privilege)", () => {
    // v0.16 grants-enforcement design: a handoff DELEGATES authority the
    // proposer already holds. With no subscription (and no grant) on Bob's
    // workspace, Alice holds nothing to delegate — propose must fail, and
    // accept-time must never bootstrap a subscription for her (that would be
    // privilege escalation onto someone else's workspace).
    const { alice, bob, conv } = setupTwoUsersInGroup();
    // Bob creates the workspace this time — so alice has no subscription.
    const ws = createWorkspace({
      name: "bob-owned-ws",
      conversation_id: conv.id,
      created_by_agent_id: bob.id,
    });
    assert.throws(
      () =>
        proposeHandoff({
          conversation_id: conv.id,
          from_user_id: "usr_alice",
          from_agent_id: alice.id,
          to_agent_id: bob.id,
          title: "Reverse direction",
          brief: "",
          body: "hello",
          workspace_id: ws.id,
        }),
      /don't have access to that workspace/i,
    );
    // No side effects: alice gained nothing on Bob's workspace.
    assert.equal(getSubscription(ws.id, alice.id), null);
  });

  it("rejects accept when the proposer's workspace access was revoked after propose", () => {
    // The world can shift between propose and accept — if the proposer's
    // access is gone, accept must fail BEFORE the status flip with an
    // accurate message (not assertGranterAuthority's confusing one), and
    // the handoff must stay 'proposed'.
    const { alice, bob, conv, ws } = setupTwoUsersInGroup();
    const h = proposeHandoff({
      conversation_id: conv.id,
      from_user_id: "usr_alice",
      from_agent_id: alice.id,
      to_agent_id: bob.id,
      title: "Soon to be orphaned",
      brief: "",
      body: "hello",
      workspace_id: ws.id,
    });
    // Revoke alice's subscription out from under the proposed handoff.
    db()
      .prepare(
        "DELETE FROM workspace_subscriptions WHERE workspace_id = ? AND agent_id = ?",
      )
      .run(ws.id, alice.id);
    assert.throws(
      () =>
        respondHandoff({
          handoff_id: h.id,
          responding_user_id: "usr_bob",
          decision: "accept",
        }),
      /no longer has access/i,
    );
    const after = getHandoff(h.id);
    assert.equal(after!.status, "proposed"); // clean state, not half-accepted
  });

  it("rejects accept when the recipient was removed from the conversation after propose — no grants minted (v0.21 C5)", () => {
    // Simulates the concurrent-removal race: member kicked between propose
    // and respond. The membership re-check now runs INSIDE the accept
    // transaction, so the whole accept (status flip + grant mint + task)
    // must roll back as one unit.
    const { alice, bob, conv, ws } = setupTwoUsersInGroup();
    const h = proposeHandoff({
      conversation_id: conv.id,
      from_user_id: "usr_alice",
      from_agent_id: alice.id,
      to_agent_id: bob.id,
      title: "Kicked before accept",
      brief: "",
      body: "hello",
      workspace_id: ws.id,
      scopes: ["read", "comment", "write"],
    });
    // Bob is removed from the room (kick or leave) before his human responds.
    db()
      .prepare(
        "DELETE FROM conversation_members WHERE conversation_id = ? AND agent_id = ?",
      )
      .run(conv.id, bob.id);
    assert.throws(
      () =>
        respondHandoff({
          handoff_id: h.id,
          responding_user_id: "usr_bob",
          decision: "accept",
        }),
      /left the conversation/i,
    );
    // Clean rollback: still 'proposed', and ZERO grants slipped through.
    assert.equal(getHandoff(h.id)!.status, "proposed");
    const grants = db()
      .prepare("SELECT COUNT(*) AS n FROM shared_grants WHERE to_agent_id = ?")
      .get(bob.id) as { n: number };
    assert.equal(grants.n, 0);
    // No task and no workspace subscription materialised either.
    assert.equal(getHandoff(h.id)!.task_id, null);
    assert.equal(getSubscription(ws.id, bob.id), null);
  });

  it("rejects accept when the proposer left the conversation after propose — no grants minted (v0.21 C5)", () => {
    const { alice, bob, conv } = setupTwoUsersInGroup();
    const h = proposeHandoff({
      conversation_id: conv.id,
      from_user_id: "usr_alice",
      from_agent_id: alice.id,
      to_agent_id: bob.id,
      title: "Proposer gone",
      brief: "",
      body: "hello",
    });
    db()
      .prepare(
        "DELETE FROM conversation_members WHERE conversation_id = ? AND agent_id = ?",
      )
      .run(conv.id, alice.id);
    assert.throws(
      () =>
        respondHandoff({
          handoff_id: h.id,
          responding_user_id: "usr_bob",
          decision: "accept",
        }),
      /left the conversation/i,
    );
    assert.equal(getHandoff(h.id)!.status, "proposed");
    const grants = db()
      .prepare("SELECT COUNT(*) AS n FROM shared_grants WHERE to_agent_id = ?")
      .get(bob.id) as { n: number };
    assert.equal(grants.n, 0);
  });

  it("rejects accept when status was already resolved (race-safe gate)", () => {
    const { alice, bob, conv, ws } = setupTwoUsersInGroup();
    const h = proposeHandoff({
      conversation_id: conv.id,
      from_user_id: "usr_alice",
      from_agent_id: alice.id,
      to_agent_id: bob.id,
      title: "Race test",
      brief: "",
      body: "hi",
      workspace_id: ws.id,
    });
    // First accept succeeds.
    respondHandoff({
      handoff_id: h.id,
      responding_user_id: "usr_bob",
      decision: "accept",
    });
    // Second accept must throw (status is no longer 'proposed').
    assert.throws(
      () =>
        respondHandoff({
          handoff_id: h.id,
          responding_user_id: "usr_bob",
          decision: "accept",
        }),
      /already resolved|only proposed/i,
    );
  });

  it("proposer can withdraw a proposed handoff", () => {
    const { alice, bob, conv } = setupTwoUsersInGroup();
    const h = proposeHandoff({
      conversation_id: conv.id,
      from_user_id: "usr_alice",
      from_agent_id: alice.id,
      to_agent_id: bob.id,
      title: "x",
      brief: "",
      body: "y",
    });
    const w = withdrawHandoff({ handoff_id: h.id, user_id: "usr_alice" });
    assert.equal(w.status, "withdrawn");
    // Non-proposer cannot withdraw.
    const h2 = proposeHandoff({
      conversation_id: conv.id,
      from_user_id: "usr_alice",
      from_agent_id: alice.id,
      to_agent_id: bob.id,
      title: "x2",
      brief: "",
      body: "y",
    });
    assert.throws(
      () => withdrawHandoff({ handoff_id: h2.id, user_id: "usr_bob" }),
      /proposer/i,
    );
  });

  it("completing a handoff revokes the grants its acceptance minted", async () => {
    const { alice, bob, conv, ws } = setupTwoUsersInGroup();
    const h = proposeHandoff({
      conversation_id: conv.id,
      from_user_id: "usr_alice",
      from_agent_id: alice.id,
      to_agent_id: bob.id,
      title: "Co-edit the brief",
      brief: "",
      body: "draft please",
      workspace_id: ws.id,
      scopes: ["read", "comment", "write"],
      duration_key: "24h",
    });
    respondHandoff({
      handoff_id: h.id,
      responding_user_id: "usr_bob",
      decision: "accept",
    });
    const { agentMayUseResource } = await import("../../lib/grants");
    // While accepted, the workspace write grant is live.
    assert.equal(
      agentMayUseResource({
        using_agent_id: bob.id,
        resource_type: "workspace",
        resource_id: ws.id,
        required_scope: "write",
      }),
      true,
    );
    // Completing the handoff winds the collaboration down → grants revoked.
    const done = markHandoffCompleted({ handoff_id: h.id, user_id: "usr_alice" });
    assert.equal(done.status, "completed");
    assert.equal(
      agentMayUseResource({
        using_agent_id: bob.id,
        resource_type: "workspace",
        resource_id: ws.id,
        required_scope: "write",
      }),
      false,
    );
  });

  // Quiet the unused-import linters in this test file.
  void getAgent;
  void getHandoff;
  void listMembers;
});
