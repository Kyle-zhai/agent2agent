import {
  authenticateWithCapability,
  capabilityAuthorizes,
  jsonError,
  jsonOk,
} from "@/lib/api-auth";
import { listMembers, listMessages } from "@/lib/conversations";
import { agentMayUseResource } from "@/lib/grants";

export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = authenticateWithCapability(req);
  if (!auth.ok) return jsonError(auth.status, auth.error);
  const { id } = await ctx.params;
  const members = listMembers(id).map((m) => m.agent_id);
  // Membership OR an active conversation read-grant. A handoff mints a
  // conversation grant on accept; honoring it here means a granted agent can
  // read the thread even if it isn't (or stops being) a member — the grant
  // is the real authority, revoking it cuts access on the next request. A
  // capability token gets ONLY what it authorizes (no membership fallback).
  const authorized = auth.capability
    ? capabilityAuthorizes(auth, "conversation", id, "read")
    : members.includes(auth.agent.id) ||
      agentMayUseResource({
        using_agent_id: auth.agent.id,
        resource_type: "conversation",
        resource_id: id,
        required_scope: "read",
      });
  if (!authorized) {
    return jsonError(403, "Not a member and no read grant for this conversation.");
  }
  const url = new URL(req.url);
  const sinceParam = url.searchParams.get("since_created_at");
  const sinceCreatedAt = sinceParam ? parseInt(sinceParam, 10) : 0;
  const limit = Math.min(
    parseInt(url.searchParams.get("limit") ?? "100", 10) || 100,
    500,
  );
  const baseUrl =
    process.env.NEXT_PUBLIC_APP_URL ?? new URL(req.url).origin;
  const msgs = listMessages(id, { sinceCreatedAt, limit }).map((m) => ({
    id: m.id,
    conversation_id: m.conversation_id,
    from_agent_id: m.from_agent_id,
    text: m.text,
    created_at: m.created_at,
    attachments: m.attachments.map((a) => ({
      id: a.id,
      filename: a.filename,
      mime_type: a.mime_type,
      size_bytes: a.size_bytes,
      download_url: `${baseUrl}/api/v1/blobs/${a.id}`,
    })),
    context_note: m.context_note
      ? {
          id: m.context_note.id,
          title: m.context_note.title,
          size_bytes: m.context_note.size_bytes,
          download_url: `${baseUrl}/api/v1/contexts/${m.context_note.id}`,
        }
      : null,
  }));
  return jsonOk({ messages: msgs });
}
