import "server-only";
import { cookies, headers } from "next/headers";
import { db } from "./db";
import { newSessionId, newUserId } from "./ids";
import { hashPassword, verifyPassword } from "./crypto";
import { consume, RATE_LIMITS } from "./rate-limit";
import { logAudit } from "./audit";

const COOKIE_NAME = "a2a_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 min

async function clientFingerprint(): Promise<{ ip: string | null; ua: string | null }> {
  const h = await headers();
  const ip =
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    h.get("x-real-ip") ||
    null;
  return { ip, ua: h.get("user-agent") };
}

/** Clamp a post-auth `?next=` redirect to a SAME-ORIGIN relative path, so
 *  `/sign-in?next=https://evil.com` can't bounce a user off-site after login
 *  (open redirect). Mirrors safeNext() in the OAuth callback: must start with
 *  a single "/" and not "//" or "/\". Anything else → "/app". */
export function safeNextPath(next: string | undefined): string {
  return next && /^\/(?![/\\])/.test(next) ? next : "/app";
}

// Exported so scripts/reset-password.ts enforces the exact same policy.
export function validatePassword(p: string): void {
  if (p.length < 10) {
    throw new Error("Password must be at least 10 characters.");
  }
  let classes = 0;
  if (/[a-z]/.test(p)) classes++;
  if (/[A-Z]/.test(p)) classes++;
  if (/[0-9]/.test(p)) classes++;
  if (/[^A-Za-z0-9]/.test(p)) classes++;
  if (classes < 3) {
    throw new Error(
      "Password must include at least 3 of: lowercase, uppercase, digit, symbol.",
    );
  }
  if (/(.)\1\1\1/.test(p)) {
    throw new Error("Password contains a too-repetitive sequence.");
  }
}

export type User = {
  id: string;
  email: string;
  display_name: string;
  created_at: number;
};

type UserRow = User & { password_hash: string; password_salt: string };

