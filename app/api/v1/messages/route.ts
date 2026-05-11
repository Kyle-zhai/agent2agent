import {
  authenticateRequest,
  jsonError,
  jsonOk,
} from "@/lib/api-auth";
import {
  saveAttachment,
  saveContextNote,
  sendMessage,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
} from "@/lib/conversations";
import { consume, RATE_LIMITS, agentKey, rateLimitResponse } from "@/lib/rate-limit";
import { logAudit, ipFromRequest, uaFromRequest } from "@/lib/audit";
import type { MessageKind } from "@/lib/types";

export const dynamic = "force-dynamic";

type SendBody = {
  conversation_id?: string;
  text?: string;
  thinking?: string;
  kind?: MessageKind;
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

  const rl = consume(agentKey(auth.agent.id, "msg"), RATE_LIMITS.apiMessage);
  if (!rl.allowed) {
    logAudit("rate_limit.exceeded", {
      agentId: auth.agent.id,
      ip: ipFromRequest(req),
      userAgent: uaFromRequest(req),
      detail: { route: "messages.post" },
    });
    return rateLimitResponse(rl);
  }

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
  const attachments = body.attachments ?? [];
  if (attachments.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    return jsonError(
      400,
      `Max ${MAX_ATTACHMENTS_PER_MESSAGE} attachments per message.`,
    );
  }

  const attachmentIds: string[] = [];
  for (const att of attachments) {
    if (!att.filename || !att.base64) {
      return jsonError(400, "attachment requires filename and base64.");
    }
    let bytes: Buffer;
    try {
      bytes = Buffer.from(att.base64, "base64");
    } catch {
      return jsonError(400, `Invalid base64 for attachment ${att.filename}.`);
    }
    if (bytes.length > MAX_ATTACHMENT_BYTES) {
      return jsonError(413, `Attachment ${att.filename} > 25 MB.`);
    }
    try {
      const saved = saveAttachment(auth.agent.id, {
        filename: att.filename,
        mime_type: att.mime_type ?? "application/octet-stream",
        bytes,
      });
      attachmentIds.push(saved.id);
    } catch (err) {
      return jsonError(400, err instanceof Error ? err.message : "Save failed.");
    }
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
      thinking: body.thinking,
      kind: body.kind,
      attachment_ids: attachmentIds,
      context_note_id: contextNoteId,
    });
    logAudit("message.send", {
      agentId: auth.agent.id,
      detail: {
        conversation_id: conversationId,
        kind: body.kind ?? "normal",
        attachments: attachmentIds.length,
        has_context_note: !!contextNoteId,
        has_thinking: !!body.thinking,
      },
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
