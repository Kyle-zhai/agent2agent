import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestDb, teardownTestDb, resetTables } from "../helpers/setup";
import { _resetDbForTests, db } from "../../lib/db";
import {
  findIdentityByProviderUser,
  handleCallbackProfile,
  listIdentitiesForUser,
  newStateNonce,
  signState,
  unlinkIdentity,
  upsertIdentity,
  verifyState,
  type OAuthProfile,
} from "../../lib/oauth";
import { createAgentForUser } from "../../lib/agents";

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

function seedExistingUser(id: string, email: string, pwHashed = true) {
  db()
    .prepare(
      "INSERT INTO users (id, email, display_name, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(
      id,
      email,
      "user " + id,
      pwHashed ? "x".repeat(128) : "",
      pwHashed ? "y".repeat(32) : "",
      NOW,
    );
}

function p(id: string, name = "X"): OAuthProfile {
  return {
    provider_user_id: id,
    display_name: name,
    email: `${id}@x.test`,
    avatar_url: null,
    raw: { foo: "bar" },
  };
}

describe("state signing", () => {
  it("signs and verifies round-trip", () => {
    const nonce = newStateNonce();
    const secret = "abc";
    const s = signState(nonce, secret, { mode: "signin" });
    const v = verifyState(s, secret);
    assert.equal(v.ok, true);
    if (!v.ok) return;
    assert.equal(v.nonce, nonce);
    assert.equal(v.intent.mode, "signin");
  });

  it("rejects tampered state", () => {
    const s = signState("abc", "secret", { mode: "signin" });
    // flip a byte in the mac
    const parts = s.split(".");
    parts[2] = parts[2].slice(0, -2) + "ff";
    const r = verifyState(parts.join("."), "secret");
    assert.equal(r.ok, false);
  });

  it("rejects state signed with a different secret", () => {
    const s = signState("abc", "secret-a", { mode: "signin" });
    const r = verifyState(s, "secret-b");
    assert.equal(r.ok, false);
  });

  it("rejects state with mac length mismatch (defense before timingSafeEqual)", () => {
    const s = signState("abc", "secret", { mode: "signin" });
    const parts = s.split(".");
    // Truncate the MAC → verifyState must reject without crashing.
    const truncated = parts[0] + "." + parts[1] + "." + parts[2].slice(0, 10);
    const r = verifyState(truncated, "secret");
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.error, "bad_state_mac");
  });
});

describe("handleCallbackProfile — signup path", () => {
  it("creates user + identity on first signin", () => {
    const res = handleCallbackProfile("google", p("gid-1"), {
      mode: "signin",
    });
    assert.equal(res.kind, "signup");
    const found = findIdentityByProviderUser("google", "gid-1");
    assert.ok(found);
    assert.equal(found!.user_id, res.user_id);
  });

  it("logs in existing user on second callback", () => {
    const first = handleCallbackProfile("google", p("gid-1"), {
      mode: "signin",
    });
    const second = handleCallbackProfile("google", p("gid-1", "Updated"), {
      mode: "signin",
    });
    assert.equal(second.kind, "signin");
    assert.equal(second.user_id, first.user_id);
    const after = findIdentityByProviderUser("google", "gid-1");
    assert.equal(after?.display_name, "Updated");
  });
});

describe("handleCallbackProfile — link path", () => {
  it("links provider to logged-in user", () => {
    seedExistingUser("usr_a", "a@a.test");
    const res = handleCallbackProfile("github", p("gh-1"), {
      mode: "link",
      user_id: "usr_a",
    });
    assert.equal(res.kind, "link");
    assert.equal(res.user_id, "usr_a");
  });

  it("rejects linking a provider account already bound to a different user", () => {
    seedExistingUser("usr_a", "a@a.test");
    seedExistingUser("usr_b", "b@b.test");
    handleCallbackProfile("github", p("gh-1"), {
      mode: "link",
      user_id: "usr_a",
    });
    assert.throws(
      () =>
        handleCallbackProfile("github", p("gh-1"), {
          mode: "link",
          user_id: "usr_b",
        }),
      /already linked/,
    );
  });
});

describe("unlinkIdentity", () => {
  it("refuses to unlink the only sign-in method when user has no password", () => {
    const res = handleCallbackProfile("google", p("gid-only"), {
      mode: "signin",
    });
    // user has empty password (OAuth signup), and only 1 identity
    assert.throws(
      () => unlinkIdentity(res.user_id, "google"),
      /only sign-in method/,
    );
  });

  it("allows unlink when password exists", () => {
    seedExistingUser("usr_a", "a@a.test"); // has password
    upsertIdentity("usr_a", "google", p("gid-pw"));
    assert.equal(listIdentitiesForUser("usr_a").length, 1);
    unlinkIdentity("usr_a", "google");
    assert.equal(listIdentitiesForUser("usr_a").length, 0);
  });

  it("allows unlink when another OAuth method exists", () => {
    const a = handleCallbackProfile("google", p("g1"), { mode: "signin" });
    handleCallbackProfile("github", p("gh1"), {
      mode: "link",
      user_id: a.user_id,
    });
    assert.equal(listIdentitiesForUser(a.user_id).length, 2);
    unlinkIdentity(a.user_id, "google");
    assert.equal(listIdentitiesForUser(a.user_id).length, 1);
  });
});

describe("audit retention", () => {
  it("pruneAuditLog removes only rows older than the cutoff", () => {
    const { pruneAuditLog, logAudit } = require("../../lib/audit");
    seedExistingUser("usr_x", "x@x.test");
    logAudit("auth.signin", { userId: "usr_x", detail: {} });
    // Force a fake old row directly
    db()
      .prepare(
        `INSERT INTO audit_log (id, user_id, agent_id, action, detail_json, ip, user_agent, created_at)
         VALUES (?, ?, NULL, 'auth.signin', '{}', NULL, NULL, ?)`,
      )
      .run("aud_old1", "usr_x", NOW - 100 * 24 * 3600 * 1000);
    const before = (db().prepare("SELECT COUNT(*) AS n FROM audit_log").get() as { n: number }).n;
    const removed = pruneAuditLog(90 * 24 * 3600 * 1000);
    const after = (db().prepare("SELECT COUNT(*) AS n FROM audit_log").get() as { n: number }).n;
    assert.equal(removed, 1);
    assert.equal(after, before - 1);
  });
});

describe("upsertIdentity — same (provider, provider_user_id) cannot link two users", () => {
  it("throws on cross-user collision", () => {
    seedExistingUser("usr_a", "a@a.test");
    seedExistingUser("usr_b", "b@b.test");
    upsertIdentity("usr_a", "google", p("shared"));
    // also need an agent for both so subsequent flows work
    createAgentForUser("usr_a", { handle: "a1", display_name: "A1" });
    createAgentForUser("usr_b", { handle: "b1", display_name: "B1" });

    assert.throws(
      () => upsertIdentity("usr_b", "google", p("shared")),
      /already linked/,
    );
  });
});
