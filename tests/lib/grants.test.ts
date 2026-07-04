import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestDb, teardownTestDb, resetTables } from "../helpers/setup";
import { _resetDbForTests, db } from "../../lib/db";
import { createAgentForUser, setAgentCapabilities } from "../../lib/agents";
import { createWorkspace, getWorkspace, subscribeAgent } from "../../lib/workspaces";
import { createGroupConversation } from "../../lib/conversations";
import { acceptFriendRequest, sendFriendRequest } from "../../lib/friends";
import { invokeTool } from "../../lib/tools";
import {
  agentMayUseResource,
  createGrant,
  createGrantsForHandoff,
  isGrantActive,
  listGrantsToAgent,
  listGrantsToUser,
  parseGrantScopes,
  revokeGrant,
  revokeGrantsForHandoff,
  verifyGrantForUse,
} from "../../lib/grants";

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
  NOW = 1_700_000_000_000;
});

function seedUserAgent(userId: string, handle: string) {
  db()
    .prepare(
      "INSERT INTO users (id, email, display_name, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(userId, `${handle}@t.test`, handle, "x".repeat(128), "y".repeat(32), NOW);
  return createAgentForUser(userId, { handle, display_name: handle }).agent;
}

function setupTwoUserScenario() {
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
  const ws = createWorkspace({
    name: "shared",
    conversation_id: conv.id,
    created_by_agent_id: alice.id,
  });
  return { alice, bob, conv, ws };
}

describe("createGrant — workspace↔conversation binding (audit #15)", () => {
  it("rejects granting a workspace bound to a conversation the granter isn't in", () => {
    const { ws } = setupTwoUserScenario(); // ws bound to a conv of {alice, bob}
    const carol = seedUserAgent("usr_carol", "carol");
    const dave = seedUserAgent("usr_dave", "dave");
    // carol gets a direct subscription (so canRead passes) but is NOT a member
    // of the workspace's conversation — she still must not be able to grant it.
    subscribeAgent(ws.id, carol.id, "reader");
    assert.throws(
      () =>
        createGrant({
          from_user_id: "usr_carol",
          from_agent_id: carol.id,
          to_agent_id: dave.id,
          resource_type: "workspace",
          resource_id: ws.id,
          scopes: ["read"],
          duration_key: "1h",
        }),
      /conversation you're not in/,
    );
  });
});

describe("createGrant — capability-scoped, signed, optionally expiring", () => {
  it("mints a grant pinned to (resource, scopes, recipient)", () => {
    const { alice, bob, ws } = setupTwoUserScenario();
    const g = createGrant({
      from_user_id: "usr_alice",
      from_agent_id: alice.id,
      to_agent_id: bob.id,
      resource_type: "workspace",
      resource_id: ws.id,
      scopes: ["read", "comment"],
      duration_key: "24h",
    });
    assert.equal(g.from_agent_id, alice.id);
    assert.equal(g.to_agent_id, bob.id);
    assert.equal(g.resource_type, "workspace");
    assert.equal(g.resource_id, ws.id);
    assert.deepEqual(parseGrantScopes(g), ["read", "comment"]);
    assert.equal(g.expires_at, NOW + 24 * 60 * 60 * 1000);
    assert.ok(g.signature.length === 64, "HMAC-SHA256 hex");
  });

  it("rejects when from_agent isn't owned by from_user", () => {
    const { alice, bob, ws } = setupTwoUserScenario();
    assert.throws(
      () =>
        createGrant({
          from_user_id: "usr_bob", // wrong owner
          from_agent_id: alice.id,
          to_agent_id: bob.id,
          resource_type: "workspace",
          resource_id: ws.id,
          scopes: ["read"],
        }),
      /Not your agent/,
    );
  });

  it("rejects when granter owns the recipient (no grant needed)", () => {
    const alice = seedUserAgent("usr_alice", "alice");
    const aliceB = createAgentForUser("usr_alice", {
      handle: "alice2",
      display_name: "Alice's other agent",
    }).agent;
    const conv = createGroupConversation(
      "usr_alice",
      alice.id,
      "Solo room",
      [aliceB.id],
    );
    const ws = createWorkspace({
      name: "shared",
      conversation_id: conv.id,
      created_by_agent_id: alice.id,
    });
    assert.throws(
      () =>
        createGrant({
          from_user_id: "usr_alice",
          from_agent_id: alice.id,
          to_agent_id: aliceB.id,
          resource_type: "workspace",
          resource_id: ws.id,
          scopes: ["read"],
        }),
      /No grant needed/,
    );
  });

  it("rejects unknown scope", () => {
    const { alice, bob, ws } = setupTwoUserScenario();
    assert.throws(
      () =>
        createGrant({
          from_user_id: "usr_alice",
          from_agent_id: alice.id,
          to_agent_id: bob.id,
          resource_type: "workspace",
          resource_id: ws.id,
          scopes: ["superuser" as never],
        }),
      /scopes must be a subset/,
    );
  });
});

describe("verifyGrantForUse — enforcement path", () => {
  it("accepts when scope matches and grant is active", () => {
    const { alice, bob, ws } = setupTwoUserScenario();
    const g = createGrant({
      from_user_id: "usr_alice",
      from_agent_id: alice.id,
      to_agent_id: bob.id,
      resource_type: "workspace",
      resource_id: ws.id,
      scopes: ["read"],
    });
    const v = verifyGrantForUse({
      grant_id: g.id,
      using_agent_id: bob.id,
      required_scope: "read",
    });
    assert.equal(v.ok, true);
  });

  it("denies an agent that isn't the recipient", () => {
    const { alice, bob, ws } = setupTwoUserScenario();
    const carol = seedUserAgent("usr_carol", "carol");
    const g = createGrant({
      from_user_id: "usr_alice",
      from_agent_id: alice.id,
      to_agent_id: bob.id,
      resource_type: "workspace",
      resource_id: ws.id,
      scopes: ["read"],
    });
    const v = verifyGrantForUse({
      grant_id: g.id,
      using_agent_id: carol.id, // wrong agent
      required_scope: "read",
    });
    assert.equal(v.ok, false);
    if (!v.ok) assert.match(v.reason, /not for this agent/);
  });

  it("denies a missing scope", () => {
    const { alice, bob, ws } = setupTwoUserScenario();
    const g = createGrant({
      from_user_id: "usr_alice",
      from_agent_id: alice.id,
      to_agent_id: bob.id,
      resource_type: "workspace",
      resource_id: ws.id,
      scopes: ["read"],
    });
    const v = verifyGrantForUse({
      grant_id: g.id,
      using_agent_id: bob.id,
      required_scope: "write",
    });
    assert.equal(v.ok, false);
    if (!v.ok) assert.match(v.reason, /scope/);
  });

  it("admin scope satisfies any required scope", () => {
    const { alice, bob, ws } = setupTwoUserScenario();
    const g = createGrant({
      from_user_id: "usr_alice",
      from_agent_id: alice.id,
      to_agent_id: bob.id,
      resource_type: "workspace",
      resource_id: ws.id,
      scopes: ["admin"],
    });
    const v = verifyGrantForUse({
      grant_id: g.id,
      using_agent_id: bob.id,
      required_scope: "write",
    });
    assert.equal(v.ok, true);
  });

  it("denies after expiry", () => {
    const { alice, bob, ws } = setupTwoUserScenario();
    const g = createGrant({
      from_user_id: "usr_alice",
      from_agent_id: alice.id,
      to_agent_id: bob.id,
      resource_type: "workspace",
      resource_id: ws.id,
      scopes: ["read"],
      duration_key: "1h",
    });
    // Advance virtual clock past expiry.
    NOW += 2 * 60 * 60 * 1000;
    const v = verifyGrantForUse({
      grant_id: g.id,
      using_agent_id: bob.id,
      required_scope: "read",
    });
    assert.equal(v.ok, false);
    if (!v.ok) assert.match(v.reason, /expired/);
    assert.equal(isGrantActive(g, NOW), false);
  });

  it("denies after revocation by granter or recipient", () => {
    const { alice, bob, ws } = setupTwoUserScenario();
    const g = createGrant({
      from_user_id: "usr_alice",
      from_agent_id: alice.id,
      to_agent_id: bob.id,
      resource_type: "workspace",
      resource_id: ws.id,
      scopes: ["read"],
    });
    revokeGrant({
      grant_id: g.id,
      user_id: "usr_bob",
      reason: "no longer needed",
    });
    const v = verifyGrantForUse({
      grant_id: g.id,
      using_agent_id: bob.id,
      required_scope: "read",
    });
    assert.equal(v.ok, false);
    if (!v.ok) assert.match(v.reason, /revoked/);
  });

  it("detects tampering with scopes_json", () => {
    const { alice, bob, ws } = setupTwoUserScenario();
    const g = createGrant({
      from_user_id: "usr_alice",
      from_agent_id: alice.id,
      to_agent_id: bob.id,
      resource_type: "workspace",
      resource_id: ws.id,
      scopes: ["read"],
    });
    // Simulate a direct DB tamper that escalates the scope without
    // recomputing the signature. Verification must reject.
    db()
      .prepare("UPDATE shared_grants SET scopes_json = ? WHERE id = ?")
      .run(JSON.stringify(["write", "admin"]), g.id);
    const v = verifyGrantForUse({
      grant_id: g.id,
      using_agent_id: bob.id,
      required_scope: "write",
    });
    assert.equal(v.ok, false);
    if (!v.ok) assert.match(v.reason, /signature mismatch|tampered/);
  });

  it("rejects (not throws) a tampered NON-HEX signature of the right length", () => {
    const { alice, bob, ws } = setupTwoUserScenario();
    const g = createGrant({
      from_user_id: "usr_alice",
      from_agent_id: alice.id,
      to_agent_id: bob.id,
      resource_type: "workspace",
      resource_id: ws.id,
      scopes: ["read"],
    });
    // 64 chars (matches HMAC hex length) but not valid hex — Buffer.from
    // would decode it to 0 bytes and timingSafeEqual would THROW without
    // the malformed-hex guard. Must be a clean denial, not a 500.
    db()
      .prepare("UPDATE shared_grants SET signature = ? WHERE id = ?")
      .run("g".repeat(64), g.id);
    const v = verifyGrantForUse({
      grant_id: g.id,
      using_agent_id: bob.id,
      required_scope: "read",
    });
    assert.equal(v.ok, false);
    if (!v.ok) assert.match(v.reason, /signature mismatch|tampered/);
  });
});

describe("grant ENFORCEMENT — agentMayUseResource + real write path", () => {
  it("agentMayUseResource tracks an active grant and its revocation", () => {
    const { alice, bob, ws } = setupTwoUserScenario();
    const probe = {
      using_agent_id: bob.id,
      resource_type: "workspace" as const,
      resource_id: ws.id,
      required_scope: "write" as const,
    };
    assert.equal(agentMayUseResource(probe), false);
    const g = createGrant({
      from_user_id: "usr_alice",
      from_agent_id: alice.id,
      to_agent_id: bob.id,
      resource_type: "workspace",
      resource_id: ws.id,
      scopes: ["write"],
      duration_key: "24h",
    });
    assert.equal(agentMayUseResource(probe), true);
    revokeGrant({ grant_id: g.id, user_id: "usr_alice" });
    assert.equal(agentMayUseResource(probe), false);
  });

  it("a write grant authorizes a write the reader subscription would block", async () => {
    const { alice, bob, ws } = setupTwoUserScenario();
    // Simulate handoff acceptance: peer is subscribed as READER (not writer),
    // and declares the workspace.write capability so the tool gate passes.
    subscribeAgent(ws.id, bob.id, "reader");
    setAgentCapabilities(bob.id, "usr_bob", [
      { name: "workspace.write" },
      { name: "workspace.read" },
    ]);
    const head = getWorkspace(ws.id)!.head_snapshot_id!;

    // Without a grant the reader cannot write — subscription role gates it out.
    const denied = await invokeTool(
      bob.id,
      "workspace.write_file",
      { workspace_id: ws.id, path: "notes.md", content: "hi", against_rev: head },
      null,
    );
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.match(denied.error, /writer role or write grant/);

    // Mint the write grant a co-edit handoff would issue → the write succeeds.
    createGrant({
      from_user_id: "usr_alice",
      from_agent_id: alice.id,
      to_agent_id: bob.id,
      resource_type: "workspace",
      resource_id: ws.id,
      scopes: ["read", "comment", "write"],
      duration_key: "24h",
    });
    const allowed = await invokeTool(
      bob.id,
      "workspace.write_file",
      { workspace_id: ws.id, path: "notes.md", content: "hi", against_rev: head },
      null,
    );
    assert.equal(allowed.ok, true);
  });

  it("revokeGrantsForHandoff revokes every grant minted for that handoff", () => {
    const { alice, bob, ws, conv } = setupTwoUserScenario();
    // A handoff row must exist for the FK on shared_grants.handoff_id.
    db()
      .prepare(
        `INSERT INTO handoffs
         (id, conversation_id, from_agent_id, from_user_id, to_agent_id, to_user_id,
          title, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'accepted', ?)`,
      )
      .run("hnd_test1", conv.id, alice.id, "usr_alice", bob.id, "usr_bob", "T", NOW);
    const grants = createGrantsForHandoff({
      handoff_id: "hnd_test1",
      from_user_id: "usr_alice",
      from_agent_id: alice.id,
      to_agent_id: bob.id,
      workspace_id: ws.id,
      conversation_id: conv.id,
      scopes: ["read", "comment", "write"],
      duration_key: "24h",
    });
    assert.ok(grants.length >= 2); // conversation grant + workspace grant
    assert.equal(
      agentMayUseResource({
        using_agent_id: bob.id,
        resource_type: "workspace",
        resource_id: ws.id,
        required_scope: "write",
      }),
      true,
    );
    const n = revokeGrantsForHandoff({ handoff_id: "hnd_test1", user_id: "usr_alice" });
    assert.equal(n, grants.length);
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
});

describe("listGrantsToAgent + revokeGrant", () => {
  it("lists active grants and excludes revoked ones", () => {
    const { alice, bob, ws } = setupTwoUserScenario();
    const g1 = createGrant({
      from_user_id: "usr_alice",
      from_agent_id: alice.id,
      to_agent_id: bob.id,
      resource_type: "workspace",
      resource_id: ws.id,
      scopes: ["read"],
    });
    const g2 = createGrant({
      from_user_id: "usr_alice",
      from_agent_id: alice.id,
      to_agent_id: bob.id,
      resource_type: "workspace",
      resource_id: ws.id,
      scopes: ["comment"],
    });
    assert.equal(listGrantsToAgent(bob.id).length, 2);
    revokeGrant({ grant_id: g1.id, user_id: "usr_alice" });
    const after = listGrantsToAgent(bob.id);
    assert.equal(after.length, 1);
    assert.equal(after[0].id, g2.id);
  });
});

describe("listGrantsToUser — inbound Access (received grants)", () => {
  it("lists grants received by the user's agents, excluding revoked", () => {
    const { alice, bob, ws } = setupTwoUserScenario();
    // alice grants bob's agent read; bob (usr_bob) is the recipient user.
    const g1 = createGrant({
      from_user_id: "usr_alice",
      from_agent_id: alice.id,
      to_agent_id: bob.id,
      resource_type: "workspace",
      resource_id: ws.id,
      scopes: ["read"],
    });
    // bob has received one grant; alice (the granter) has received none.
    assert.equal(listGrantsToUser("usr_bob").length, 1);
    assert.equal(listGrantsToUser("usr_bob")[0].id, g1.id);
    assert.equal(listGrantsToUser("usr_alice").length, 0);
    // Revoking removes it from the active inbound list, but include_revoked keeps it.
    revokeGrant({ grant_id: g1.id, user_id: "usr_bob" });
    assert.equal(listGrantsToUser("usr_bob").length, 0);
    assert.equal(listGrantsToUser("usr_bob", { include_revoked: true }).length, 1);
  });
});
