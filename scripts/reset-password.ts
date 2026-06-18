// Operator stopgap for forgotten passwords. There is no mailer in this
// project, so a self-service email reset is out of scope — instead the
// operator resets the password from the shell:
//   npm run reset-password -- <email> <new-password>
// Optionally target another database: A2A_DB_PATH=/path/to.db npm run ...
//
// Like scripts/db-init.ts, this reuses lib/* as the single source of truth
// and runs via tsx with the test tsconfig so the `server-only` and
// `next/headers` imports inside lib resolve to no-op shims outside Next.js:
//   TSX_TSCONFIG_PATH=tsconfig.test.json node --import tsx scripts/reset-password.ts
import { db } from "../lib/db";
import { validatePassword } from "../lib/auth";
import { hashPassword } from "../lib/crypto";
import { logAudit } from "../lib/audit";

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const [email, newPassword] = process.argv.slice(2);
if (!email || !newPassword) {
  fail("Usage: npm run reset-password -- <email> <new-password>");
}

const cleanEmail = email.trim().toLowerCase();
const user = db()
  .prepare("SELECT id, email FROM users WHERE email = ?")
  .get(cleanEmail) as { id: string; email: string } | undefined;
if (!user) {
  fail(`No account found for "${cleanEmail}". Check the email and try again.`);
}

// Same policy as signup — reuse the exported validator from lib/auth.ts.
try {
  validatePassword(newPassword);
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}

// Same scrypt hash+salt as signUp. Also clear the lockout counters so a
// locked-out user can sign in immediately with the new password, and
// invalidate ALL sessions (an operator reset implies the old credential
// may be compromised or lost — no session survives it).
const { hash, salt } = hashPassword(newPassword);
const sessionsInvalidated = db().transaction(() => {
  db()
    .prepare(
      `UPDATE users SET password_hash = ?, password_salt = ?,
         failed_login_count = 0, locked_until = NULL WHERE id = ?`,
    )
    .run(hash, salt, user.id);
  return db().prepare("DELETE FROM sessions WHERE user_id = ?").run(user.id)
    .changes;
})();

logAudit("auth.password_change", {
  userId: user.id,
  detail: { via: "operator_cli", sessions_invalidated: sessionsInvalidated },
});

console.log(`✓ Password reset for ${user.email}.`);
console.log(`✓ ${sessionsInvalidated} active session(s) signed out.`);
console.log("✓ Audit row written (auth.password_change).");
