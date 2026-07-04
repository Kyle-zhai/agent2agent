import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { setupTestDb, teardownTestDb, resetTables } from "../helpers/setup";
import { _resetDbForTests, db } from "../../lib/db";
import { createAgentForUser } from "../../lib/agents";
import { createWorkspace } from "../../lib/workspaces";
import { createGroupConversation } from "../../lib/conversations";
import { acceptFriendRequest, sendFriendRequest } from "../../lib/friends";
import { createGrant, revokeGrant } from "../../lib/grants";
import { _resetSigningKeyForTests } from "../../lib/card-signing";
import {
  mintAccessToken,
  verifyAccessToken,
  capabilityAllows,
} from "../../lib/token-exchange";
import type { SharedGrant } from "../../lib/types";

const ISS = "https://hub.test";
let NOW = 1_700_000_000_000;
const RealDateNow = Date.now;

before(() => {
  setupTestDb();
  _resetDbForTests();
  Date.now = () => NOW;
});
after(() => {
  Date.now = RealDateNow;
  delete process.env.A2A_CARD_SIGNING_KEY;
  _resetSigningKeyForTests();
  _resetDbForTests();
  teardownTestDb();
});
beforeEach(() => {
  resetTables(db());
  NOW = 1_700_000_000_000;
  delete process.env.A2A_CARD_SIGNING_KEY;
  _resetSigningKeyForTests();
});

