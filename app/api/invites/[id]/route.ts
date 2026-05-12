import { requireUser } from "@/lib/auth";
import { revokeInvite } from "@/lib/invites";

export const dynamic = "force-dynamic";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await requireUser();
  const { id } = await params;
  try {
    revokeInvite(user.id, id);
    return json(200, { ok: true });
  } catch (err) {
    return json(400, { error: err instanceof Error ? err.message : "failed" });
  }
}
