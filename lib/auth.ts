import "server-only";
import { cookies } from "next/headers";
import { db } from "./db";
import { newSessionId, newUserId } from "./ids";
import { hashPassword, verifyPassword } from "./crypto";

const COOKIE_NAME = "a2a_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

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
  const cleanEmail = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    throw new Error("Invalid email.");
  }
  if (password.length < 8) {
    throw new Error("Password must be at least 8 characters.");
  }
  const name = displayName.trim();
  if (name.length < 1 || name.length > 60) {
    throw new Error("Display name must be 1-60 characters.");
  }
  const existing = db()
    .prepare("SELECT id FROM users WHERE email = ?")
    .get(cleanEmail);
  if (existing) throw new Error("This email is already registered.");

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
  return user;
}

export async function signIn(email: string, password: string): Promise<User> {
  const row = db()
    .prepare("SELECT * FROM users WHERE email = ?")
    .get(email.trim().toLowerCase()) as UserRow | undefined;
  if (!row) throw new Error("Email or password is incorrect.");
  if (!verifyPassword(password, row.password_hash, row.password_salt)) {
    throw new Error("Email or password is incorrect.");
  }
  await createSession(row.id);
  return {
    id: row.id,
    email: row.email,
    display_name: row.display_name,
    created_at: row.created_at,
  };
}

export async function signOut(): Promise<void> {
  const jar = await cookies();
  const sid = jar.get(COOKIE_NAME)?.value;
  if (sid) {
    db().prepare("DELETE FROM sessions WHERE id = ?").run(sid);
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

async function createSession(userId: string): Promise<void> {
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
