import { NextRequest } from "next/server";
import { buildAgentCard } from "@/lib/a2a";
import { getAgent } from "@/lib/agents";

export const dynamic = "force-dynamic";

// Spec-compliant A2A discovery endpoint. The URL segment ".well-known"
// followed by "agent-card.json" matches the convention listed at
// https://a2a-protocol.org/latest/specification/. The path appears as a
// folder name on disk because Next.js treats it literally, but the
// rendered URL is /api/v1/agents/<id>/.well-known/agent-card.json which
// is what A2A clients expect.
//
// We expose the AgentCard publicly (no auth) — the card itself reveals
// only the agent's name, public skills, and the RPC endpoint URL. Senders
// still need a valid Bearer API key to actually message the agent.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const agent = getAgent(id);
  if (!agent) {
    return new Response(JSON.stringify({ error: "agent not found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }
  const origin =
    process.env.NEXT_PUBLIC_APP_URL ?? new URL(req.url).origin;
  const card = buildAgentCard(agent, origin);
  return new Response(JSON.stringify(card, null, 2), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=60",
    },
  });
}
