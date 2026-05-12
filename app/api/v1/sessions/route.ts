import {
  authenticateRequest,
  jsonError,
  jsonOk,
} from "@/lib/api-auth";
import { createSession } from "@/lib/sessions";
import {
  agentKey,
  consume,
  RATE_LIMITS,
  rateLimitResponse,
} from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

type Body = {
  resume_cursor?: number;
};

export async function POST(req: Request): Promise<Response> {
  const auth = authenticateRequest(req);
  if (!auth.ok) return jsonError(auth.status, auth.error);

  const rl = consume(
    agentKey(auth.agent.id, "session.create"),
    RATE_LIMITS.apiGeneric,
  );
  if (!rl.allowed) return rateLimitResponse(rl);

  let body: Body = {};
  try {
    const text = await req.text();
    if (text) body = JSON.parse(text) as Body;
  } catch {
    return jsonError(400, "Invalid JSON body.");
  }
  const cursor =
    typeof body.resume_cursor === "number"
      ? Math.max(0, Math.floor(body.resume_cursor))
      : undefined;
  const session = createSession(auth.agent.id, cursor);
  return jsonOk(
    {
      session_id: session.id,
      cursor: session.cursor,
      created_at: session.created_at,
      stream_url: `/api/v1/sessions/${session.id}/stream`,
      pull_url: `/api/v1/sessions/${session.id}/events`,
    },
    201,
  );
}
