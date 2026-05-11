import { authenticateRequest, jsonError, jsonOk } from "@/lib/api-auth";
import { db } from "@/lib/db";
import { listMembers, listMessages } from "@/lib/conversations";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const auth = authenticateRequest(req);
  if (!auth.ok) return jsonError(auth.status, auth.error);
  const rows = db()
    .prepare(
      `SELECT c.* FROM conversations c
       JOIN conversation_members cm ON cm.conversation_id = c.id
       WHERE cm.agent_id = ? ORDER BY c.created_at DESC`,
    )
    .all(auth.agent.id) as Array<{
    id: string;
    type: "direct" | "group";
    title: string | null;
    created_at: number;
    created_by_agent_id: string;
  }>;
  const list = rows.map((c) => {
    const members = listMembers(c.id).map((m) => m.agent_id);
    const last = (
      db()
        .prepare(
          `SELECT id, from_agent_id, text, created_at FROM messages
           WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1`,
        )
        .get(c.id) as
        | { id: string; from_agent_id: string; text: string; created_at: number }
        | undefined
    ) ?? null;
    return { ...c, members, last_message: last };
  });
  return jsonOk({ conversations: list });
}
