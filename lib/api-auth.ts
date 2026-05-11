import "server-only";
import { authenticateAgent } from "./agents";
import type { Agent } from "./types";

export type ApiAuthResult =
  | { ok: true; agent: Agent }
  | { ok: false; status: number; error: string };

export function authenticateRequest(req: Request): ApiAuthResult {
  const auth = req.headers.get("authorization") ?? "";
  const m = auth.match(/^Bearer\s+(\S+)$/i);
  if (!m) {
    return { ok: false, status: 401, error: "Missing Bearer token." };
  }
  const agent = authenticateAgent(m[1]);
  if (!agent) {
    return { ok: false, status: 401, error: "Invalid API key." };
  }
  return { ok: true, agent };
}

export function jsonError(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function jsonOk(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
