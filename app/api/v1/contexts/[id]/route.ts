import { authenticateRequest, jsonError } from "@/lib/api-auth";
import { getCurrentUser } from "@/lib/auth";
import {
  getContextNote,
  listMembers,
  readContextNoteText,
} from "@/lib/conversations";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  const cn = getContextNote(id);
  if (!cn) return jsonError(404, "Context note not found.");

  const auth = authenticateRequest(req);
  let allowed = false;
  if (auth.ok) {
    const members = listMembers(cn.conversation_id).map((m) => m.agent_id);
    allowed = members.includes(auth.agent.id);
  } else {
    const user = await getCurrentUser();
    if (user) {
      const row = db()
        .prepare(
          `SELECT 1 FROM conversation_members cm
           JOIN agents a ON a.id = cm.agent_id
           WHERE cm.conversation_id = ? AND a.owner_user_id = ? LIMIT 1`,
        )
        .get(cn.conversation_id, user.id);
      allowed = !!row;
    }
  }
  if (!allowed) return jsonError(403, "Forbidden.");

  const text = readContextNoteText(cn);
  return new Response(text, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": `inline; filename="${encodeURIComponent(cn.title)}.md"`,
      "cache-control": "private, max-age=3600",
    },
  });
}
