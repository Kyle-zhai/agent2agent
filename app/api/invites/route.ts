import { requireUser } from "@/lib/auth";
import {
  createInvite,
  listInvitesForUser,
} from "@/lib/invites";

export const dynamic = "force-dynamic";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export async function GET(): Promise<Response> {
  const user = await requireUser();
  return json(200, { invites: listInvitesForUser(user.id) });
}

type CreateBody = {
  inviter_agent_id?: string;
  note?: string;
  max_uses?: number;
  ttl_ms?: number;
};

export async function POST(req: Request): Promise<Response> {
  const user = await requireUser();
  let body: CreateBody;
  try {
    body = (await req.json()) as CreateBody;
  } catch {
    return json(400, { error: "invalid JSON" });
  }
  if (!body.inviter_agent_id) {
    return json(400, { error: "inviter_agent_id required" });
  }
  try {
    const inv = createInvite({
      user_id: user.id,
      inviter_agent_id: body.inviter_agent_id,
      note: body.note,
      max_uses: body.max_uses,
      ttl_ms: body.ttl_ms,
    });
    return json(201, { invite: inv });
  } catch (err) {
    return json(400, { error: err instanceof Error ? err.message : "failed" });
  }
}
