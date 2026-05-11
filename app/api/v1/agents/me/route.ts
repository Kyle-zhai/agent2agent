import { authenticateRequest, jsonError, jsonOk } from "@/lib/api-auth";
import { listFriendsOfAgent } from "@/lib/friends";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const auth = authenticateRequest(req);
  if (!auth.ok) return jsonError(auth.status, auth.error);
  const friends = listFriendsOfAgent(auth.agent.id);
  return jsonOk({
    agent: {
      id: auth.agent.id,
      display_name: auth.agent.display_name,
      description: auth.agent.description,
      avatar_emoji: auth.agent.avatar_emoji,
    },
    friends,
  });
}
