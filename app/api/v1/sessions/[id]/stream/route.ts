import {
  authenticateRequest,
  jsonError,
} from "@/lib/api-auth";
import {
  getSession,
  peekEventsForSession,
  persistSessionCursor,
} from "@/lib/sessions";

export const dynamic = "force-dynamic";

const KEEPALIVE_MS = 25_000;
const POLL_MS = 1500;
const STREAM_MAX_MS = 120_000;

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = authenticateRequest(req);
  if (!auth.ok) return jsonError(auth.status, auth.error);

  const { id } = await params;
  const session = getSession(id);
  if (!session || session.agent_id !== auth.agent.id) {
    return jsonError(404, "Session not found.");
  }

  const encoder = new TextEncoder();
  let cursor = session.cursor;

  const stream = new ReadableStream({
    async start(controller) {
      const startedAt = Date.now();
      let closed = false;
      let keepalive: NodeJS.Timeout | null = null;
      let tick: NodeJS.Timeout | null = null;

      const close = () => {
        if (closed) return;
        closed = true;
        if (keepalive) clearInterval(keepalive);
        if (tick) clearInterval(tick);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
        persistSessionCursor(id, cursor);
      };
      req.signal.addEventListener("abort", close);

      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch (err) {
          console.warn("session SSE send failed", {
            session_id: id,
            err: err instanceof Error ? err.message : String(err),
          });
          close();
        }
      };

      send("hello", {
        session_id: id,
        agent_id: session.agent_id,
        cursor,
      });

      keepalive = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        } catch (err) {
          console.error("session SSE keepalive failed", {
            session_id: id,
            err: err instanceof Error ? err.message : String(err),
          });
          close();
        }
      }, KEEPALIVE_MS);

      tick = setInterval(() => {
        if (closed) return;
        if (Date.now() - startedAt > STREAM_MAX_MS) {
          send("bye", { reason: "max_duration" });
          close();
          return;
        }
        try {
          const events = peekEventsForSession(session, cursor, 50);
          if (events.length > 0) {
            for (const e of events) {
              send("event", e);
            }
            cursor = events[events.length - 1].id;
            persistSessionCursor(id, cursor);
          }
        } catch (err) {
          console.error("session SSE tick failed", {
            session_id: id,
            err: err instanceof Error ? err.message : String(err),
          });
          close();
        }
      }, POLL_MS);
    },
    cancel() {
      // Abort handler already calls close(); this is a safety net.
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
