import {
  authenticateRequest,
  jsonError,
  jsonOk,
} from "@/lib/api-auth";
import {
  getSession,
  pullEventsForSession,
} from "@/lib/sessions";
import {
  agentKey,
  consume,
  RATE_LIMITS,
  rateLimitResponse,
} from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = authenticateRequest(req);
  if (!auth.ok) return jsonError(auth.status, auth.error);

  const rl = consume(
    agentKey(auth.agent.id, "session.pull"),
    RATE_LIMITS.apiHeartbeat,
  );
  if (!rl.allowed) return rateLimitResponse(rl);

  const { id } = await params;
  const s = getSession(id);
  if (!s || s.agent_id !== auth.agent.id) {
    return jsonError(404, "Session not found.");
  }
  const url = new URL(req.url);
  const limit = Math.max(
    1,
    Math.min(200, Number(url.searchParams.get("max") ?? "100")),
  );
  const { events, cursor } = pullEventsForSession(s, limit);
  return jsonOk({ events, cursor });
}
