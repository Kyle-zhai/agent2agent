import { NextRequest } from "next/server";
import { authenticateRequest, jsonError, jsonOk } from "@/lib/api-auth";
import { getGrant, revokeGrant } from "@/lib/grants";
import { getAgent } from "@/lib/agents";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = authenticateRequest(req);
  if (!auth.ok) return jsonError(auth.status, auth.error);
  const { id } = await params;
  const g = getGrant(id);
  if (!g) return jsonError(404, "grant not found");
  // Either the granter or the recipient may look at the grant. Authorize by
  // owner_user_id (not agent id) to match DELETE/revokeGrant — a user with
  // several agents can read a grant via any of their agents.
  const me = auth.agent.owner_user_id;
  if (
    getAgent(g.from_agent_id)?.owner_user_id !== me &&
    getAgent(g.to_agent_id)?.owner_user_id !== me
  ) {
    return jsonError(403, "not your grant");
  }
  return jsonOk({
    id: g.id,
    from_agent_id: g.from_agent_id,
    to_agent_id: g.to_agent_id,
    resource_type: g.resource_type,
    resource_id: g.resource_id,
    scopes: JSON.parse(g.scopes_json),
    expires_at: g.expires_at,
    revoked_at: g.revoked_at,
    revoked_reason: g.revoked_reason,
    handoff_id: g.handoff_id,
    created_at: g.created_at,
    last_used_at: g.last_used_at,
  });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = authenticateRequest(req);
  if (!auth.ok) return jsonError(auth.status, auth.error);
  const { id } = await params;
  try {
    const g = revokeGrant({
      grant_id: id,
      user_id: auth.agent.owner_user_id,
      reason: "API-initiated revocation",
    });
    return jsonOk({ id: g.id, revoked_at: g.revoked_at });
  } catch (err) {
    return jsonError(400, err instanceof Error ? err.message : "revoke failed");
  }
}
