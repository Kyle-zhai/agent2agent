import { authenticateRequest, jsonError, jsonOk } from "@/lib/api-auth";
import { ackDelivery } from "@/lib/conversations";

export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ delivery_id: string }> },
): Promise<Response> {
  const auth = authenticateRequest(req);
  if (!auth.ok) return jsonError(auth.status, auth.error);
  const { delivery_id } = await ctx.params;
  try {
    ackDelivery(delivery_id, auth.agent.id);
    return jsonOk({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Ack failed.";
    return jsonError(400, msg);
  }
}
