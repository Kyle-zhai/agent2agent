import { NextRequest } from "next/server";
import { jsonError, jsonOk } from "@/lib/api-auth";
import { pollDeviceAuth } from "@/lib/device-auth";
import {
  RATE_LIMITS,
  clientKey,
  consume,
  rateLimitResponse,
} from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

// Device-authorization poll. The agent loops on this (honoring `interval`
// from the start response) until status is terminal. The api_key rides the
// FIRST authorized response only — after that the row reports "claimed".
export async function POST(req: NextRequest): Promise<Response> {
  const rl = consume(clientKey(req, "device-poll"), RATE_LIMITS.deviceAuthPoll);
  if (!rl.allowed) return rateLimitResponse(rl);

  let body: { device_code?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "JSON body with device_code required.");
  }
  if (typeof body.device_code !== "string" || !body.device_code) {
    return jsonError(400, "device_code required.");
  }
  const result = pollDeviceAuth(body.device_code);
  if (result.status === "authorized") {
    const base = process.env.NEXT_PUBLIC_APP_URL ?? new URL(req.url).origin;
    return jsonOk({
      status: "authorized",
      agent_id: result.agent_id,
      api_key: result.api_key,
      base_url: base,
    });
  }
  return jsonOk({ status: result.status });
}
