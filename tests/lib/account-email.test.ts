import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestDb, teardownTestDb, resetTables } from "../helpers/setup";
import { _resetDbForTests, db } from "../../lib/db";
import { signUp, signIn } from "../../lib/auth";
import {
  requestPasswordReset,
  resetPassword,
  requestEmailVerification,
  verifyEmail,
  isEmailVerified,
} from "../../lib/account-email";
import { runMaintenanceSweep } from "../../lib/maintenance";
import { _sentForTests } from "../../lib/mailer";

// Email capability — self-serve password reset + email verification, on the
// zero-dep console mailer (captured via _sentForTests).

before(() => {
  setupTestDb();
  _resetDbForTests();
  process.env.MAIL_PROVIDER = "console";
});
after(() => {
  _resetDbForTests();
  teardownTestDb();
  delete process.env.MAIL_PROVIDER;
});
beforeEach(() => {
  resetTables(db());
  _sentForTests.length = 0;
});

// signUp/signIn read cookies via next/headers; the test shim makes that a
// no-op store, so they work without a request. Seed a user the direct way
// where we only need the row.
function seedUser(email: string, password: string) {
  // Use the real signUp so the password hash is correct for later signIn.
  return signUp(email, password, "Tester");
}

const PW = "Passw0rd-Tester!";
const NEW_PW = "Newpassw0rd-9!";

describe("password reset", () => {
  it("mints a token, emails a link, and lets the user set a new password", async () => {
    const u = await seedUser("alice@t.test", PW);
    _sentForTests.length = 0; // drop the signup verification email

    await requestPasswordReset("alice@t.test");
    assert.equal(_sentForTests.length, 1, "one reset email sent");
    const mail = _sentForTests[0];
    assert.equal(mail.to, "alice@t.test");
    const m = mail.text.match(/\/reset\?token=([^\s]+)/);
    assert.ok(m, "email contains a reset link with a token");
    const token = decodeURIComponent(m![1]);

    resetPassword(token, NEW_PW);
    // old password no longer works, new one does
    assert.rejects(() => signIn("alice@t.test", PW));
    const back = await signIn("alice@t.test", NEW_PW);
    assert.equal(back.id, u.id);
  });

  it("is enumeration-safe: unknown email sends nothing and does not throw", async () => {
    await requestPasswordReset("nobody@t.test");
    assert.equal(_sentForTests.length, 0, "no email for an unknown address");
    assert.equal(
      (db().prepare("SELECT COUNT(*) AS n FROM password_reset_tokens").get() as { n: number }).n,
      0,
    );
  });

  it("rejects an invalid, expired, or reused token", async () => {
    await seedUser("bob@t.test", PW);
    _sentForTests.length = 0;
    await requestPasswordReset("bob@t.test");
    const token = decodeURIComponent(
      _sentForTests[0].text.match(/\/reset\?token=([^\s]+)/)![1],
    );

    assert.throws(() => resetPassword("garbage-token", NEW_PW), /invalid or has expired/);

    // expire it
    db().prepare("UPDATE password_reset_tokens SET expires_at = ?").run(Date.now() - 1000);
    assert.throws(() => resetPassword(token, NEW_PW), /invalid or has expired/);

    // un-expire, use once, then reuse must fail
    db().prepare("UPDATE password_reset_tokens SET expires_at = ?, used_at = NULL").run(Date.now() + 60_000);
    resetPassword(token, NEW_PW);
    assert.throws(() => resetPassword(token, NEW_PW), /invalid|already used/);
  });

  it("a reset invalidates all of the user's existing sessions", async () => {
    const u = await seedUser("carol@t.test", PW);
    // two live sessions
    db().prepare("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES ('s1', ?, ?, ?)").run(u.id, Date.now() + 1e9, Date.now());
    db().prepare("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES ('s2', ?, ?, ?)").run(u.id, Date.now() + 1e9, Date.now());
    _sentForTests.length = 0;
    await requestPasswordReset("carol@t.test");
    const token = decodeURIComponent(
      _sentForTests[0].text.match(/\/reset\?token=([^\s]+)/)![1],
    );
    resetPassword(token, NEW_PW);
    const left = db().prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?").get(u.id) as { n: number };
    assert.equal(left.n, 0, "all sessions cleared after reset");
  });

  it("enforces the password policy on reset", async () => {
    await seedUser("dave@t.test", PW);
    _sentForTests.length = 0;
    await requestPasswordReset("dave@t.test");
    const token = decodeURIComponent(
      _sentForTests[0].text.match(/\/reset\?token=([^\s]+)/)![1],
    );
    assert.throws(() => resetPassword(token, "weak"));
  });
});

describe("email verification", () => {
  it("signup-style mint → verify marks the email verified; reuse fails", async () => {
    const u = await seedUser("erin@t.test", PW);
    assert.equal(isEmailVerified(u.id), false);
    _sentForTests.length = 0;
    await requestEmailVerification(u.id, "erin@t.test");
    const token = decodeURIComponent(
      _sentForTests[0].text.match(/\/verify-email\?token=([^\s]+)/)![1],
    );
    const vid = verifyEmail(token);
    assert.equal(vid, u.id);
    assert.equal(isEmailVerified(u.id), true);
    // A consumed token is rejected (single-threaded: it reads as no-longer-valid).
    assert.throws(() => verifyEmail(token), /invalid or has expired|already used/);
  });

  it("rejects a bad verification token", () => {
    assert.throws(() => verifyEmail("nope"), /invalid or has expired/);
  });
});

describe("maintenance sweep", () => {
  it("drops expired account-email tokens", async () => {
    const u = await seedUser("frank@t.test", PW);
    await requestPasswordReset("frank@t.test");
    await requestEmailVerification(u.id, "frank@t.test");
    // expire both
    db().prepare("UPDATE password_reset_tokens SET expires_at = ?").run(Date.now() - 1);
    db().prepare("UPDATE email_verification_tokens SET expires_at = ?").run(Date.now() - 1);
    const res = runMaintenanceSweep();
    assert.ok(res.accountEmailTokens >= 2, "swept both expired tokens");
    assert.equal((db().prepare("SELECT COUNT(*) AS n FROM password_reset_tokens").get() as { n: number }).n, 0);
    assert.equal((db().prepare("SELECT COUNT(*) AS n FROM email_verification_tokens").get() as { n: number }).n, 0);
  });
});
