import "server-only";
import { randomBytes } from "node:crypto";
import {
  getGrant,
  isGrantActive,
  parseGrantScopes,
  verifyGrantForUse,
} from "./grants";
import { signJwtHs256, verifyJwtHs256 } from "./crypto";
import {
  es256Available,
  es256Kid,
  signDataES256,
  verifyDataES256,
} from "./card-signing";
import type { GrantResourceType, GrantScope, SharedGrant } from "./types";

// ---------------------------------------------------------------------------
// Capability token-exchange — OAuth 2.0 Token Exchange (RFC 8693) for grants.
//
// A signed capability [[grant]] is powerful but hub-internal: only the
// recipient agent, presenting its own api key, can use it. An EXTERNAL agent
// (Azure AI Foundry / Bedrock AgentCore / Gemini Enterprise) has no way to
// "consume" a grant. RFC 8693 closes that: the grant holder exchanges its
// grant (the subject_token) for a short-lived, scope-ATTENUATED, audience-
// bound access token — a standard compact JWT the external agent presents as
// `Authorization: Bearer <jwt>` to our resource endpoints.
//
// Two properties make this stronger than plain OAuth:
//   1. Attenuation only — requested scope must be a SUBSET of the grant's.
//   2. The token is re-validated against its underlying grant on every use,
//      so REVOKING or EXPIRING the grant instantly kills every token minted
//      from it (revoke即断), on top of the token's own short exp.
//
// Signing: ES256 (our card-signing key) when configured, so outside parties
// verify tokens against our public JWKS at /.well-known/jwks.json; otherwise
// HS256 with the per-server grant secret (hub-verifiable, works out of the
// box). The header `alg` records which; verification accepts ONLY these two
// and rejects `none` / unexpected algs (alg-confusion defense).
// ---------------------------------------------------------------------------

export const TOKEN_EXCHANGE_GRANT_TYPE =
  "urn:ietf:params:oauth:grant-type:token-exchange";
export const SUBJECT_TOKEN_TYPE_GRANT =
  "urn:x-a2a:params:oauth:token-type:grant";
export const ACCESS_TOKEN_TYPE =
  "urn:ietf:params:oauth:token-type:access_token";

const DEFAULT_TTL_SECONDS = 300; // 5 min
const MAX_TTL_SECONDS = 3600; // 1 h — hard ceiling regardless of request
const CLOCK_SKEW_SECONDS = 60;

export type CapabilityClaims = {
  agent_id: string; // sub — the acting (grant-holder) agent
  from_agent_id: string; // the granting agent
  resource_type: GrantResourceType;
  resource_id: string;
  scopes: GrantScope[];
  grant_id: string;
  audience: string | null;
  jti: string;
  expires_at: number; // epoch seconds
};

type Header = { alg: "ES256" | "HS256"; typ: string; kid?: string };
type Payload = {
  iss: string;
  sub: string;
  aud?: string;
  iat: number;
  nbf: number;
  exp: number;
  jti: string;
  scope: string;
  a2a: {
    grant_id: string;
    resource_type: GrantResourceType;
    resource_id: string;
    from_agent_id: string;
  };
};

