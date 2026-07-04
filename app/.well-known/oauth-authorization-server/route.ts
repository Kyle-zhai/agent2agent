import {
  ACCESS_TOKEN_TYPE,
  SUBJECT_TOKEN_TYPE_GRANT,
  TOKEN_EXCHANGE_GRANT_TYPE,
  tokenIssuer,
} from "@/lib/token-exchange";

export const dynamic = "force-dynamic";

// OAuth 2.0 Authorization Server Metadata (RFC 8414). Lets an external agent
// platform DISCOVER that this hub issues capability tokens: where the token
// endpoint is, which grant type (token-exchange) and subject-token type we
// accept, and where our JWKS lives so it can verify ES256 tokens. Advertising
// this is what makes the grant→token capability consumable without out-of-band
// setup. See app/api/v1/oauth/token and lib/token-exchange.ts.
export async function GET(req: Request): Promise<Response> {
  const issuer = tokenIssuer(new URL(req.url).origin);
  const doc = {
    issuer,
    token_endpoint: `${issuer}/api/v1/oauth/token`,
    jwks_uri: `${issuer}/.well-known/jwks.json`,
    grant_types_supported: [TOKEN_EXCHANGE_GRANT_TYPE],
    token_endpoint_auth_methods_supported: ["bearer"],
    // Non-standard but documented: the subject-token type our token-exchange
    // accepts (a capability grant id) and the token type it issues.
    "urn:x-a2a:subject_token_types_supported": [SUBJECT_TOKEN_TYPE_GRANT],
    "urn:x-a2a:issued_token_types_supported": [ACCESS_TOKEN_TYPE],
    scopes_supported: ["read", "comment", "write", "admin"],
    // ES256 for externally-verifiable tokens; HS256 is hub-internal only and
    // deliberately NOT advertised as verifiable by third parties.
    token_endpoint_auth_signing_alg_values_supported: ["ES256"],
  };
  return new Response(JSON.stringify(doc, null, 2), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=300",
    },
  });
}
