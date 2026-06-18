import {
  authenticateRequest,
  jsonError,
  jsonOk,
} from "@/lib/api-auth";
import {
  listHandoffsForUser,
  proposeHandoff,
  type ProposeHandoffInput,
} from "@/lib/handoffs";
import { agentKey, consume, RATE_LIMITS, rateLimitResponse } from "@/lib/rate-limit";
import type { GrantScope, Handoff } from "@/lib/types";

export const dynamic = "force-dynamic";

// Agent-facing REST for directed handoffs. The web UI drives the same
// proposeHandoff/respondHandoff logic via server actions; this exposes it so a
// user's OWN local agent can propose context to a peer's agent and (via the
// sibling [id]/respond route) accept it — without a human clicking in the
// browser. Authz: the caller is a Bearer-authenticated agent; it acts on
// behalf of its owner_user_id (proposeHandoff requires from_agent to be the
// caller and from_user to own it).

/** Public JSON shape — drops shared_body/private_summary internals callers
 *  don't need, keeps the fields an agent acts on. */
export function serializeHandoff(h: Handoff) {
  return {
    id: h.id,
    conversation_id: h.conversation_id,
    workspace_id: h.workspace_id,
    from_agent_id: h.from_agent_id,
    to_agent_id: h.to_agent_id,
    title: h.title,
    brief: h.brief,
    // shared_body is the already-redacted content the recipient may read.
    shared_body: h.shared_body,
    redaction_count: h.redaction_count,
    task_id: h.task_id,
    status: h.status,
    scopes: JSON.parse(h.scopes_json || "[]") as GrantScope[],
    duration_key: h.duration_key,
    created_at: h.created_at,
    responded_at: h.responded_at,
  };
}

export async function GET(req: Request): Promise<Response> {
  const auth = authenticateRequest(req);
  if (!auth.ok) return jsonError(auth.status, auth.error);
  const rl = consume(agentKey(auth.agent.id, "handoff.list"), RATE_LIMITS.apiGeneric);
  if (!rl.allowed) return rateLimitResponse(rl);

  const handoffs = listHandoffsForUser(auth.agent.owner_user_id);
  return jsonOk({ handoffs: handoffs.map(serializeHandoff) });
}

export async function POST(req: Request): Promise<Response> {
  const auth = authenticateRequest(req);
  if (!auth.ok) return jsonError(auth.status, auth.error);
  const agent = auth.agent;

  const rl = consume(agentKey(agent.id, "handoff.propose"), RATE_LIMITS.apiTaskWrite);
  if (!rl.allowed) return rateLimitResponse(rl);

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return jsonError(400, "Body must be valid JSON.");
  }

  const conversationId = String(body.conversation_id ?? "").trim();
  const toAgentId = String(body.to_agent_id ?? "").trim();
  const title = String(body.title ?? "").trim();
  if (!conversationId) return jsonError(400, "conversation_id is required.");
  if (!toAgentId) return jsonError(400, "to_agent_id is required.");
  if (!title) return jsonError(400, "title is required.");

  const input: ProposeHandoffInput = {
    conversation_id: conversationId,
    // The caller IS the proposer — never trust a from_* from the body.
    from_agent_id: agent.id,
    from_user_id: agent.owner_user_id,
    to_agent_id: toAgentId,
    title,
    brief: String(body.brief ?? ""),
    body: String(body.body ?? ""),
    workspace_id:
      typeof body.workspace_id === "string" && body.workspace_id
        ? body.workspace_id
        : null,
    scopes: Array.isArray(body.scopes)
      ? (body.scopes.filter((s) => typeof s === "string") as GrantScope[])
      : undefined,
    duration_key:
      typeof body.duration_key === "string" ? body.duration_key : undefined,
    attachment_ids: Array.isArray(body.attachment_ids)
      ? (body.attachment_ids.filter((s) => typeof s === "string") as string[])
      : undefined,
  };

  try {
    const h = proposeHandoff(input);
    return jsonOk({ handoff: serializeHandoff(h) }, 201);
  } catch (err) {
    // proposeHandoff throws plain validation errors (not-your-agent, not a
    // member, no workspace authority, etc.) — surface as 400 with the message.
    return jsonError(
      400,
      err instanceof Error ? err.message : "Could not propose the handoff.",
    );
  }
}
