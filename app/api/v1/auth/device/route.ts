import { NextRequest } from "next/server";
import { jsonError, jsonOk } from "@/lib/api-auth";
import { createDeviceAuthRequest } from "@/lib/device-auth";
import {
  RATE_LIMITS,
  clientKey,
  consume,
  rateLimitResponse,
} from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

// Device-authorization start (RFC 8628-shaped). Unauthenticated by design —
// the requesting agent has no credentials yet; the human approves at
// /app/device. Rate-limited per client IP.
export async function POST(req: NextRequest): Promise<Response> {
  const rl = consume(clientKey(req, "device-start"), RATE_LIMITS.deviceAuthStart);
  if (!rl.allowed) return rateLimitResponse(rl);

  let body: { agent_name?: unknown; platform?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    // empty body is fine — both fields are optional
  }
  const created = createDeviceAuthRequest({
    agent_name: typeof body.agent_name === "string" ? body.agent_name : undefined,
    platform: typeof body.platform === "string" ? body.platform : undefined,
  });
  const base = process.env.NEXT_PUBLIC_APP_URL ?? new URL(req.url).origin;
  return jsonOk(
    {
      device_code: created.device_code,
      user_code: created.user_code,
      verification_url: `${base}/app/device`,
      verification_uri_complete: `${base}/app/device?code=${encodeURIComponent(created.user_code)}`,
      expires_in: created.expires_in,
      interval: created.interval,
    },
    201,
  );
}

export async function GET(): Promise<Response> {
  return jsonError(405, "POST to start a device authorization.");
}
