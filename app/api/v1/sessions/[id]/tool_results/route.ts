import {
  authenticateRequest,
  jsonError,
  jsonOk,
} from "@/lib/api-auth";
import { getSession } from "@/lib/sessions";
import { reportToolResult } from "@/lib/reverse-rpc";
import {
  agentKey,
  consume,
  RATE_LIMITS,
  rateLimitResponse,
} from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

type Body = {
  rpc_id?: string;
  ok?: boolean;
  result?: unknown;
  error?: string;
};

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = authenticateRequest(req);
  if (!auth.ok) return jsonError(auth.status, auth.error);

  const rl = consume(
    agentKey(auth.agent.id, "rpc.report"),
    RATE_LIMITS.apiGeneric,
  );
  if (!rl.allowed) return rateLimitResponse(rl);

  const { id } = await params;
  const session = getSession(id);
  if (!session || session.agent_id !== auth.agent.id) {
    return jsonError(404, "Session not found.");
  }
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return jsonError(400, "Invalid JSON body.");
  }
  if (!body.rpc_id) return jsonError(400, "rpc_id is required.");
  if (typeof body.ok !== "boolean") return jsonError(400, "ok must be boolean.");
  try {
    const res = reportToolResult({
      rpc_id: body.rpc_id,
      reporter_agent_id: auth.agent.id,
      ok: body.ok,
      result: body.result,
      error: body.error,
    });
    return jsonOk(res);
  } catch (err) {
    return jsonError(400, err instanceof Error ? err.message : "report failed");
  }
}