export async function signUp(
  email: string,
  password: string,
  displayName: string,
): Promise<User> {
  const fp = await clientFingerprint();
  const rl = consume(`signup:ip:${fp.ip ?? "anon"}`, RATE_LIMITS.signup);
  // Global cap a spoofed x-forwarded-for can't rotate around (constant key).
  const rlGlobal = consume("signup:global", RATE_LIMITS.signupGlobal);
  if (!rl.allowed || !rlGlobal.allowed) {
    const r = !rlGlobal.allowed ? rlGlobal : rl;
    logAudit("rate_limit.exceeded", {
      ip: fp.ip,
      userAgent: fp.ua,
      detail: { route: "signup", scope: !rlGlobal.allowed ? "global" : "ip" },
    });
    throw new Error(
      `Too many sign-up attempts. Try again in ${r.retryAfterSeconds}s.`,
    );
  }
  const cleanEmail = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    throw new Error("Invalid email.");
  }
  validatePassword(password);
  const name = displayName.trim();
  if (name.length < 1 || name.length > 60) {
    throw new Error("Display name must be 1-60 characters.");
  }
  const existing = db()
    .prepare("SELECT id FROM users WHERE email = ?")
    .get(cleanEmail);
  if (existing) {
    // Generic message to avoid email enumeration.
    throw new Error("Could not create account. Try a different email.");
  }

  const { hash, salt } = hashPassword(password);
  const user: User = {
    id: newUserId(),
    email: cleanEmail,
    display_name: name,
    created_at: Date.now(),
  };
  db()
    .prepare(
      `INSERT INTO users (id, email, display_name, password_hash, password_salt, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(user.id, user.email, user.display_name, hash, salt, user.created_at);
  await createSession(user.id);
  logAudit("auth.signup", { userId: user.id, ip: fp.ip, userAgent: fp.ua });
  return user;
}

export async function signIn(email: string, password: string): Promise<User> {
  const fp = await clientFingerprint();
  const rl = consume(`signin:ip:${fp.ip ?? "anon"}`, RATE_LIMITS.signin);
  // Global cap a spoofed x-forwarded-for can't rotate around. (signin also has
  // per-account lockout below; this just bounds total attempt volume.)
  const rlGlobal = consume("signin:global", RATE_LIMITS.signinGlobal);
  if (!rl.allowed || !rlGlobal.allowed) {
    const r = !rlGlobal.allowed ? rlGlobal : rl;
    logAudit("rate_limit.exceeded", {
      ip: fp.ip,
      userAgent: fp.ua,
      detail: { route: "signin", scope: !rlGlobal.allowed ? "global" : "ip" },
    });
    throw new Error(
      `Too many sign-in attempts. Try again in ${r.retryAfterSeconds}s.`,
    );
  }
  const cleanEmail = email.trim().toLowerCase();
  const row = db()
    .prepare("SELECT * FROM users WHERE email = ?")
    .get(cleanEmail) as
    | (UserRow & { failed_login_count: number; locked_until: number | null })
    | undefined;
  // Constant-ish timing path: always verify with a placeholder hash if user missing.
  if (!row) {
    verifyPassword(
      password,
      "0".repeat(128),
      "0".repeat(32),
    );
    logAudit("auth.signin_fail", {
      ip: fp.ip,
      userAgent: fp.ua,
      detail: { reason: "no_user" },
    });
    throw new Error("Email or password is incorrect.");
  }
  if (row.locked_until && row.locked_until > Date.now()) {
    const sec = Math.ceil((row.locked_until - Date.now()) / 1000);
    logAudit("auth.signin_fail", {
      userId: row.id,
      ip: fp.ip,
      userAgent: fp.ua,
      detail: { reason: "locked" },
    });
    throw new Error(`Account temporarily locked. Try again in ${sec}s.`);
  }
  const ok = verifyPassword(password, row.password_hash, row.password_salt);
  if (!ok) {
    const newCount = (row.failed_login_count ?? 0) + 1;
    const lock =
      newCount >= LOCKOUT_THRESHOLD
        ? Date.now() + LOCKOUT_DURATION_MS
        : null;
    db()
      .prepare(
        `UPDATE users SET failed_login_count = ?, locked_until = ? WHERE id = ?`,
      )
      .run(newCount, lock, row.id);
    if (lock) {
      logAudit("auth.lockout", {
        userId: row.id,
        ip: fp.ip,
        userAgent: fp.ua,
        detail: { until: lock },
      });
    } else {
      logAudit("auth.signin_fail", {
        userId: row.id,
        ip: fp.ip,
        userAgent: fp.ua,
      });
    }
    throw new Error("Email or password is incorrect.");
  }
  // Success: reset counters.
  db()
    .prepare(
      `UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = ?`,
    )
    .run(row.id);
  await createSession(row.id);
  logAudit("auth.signin", { userId: row.id, ip: fp.ip, userAgent: fp.ua });
  return {
    id: row.id,
    email: row.email,
    display_name: row.display_name,
    created_at: row.created_at,
  };
}

export async function changePassword(
  userId: string,
  oldPassword: string,
  newPassword: string,
): Promise<void> {
  const fp = await clientFingerprint();
  const row = db()
    .prepare("SELECT password_hash, password_salt FROM users WHERE id = ?")
    .get(userId) as
    | { password_hash: string; password_salt: string }
    | undefined;
  if (!row) throw new Error("User not found.");
  if (!verifyPassword(oldPassword, row.password_hash, row.password_salt)) {
    logAudit("auth.password_change_fail", {
      userId,
      ip: fp.ip,
      userAgent: fp.ua,
      detail: { reason: "old_password_incorrect" },
    });
    throw new Error("Current password is incorrect.");
  }
  validatePassword(newPassword);
  if (oldPassword === newPassword) {
    throw new Error("New password must be different from the old one.");
  }
  const { hash, salt } = hashPassword(newPassword);
  db()
    .prepare(
      "UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?",
    )
    .run(hash, salt, userId);
  // Invalidate other sessions; keep current.
  const jar = await cookies();
  const currentSid = jar.get(COOKIE_NAME)?.value;
  if (currentSid) {
    db()
      .prepare("DELETE FROM sessions WHERE user_id = ? AND id != ?")
      .run(userId, currentSid);
  }
  logAudit("auth.password_change", {
    userId,
    ip: fp.ip,
    userAgent: fp.ua,
  });
}

export async function signOut(): Promise<void> {
  const jar = await cookies();
  const sid = jar.get(COOKIE_NAME)?.value;
  if (sid) {
    const session = db()
      .prepare("SELECT user_id FROM sessions WHERE id = ?")
      .get(sid) as { user_id: string } | undefined;
    db().prepare("DELETE FROM sessions WHERE id = ?").run(sid);
    if (session) {
      const fp = await clientFingerprint();
      logAudit("auth.signout", {
        userId: session.user_id,
        ip: fp.ip,
        userAgent: fp.ua,
      });
    }
  }
  jar.delete(COOKIE_NAME);
}

export async function getCurrentUser(): Promise<User | null> {
  const jar = await cookies();
  const sid = jar.get(COOKIE_NAME)?.value;
  if (!sid) return null;
  const row = db()
    .prepare(
      `SELECT u.id, u.email, u.display_name, u.created_at, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
    )
    .get(sid) as
    | (User & { expires_at: number })
    | undefined;
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db().prepare("DELETE FROM sessions WHERE id = ?").run(sid);
    return null;
  }
  return {
    id: row.id,
    email: row.email,
    display_name: row.display_name,
    created_at: row.created_at,
  };
}

export async function requireUser(): Promise<User> {
  const user = await getCurrentUser();
  if (!user) throw new Error("UNAUTHENTICATED");
  return user;
}

export async function createSession(userId: string): Promise<void> {
  const id = newSessionId();
  const now = Date.now();
  db()
    .prepare(
      `INSERT INTO sessions (id, user_id, expires_at, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(id, userId, now + SESSION_TTL_MS, now);
  const jar = await cookies();
  jar.set(COOKIE_NAME, id, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
    secure: process.env.NODE_ENV === "production",
  });
}
