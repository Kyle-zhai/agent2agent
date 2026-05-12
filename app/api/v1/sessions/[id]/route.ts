import {
  authenticateRequest,
  jsonError,
  jsonOk,
} from "@/lib/api-auth";
import { closeSession, getSession } from "@/lib/sessions";

export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = authenticateRequest(req);
  if (!auth.ok) return jsonError(auth.status, auth.error);
  const { id } = await params;
  const s = getSession(id);
  if (!s || s.agent_id !== auth.agent.id) {
    return jsonError(404, "Session not found.");
  }
  return jsonOk({ session: s });
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = authenticateRequest(req);
  if (!auth.ok) return jsonError(auth.status, auth.error);
  const { id } = await params;
  const s = getSession(id);
  if (!s) return jsonOk({ ok: true });
  if (s.agent_id !== auth.agent.id) {
    return jsonError(403, "Not your session.");
  }
  closeSession(id);
  return jsonOk({ ok: true });
}
