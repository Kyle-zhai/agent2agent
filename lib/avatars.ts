import "server-only";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { db } from "./db";
import { customAlphabet } from "nanoid";
import { validateFileBytes, isAllowedAvatarMime } from "./file-validation";
import { logAudit } from "./audit";
import { getAgentOwnedBy } from "./agents";

const AVATAR_DIR = join(process.cwd(), "blobs", "avatars");
if (!existsSync(AVATAR_DIR)) mkdirSync(AVATAR_DIR, { recursive: true });

const aid = customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 10);

export const MAX_AVATAR_BYTES = 1 * 1024 * 1024;

export type AvatarSaveResult = {
  blob_path: string;
  size: number;
  mime: string;
};

export function saveAvatarBytes(
  ownerKey: string,
  bytes: Buffer,
  declaredMime: string,
): AvatarSaveResult {
  const validated = validateFileBytes(bytes, MAX_AVATAR_BYTES, declaredMime);
  if (validated.oversized) {
    throw new Error("Avatar exceeds 1 MB.");
  }
  const mime = validated.detectedMime ?? declaredMime;
  if (!isAllowedAvatarMime(mime)) {
    throw new Error("Avatar must be PNG, JPEG, or WebP.");
  }
  const ext = mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : "png";
  const filename = `${ownerKey.replace(/[^a-zA-Z0-9._-]/g, "_")}_${aid()}.${ext}`;
  const blobPath = join("avatars", filename);
  writeFileSync(join(process.cwd(), "blobs", blobPath), bytes);
  return { blob_path: blobPath, size: bytes.length, mime };
}

export function readAvatarBytes(blobPath: string): Buffer {
  return readFileSync(join(process.cwd(), "blobs", blobPath));
}

export function setAgentAvatarFromUpload(
  agentId: string,
  userId: string,
  bytes: Buffer,
  declaredMime: string,
): { mime: string } {
  const a = getAgentOwnedBy(agentId, userId);
  if (!a) throw new Error("Agent not found.");
  const result = saveAvatarBytes(`agent_${agentId}`, bytes, declaredMime);
  const info = db()
    .prepare("UPDATE agents SET avatar_blob_path = ? WHERE id = ?")
    .run(result.blob_path, agentId);
  if (info.changes === 0) {
    // Agent was deleted in the gap between the ownership check and the
    // UPDATE. The blob is now orphaned on disk; leave it for a future GC.
    throw new Error("Agent disappeared mid-upload.");
  }
  logAudit("agent.avatar_update", {
    userId,
    agentId,
    detail: { mime: result.mime, size: result.size },
  });
  return { mime: result.mime };
}

export function clearAgentAvatar(agentId: string, userId: string): void {
  const a = getAgentOwnedBy(agentId, userId);
  if (!a) throw new Error("Agent not found.");
  db()
    .prepare("UPDATE agents SET avatar_blob_path = NULL WHERE id = ?")
    .run(agentId);
}
