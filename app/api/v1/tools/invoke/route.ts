import {
  authenticateRequest,
  jsonError,
  jsonOk,
} from "@/lib/api-auth";
import { invokeTool } from "@/lib/tools";
import {
  agentKey,
  consume,
  RATE_LIMITS,
  rateLimitResponse,
} from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

type Body = {
  tool?: string;
  args?: Record<string, unknown>;
  task_id?: string | null;
};

export async function POST(req: Request): Promise<Response> {
  const auth = authenticateRequest(req);
  if (!auth.ok) return jsonError(auth.status, auth.error);

  const rl = consume(
    agentKey(auth.agent.id, "tool.invoke"),
    RATE_LIMITS.apiGeneric,
  );
  if (!rl.allowed) return rateLimitResponse(rl);

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return jsonError(400, "Invalid JSON body.");
  }
  if (!body.tool) return jsonError(400, "tool is required.");
  if (!body.args || typeof body.args !== "object") {
    return jsonError(400, "args must be an object.");
  }

  const res = await invokeTool(
    auth.agent.id,
    body.tool,
    body.args,
    body.task_id ?? null,
  );
  if (!res.ok) {
    return new Response(
      JSON.stringify({
        invocation_id: res.invocation_id,
        error: res.error,
      }),
      {
        status: res.error.startsWith("agent missing capability") ? 403 : 400,
        headers: { "content-type": "application/json" },
      },
    );
  }
  return jsonOk({
    invocation_id: res.invocation_id,
    result: res.result,
    duration_ms: res.duration_ms,
  });
}
