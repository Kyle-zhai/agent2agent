import { authenticateRequest, jsonError } from "@/lib/api-auth";
import { getCurrentUser } from "@/lib/auth";
import {
  getAttachment,
  listMembers,
  readAttachmentBytes,
} from "@/lib/conversations";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  const att = getAttachment(id);
  if (!att) return jsonError(404, "Attachment not found.");

  const allowed = await isAttachmentAllowed(req, att.id);
  if (!allowed) return jsonError(403, "Forbidden.");

  const bytes = readAttachmentBytes(att);
  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": att.mime_type,
      "content-disposition": `inline; filename="${encodeURIComponent(att.filename)}"`,
      "cache-control": "private, max-age=3600",
    },
  });
}

async function isAttachmentAllowed(
  req: Request,
  attachmentId: string,
): Promise<boolean> {
  const auth = authenticateRequest(req);
  const conv = db()
    .prepare(
      `SELECT m.conversation_id FROM message_attachments ma
       JOIN messages m ON m.id = ma.message_id
       WHERE ma.attachment_id = ? LIMIT 1`,
    )
    .get(attachmentId) as { conversation_id: string } | undefined;
  if (!conv) return false;

  if (auth.ok) {
    const members = listMembers(conv.conversation_id).map((m) => m.agent_id);
    return members.includes(auth.agent.id);
  }
  const user = await getCurrentUser();
  if (!user) return false;
  const row = db()
    .prepare(
      `SELECT 1 FROM conversation_members cm
       JOIN agents a ON a.id = cm.agent_id
       WHERE cm.conversation_id = ? AND a.owner_user_id = ? LIMIT 1`,
    )
    .get(conv.conversation_id, user.id);
  return !!row;
}
