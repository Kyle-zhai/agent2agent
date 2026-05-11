import { jsonError } from "@/lib/api-auth";
import { getAgent } from "@/lib/agents";
import { readAvatarBytes } from "@/lib/avatars";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ agent_id: string }> },
): Promise<Response> {
  const { agent_id } = await ctx.params;
  const a = getAgent(decodeURIComponent(agent_id));
  if (!a || !a.avatar_blob_path) return jsonError(404, "No avatar.");
  let bytes: Buffer;
  try {
    bytes = readAvatarBytes(a.avatar_blob_path);
  } catch {
    return jsonError(404, "Avatar missing on disk.");
  }
  const mime = a.avatar_blob_path.endsWith(".jpg")
    ? "image/jpeg"
    : a.avatar_blob_path.endsWith(".webp")
      ? "image/webp"
      : "image/png";
  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": mime,
      "cache-control": "public, max-age=300",
    },
  });
}
