import {
  authenticateRequest,
  jsonError,
  jsonOk,
} from "@/lib/api-auth";
import {
  parseAgentCapabilities,
  setAgentCapabilities,
} from "@/lib/agents";
import { logAudit } from "@/lib/audit";
import {
  agentKey,
  consume,
  RATE_LIMITS,
  rateLimitResponse,
} from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const auth = authenticateRequest(req);
  if (!auth.ok) return jsonError(auth.status, auth.error);
  return jsonOk({ capabilities: parseAgentCapabilities(auth.agent) });
}

type PutBody = {
  capabilities?: unknown;
};

export async function PUT(req: Request): Promise<Response> {
  const auth = authenticateRequest(req);
  if (!auth.ok) return jsonError(auth.status, auth.error);

  const rl = consume(
    agentKey(auth.agent.id, "agent.caps"),
    RATE_LIMITS.apiGeneric,
  );
  if (!rl.allowed) return rateLimitResponse(rl);

  let body: PutBody;
  try {
    body = (await req.json()) as PutBody;
  } catch {
    return jsonError(400, "Invalid JSON body.");
  }
  try {
    setAgentCapabilities(auth.agent.id, auth.agent.owner_user_id, body.capabilities);
    logAudit("agent.capabilities_set", {
      agentId: auth.agent.id,
      detail: {
        count: Array.isArray(body.capabilities) ? body.capabilities.length : 0,
      },
    });
    return jsonOk({ ok: true });
  } catch (err) {
    return jsonError(400, err instanceof Error ? err.message : "Set failed.");
  }
}
