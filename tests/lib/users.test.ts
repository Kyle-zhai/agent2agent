import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestDb, teardownTestDb, resetTables } from "../helpers/setup";
import { _resetDbForTests, db } from "../../lib/db";
import { deleteUserAccount } from "../../lib/users";
import { createAgentForUser, type Agent } from "../../lib/agents";
import { sendMessage } from "../../lib/conversations";
import { newConversationId } from "../../lib/ids";

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

function seedUser(userId: string, handle: string): Agent {
  db()
    .prepare(
      "INSERT INTO users (id, email, display_name, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(userId, `${handle}@t.test`, handle, "x".repeat(128), "y".repeat(32), NOW);
  return createAgentForUser(userId, { handle, display_name: handle }).agent;
}

function seedSession(sessionId: string, userId: string): void {
  db()
    .prepare(
      "INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
    )
    .run(sessionId, userId, NOW + 1_000_000, NOW);
}

function seedOauth(id: string, userId: string, provider: string): void {
  db()
    .prepare(
      `INSERT INTO oauth_identities (id, user_id, provider, provider_user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(id, userId, provider, `pid_${id}`, NOW, NOW);
}

function seedAudit(id: string, userId: string, action: string): void {
  db()
    .prepare(
      `INSERT INTO audit_log (id, user_id, action, created_at) VALUES (?, ?, ?, ?)`,
    )
    .run(id, userId, action, NOW);
}

function seedInvite(id: string, userId: string, agentId: string): void {
  db()
    .prepare(
      `INSERT INTO invite_links (id, code, created_by_user_id, inviter_agent_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(id, `code_${id}`, userId, agentId, NOW);
}

function seedGrant(
  id: string,
  from: { userId: string; agentId: string },
  to: { userId: string; agentId: string },
): void {
  db()
    .prepare(
      `INSERT INTO shared_grants
       (id, from_agent_id, from_user_id, to_agent_id, to_user_id,
        resource_type, resource_id, scopes_json, signature, created_at)
       VALUES (?, ?, ?, ?, ?, 'workspace', 'ws_x', '["read"]', 'sig', ?)`,
    )
    .run(id, from.agentId, from.userId, to.agentId, to.userId, NOW);
}

function seedHandoff(
  id: string,
  conversationId: string,
  from: { userId: string; agentId: string },
  to: { userId: string; agentId: string },
): void {
  db()
    .prepare(
      `INSERT INTO handoffs
       (id, conversation_id, from_agent_id, from_user_id, to_agent_id, to_user_id,
        title, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'h', 'proposed', ?)`,
    )
    .run(id, conversationId, from.agentId, from.userId, to.agentId, to.userId, NOW);
}

function makeConv(memberIds: string[], creatorId: string): { id: string } {
  const id = newConversationId();
  db()
    .prepare(
      `INSERT INTO conversations (id, type, title, created_by_agent_id, created_at)
       VALUES (?, 'group', 'g', ?, ?)`,
    )
    .run(id, creatorId, NOW);
  for (const m of memberIds) {
    db()
      .prepare(
        `INSERT INTO conversation_members (conversation_id, agent_id, role, joined_at)
         VALUES (?, ?, 'member', ?)`,
      )
      .run(id, m, NOW);
  }
  return { id };
}

function count(sql: string, ...params: unknown[]): number {
  return (db().prepare(sql).get(...params) as { n: number }).n;
}

describe("deleteUserAccount — confirmation gate", () => {
  it("wrong email confirmation throws and deletes nothing", () => {
    const a = seedUser("usr_a", "alice");
    seedSession("sess_a", "usr_a");
    seedOauth("oa_a", "usr_a", "github");

    assert.throws(
      () => deleteUserAccount("usr_a", "not-alice@t.test"),
      /doesn't match/,
    );

    assert.equal(count("SELECT COUNT(*) AS n FROM users WHERE id = ?", "usr_a"), 1);
    assert.equal(count("SELECT COUNT(*) AS n FROM agents WHERE id = ?", a.id), 1);
    assert.equal(count("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?", "usr_a"), 1);
    assert.equal(
      count("SELECT COUNT(*) AS n FROM oauth_identities WHERE user_id = ?", "usr_a"),
      1,
    );
  });

  it("unknown user id throws 'User not found.'", () => {
    assert.throws(
      () => deleteUserAccount("usr_nobody", "x@t.test"),
      /User not found/,
    );
  });

  it("email confirmation is case-insensitive and trims whitespace", () => {
    seedUser("usr_a", "alice");
    deleteUserAccount("usr_a", "  ALICE@T.TEST  ");
    assert.equal(count("SELECT COUNT(*) AS n FROM users WHERE id = ?", "usr_a"), 0);
  });
});

describe("deleteUserAccount — full cascade", () => {
  it("removes the users row, sessions, oauth identities, and owned agents", () => {
    const a = seedUser("usr_a", "alice");
    const b = seedUser("usr_b", "bob");
    seedSession("sess_a1", "usr_a");
    seedSession("sess_a2", "usr_a");
    seedOauth("oa_a", "usr_a", "github");
    const conv = makeConv([a.id, b.id], a.id);
    sendMessage(conv.id, a.id, { text: "supersecretword", kind: "agent_to_agent" });

    deleteUserAccount("usr_a", "alice@t.test");

    assert.equal(count("SELECT COUNT(*) AS n FROM users WHERE id = ?", "usr_a"), 0);
    assert.equal(count("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?", "usr_a"), 0);
    assert.equal(
      count("SELECT COUNT(*) AS n FROM oauth_identities WHERE user_id = ?", "usr_a"),
      0,
    );
    assert.equal(
      count("SELECT COUNT(*) AS n FROM agents WHERE owner_user_id = ?", "usr_a"),
      0,
    );
    // deleteAgentForUser semantics: messages authored by the agent go with it.
    assert.equal(
      count("SELECT COUNT(*) AS n FROM messages WHERE from_agent_id = ?", a.id),
      0,
    );
    // Privacy: the search index must not keep the deleted user's message text.
    assert.equal(
      count(
        "SELECT COUNT(*) AS n FROM messages_fts WHERE messages_fts MATCH ?",
        "supersecretword",
      ),
      0,
    );
  });

  it("removes the user's audit_log rows", () => {
    seedUser("usr_a", "alice");
    seedUser("usr_b", "bob");
    seedAudit("aud_1", "usr_a", "auth.signin");
    seedAudit("aud_2", "usr_a", "message.send");
    seedAudit("aud_3", "usr_b", "auth.signin");

    deleteUserAccount("usr_a", "alice@t.test");

    assert.equal(
      count("SELECT COUNT(*) AS n FROM audit_log WHERE user_id = ?", "usr_a"),
      0,
    );
    assert.equal(
      count("SELECT COUNT(*) AS n FROM audit_log WHERE user_id = ?", "usr_b"),
      1,
    );
  });

  it("removes invite links the user created and device-auth requests they approved", () => {
    const a = seedUser("usr_a", "alice");
    const b = seedUser("usr_b", "bob");
    seedInvite("inv_a", "usr_a", a.id);
    seedInvite("inv_b", "usr_b", b.id);
    // B redeemed A's invite; A redeemed B's invite — both rows must go.
    db()
      .prepare(
        `INSERT INTO invite_redemptions (invite_id, redeemer_user_id, redeemer_agent_id, redeemed_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run("inv_a", "usr_b", b.id, NOW);
    db()
      .prepare(
        `INSERT INTO invite_redemptions (invite_id, redeemer_user_id, redeemer_agent_id, redeemed_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run("inv_b", "usr_a", a.id, NOW);
    db()
      .prepare(
        `INSERT INTO device_auth_requests (id, device_code, user_code, approved_by_user_id, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run("dar_a", "dc_a", "uc_a", "usr_a", NOW, NOW + 1_000_000);
    db()
      .prepare(
        `INSERT INTO device_auth_requests (id, device_code, user_code, approved_by_user_id, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run("dar_b", "dc_b", "uc_b", "usr_b", NOW, NOW + 1_000_000);

    deleteUserAccount("usr_a", "alice@t.test");

    assert.equal(
      count("SELECT COUNT(*) AS n FROM invite_links WHERE created_by_user_id = ?", "usr_a"),
      0,
    );
    assert.equal(count("SELECT COUNT(*) AS n FROM invite_redemptions"), 0);
    assert.equal(
      count(
        "SELECT COUNT(*) AS n FROM device_auth_requests WHERE approved_by_user_id = ?",
        "usr_a",
      ),
      0,
    );
    // B's own rows survive.
    assert.equal(
      count("SELECT COUNT(*) AS n FROM invite_links WHERE id = ?", "inv_b"),
      1,
    );
    assert.equal(
      count("SELECT COUNT(*) AS n FROM device_auth_requests WHERE id = ?", "dar_b"),
      1,
    );
  });
});

describe("deleteUserAccount — isolation and no dangling references", () => {
  it("deleting user A leaves user B's world fully intact", () => {
    const a = seedUser("usr_a", "alice");
    const b = seedUser("usr_b", "bob");
    const c = seedUser("usr_c", "carol");
    seedSession("sess_a", "usr_a");
    seedSession("sess_b", "usr_b");
    seedOauth("oa_a", "usr_a", "github");
    seedOauth("oa_b", "usr_b", "github");
    seedAudit("aud_a", "usr_a", "auth.signin");
    seedAudit("aud_b", "usr_b", "auth.signin");
    seedInvite("inv_b", "usr_b", b.id);
    const conv = makeConv([a.id, b.id], a.id);
    sendMessage(conv.id, a.id, { text: "from alice", kind: "agent_to_agent" });
    sendMessage(conv.id, b.id, { text: "bobword", kind: "agent_to_agent" });
    // Grants in every direction; only the B→C grant must survive.
    seedGrant("g_ab", { userId: "usr_a", agentId: a.id }, { userId: "usr_b", agentId: b.id });
    seedGrant("g_ba", { userId: "usr_b", agentId: b.id }, { userId: "usr_a", agentId: a.id });
    seedGrant("g_bc", { userId: "usr_b", agentId: b.id }, { userId: "usr_c", agentId: c.id });

    deleteUserAccount("usr_a", "alice@t.test");

    // B's account-level rows are untouched.
    assert.equal(count("SELECT COUNT(*) AS n FROM users WHERE id = ?", "usr_b"), 1);
    assert.equal(count("SELECT COUNT(*) AS n FROM agents WHERE id = ?", b.id), 1);
    assert.equal(count("SELECT COUNT(*) AS n FROM sessions WHERE id = ?", "sess_b"), 1);
    assert.equal(
      count("SELECT COUNT(*) AS n FROM oauth_identities WHERE id = ?", "oa_b"),
      1,
    );
    assert.equal(count("SELECT COUNT(*) AS n FROM audit_log WHERE id = ?", "aud_b"), 1);
    assert.equal(count("SELECT COUNT(*) AS n FROM invite_links WHERE id = ?", "inv_b"), 1);
    // The shared room survives (reassigned to B's agent) with B's message.
    assert.equal(count("SELECT COUNT(*) AS n FROM conversations WHERE id = ?", conv.id), 1);
    assert.equal(
      count("SELECT COUNT(*) AS n FROM messages WHERE from_agent_id = ?", b.id),
      1,
    );
    assert.equal(
      count("SELECT COUNT(*) AS n FROM messages_fts WHERE messages_fts MATCH ?", "bobword"),
      1,
    );
    // Grants involving A are revoked in both directions; B→C survives.
    assert.equal(count("SELECT COUNT(*) AS n FROM shared_grants WHERE id = ?", "g_ab"), 0);
    assert.equal(count("SELECT COUNT(*) AS n FROM shared_grants WHERE id = ?", "g_ba"), 0);
    assert.equal(count("SELECT COUNT(*) AS n FROM shared_grants WHERE id = ?", "g_bc"), 1);
  });

  it("grants, handoffs, and agent links involving A's agents do not dangle", () => {
    const a = seedUser("usr_a", "alice");
    const b = seedUser("usr_b", "bob");
    const c = seedUser("usr_c", "carol");
    const conv = makeConv([a.id, b.id, c.id], a.id);
    seedGrant("g_ab", { userId: "usr_a", agentId: a.id }, { userId: "usr_b", agentId: b.id });
    seedGrant("g_ba", { userId: "usr_b", agentId: b.id }, { userId: "usr_a", agentId: a.id });
    seedHandoff("h_ab", conv.id, { userId: "usr_a", agentId: a.id }, { userId: "usr_b", agentId: b.id });
    seedHandoff("h_ba", conv.id, { userId: "usr_b", agentId: b.id }, { userId: "usr_a", agentId: a.id });
    // Link between A's and B's agents, initiated by A → must be deleted.
    const [abLo, abHi] = [a.id, b.id].sort();
    db()
      .prepare(
        `INSERT INTO agent_links (id, agent_a, agent_b, conversation_id, initiated_by_user_id, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'accepted', ?)`,
      )
      .run("lnk_ab", abLo, abHi, conv.id, "usr_a", NOW);
    // Link between B's and C's agents responded to by A → survives with the
    // responder reference nulled, never dangling.
    const [bcLo, bcHi] = [b.id, c.id].sort();
    db()
      .prepare(
        `INSERT INTO agent_links (id, agent_a, agent_b, conversation_id, initiated_by_user_id, status, responded_by_user_id, created_at)
         VALUES (?, ?, ?, ?, ?, 'accepted', ?, ?)`,
      )
      .run("lnk_bc", bcLo, bcHi, conv.id, "usr_b", "usr_a", NOW);

    deleteUserAccount("usr_a", "alice@t.test");

    assert.equal(
      count(
        "SELECT COUNT(*) AS n FROM shared_grants WHERE from_agent_id = ? OR to_agent_id = ? OR from_user_id = ? OR to_user_id = ?",
        a.id,
        a.id,
        "usr_a",
        "usr_a",
      ),
      0,
    );
    assert.equal(
      count(
        "SELECT COUNT(*) AS n FROM handoffs WHERE from_agent_id = ? OR to_agent_id = ? OR from_user_id = ? OR to_user_id = ?",
        a.id,
        a.id,
        "usr_a",
        "usr_a",
      ),
      0,
    );
    assert.equal(
      count(
        "SELECT COUNT(*) AS n FROM agent_links WHERE agent_a = ? OR agent_b = ? OR initiated_by_user_id = ?",
        a.id,
        a.id,
        "usr_a",
      ),
      0,
    );
    const bcLink = db()
      .prepare("SELECT responded_by_user_id FROM agent_links WHERE id = ?")
      .get("lnk_bc") as { responded_by_user_id: string | null } | undefined;
    assert.ok(bcLink, "B–C link must survive A's deletion");
    assert.equal(bcLink.responded_by_user_id, null);
    // FK integrity sweep — nothing anywhere references a missing row.
    const violations = db().pragma("foreign_key_check") as unknown[];
    assert.deepEqual(violations, []);
  });
});
