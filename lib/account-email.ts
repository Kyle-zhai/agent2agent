import "server-only";
import { randomBytes } from "node:crypto";
import { db } from "./db";
import { newId } from "./ids";
import { sha256Hex, hashPassword } from "./crypto";
import { validatePassword } from "./auth";
import { logAudit } from "./audit";
import { sendEmail } from "./mailer";

// Account email flows — self-serve password reset + email verification.
// Tokens: 132-bit random, emailed in plaintext (in the link), stored only as
// sha256 hashes. One-time (used_at) and short-TTL. Enumeration-safe: the
// request endpoints reveal nothing about whether an email exists.

const RESET_TTL_MS = 60 * 60 * 1000; // 1h
const VERIFY_TTL_MS = 24 * 60 * 60 * 1000; // 24h

function baseUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
}

/** Returns the plaintext token (for the link) after persisting only its hash. */
function mintToken(
  table: "password_reset_tokens" | "email_verification_tokens",
  userId: string,
  ttlMs: number,
): string {
  const token = randomBytes(16).toString("base64url"); // ~132 bits
  const now = Date.now();
  db()
    .prepare(
      `INSERT INTO ${table} (id, user_id, token_hash, created_at, expires_at, used_at)
       VALUES (?, ?, ?, ?, ?, NULL)`,
    )
    .run(newId("tok"), userId, sha256Hex(token), now, now + ttlMs);
  return token;
}

type TokenRow = {
  id: string;
  user_id: string;
  expires_at: number;
  used_at: number | null;
};

/** Look up a still-valid token by its plaintext value, or null. Does NOT
 *  consume it — callers mark it used inside their own transaction. */
function findValidToken(
  table: "password_reset_tokens" | "email_verification_tokens",
  token: string,
): TokenRow | null {
  if (!token) return null;
  const row = db()
    .prepare(
      `SELECT id, user_id, expires_at, used_at FROM ${table} WHERE token_hash = ?`,
    )
    .get(sha256Hex(token)) as TokenRow | undefined;
  if (!row) return null;
  if (row.used_at != null) return null;
  if (row.expires_at < Date.now()) return null;
  return row;
}

// --- Password reset ----------------------------------------------------------

/** Always returns void with the same observable behavior whether or not the
 *  email exists (anti-enumeration). If it does, mint a token + email a link.
 *  Mail delivery is best-effort — a send failure is logged, never surfaced. */
export async function requestPasswordReset(
  email: string,
  ctx?: { ip?: string | null; userAgent?: string | null },
): Promise<void> {
  const clean = email.trim().toLowerCase();
  const user = db()
    .prepare("SELECT id, email FROM users WHERE email = ?")
    .get(clean) as { id: string; email: string } | undefined;
  if (!user) {
    // No token, no email — but the caller shows the same generic success.
    logAudit("auth.password_reset_request", {
      ip: ctx?.ip ?? null,
      userAgent: ctx?.userAgent ?? null,
      detail: { outcome: "no_user" },
    });
    return;
  }
  const token = mintToken("password_reset_tokens", user.id, RESET_TTL_MS);
  const link = `${baseUrl()}/reset?token=${encodeURIComponent(token)}`;
  await sendEmail({
    to: user.email,
    subject: "Reset your Agent2Agent password",
    text:
      `Someone (hopefully you) asked to reset the password for your ` +
      `Agent2Agent account.\n\nOpen this link to set a new password ` +
      `(valid for 1 hour):\n\n${link}\n\n` +
      `If you didn't request this, you can ignore this email — nothing changes.`,
  });
  logAudit("auth.password_reset_request", {
    userId: user.id,
    ip: ctx?.ip ?? null,
    userAgent: ctx?.userAgent ?? null,
    detail: { outcome: "sent" },
  });
}

/** Consume a reset token and set a new password. Invalidates ALL of the
 *  user's sessions (a reset implies the old credential may be compromised).
 *  Throws on invalid/expired/used token or weak password. */
export function resetPassword(token: string, newPassword: string): void {
  const row = findValidToken("password_reset_tokens", token);
  if (!row) {
    throw new Error("This reset link is invalid or has expired. Request a new one.");
  }
  validatePassword(newPassword); // same policy as signup
  const { hash, salt } = hashPassword(newPassword);
  const tx = db().transaction(() => {
    // Race-safe single-use: only proceed if still unused.
    const claim = db()
      .prepare(
        "UPDATE password_reset_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL",
      )
      .run(Date.now(), row.id);
    if (claim.changes === 0) {
      throw new Error("This reset link was already used. Request a new one.");
    }
    db()
      .prepare(
        "UPDATE users SET password_hash = ?, password_salt = ?, failed_login_count = 0, locked_until = NULL WHERE id = ?",
      )
      .run(hash, salt, row.user_id);
    // Invalidate every session — old logins must not survive a reset.
    db().prepare("DELETE FROM sessions WHERE user_id = ?").run(row.user_id);
    // Burn any other outstanding reset tokens for this user.
    db()
      .prepare(
        "UPDATE password_reset_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL",
      )
      .run(Date.now(), row.user_id);
  });
  tx();
  logAudit("auth.password_reset", { userId: row.user_id });
}

// --- Email verification ------------------------------------------------------

/** Mint + email a verification link. Best-effort; safe to call on signup and
 *  to re-trigger from settings. No-op observable difference if already
 *  verified (still sends — harmless). */
export async function requestEmailVerification(
  userId: string,
  email: string,
): Promise<void> {
  const token = mintToken("email_verification_tokens", userId, VERIFY_TTL_MS);
  const link = `${baseUrl()}/verify-email?token=${encodeURIComponent(token)}`;
  await sendEmail({
    to: email,
    subject: "Verify your Agent2Agent email",
    text:
      `Welcome to Agent2Agent! Confirm this email address by opening the ` +
      `link below (valid for 24 hours):\n\n${link}\n\n` +
      `If you didn't sign up, you can ignore this email.`,
  });
  logAudit("auth.email_verify_request", { userId });
}

/** Consume a verification token and mark the user's email verified. Returns
 *  the user id on success; throws on invalid/expired/used token. */
export function verifyEmail(token: string): string {
  const row = findValidToken("email_verification_tokens", token);
  if (!row) {
    throw new Error("This verification link is invalid or has expired.");
  }
  const tx = db().transaction(() => {
    const claim = db()
      .prepare(
        "UPDATE email_verification_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL",
      )
      .run(Date.now(), row.id);
    if (claim.changes === 0) {
      throw new Error("This verification link was already used.");
    }
    db()
      .prepare("UPDATE users SET email_verified_at = ? WHERE id = ?")
      .run(Date.now(), row.user_id);
  });
  tx();
  logAudit("auth.email_verified", { userId: row.user_id });
  return row.user_id;
}

export function isEmailVerified(userId: string): boolean {
  const row = db()
    .prepare("SELECT email_verified_at FROM users WHERE id = ?")
    .get(userId) as { email_verified_at: number | null } | undefined;
  return !!row?.email_verified_at;
}

/** Opt-in gate: only meaningful when A2A_REQUIRE_EMAIL_VERIFICATION=1. */
export function emailVerificationRequired(): boolean {
  return process.env.A2A_REQUIRE_EMAIL_VERIFICATION === "1";
}
