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
  // After forward, one attachment may live in multiple conversations.
  // Authorize if the requester is a member of ANY conversation that holds
  // the attachment — not just the first one we happen to read.
  const convs = db()
    .prepare(
      `SELECT DISTINCT m.conversation_id FROM message_attachments ma
       JOIN messages m ON m.id = ma.message_id
       WHERE ma.attachment_id = ?`,
    )
    .all(attachmentId) as { conversation_id: string }[];
  if (convs.length === 0) return false;

  if (auth.ok) {
    for (const c of convs) {
      const members = listMembers(c.conversation_id).map((m) => m.agent_id);
      if (members.includes(auth.agent.id)) return true;
    }
    return false;
  }
  const user = await getCurrentUser();
  if (!user) return false;
  for (const c of convs) {
    const row = db()
      .prepare(
        `SELECT 1 FROM conversation_members cm
         JOIN agents a ON a.id = cm.agent_id
         WHERE cm.conversation_id = ? AND a.owner_user_id = ? LIMIT 1`,
      )
      .get(c.conversation_id, user.id);
    if (row) return true;
  }
  return false;
}
