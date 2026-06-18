import { jsonError } from "@/lib/api-auth";
import { getAgent } from "@/lib/agents";
import { readAvatarBytes } from "@/lib/avatars";

export const dynamic = "force-dynamic";

// Agent ids are slug.purpose.tail shaped (see lib/ids.ts newAgentId) — this
// is the full legal alphabet plus a generous length bound. Anything else
// (path traversal probes, control chars, kilobyte ids, uppercase — ids are
// generated lowercase-only) 404s before any agent or storage lookup runs.
const AGENT_ID_RE = /^[a-z0-9._-]{1,80}$/;

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ agent_id: string }> },
): Promise<Response> {
  const { agent_id } = await ctx.params;
  let id: string;
  try {
    id = decodeURIComponent(agent_id);
  } catch {
    return jsonError(404, "No avatar."); // malformed percent-encoding
  }
  if (!AGENT_ID_RE.test(id)) return jsonError(404, "No avatar.");
  const a = getAgent(id);
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
