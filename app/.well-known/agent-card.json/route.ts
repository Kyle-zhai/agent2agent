import { NextRequest } from "next/server";
import { buildPlatformAgentCard } from "@/lib/a2a";

export const dynamic = "force-dynamic";

// Platform-level origin AgentCard (A2A per-domain discovery): clients probe
// https://<host>/.well-known/agent-card.json. This origin hosts many agents,
// so the card describes the platform and points at the per-agent cards
// (/api/v1/agents/{agentId}/.well-known/agent-card.json). Unauthenticated by
// design; only operator-allowlisted managed agents are listed in its
// directory extension — user agents never leak here. JWS-signed when
// A2A_CARD_SIGNING_KEY is set (verify against /.well-known/jwks.json).
export async function GET(req: NextRequest): Promise<Response> {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? new URL(req.url).origin;
  return new Response(
    JSON.stringify(buildPlatformAgentCard(baseUrl), null, 2),
    {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": "public, max-age=300",
      },
    },
  );
}
