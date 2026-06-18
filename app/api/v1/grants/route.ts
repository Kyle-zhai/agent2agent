import { authenticateRequest, jsonError, jsonOk } from "@/lib/api-auth";
import {
  ALL_SCOPES,
  DURATION_PRESETS,
  createGrant,
  listGrantsToAgent,
  type GrantResourceType,
  type GrantScope,
} from "@/lib/grants";

export const dynamic = "force-dynamic";

// Agent-facing CRUD for capability-scoped grants. An agent uses its own
// Bearer API key; LIST returns grants where THIS agent is the recipient,
// POST creates a new grant from this agent to a peer.
//
// Mirrors the AgentCard skill list — any A2A client that fetches this
// agent's card can later POST here to mint a grant for one of their own
// agents.

export async function GET(req: Request): Promise<Response> {
  const auth = authenticateRequest(req);
  if (!auth.ok) return jsonError(auth.status, auth.error);
  const grants = listGrantsToAgent(auth.agent.id);
  return jsonOk({
    grants: grants.map((g) => ({
      id: g.id,
      from_agent_id: g.from_agent_id,
      resource_type: g.resource_type,
      resource_id: g.resource_id,
      scopes: JSON.parse(g.scopes_json),
      expires_at: g.expires_at,
      created_at: g.created_at,
      handoff_id: g.handoff_id,
    })),
  });
}

type CreateBody = {
  to_agent_id?: string;
  resource_type?: GrantResourceType;
  resource_id?: string;
  scopes?: GrantScope[];
  duration_key?: string;
  expires_at?: number | null;
};

export async function POST(req: Request): Promise<Response> {
  const auth = authenticateRequest(req);
  if (!auth.ok) return jsonError(auth.status, auth.error);
  let body: CreateBody;
  try {
    body = (await req.json()) as CreateBody;
  } catch {
    return jsonError(400, "Invalid JSON body.");
  }
  const { to_agent_id, resource_type, resource_id, scopes, duration_key, expires_at } =
    body;
  if (!to_agent_id || !resource_type || !resource_id || !scopes) {
    return jsonError(
      400,
      "to_agent_id, resource_type, resource_id, scopes are required.",
    );
  }
  if (!(ALL_SCOPES as readonly string[]).includes(scopes[0] ?? "__nope")) {
    // Cheap sanity — full validation lives in createGrant.
  }
  try {
    const g = createGrant({
      from_user_id: auth.agent.owner_user_id,
      from_agent_id: auth.agent.id,
      to_agent_id,
      resource_type,
      resource_id,
      scopes,
      duration_key,
      expires_at: expires_at ?? null,
    });
    return jsonOk(
      {
        id: g.id,
        signature: g.signature,
        expires_at: g.expires_at,
        scopes: JSON.parse(g.scopes_json),
        duration_options: DURATION_PRESETS,
      },
      201,
    );
  } catch (err) {
    return jsonError(400, err instanceof Error ? err.message : "Grant failed.");
  }
}
