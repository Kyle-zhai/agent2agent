import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestDb, teardownTestDb, resetTables } from "../helpers/setup";
import { _resetDbForTests, db } from "../../lib/db";
import { hashPassword } from "../../lib/crypto";
import {
  signUp,
  signIn,
  changePassword,
  signOut,
  getCurrentUser,
  requireUser,
} from "../../lib/auth";
import { __test as reqCtx } from "../shims/next-headers";

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
  reqCtx.reset(); // clear shim cookies + headers between tests
});

const GOOD_PW = "Passw0rd-X1";

function seedUser(id: string, email: string, password = GOOD_PW) {
  const { hash, salt } = hashPassword(password);
  db()
    .prepare(
      `INSERT INTO users (id, email, display_name, password_hash, password_salt, created_at, failed_login_count, locked_until)
       VALUES (?, ?, ?, ?, ?, ?, 0, NULL)`,
    )
    .run(id, email, email.split("@")[0], hash, salt, NOW);
}

describe("signUp — password policy + enumeration defense", () => {
  it("creates a user and opens a session for a strong password", async () => {
    const u = await signUp("alice@test.app", GOOD_PW, "Alice");
    assert.equal(u.email, "alice@test.app");
    // A session cookie was set (the shim captured it).
    assert.ok(await getCurrentUser());
  });

  it("rejects weak passwords (too short / too few classes / repetition)", async () => {
    await assert.rejects(() => signUp("a@test.app", "short1A", "A"), /at least 10/i);
    await assert.rejects(() => signUp("b@test.app", "alllowercase", "B"), /3 of/i);
    await assert.rejects(() => signUp("c@test.app", "Passw0000rd!", "C"), /repetitive/i);
  });

  it("rejects a malformed email", async () => {
    await assert.rejects(() => signUp("not-an-email", GOOD_PW, "X"), /invalid email/i);
  });

  it("uses a GENERIC error for a duplicate email (no enumeration)", async () => {
    await signUp("dup@test.app", GOOD_PW, "First");
    reqCtx.reset();
    // Same generic 'could not create' message — never 'email taken'.
    await assert.rejects(
      () => signUp("dup@test.app", GOOD_PW, "Second"),
      /could not create account/i,
    );
  });
});

describe("signIn — lockout + constant-time + enumeration", () => {
  it("signs in with the right password", async () => {
    seedUser("usr_a", "a@test.app");
    const u = await signIn("a@test.app", GOOD_PW);
    assert.equal(u.id, "usr_a");
  });

  it("returns the SAME generic error for wrong password and unknown email", async () => {
    seedUser("usr_a", "a@test.app");
    await assert.rejects(() => signIn("a@test.app", "WrongPass-9Z"), /incorrect/i);
    reqCtx.reset();
    await assert.rejects(() => signIn("nobody@test.app", GOOD_PW), /incorrect/i);
  });

  it("locks the account after 5 failed attempts", async () => {
    seedUser("usr_a", "a@test.app");
    // signin bucket capacity is exactly 5, so 5 failures all pass the rate
    // gate and the 5th flips the lock.
    for (let i = 0; i < 5; i++) {
      await assert.rejects(() => signIn("a@test.app", "WrongPass-9Z"));
    }
    const row = db()
      .prepare("SELECT failed_login_count, locked_until FROM users WHERE id = ?")
      .get("usr_a") as { failed_login_count: number; locked_until: number | null };
    assert.equal(row.failed_login_count, 5);
    assert.ok(row.locked_until && row.locked_until > NOW);
  });

  it("refuses sign-in while locked, even with the CORRECT password", async () => {
    seedUser("usr_a", "a@test.app");
    db()
      .prepare("UPDATE users SET locked_until = ? WHERE id = ?")
      .run(NOW + 10 * 60_000, "usr_a");
    await assert.rejects(() => signIn("a@test.app", GOOD_PW), /locked/i);
  });

  it("resets the failure counter on a successful sign-in", async () => {
    seedUser("usr_a", "a@test.app");
    db().prepare("UPDATE users SET failed_login_count = 3 WHERE id = ?").run("usr_a");
    await signIn("a@test.app", GOOD_PW);
    const row = db()
      .prepare("SELECT failed_login_count, locked_until FROM users WHERE id = ?")
      .get("usr_a") as { failed_login_count: number; locked_until: number | null };
    assert.equal(row.failed_login_count, 0);
    assert.equal(row.locked_until, null);
  });
});

describe("changePassword", () => {
  it("requires the correct current password and a different new one", async () => {
    seedUser("usr_a", "a@test.app");
    await assert.rejects(
      () => changePassword("usr_a", "WrongOld-9Z", "NewPass-9Z1"),
      /incorrect/i,
    );
    await assert.rejects(
      () => changePassword("usr_a", GOOD_PW, GOOD_PW),
      /different/i,
    );
  });

  it("changes the password and invalidates OTHER sessions", async () => {
    seedUser("usr_a", "a@test.app");
    // Two sessions for usr_a; one is "current" (in the cookie jar).
    db()
      .prepare("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
      .run("ses_other", "usr_a", NOW + 1_000_000, NOW);
    db()
      .prepare("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
      .run("ses_current", "usr_a", NOW + 1_000_000, NOW);
    reqCtx.setCookie("a2a_session", "ses_current");

    await changePassword("usr_a", GOOD_PW, "NewPass-9Z1");

    // Other session gone, current kept.
    const remaining = db()
      .prepare("SELECT id FROM sessions WHERE user_id = ?")
      .all("usr_a")
      .map((r) => (r as { id: string }).id);
    assert.deepEqual(remaining, ["ses_current"]);
    // Old password no longer works; new one does.
    reqCtx.reset();
    await assert.rejects(() => signIn("a@test.app", GOOD_PW), /incorrect/i);
    reqCtx.reset();
    assert.equal((await signIn("a@test.app", "NewPass-9Z1")).id, "usr_a");
  });
});

describe("session lifecycle", () => {
  it("getCurrentUser returns null and deletes the row for an expired session", async () => {
    seedUser("usr_a", "a@test.app");
    db()
      .prepare("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
      .run("ses_old", "usr_a", NOW - 1000, NOW - 2000); // already expired
    reqCtx.setCookie("a2a_session", "ses_old");
    assert.equal(await getCurrentUser(), null);
    const gone = db().prepare("SELECT id FROM sessions WHERE id = ?").get("ses_old");
    assert.equal(gone, undefined);
  });

  it("requireUser throws UNAUTHENTICATED with no session", async () => {
    await assert.rejects(() => requireUser(), /UNAUTHENTICATED/);
  });

  it("signOut deletes the session and clears the cookie", async () => {
    seedUser("usr_a", "a@test.app");
    db()
      .prepare("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
      .run("ses_live", "usr_a", NOW + 1_000_000, NOW);
    reqCtx.setCookie("a2a_session", "ses_live");
    await signOut();
    assert.equal(db().prepare("SELECT id FROM sessions WHERE id = ?").get("ses_live"), undefined);
    assert.equal(await getCurrentUser(), null);
  });
});
