import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestDb, teardownTestDb, resetTables } from "../helpers/setup";
import { _resetDbForTests, db } from "../../lib/db";
import { createAgentForUser } from "../../lib/agents";
import { createWorkspace } from "../../lib/workspaces";
import { createGroupConversation } from "../../lib/conversations";
import { acceptFriendRequest, sendFriendRequest } from "../../lib/friends";
import { createGrant, revokeGrant } from "../../lib/grants";
import { mintAccessToken } from "../../lib/token-exchange";
import {
  authenticateWithCapability,
  capabilityAuthorizes,
} from "../../lib/api-auth";

const ORIGIN = "https://hub.test";
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
  delete process.env.NEXT_PUBLIC_APP_URL; // issuer falls back to request origin
});

function seedUser(userId: string, handle: string) {
  db()
    .prepare(
      "INSERT INTO users (id, email, display_name, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(userId, `${handle}@t.test`, handle, "x".repeat(128), "y".repeat(32), NOW);
  return createAgentForUser(userId, { handle, display_name: handle });
}

function bearer(token: string) {
  return new Request(`${ORIGIN}/api/v1/workspaces/x`, {
    headers: { authorization: `Bearer ${token}` },
  });
}

function setup() {
  const alice = seedUser("usr_alice", "alice");
  const bob = seedUser("usr_bob", "bob");
  const req = sendFriendRequest("usr_alice", alice.agent.id, bob.agent.id);
  acceptFriendRequest("usr_bob", req.id);
  const conv = createGroupConversation("usr_alice", alice.agent.id, "P", [bob.agent.id]);
  const ws = createWorkspace({ name: "s", conversation_id: conv.id, created_by_agent_id: alice.agent.id });
  const grant = createGrant({
    from_user_id: "usr_alice",
    from_agent_id: alice.agent.id,
    to_agent_id: bob.agent.id,
    resource_type: "workspace",
    resource_id: ws.id,
    scopes: ["read"],
    duration_key: "24h",
  });
  return { alice, bob, ws, grant };
}

describe("authenticateWithCapability — api-key path", () => {
  it("accepts an a2a_ key as a full agent with no capability constraint", () => {
    const { bob } = setup();
    const res = authenticateWithCapability(bearer(bob.apiKey));
    assert.ok(res.ok);
    assert.equal(res.agent.id, bob.agent.id);
    assert.equal(res.capability, null);
  });
  it("rejects a garbage bearer", () => {
    const res = authenticateWithCapability(bearer("not-a-key-or-token"));
    assert.ok(!res.ok);
    assert.equal(res.status, 401);
  });
});

describe("authenticateWithCapability — capability-token path (external agent)", () => {
  it("accepts a minted token, binding the acting agent + scoped capability", () => {
    const { bob, ws, grant } = setup();
    const m = mintAccessToken({
      grant, using_agent_id: bob.agent.id, requested_scopes: null,
      audience: null, issuer: ORIGIN,
    });
    assert.ok(m.ok);
    const res = authenticateWithCapability(bearer(m.access_token));
    assert.ok(res.ok);
    assert.equal(res.agent.id, bob.agent.id); // acting agent = grant holder
    assert.ok(res.capability);
    // authorizes exactly the granted resource + scope, nothing else
    assert.ok(capabilityAuthorizes(res, "workspace", ws.id, "read"));
    assert.ok(!capabilityAuthorizes(res, "workspace", ws.id, "write")); // scope not granted
    assert.ok(!capabilityAuthorizes(res, "workspace", "other_ws", "read")); // other resource
    assert.ok(!capabilityAuthorizes(res, "conversation", ws.id, "read")); // other type
  });

  it("a revoked grant makes the presented token unauthenticated", () => {
    const { bob, grant } = setup();
    const m = mintAccessToken({
      grant, using_agent_id: bob.agent.id, requested_scopes: null,
      audience: null, issuer: ORIGIN,
    });
    assert.ok(m.ok);
    revokeGrant({ grant_id: grant.id, user_id: "usr_alice" });
    const res = authenticateWithCapability(bearer(m.access_token));
    assert.ok(!res.ok);
    assert.equal(res.status, 401);
  });

  it("capabilityAuthorizes returns false for an api-key auth (no borrowing)", () => {
    const { bob, ws } = setup();
    const res = authenticateWithCapability(bearer(bob.apiKey));
    assert.ok(res.ok);
    // Even though bob's agent holds the grant, the api-key branch does not
    // report capability authority — the caller falls through to its own
    // subscription/grant checks instead.
    assert.ok(!capabilityAuthorizes(res, "workspace", ws.id, "read"));
  });
});