function b64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeSegment<T>(seg: string): T | null {
  try {
    return JSON.parse(Buffer.from(seg, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}

/** The issuer/audience origin for tokens this hub mints. Prefer the configured
 *  public origin so tokens verify identically regardless of which request URL
 *  minted them; fall back to the request origin in dev. */
export function tokenIssuer(reqOrigin?: string): string {
  return process.env.NEXT_PUBLIC_APP_URL ?? reqOrigin ?? "http://localhost:3000";
}

export type MintInput = {
  grant: SharedGrant;
  using_agent_id: string;
  requested_scopes?: GrantScope[] | null;
  audience?: string | null;
  ttl_seconds?: number | null;
  issuer: string;
};

export type MintResult =
  | {
      ok: true;
      access_token: string;
      token_type: "Bearer";
      issued_token_type: string;
      expires_in: number;
      scope: string;
      alg: "ES256" | "HS256";
    }
  | { ok: false; error: string; error_description: string };

/** Mint a capability access token from a grant the caller holds. Enforces
 *  attenuation (requested ⊆ grant scopes) and caps expiry at the grant's own
 *  expiry so a token can never outlive its grant. */
export function mintAccessToken(input: MintInput): MintResult {
  const g = input.grant;
  if (g.to_agent_id !== input.using_agent_id) {
    return {
      ok: false,
      error: "invalid_grant",
      error_description: "Grant is not held by the authenticated agent.",
    };
  }
  const nowMs = Date.now();
  if (!isGrantActive(g, nowMs)) {
    return {
      ok: false,
      error: "invalid_grant",
      error_description:
        g.revoked_at !== null ? "Grant has been revoked." : "Grant has expired.",
    };
  }
  const grantScopes = parseGrantScopes(g);
  if (grantScopes.length === 0) {
    return {
      ok: false,
      error: "invalid_grant",
      error_description: "Grant carries no usable scopes.",
    };
  }
  // Attenuation: default to the full grant scope set; a requested set may only
  // narrow it, never widen. A grant carrying "admin" covers every scope (same
  // rule verifyGrantForUse enforces), so an admin holder may mint a token for
  // any narrower scope — the token then carries EXACTLY what was requested
  // (least privilege), not the blanket admin.
  let scopes: GrantScope[];
  if (input.requested_scopes && input.requested_scopes.length > 0) {
    const grantSet = new Set(grantScopes);
    const covers = (s: GrantScope) => grantSet.has(s) || grantSet.has("admin");
    const bad = input.requested_scopes.filter((s) => !covers(s));
    if (bad.length > 0) {
      return {
        ok: false,
        error: "invalid_scope",
        error_description: `Requested scope exceeds the grant: ${bad.join(", ")}.`,
      };
    }
    scopes = Array.from(new Set(input.requested_scopes)).sort();
  } else {
    scopes = [...grantScopes].sort();
  }

  const nowSec = Math.floor(nowMs / 1000);
  let ttl = input.ttl_seconds ?? DEFAULT_TTL_SECONDS;
  if (!Number.isFinite(ttl) || ttl <= 0) ttl = DEFAULT_TTL_SECONDS;
  ttl = Math.min(Math.floor(ttl), MAX_TTL_SECONDS);
  let exp = nowSec + ttl;
  // Never outlive the grant. expires_at is epoch ms.
  if (g.expires_at !== null) {
    const grantExpSec = Math.floor(g.expires_at / 1000);
    if (grantExpSec <= nowSec) {
      return {
        ok: false,
        error: "invalid_grant",
        error_description: "Grant has expired.",
      };
    }
    exp = Math.min(exp, grantExpSec);
  }
  const expiresIn = exp - nowSec;

  const payload: Payload = {
    iss: input.issuer,
    sub: input.using_agent_id,
    iat: nowSec,
    nbf: nowSec,
    exp,
    jti: `tok_${randomBytes(16).toString("hex")}`,
    scope: scopes.join(" "),
    a2a: {
      grant_id: g.id,
      resource_type: g.resource_type as GrantResourceType,
      resource_id: g.resource_id,
      from_agent_id: g.from_agent_id,
    },
  };
  if (input.audience) payload.aud = input.audience;

  const payloadB64 = b64urlJson(payload);

  const kid = es256Kid();
  if (kid) {
    // Header carries the kid so external verifiers select the right JWKS key.
    const header: Header = { alg: "ES256", typ: "at+jwt", kid };
    const headerB64 = b64urlJson(header);
    const signingInput = `${headerB64}.${payloadB64}`;
    const signed = signDataES256(Buffer.from(signingInput, "utf8"));
    if (!signed) {
      return {
        ok: false,
        error: "server_error",
        error_description: "Signing key unavailable.",
      };
    }
    return {
      ok: true,
      access_token: `${signingInput}.${signed.signature.toString("base64url")}`,
      token_type: "Bearer",
      issued_token_type: ACCESS_TOKEN_TYPE,
      expires_in: expiresIn,
      scope: payload.scope,
      alg: "ES256",
    };
  }

  const header: Header = { alg: "HS256", typ: "at+jwt" };
  const signingInput = `${b64urlJson(header)}.${payloadB64}`;
  return {
    ok: true,
    access_token: `${signingInput}.${signJwtHs256(signingInput)}`,
    token_type: "Bearer",
    issued_token_type: ACCESS_TOKEN_TYPE,
    expires_in: expiresIn,
    scope: payload.scope,
    alg: "HS256",
  };
}

export type VerifyResult =
  | { ok: true; claims: CapabilityClaims }
  | { ok: false; reason: string };

/** Verify a capability access token and re-validate it against its underlying
 *  grant. A token is good only if: it parses, the alg is one we issue, the
 *  signature checks out, iss matches, it is inside its nbf/exp window, and the
 *  grant it references is STILL active, unrevoked, signature-valid, held by the
 *  same sub, and covers the same resource + a superset of the token's scopes.
 *  The grant re-check is what makes revocation instant. */
export function verifyAccessToken(
  token: string,
  opts: { issuer: string; audience?: string | null; now?: number },
): VerifyResult {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed token" };
  const [headerB64, payloadB64, sigB64] = parts;
  const header = decodeSegment<Header>(headerB64);
  if (!header) return { ok: false, reason: "bad header" };
  // Only the two algs we issue — never `none`, never an unexpected family.
  if (header.alg !== "ES256" && header.alg !== "HS256") {
    return { ok: false, reason: `unsupported alg "${String(header.alg)}"` };
  }
  const signingInput = `${headerB64}.${payloadB64}`;
  let sigOk = false;
  if (header.alg === "ES256") {
    // If no ES256 key is configured, we cannot have issued an ES256 token —
    // refuse rather than silently trying HS256 (alg-confusion defense).
    if (!es256Available()) return { ok: false, reason: "ES256 not configured" };
    try {
      sigOk = verifyDataES256(
        Buffer.from(signingInput, "utf8"),
        Buffer.from(sigB64, "base64url"),
      );
    } catch {
      sigOk = false;
    }
  } else {
    sigOk = verifyJwtHs256(signingInput, sigB64);
  }
  if (!sigOk) return { ok: false, reason: "signature mismatch" };

  const payload = decodeSegment<Payload>(payloadB64);
  if (!payload || typeof payload !== "object") {
    return { ok: false, reason: "bad payload" };
  }
  if (payload.iss !== opts.issuer) return { ok: false, reason: "issuer mismatch" };
  const nowSec = Math.floor((opts.now ?? Date.now()) / 1000);
  if (typeof payload.exp !== "number" || payload.exp <= nowSec) {
    return { ok: false, reason: "token expired" };
  }
  if (typeof payload.nbf === "number" && payload.nbf > nowSec + CLOCK_SKEW_SECONDS) {
    return { ok: false, reason: "token not yet valid" };
  }
  if (
    opts.audience &&
    payload.aud !== undefined &&
    payload.aud !== opts.audience
  ) {
    return { ok: false, reason: "audience mismatch" };
  }
  const a2a = payload.a2a;
  if (!a2a || typeof a2a.grant_id !== "string") {
    return { ok: false, reason: "missing grant reference" };
  }

  // Re-validate against the live grant — this is what makes revoke/expire
  // instant and stops a token from outliving its authority.
  const grant = getGrant(a2a.grant_id);
  if (!grant) return { ok: false, reason: "grant no longer exists" };
  if (grant.to_agent_id !== payload.sub) {
    return { ok: false, reason: "grant holder changed" };
  }
  // Confirm resource pin still matches the token.
  if (
    grant.resource_type !== a2a.resource_type ||
    grant.resource_id !== a2a.resource_id
  ) {
    return { ok: false, reason: "grant resource changed" };
  }
  const tokenScopes = payload.scope
    .split(/\s+/)
    .filter((s): s is GrantScope => s === "read" || s === "comment" || s === "write" || s === "admin");
  // The token's scopes must still be authorized by the grant. Use the first
  // scope only to drive verifyGrantForUse's active+signature+scope check; then
  // confirm the remaining token scopes are a subset of the grant's.
  const liveScopes = new Set(parseGrantScopes(grant));
  const superset =
    tokenScopes.length > 0 &&
    tokenScopes.every((s) => liveScopes.has(s) || liveScopes.has("admin"));
  if (!superset) {
    return { ok: false, reason: "token scopes exceed live grant" };
  }
  // verifyGrantForUse also stamps last_used_at, checks the grant signature
  // (anti-tamper), active window, and that sub holds it. Drive it with a
  // representative scope the token claims.
  const check = verifyGrantForUse({
    grant_id: grant.id,
    using_agent_id: payload.sub,
    required_scope: tokenScopes[0],
  });
  if (!check.ok) return { ok: false, reason: check.reason };

  return {
    ok: true,
    claims: {
      agent_id: payload.sub,
      from_agent_id: a2a.from_agent_id,
      resource_type: a2a.resource_type,
      resource_id: a2a.resource_id,
      scopes: tokenScopes,
      grant_id: a2a.grant_id,
      audience: payload.aud ?? null,
      jti: payload.jti,
      expires_at: payload.exp,
    },
  };
}

/** Does a verified capability authorize `required_scope` on this resource?
 *  Exact resource match (mirrors agentMayUseResource — no cross-type widening),
 *  scope satisfied directly or by "admin". */
export function capabilityAllows(
  claims: CapabilityClaims,
  resource_type: GrantResourceType,
  resource_id: string,
  required_scope: GrantScope,
): boolean {
  if (claims.resource_type !== resource_type) return false;
  if (claims.resource_id !== resource_id) return false;
  return claims.scopes.includes(required_scope) || claims.scopes.includes("admin");
}
