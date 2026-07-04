import "server-only";
import {
  scryptSync,
  randomBytes,
  timingSafeEqual,
  createHash,
  createHmac,
} from "node:crypto";

const SCRYPT_KEYLEN = 64;

export function hashPassword(plain: string): { hash: string; salt: string } {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(plain, salt, SCRYPT_KEYLEN).toString("hex");
  return { hash, salt };
}

export function verifyPassword(plain: string, hash: string, salt: string): boolean {
  const candidate = scryptSync(plain, salt, SCRYPT_KEYLEN);
  const known = Buffer.from(hash, "hex");
  if (candidate.length !== known.length) return false;
  return timingSafeEqual(candidate, known);
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function sha256HexOfBuffer(input: Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Per-server HMAC secret used to sign capability-scoped grants. In dev
 *  we synthesize a stable secret from the database path so two restarts
 *  on the same machine see consistent signatures; in prod, set
 *  A2A_GRANT_SECRET to a 32-byte hex string and keep it out of git. */
function grantSecret(): string {
  const fromEnv = process.env.A2A_GRANT_SECRET;
  if (fromEnv && fromEnv.length >= 16) return fromEnv;
  // Fail closed in production: a derived secret keyed only on the DB path is
  // predictable (the default "default-dev-secret" is public), so an attacker
  // could forge grant signatures. Refuse rather than sign with it. Dev/test
  // keep the stable derived secret for restart-consistent signatures.
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "A2A_GRANT_SECRET must be set in production (capability-grant signing). Set a 32-byte hex secret.",
    );
  }
  const seed = process.env.A2A_DB_PATH ?? "default-dev-secret";
  return sha256Hex(`grant:${seed}`);
}

export function signGrantPayload(canonicalJson: string): string {
  return createHmac("sha256", grantSecret()).update(canonicalJson).digest("hex");
}

/** Sign an outbound webhook delivery (A2A push notifications). The receiver
 *  recomputes HMAC-SHA256(secret, `${timestamp}.${requestId}.${body}`) and
 *  compares — proving the POST came from us, hasn't been tampered with, and
 *  (via timestamp + requestId) isn't a replay. The secret is the per-config
 *  token the registrant chose at pushNotificationConfig/set time. */
export function signWebhookDelivery(
  secret: string,
  timestamp: string,
  requestId: string,
  body: string,
): string {
  return createHmac("sha256", secret)
    .update(`${timestamp}.${requestId}.${body}`)
    .digest("hex");
}

/** Standard Webhooks (standardwebhooks.com) signature: base64 HMAC-SHA256
 *  over `${msgId}.${timestampSeconds}.${body}`. Sent as `webhook-signature:
 *  v1,<base64>` so off-the-shelf receiver libraries verify our pushes. */
export function signStandardWebhook(
  secret: string,
  msgId: string,
  timestampSeconds: string,
  body: string,
): string {
  return createHmac("sha256", secret)
    .update(`${msgId}.${timestampSeconds}.${body}`)
    .digest("base64");
}

export function verifyGrantSignature(canonicalJson: string, signature: string): boolean {
  const expected = signGrantPayload(canonicalJson);
  if (expected.length !== signature.length) return false;
  // A tampered row can hold a non-hex "signature"; Buffer.from(…, "hex")
  // stops at the first bad char, so the buffers end up different lengths and
  // timingSafeEqual THROWS instead of returning false. Reject malformed hex
  // up front — the comparison below stays constant-time for well-formed input.
  if (!/^[0-9a-f]+$/i.test(signature)) return false;
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signature, "hex"));
}

// ---------------------------------------------------------------------------
// HS256 JWT primitives — used by the capability token-exchange (RFC 8693)
// when no ES256 card-signing key is configured. The token is signed with the
// same per-server grant secret, so it is verifiable BY THIS HUB (and any
// replica sharing the secret) but not by outside parties. When A2A_CARD_
// SIGNING_KEY is set, token-exchange prefers ES256 so external verifiers can
// check tokens against our public JWKS. See lib/token-exchange.ts.
// ---------------------------------------------------------------------------

/** base64url HMAC-SHA256 of the JWS signing input, keyed on the grant secret. */
export function signJwtHs256(signingInput: string): string {
  return createHmac("sha256", grantSecret()).update(signingInput).digest("base64url");
}

/** Constant-time verify of an HS256 JWS signature (base64url) over `signingInput`. */
export function verifyJwtHs256(signingInput: string, signature: string): boolean {
  const expected = Buffer.from(signJwtHs256(signingInput), "utf8");
  const given = Buffer.from(signature, "utf8");
  if (expected.length !== given.length) return false;
  return timingSafeEqual(expected, given);
}
