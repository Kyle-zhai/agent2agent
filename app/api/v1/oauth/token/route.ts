import { authenticateRequest } from "@/lib/api-auth";
import { getGrant } from "@/lib/grants";
import {
  ACCESS_TOKEN_TYPE,
  mintAccessToken,
  SUBJECT_TOKEN_TYPE_GRANT,
  TOKEN_EXCHANGE_GRANT_TYPE,
  tokenIssuer,
} from "@/lib/token-exchange";
import { logAudit } from "@/lib/audit";
import {
  agentKey,
  consume,
  RATE_LIMITS,
  rateLimitResponse,
} from "@/lib/rate-limit";
import type { GrantScope } from "@/lib/types";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// OAuth 2.0 Token Exchange endpoint (RFC 8693) for capability grants.
//
//   POST /api/v1/oauth/token
//   Authorization: Bearer a2a_<the grant-holder agent's api key>
//   Content-Type: application/x-www-form-urlencoded   (JSON also accepted)
//
//   grant_type=urn:ietf:params:oauth:grant-type:token-exchange
//   subject_token=<grant_id>
//   subject_token_type=urn:x-a2a:params:oauth:token-type:grant
//   scope=read write            (optional — attenuates; must be ⊆ grant)
//   audience=https://peer.example (optional — binds the token's aud)
//
// Returns a short-lived, scope-attenuated access token the holder can hand to
// an EXTERNAL agent to present at our resource endpoints. See lib/token-
// exchange.ts for the token shape + why revocation stays instant.
// ---------------------------------------------------------------------------

function oauthError(
  status: number,
  error: string,
  error_description: string,
): Response {
  return new Response(JSON.stringify({ error, error_description }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

async function readParams(req: Request): Promise<Record<string, string>> {
  const ctype = req.headers.get("content-type") ?? "";
  if (ctype.includes("application/json")) {
    const body = (await req.json()) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(body)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  }
  // Default to form-urlencoded per the OAuth token-endpoint convention.
  const text = await req.text();
  const params = new URLSearchParams(text);
  const out: Record<string, string> = {};
  for (const [k, v] of params) out[k] = v;
  return out;
}

export async function POST(req: Request): Promise<Response> {
  const auth = authenticateRequest(req);
  if (!auth.ok) {
    // OAuth wants invalid_client on bad client auth at the token endpoint.
    return oauthError(auth.status, "invalid_client", auth.error);
  }

  const rl = consume(
    agentKey(auth.agent.id, "token.exchange"),
    RATE_LIMITS.apiTokenExchange,
  );
  if (!rl.allowed) return rateLimitResponse(rl);

  let params: Record<string, string>;
  try {
    params = await readParams(req);
  } catch {
    return oauthError(400, "invalid_request", "Malformed request body.");
  }

  if (params.grant_type !== TOKEN_EXCHANGE_GRANT_TYPE) {
    return oauthError(
      400,
      "unsupported_grant_type",
      `grant_type must be "${TOKEN_EXCHANGE_GRANT_TYPE}".`,
    );
  }
  if (
    params.subject_token_type &&
    params.subject_token_type !== SUBJECT_TOKEN_TYPE_GRANT
  ) {
    return oauthError(
      400,
      "invalid_request",
      `subject_token_type must be "${SUBJECT_TOKEN_TYPE_GRANT}".`,
    );
  }
  if (
    params.requested_token_type &&
    params.requested_token_type !== ACCESS_TOKEN_TYPE
  ) {
    return oauthError(
      400,
      "invalid_request",
      `requested_token_type must be "${ACCESS_TOKEN_TYPE}".`,
    );
  }
  const grantId = params.subject_token;
  if (!grantId) {
    return oauthError(400, "invalid_request", "subject_token (grant id) is required.");
  }

  const grant = getGrant(grantId);
  // Uniform invalid_grant whether the grant is missing OR held by someone
  // else — don't leak which grant ids exist to an authenticated peer probing.
  if (!grant || grant.to_agent_id !== auth.agent.id) {
    logAudit("token.exchange_denied", {
      agentId: auth.agent.id,
      detail: { reason: "grant not found or not held", grant_id: grantId },
    });
    return oauthError(400, "invalid_grant", "Grant not found for this client.");
  }

  const requestedScopes = (params.scope ?? "")
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean) as GrantScope[];
  // audience OR resource (RFC 8707) — resource is a fallback alias.
  const audience = params.audience || params.resource || null;

  const result = mintAccessToken({
    grant,
    using_agent_id: auth.agent.id,
    requested_scopes: requestedScopes.length > 0 ? requestedScopes : null,
    audience,
    issuer: tokenIssuer(new URL(req.url).origin),
  });

  if (!result.ok) {
    logAudit("token.exchange_denied", {
      agentId: auth.agent.id,
      detail: { reason: result.error_description, grant_id: grantId },
    });
    const status = result.error === "server_error" ? 500 : 400;
    return oauthError(status, result.error, result.error_description);
  }

  logAudit("token.exchange", {
    agentId: auth.agent.id,
    detail: {
      grant_id: grantId,
      scope: result.scope,
      audience,
      alg: result.alg,
      expires_in: result.expires_in,
    },
  });

  return new Response(
    JSON.stringify({
      access_token: result.access_token,
      issued_token_type: result.issued_token_type,
      token_type: result.token_type,
      expires_in: result.expires_in,
      scope: result.scope,
    }),
    {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
      },
    },
  );
}
