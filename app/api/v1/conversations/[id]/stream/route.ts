import { authenticateRequest, jsonError } from "@/lib/api-auth";
import { getCurrentUser } from "@/lib/auth";
import {
  getConversation,
  getMaxConversationEventId,
  listConversationEventsAfter,
  listMembers,
} from "@/lib/conversations";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

const KEEPALIVE_MS = 25_000;
const POLL_MS = 1500;
const STREAM_MAX_MS = 120_000;

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  const conv = getConversation(id);
  if (!conv) return jsonError(404, "Conversation not found.");

  const allowed = await isMember(req, id);
  if (!allowed) return jsonError(403, "Forbidden.");

  let lastEventId = getMaxConversationEventId(id);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const startedAt = Date.now();
      let closed = false;

      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          /* noop */
        }
      };

      req.signal.addEventListener("abort", close);

      const send = (eventName: string, data: unknown) => {
        if (closed) return;
        const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
        try {
          controller.enqueue(encoder.encode(payload));
        } catch (err) {
          // Most common cause: client disconnected mid-write. Less common:
          // JSON.stringify on a malformed payload. We don't want to bury
          // either — even a benign disconnect shouldn't disappear silently.
          console.warn("SSE send failed", {
            conversationId: id,
            eventName,
            err: err instanceof Error ? err.message : String(err),
          });
          close();
        }
      };

      send("hello", { conversation_id: id, last_event_id: lastEventId });
      const keepalive = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        } catch (err) {
          console.error("SSE keepalive enqueue failed", {
            conversationId: id,
            err: err instanceof Error ? err.message : String(err),
          });
          close();
        }
      }, KEEPALIVE_MS);

      const tick = setInterval(() => {
        if (closed) return;
        if (Date.now() - startedAt > STREAM_MAX_MS) {
          send("bye", { reason: "max_duration" });
          close();
          return;
        }
        try {
          const events = listConversationEventsAfter(id, lastEventId, 50);
          if (events.length > 0) {
            for (const e of events) {
              send("message", {
                event_id: e.id,
                kind: e.kind,
                message_id: e.message_id,
                created_at: e.created_at,
              });
            }
            lastEventId = events[events.length - 1].id;
          }
        } catch (err) {
          console.error("SSE tick failed", {
            conversationId: id,
            lastEventId,
            err: err instanceof Error ? err.message : String(err),
          });
          close();
        }
      }, POLL_MS);

      const cleanup = setInterval(() => {
        if (closed) {
          clearInterval(keepalive);
          clearInterval(tick);
          clearInterval(cleanup);
        }
      }, POLL_MS);
    },
    cancel() {
      /* nothing — close handled in abort */
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

async function isMember(req: Request, conversationId: string): Promise<boolean> {
  const auth = authenticateRequest(req);
  if (auth.ok) {
    const ids = listMembers(conversationId).map((m) => m.agent_id);
    return ids.includes(auth.agent.id);
  }
  const user = await getCurrentUser();
  if (!user) return false;
  const row = db()
    .prepare(
      `SELECT 1 FROM conversation_members cm
       JOIN agents a ON a.id = cm.agent_id
       WHERE cm.conversation_id = ? AND a.owner_user_id = ? LIMIT 1`,
    )
    .get(conversationId, user.id);
  return !!row;
}
