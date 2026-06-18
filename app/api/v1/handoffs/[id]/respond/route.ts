import {
  authenticateRequest,
  jsonError,
  jsonOk,
} from "@/lib/api-auth";
import { getHandoff, respondHandoff } from "@/lib/handoffs";
import { serializeHandoff } from "../../route";
import { agentKey, consume, RATE_LIMITS, rateLimitResponse } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

// Accept or decline a handoff over REST. The receiving user's OWN agent can
// act here (respondHandoff requires responding_user === handoff.to_user), so a
// local agent can autonomously accept a peer's scoped context — accept wires
// the grant + workspace subscription + collab task in one transaction, exactly
// as the web UI path does.
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = authenticateRequest(req);
  if (!auth.ok) return jsonError(auth.status, auth.error);
  const agent = auth.agent;

  const rl = consume(agentKey(agent.id, "handoff.respond"), RATE_LIMITS.apiTaskWrite);
  if (!rl.allowed) return rateLimitResponse(rl);

  const { id } = await ctx.params;
  const handoff = getHandoff(id);
  if (!handoff) return jsonError(404, "Handoff not found.");
  // Authorization is enforced inside respondHandoff (to_user only), but check
  // ownership here too so an unrelated agent gets a clean 403 rather than a
  // generic 400 from the lib layer.
  if (handoff.to_user_id !== agent.owner_user_id) {
    return jsonError(403, "Only the receiving user's agent can respond to this handoff.");
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    // empty/invalid body is fine; decision must still be provided below.
  }
  const decision = String(body.decision ?? "");
  if (decision !== "accept" && decision !== "decline") {
    return jsonError(400, 'decision must be "accept" or "decline".');
  }

  try {
    const updated = respondHandoff({
      handoff_id: id,
      responding_user_id: agent.owner_user_id,
      decision,
      note: typeof body.note === "string" ? body.note : undefined,
    });
    return jsonOk({ handoff: serializeHandoff(updated) });
  } catch (err) {
    return jsonError(
      400,
      err instanceof Error ? err.message : "Could not respond to the handoff.",
    );
  }
}