function seedUserAgent(userId: string, handle: string) {
  db()
    .prepare(
      "INSERT INTO users (id, email, display_name, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(userId, `${handle}@t.test`, handle, "x".repeat(128), "y".repeat(32), NOW);
  return createAgentForUser(userId, { handle, display_name: handle }).agent;
}

/** alice grants bob `scopes` on a shared workspace; bob is the holder. */
function scenario(scopes: Parameters<typeof createGrant>[0]["scopes"], duration = "24h") {
  const alice = seedUserAgent("usr_alice", "alice");
  const bob = seedUserAgent("usr_bob", "bob");
  const req = sendFriendRequest("usr_alice", alice.id, bob.id);
  acceptFriendRequest("usr_bob", req.id);
  const conv = createGroupConversation("usr_alice", alice.id, "Project X", [bob.id]);
  const ws = createWorkspace({
    name: "shared",
    conversation_id: conv.id,
    created_by_agent_id: alice.id,
  });
  const grant = createGrant({
    from_user_id: "usr_alice",
    from_agent_id: alice.id,
    to_agent_id: bob.id,
    resource_type: "workspace",
    resource_id: ws.id,
    scopes,
    duration_key: duration,
  });
  return { alice, bob, conv, ws, grant };
}

function mint(grant: SharedGrant, holder: string, extra: Partial<Parameters<typeof mintAccessToken>[0]> = {}) {
  return mintAccessToken({
    grant,
    using_agent_id: holder,
    requested_scopes: null,
    audience: null,
    issuer: ISS,
    ...extra,
  });
}

describe("token-exchange — mint/verify roundtrip (HS256)", () => {
  it("mints a token and verifies it back to the grant's claims", () => {
    const { bob, ws, grant } = scenario(["read", "write"]);
    const m = mint(grant, bob.id);
    assert.ok(m.ok);
    assert.equal(m.alg, "HS256");
    assert.equal(m.token_type, "Bearer");
    assert.equal(m.scope, "read write");
    const v = verifyAccessToken(m.access_token, { issuer: ISS });
    assert.ok(v.ok);
    assert.equal(v.claims.agent_id, bob.id);
    assert.equal(v.claims.resource_type, "workspace");
    assert.equal(v.claims.resource_id, ws.id);
    assert.deepEqual([...v.claims.scopes].sort(), ["read", "write"]);
    assert.equal(v.claims.grant_id, grant.id);
  });
});

describe("token-exchange — attenuation (subset only, never widen)", () => {
  it("narrows scope when requested", () => {
    const { bob, grant } = scenario(["read", "write"]);
    const m = mint(grant, bob.id, { requested_scopes: ["read"] });
    assert.ok(m.ok);
    assert.equal(m.scope, "read");
    const v = verifyAccessToken(m.access_token, { issuer: ISS });
    assert.ok(v.ok);
    assert.deepEqual(v.claims.scopes, ["read"]);
  });
  it("refuses a scope the grant does not carry (no widening)", () => {
    const { bob, grant } = scenario(["read"]);
    const m = mint(grant, bob.id, { requested_scopes: ["write"] });
    assert.ok(!m.ok);
    assert.equal(m.error, "invalid_scope");
  });
  it("admin in the grant does NOT auto-expand a narrower request", () => {
    const { bob, grant } = scenario(["admin"]);
    const m = mint(grant, bob.id, { requested_scopes: ["read"] });
    assert.ok(m.ok);
    assert.equal(m.scope, "read"); // exactly what was asked
  });
});

describe("token-exchange — expiry is capped at the grant's own expiry", () => {
  it("never issues a token that outlives the grant", () => {
    // grant expires in 100s; default ttl is 300s → token capped to ≤100s.
    const alice = seedUserAgent("usr_alice", "alice");
    const bob = seedUserAgent("usr_bob", "bob");
    const req = sendFriendRequest("usr_alice", alice.id, bob.id);
    acceptFriendRequest("usr_bob", req.id);
    const conv = createGroupConversation("usr_alice", alice.id, "P", [bob.id]);
    const ws = createWorkspace({ name: "s", conversation_id: conv.id, created_by_agent_id: alice.id });
    const grant = createGrant({
      from_user_id: "usr_alice",
      from_agent_id: alice.id,
      to_agent_id: bob.id,
      resource_type: "workspace",
      resource_id: ws.id,
      scopes: ["read"],
      expires_at: NOW + 100_000, // 100s
    });
    const m = mint(grant, bob.id);
    assert.ok(m.ok);
    assert.ok(m.expires_in <= 100, `expires_in=${m.expires_in}`);
  });
  it("caps a huge requested ttl at the 1h ceiling", () => {
    const { bob, grant } = scenario(["read"], "forever");
    const m = mint(grant, bob.id, { ttl_seconds: 999_999 });
    assert.ok(m.ok);
    assert.ok(m.expires_in <= 3600, `expires_in=${m.expires_in}`);
  });
});

describe("token-exchange — revocation & expiry propagate instantly", () => {
  it("revoking the grant invalidates an already-minted token", () => {
    const { bob, grant } = scenario(["read", "write"]);
    const m = mint(grant, bob.id);
    assert.ok(m.ok);
    assert.ok(verifyAccessToken(m.access_token, { issuer: ISS }).ok);
    revokeGrant({ grant_id: grant.id, user_id: "usr_alice", reason: "done" });
    const v = verifyAccessToken(m.access_token, { issuer: ISS });
    assert.ok(!v.ok);
    assert.match(v.reason, /revoked/);
  });
  it("a token expires when its own exp passes (before grant expiry too)", () => {
    const { bob, grant } = scenario(["read"], "forever");
    const m = mint(grant, bob.id, { ttl_seconds: 300 });
    assert.ok(m.ok);
    NOW += 301_000; // advance past token exp
    const v = verifyAccessToken(m.access_token, { issuer: ISS });
    assert.ok(!v.ok);
    assert.match(v.reason, /expired/);
  });
});

describe("token-exchange — integrity & issuer", () => {
  it("rejects a wrong issuer", () => {
    const { bob, grant } = scenario(["read"]);
    const m = mint(grant, bob.id);
    assert.ok(m.ok);
    const v = verifyAccessToken(m.access_token, { issuer: "https://evil.test" });
    assert.ok(!v.ok);
    assert.match(v.reason, /issuer/);
  });
  it("rejects a tampered payload (scope escalation in the JWT body)", () => {
    const { bob, grant } = scenario(["read"]);
    const m = mint(grant, bob.id);
    assert.ok(m.ok);
    const [h, p, s] = m.access_token.split(".");
    const payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
    payload.scope = "read write admin";
    const forged = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const v = verifyAccessToken(`${h}.${forged}.${s}`, { issuer: ISS });
    assert.ok(!v.ok);
    assert.match(v.reason, /signature/);
  });
  it("rejects audience mismatch when the token is audience-bound", () => {
    const { bob, grant } = scenario(["read"]);
    const m = mint(grant, bob.id, { audience: "https://peerA.test" });
    assert.ok(m.ok);
    const bad = verifyAccessToken(m.access_token, { issuer: ISS, audience: "https://peerB.test" });
    assert.ok(!bad.ok);
    assert.match(bad.reason, /audience/);
    const good = verifyAccessToken(m.access_token, { issuer: ISS, audience: "https://peerA.test" });
    assert.ok(good.ok);
  });
});

describe("token-exchange — alg-confusion defense", () => {
  it('rejects alg:"none"', () => {
    const { bob, grant } = scenario(["read"]);
    const m = mint(grant, bob.id);
    assert.ok(m.ok);
    const [, p] = m.access_token.split(".");
    const noneHeader = Buffer.from(JSON.stringify({ alg: "none", typ: "at+jwt" }), "utf8").toString("base64url");
    const v = verifyAccessToken(`${noneHeader}.${p}.`, { issuer: ISS });
    assert.ok(!v.ok);
    assert.match(v.reason, /alg/);
  });
  it("rejects an ES256-claimed token when no ES256 key is configured", () => {
    const { bob, grant } = scenario(["read"]);
    const m = mint(grant, bob.id); // HS256 (no key set)
    assert.ok(m.ok);
    const [, p, s] = m.access_token.split(".");
    const esHeader = Buffer.from(JSON.stringify({ alg: "ES256", typ: "at+jwt" }), "utf8").toString("base64url");
    const v = verifyAccessToken(`${esHeader}.${p}.${s}`, { issuer: ISS });
    assert.ok(!v.ok);
    assert.match(v.reason, /ES256 not configured/);
  });
});

describe("token-exchange — holder binding", () => {
  it("refuses to mint for an agent that does not hold the grant", () => {
    const { grant } = scenario(["read"]);
    const carol = seedUserAgent("usr_carol", "carol");
    const m = mint(grant, carol.id);
    assert.ok(!m.ok);
    assert.equal(m.error, "invalid_grant");
  });
});

describe("token-exchange — ES256 path (externally verifiable)", () => {
  it("mints an ES256 token verifiable via our own key, and rejects tampering", () => {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    process.env.A2A_CARD_SIGNING_KEY = privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString();
    _resetSigningKeyForTests();

    const { bob, grant } = scenario(["read", "write"]);
    const m = mint(grant, bob.id);
    assert.ok(m.ok);
    assert.equal(m.alg, "ES256");
    // header advertises a kid so external verifiers can select the JWKS key.
    const header = JSON.parse(Buffer.from(m.access_token.split(".")[0], "base64url").toString("utf8"));
    assert.equal(header.alg, "ES256");
    assert.ok(typeof header.kid === "string" && header.kid.length > 0);

    const v = verifyAccessToken(m.access_token, { issuer: ISS });
    assert.ok(v.ok);
    assert.equal(v.claims.agent_id, bob.id);

    // flip one byte of the signature → verify fails
    const [h, p, s] = m.access_token.split(".");
    const sigBuf = Buffer.from(s, "base64url");
    sigBuf[0] ^= 0xff;
    const bad = verifyAccessToken(`${h}.${p}.${sigBuf.toString("base64url")}`, { issuer: ISS });
    assert.ok(!bad.ok);
  });
});

describe("capabilityAllows — exact resource + scope", () => {
  it("authorizes only the exact resource and scope (admin covers all)", () => {
    const claims = {
      agent_id: "a", from_agent_id: "b", resource_type: "workspace" as const,
      resource_id: "ws1", scopes: ["read" as const], grant_id: "g", audience: null,
      jti: "j", expires_at: 0,
    };
    assert.ok(capabilityAllows(claims, "workspace", "ws1", "read"));
    assert.ok(!capabilityAllows(claims, "workspace", "ws1", "write"));
    assert.ok(!capabilityAllows(claims, "workspace", "ws2", "read")); // wrong id
    assert.ok(!capabilityAllows(claims, "task", "ws1", "read")); // wrong type
    const admin = { ...claims, scopes: ["admin" as const] };
    assert.ok(capabilityAllows(admin, "workspace", "ws1", "write"));
  });
});
