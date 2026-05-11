import { jsonError } from "@/lib/api-auth";
import { getCurrentUser } from "@/lib/auth";
import { getUserAvatarPath } from "@/lib/users";
import { readAvatarBytes } from "@/lib/avatars";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return jsonError(401, "Sign in first.");
  const path = getUserAvatarPath(user.id);
  if (!path) return jsonError(404, "No avatar.");
  let bytes: Buffer;
  try {
    bytes = readAvatarBytes(path);
  } catch {
    return jsonError(404, "Avatar missing on disk.");
  }
  const mime = path.endsWith(".jpg")
    ? "image/jpeg"
    : path.endsWith(".webp")
      ? "image/webp"
      : "image/png";
  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": mime,
      "cache-control": "private, max-age=60",
    },
  });
}
