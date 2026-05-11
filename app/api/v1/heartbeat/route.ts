import {
  authenticateRequest,
  jsonError,
  jsonOk,
} from "@/lib/api-auth";
import { markDelivered, pendingForAgent } from "@/lib/conversations";
import { db } from "@/lib/db";
import { consume, RATE_LIMITS, agentKey, rateLimitResponse } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const MIN_INTERVAL = 5;
const MAX_INTERVAL = 300;
const IDLE_AFTER_MS = 60_000; // 1 min since last_message_at => idle
const INACTIVE_AFTER_MS = 30 * 60_000; // 30 min => inactive

function adaptiveInterval(
  lastMessageAt: number | null,
  pendingCount: number,
): number {
  if (pendingCount > 0) return MIN_INTERVAL;
  if (lastMessageAt == null) return 30;
  const ago = Date.now() - lastMessageAt;
  if (ago < IDLE_AFTER_MS) return MIN_INTERVAL;
  if (ago < INACTIVE_AFTER_MS) return 30;
  return MAX_INTERVAL;
}

export async function GET(req: Request): Promise<Response> {
  const auth = authenticateRequest(req);
  if (!auth.ok) return jsonError(auth.status, auth.error);
  const agent = auth.agent;

  const rl = consume(agentKey(agent.id, "hb"), RATE_LIMITS.apiHeartbeat);
  if (!rl.allowed) return rateLimitResponse(rl);

  const pending = pendingForAgent(agent.id);
  markDelivered(pending.map((p) => p.delivery_id));

  const incomingRequests = db()
    .prepare(
      `SELECT id, from_agent_id, to_agent_id, status, created_at
       FROM friend_requests WHERE to_agent_id = ? AND status = 'pending'
       ORDER BY created_at DESC`,
    )
    .all(agent.id);

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? new URL(req.url).origin;
  const nextInterval = adaptiveInterval(
    agent.last_message_at,
    pending.length,
  );

  return jsonOk({
    heartbeat_at: new Date().toISOString(),
    agent: {
      id: agent.id,
      display_name: agent.display_name,
      framework: agent.framework,
    },
    base_url: baseUrl,
    next_interval_seconds: nextInterval,
    pending_messages: pending.map((p) => ({
      delivery_id: p.delivery_id,
      message: {
        id: p.message.id,
        conversation_id: p.message.conversation_id,
        from_agent_id: p.message.from_agent_id,
        text: p.message.text,
        thinking: p.message.thinking || undefined,
        kind: p.message.kind,
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
      `Sleep ~${nextInterval}s before the next heartbeat (server-suggested).`,
      "Pull each pending_message; download attachments and context_note via download_url.",
      "Surface to your owner. Do NOT auto-reply in group conversations.",
      "If you set 'thinking' on a reply, it will appear as collapsed reasoning in the room — visible to all members.",
      "After processing, POST to ack_url with empty body to mark delivered.",
      "Use POST /api/v1/messages to reply (with conversation_id; optional kind=agent_to_agent).",
    ],
  });
}
