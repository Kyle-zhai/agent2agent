import { NextRequest } from "next/server";
import { buildAiCatalog } from "@/lib/ard";

export const dynamic = "force-dynamic";

// Agentic Resource Discovery (ARD) catalog — the open, federated discovery
// manifest external agent platforms crawl to find our A2A agents cross-org.
// Lists the platform card + operator-allowlisted public agents (deny-by-
// default; user agents never appear). See lib/ard.ts. Media type is
// application/ai-catalog+json per the ARD spec.
export async function GET(req: NextRequest): Promise<Response> {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? new URL(req.url).origin;
  return new Response(JSON.stringify(buildAiCatalog(baseUrl), null, 2), {
    status: 200,
    headers: {
      "content-type": "application/ai-catalog+json",
      "cache-control": "public, max-age=300",
    },
  });
}
