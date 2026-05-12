import {
  authenticateRequest,
  jsonError,
  jsonOk,
} from "@/lib/api-auth";
import {
  createWorkspace,
  listWorkspacesForAgent,
  listWorkspacesForConversation,
  subscribeAgent,
} from "@/lib/workspaces";
import { listMembers } from "@/lib/conversations";
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

  const rl = consume(agentKey(auth.agent.id, "ws.list"), RATE_LIMITS.apiGeneric);
  if (!rl.allowed) return rateLimitResponse(rl);

  const url = new URL(req.url);
  const conv = url.searchParams.get("conversation_id");
  const list = conv
    ? listWorkspacesForConversation(conv).filter((w) =>
        // an agent can see workspaces in conversations it belongs to
        listMembers(conv).some((m) => m.agent_id === auth.agent.id) ||
        listWorkspacesForAgent(auth.agent.id).some((mine) => mine.id === w.id),
      )
    : listWorkspacesForAgent(auth.agent.id);

  return jsonOk({ workspaces: list });
}

type CreateBody = {
  name?: string;
  conversation_id?: string | null;
  subscribe?: Array<{ agent_id: string; role?: "reader" | "writer" | "admin" }>;
};

export async function POST(req: Request): Promise<Response> {
  const auth = authenticateRequest(req);
  if (!auth.ok) return jsonError(auth.status, auth.error);

  const rl = consume(
    agentKey(auth.agent.id, "ws.write"),
    RATE_LIMITS.apiGeneric,
  );
  if (!rl.allowed) return rateLimitResponse(rl);

  let body: CreateBody;
  try {
    body = (await req.json()) as CreateBody;
  } catch {
    return jsonError(400, "Invalid JSON body.");
  }
  if (!body.name) return jsonError(400, "name is required.");

  if (body.conversation_id) {
    const members = listMembers(body.conversation_id);
    if (!members.some((m) => m.agent_id === auth.agent.id)) {
      return jsonError(403, "Not a member of conversation.");
    }
  }

  try {
    const ws = createWorkspace({
      name: body.name,
      conversation_id: body.conversation_id ?? null,
      created_by_agent_id: auth.agent.id,
    });
    for (const s of body.subscribe ?? []) {
      // Only subscribe co-members or self.
      if (body.conversation_id) {
        const members = listMembers(body.conversation_id);
        if (!members.some((m) => m.agent_id === s.agent_id)) continue;
      } else if (s.agent_id !== auth.agent.id) {
        continue;
      }
      subscribeAgent(ws.id, s.agent_id, s.role ?? "writer");
    }
    return jsonOk({ workspace: ws }, 201);
  } catch (err) {
    return jsonError(400, err instanceof Error ? err.message : "Create failed.");
  }
}
