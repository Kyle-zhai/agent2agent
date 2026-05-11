import "server-only";
import { db } from "./db";
import { saveAvatarBytes } from "./avatars";
import { logAudit } from "./audit";
import type { User } from "./auth";

export function updateUserDisplayName(userId: string, name: string): void {
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 60) {
    throw new Error("Display name must be 1-60 characters.");
  }
  db()
    .prepare("UPDATE users SET display_name = ? WHERE id = ?")
    .run(trimmed, userId);
}

export function setUserAvatarFromUpload(
  userId: string,
  bytes: Buffer,
  declaredMime: string,
): { mime: string } {
  const result = saveAvatarBytes(`user_${userId}`, bytes, declaredMime);
  db()
    .prepare("UPDATE users SET avatar_blob_path = ? WHERE id = ?")
    .run(result.blob_path, userId);
  logAudit("agent.avatar_update", {
    userId,
    detail: { for: "user", mime: result.mime, size: result.size },
  });
  return { mime: result.mime };
}

export function clearUserAvatar(userId: string): void {
  db()
    .prepare("UPDATE users SET avatar_blob_path = NULL WHERE id = ?")
    .run(userId);
}

export function getUserAvatarPath(userId: string): string | null {
  const row = db()
    .prepare("SELECT avatar_blob_path FROM users WHERE id = ?")
    .get(userId) as { avatar_blob_path: string | null } | undefined;
  return row?.avatar_blob_path ?? null;
}

export function getUserExtended(userId: string): User & {
  avatar_blob_path: string | null;
} {
  const row = db()
    .prepare(
      "SELECT id, email, display_name, avatar_blob_path, created_at FROM users WHERE id = ?",
    )
    .get(userId) as
    | (User & { avatar_blob_path: string | null })
    | undefined;
  if (!row) throw new Error("User not found.");
  return row;
}
