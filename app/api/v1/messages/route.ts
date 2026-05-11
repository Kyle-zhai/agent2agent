import {
  authenticateRequest,
  jsonError,
  jsonOk,
} from "@/lib/api-auth";
import {
  saveAttachment,
  saveContextNote,
  sendMessage,
} from "@/lib/conversations";

export const dynamic = "force-dynamic";

type SendBody = {
  conversation_id?: string;
  text?: string;
  attachments?: Array<{
    filename: string;
    mime_type?: string;
    base64: string;
  }>;
  context_note?: {
    title: string;
    markdown: string;
    frontmatter?: Record<string, unknown>;
  };
};

export async function POST(req: Request): Promise<Response> {
  const auth = authenticateRequest(req);
  if (!auth.ok) return jsonError(auth.status, auth.error);

  let body: SendBody;
  try {
    body = (await req.json()) as SendBody;
  } catch {
    return jsonError(400, "Invalid JSON body.");
  }
  const conversationId = body.conversation_id;
  if (!conversationId) {
    return jsonError(400, "conversation_id is required.");
  }

  const attachmentIds: string[] = [];
  for (const att of body.attachments ?? []) {
    if (!att.filename || !att.base64) {
      return jsonError(400, "attachment requires filename and base64.");
    }
    let bytes: Buffer;
    try {
      bytes = Buffer.from(att.base64, "base64");
    } catch {
      return jsonError(400, `Invalid base64 for attachment ${att.filename}.`);
    }
    if (bytes.length > 25 * 1024 * 1024) {
      return jsonError(413, `Attachment ${att.filename} > 25 MB.`);
    }
    const saved = saveAttachment(auth.agent.id, {
      filename: att.filename,
      mime_type: att.mime_type ?? "application/octet-stream",
      bytes,
    });
    attachmentIds.push(saved.id);
  }

  let contextNoteId: string | null = null;
  if (body.context_note) {
    if (!body.context_note.title || !body.context_note.markdown) {
      return jsonError(400, "context_note requires title and markdown.");
    }
    const cn = saveContextNote(conversationId, auth.agent.id, {
      title: body.context_note.title,
      markdown: body.context_note.markdown,
      frontmatter: body.context_note.frontmatter,
    });
    contextNoteId = cn.id;
  }

  try {
    const m = sendMessage(conversationId, auth.agent.id, {
      text: body.text,
      attachment_ids: attachmentIds,
      context_note_id: contextNoteId,
    });
    return jsonOk({
      id: m.id,
      conversation_id: m.conversation_id,
      created_at: m.created_at,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Send failed.";
    return jsonError(400, msg);
  }
}
