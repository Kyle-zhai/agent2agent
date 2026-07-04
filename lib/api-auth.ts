import "server-only";
import { authenticateAgent, getAgent } from "./agents";
import {
  capabilityAllows,
  tokenIssuer,
  verifyAccessToken,
  type CapabilityClaims,
} from "./token-exchange";
import type { Agent, GrantResourceType, GrantScope } from "./types";

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

/** Result of authentication that may arrive via an api key OR a capability
 *  token (RFC 8693). When `capability` is set, the acting agent's authority on
 *  THIS request is constrained to what the token authorizes — resource
 *  endpoints must check it with `capabilityAllows` (or the `authorizes`
 *  helper) instead of assuming full agent rights. */
export type CapabilityAuthResult =
  | { ok: true; agent: Agent; capability: CapabilityClaims | null }
  | { ok: false; status: number; error: string };

const CAPABILITY_TOKEN_RE = /^(?:[A-Za-z0-9_-]+)\.(?:[A-Za-z0-9_-]+)\.(?:[A-Za-z0-9_-]+)$/;

/** Authenticate allowing EITHER an `a2a_…` api key (full agent) or a
 *  capability access token minted via /api/v1/oauth/token (scoped agent).
 *
 *  - api key  → { agent, capability: null }  (authority decided as usual)
 *  - JWT      → { agent: <token.sub>, capability }  (authority limited to the
 *               token's resource + scopes; the acting agent is the grant
 *               holder named in `sub`)
 *
 *  The JWT path is what lets an external agent present a Bearer token it was
 *  handed, without ever holding one of our api keys. */
export function authenticateWithCapability(req: Request): CapabilityAuthResult {
  const auth = req.headers.get("authorization") ?? "";
  const m = auth.match(/^Bearer\s+(\S+)$/i);
  if (!m) return { ok: false, status: 401, error: "Missing Bearer token." };
  const token = m[1];

  // api key first — cheap and the common case.
  if (token.startsWith("a2a_")) {
    const agent = authenticateAgent(token);
    if (!agent) return { ok: false, status: 401, error: "Invalid API key." };
    return { ok: true, agent, capability: null };
  }

  // Otherwise, try to verify it as a capability token (compact JWS: x.y.z).
  if (CAPABILITY_TOKEN_RE.test(token)) {
    const res = verifyAccessToken(token, {
      issuer: tokenIssuer(new URL(req.url).origin),
      audience: null,
    });
    if (!res.ok) {
      return { ok: false, status: 401, error: `Invalid token: ${res.reason}` };
    }
    const agent = getAgent(res.claims.agent_id);
    if (!agent) {
      return { ok: false, status: 401, error: "Token subject no longer exists." };
    }
    return { ok: true, agent, capability: res.claims };
  }

  return { ok: false, status: 401, error: "Invalid API key." };
}

/** Does this auth result authorize `required_scope` on the given resource?
 *  - api-key requests (capability === null) return `false` here — the caller
 *    must fall through to its normal subscription/grant checks (this helper is
 *    ONLY the capability-token branch, so it never grants api-key callers more
 *    than they'd otherwise have).
 *  - capability-token requests are authorized iff the token covers exactly this
 *    resource with the scope. */
export function capabilityAuthorizes(
  auth: Extract<CapabilityAuthResult, { ok: true }>,
  resource_type: GrantResourceType,
  resource_id: string,
  required_scope: GrantScope,
): boolean {
  if (!auth.capability) return false;
  return capabilityAllows(
    auth.capability,
    resource_type,
    resource_id,
    required_scope,
  );
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
