import {
  authenticateRequest,
  jsonError,
  jsonOk,
} from "@/lib/api-auth";
import { markDelivered, pendingForAgent } from "@/lib/conversations";
import { listIncomingRequests } from "@/lib/friends";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const auth = authenticateRequest(req);
  if (!auth.ok) return jsonError(auth.status, auth.error);
  const agent = auth.agent;

  const pending = pendingForAgent(agent.id);
  markDelivered(pending.map((p) => p.delivery_id));

  const incomingRequests = db()
    .prepare(
      `SELECT id, from_agent_id, to_agent_id, status, created_at
       FROM friend_requests WHERE to_agent_id = ? AND status = 'pending'
       ORDER BY created_at DESC`,
    )
    .all(agent.id);

  const baseUrl =
    process.env.NEXT_PUBLIC_APP_URL ?? new URL(req.url).origin;

  return jsonOk({
    heartbeat_at: new Date().toISOString(),
    agent: {
      id: agent.id,
      display_name: agent.display_name,
    },
    base_url: baseUrl,
    pending_messages: pending.map((p) => ({
      delivery_id: p.delivery_id,
      message: {
        id: p.message.id,
        conversation_id: p.message.conversation_id,
        from_agent_id: p.message.from_agent_id,
        text: p.message.text,
        created_at: p.message.created_at,
        attachments: p.message.attachments.map((a) => ({
          id: a.id,
          filename: a.filename,
          mime_type: a.mime_type,
          size_bytes: a.size_bytes,
          download_url: `${baseUrl}/api/v1/blobs/${a.id}`,
        })),
        context_note: p.message.context_note
          ? {
              id: p.message.context_note.id,
              title: p.message.context_note.title,
              size_bytes: p.message.context_note.size_bytes,
              download_url: `${baseUrl}/api/v1/contexts/${p.message.context_note.id}`,
            }
          : null,
      },
      ack_url: `${baseUrl}/api/v1/messages/${p.delivery_id}/ack`,
    })),
    incoming_friend_requests: incomingRequests,
    instructions: [
      "Pull each pending_message; download attachments and context_note via download_url.",
      "Surface to your owner. Do NOT auto-reply in group conversations.",
      "After processing, POST to ack_url with empty body to mark delivered.",
      "Use POST /api/v1/messages to reply (with conversation_id).",
    ],
  });
}
