import "server-only";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  type JsonWebKey,
  type KeyObject,
} from "node:crypto";

// ---------------------------------------------------------------------------
// JWS-signed Agent Cards — A2A v1.0's headline security feature.
//
// Our cards are served publicly and unauthenticated; without a signature any
// party can spoof "one of our agents" (OWASP ASI07). Per the spec, a card
// carries signatures[] where each entry is a detached JWS (RFC 7515) computed
// over the RFC 8785 (JCS) canonical form of the card WITHOUT the signatures
// field. We sign with ES256 (P-256) and publish the public half as a JWKS at
// /.well-known/jwks.json so verifiers can fetch + rotate keys by `kid`.
//
// Signing is opt-in: set A2A_CARD_SIGNING_KEY to a PEM-encoded P-256 private
// key (pkcs8). Without it, cards are served unsigned exactly as before.
// ---------------------------------------------------------------------------

export type AgentCardSignature = {
  /** base64url(JSON of the JWS protected header: { alg, kid, typ }) */
  protected: string;
  /** base64url of the ES256 signature (raw r||s per RFC 7515) */
  signature: string;
};

/** RFC 8785 (JCS) canonicalization, scoped to our card value domain: objects
 *  get lexicographically sorted keys (code-point order, which String.sort
 *  gives us for these ASCII keys), arrays keep order, undefined members are
 *  dropped. Our cards contain only strings/booleans/arrays/objects — no
 *  floats — so JSON.stringify of scalars matches JCS exactly. */
export function canonicalizeJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value
      .map((v) => canonicalizeJson(v === undefined ? null : v))
      .join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalizeJson(v)}`)
    .join(",")}}`;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

let cachedKey: { key: KeyObject; kid: string } | null | undefined;

/** Lazily load the signing key from env. Returns null (and caches the null)
 *  when unset or unparseable — signing silently stays off rather than taking
 *  every card request down with it. */
function signingKey(): { key: KeyObject; kid: string } | null {
  if (cachedKey !== undefined) return cachedKey;
  const pem = process.env.A2A_CARD_SIGNING_KEY;
  if (!pem) {
    cachedKey = null;
    return cachedKey;
  }
  try {
    const key = createPrivateKey(pem);
    // kid = stable fingerprint of the PUBLIC key (DER), so rotation changes it.
    const pub = createPublicKey(key).export({ type: "spki", format: "der" });
    const kid = createHash("sha256").update(pub).digest("hex").slice(0, 16);
    cachedKey = { key, kid };
  } catch (err) {
    // The operator SET a key but it doesn't parse — that's a misconfiguration,
    // not "signing off by choice". Cards will be served UNSIGNED, silently
    // downgrading every remote peer's verification to "unverified". Shout
    // once (the null result is memoized) so it lands in operator logs.
    console.error(
      "A2A_CARD_SIGNING_KEY is set but could not be parsed as a P-256 PKCS#8 PEM — agent cards will be served UNSIGNED",
      err instanceof Error ? err.message : err,
    );
    cachedKey = null;
  }
  return cachedKey;
}

/** Test hook: clear the memoized key after mutating env. */
export function _resetSigningKeyForTests(): void {
  cachedKey = undefined;
}

/** True when an ES256 signing key is configured — capability tokens can then
 *  be signed asymmetrically (ES256) and verified by outside parties against
 *  our public JWKS, rather than falling back to hub-only HS256. */
export function es256Available(): boolean {
  return signingKey() !== null;
}

/** The `kid` (public-key fingerprint) of the configured ES256 key, or null.
 *  Lets callers stamp a compact-JWS header without a throwaway signature. */
export function es256Kid(): string | null {
  return signingKey()?.kid ?? null;
}

/** Sign raw bytes with the ES256 card key (raw r||s per RFC 7515). Returns the
 *  signature + the key's `kid` (so a compact JWS can advertise it), or null
 *  when no key is configured. Reused by the capability token-exchange to issue
 *  externally-verifiable JWTs from the same key that signs Agent Cards. */
export function signDataES256(
  data: Buffer,
): { signature: Buffer; kid: string } | null {
  const k = signingKey();
  if (!k) return null;
  const signature = cryptoSign("sha256", data, {
    key: k.key,
    dsaEncoding: "ieee-p1363",
  });
  return { signature, kid: k.kid };
}

/** Verify raw bytes against OUR OWN ES256 public key (the counterpart of
 *  signDataES256). Used to validate capability tokens this hub issued. Returns
 *  false — never throws — when no key is configured or verification fails. */
export function verifyDataES256(data: Buffer, signature: Buffer): boolean {
  const k = signingKey();
  if (!k) return false;
  try {
    return cryptoVerify(
      "sha256",
      data,
      { key: createPublicKey(k.key), dsaEncoding: "ieee-p1363" },
      signature,
    );
  } catch {
    return false;
  }
}

/** Sign a card object (WITHOUT its signatures field) and return the
 *  signatures array to attach, or null when signing is off. */
export function signAgentCard(
  cardWithoutSignatures: Record<string, unknown>,
): AgentCardSignature[] | null {
  const k = signingKey();
  if (!k) return null;
  const header = { alg: "ES256", kid: k.kid, typ: "JOSE" };
  const protectedB64 = b64url(JSON.stringify(header));
  const payloadB64 = b64url(canonicalizeJson(cardWithoutSignatures));
  const sig = cryptoSign(
    "sha256",
    Buffer.from(`${protectedB64}.${payloadB64}`),
    // JWS wants raw r||s (64 bytes), not ASN.1/DER.
    { key: k.key, dsaEncoding: "ieee-p1363" },
  );
  return [{ protected: protectedB64, signature: b64url(sig) }];
}

/** Verify one of our own signatures (used in tests + available to peers who
 *  pull our JWKS). */
export function verifyAgentCardSignature(
  cardWithoutSignatures: Record<string, unknown>,
  signature: AgentCardSignature,
  publicKeyPem: string,
): boolean {
  try {
    const payloadB64 = b64url(canonicalizeJson(cardWithoutSignatures));
    return cryptoVerify(
      "sha256",
      Buffer.from(`${signature.protected}.${payloadB64}`),
      { key: createPublicKey(publicKeyPem), dsaEncoding: "ieee-p1363" },
      Buffer.from(signature.signature, "base64url"),
    );
  } catch {
    return false;
  }
}

/** Verify a card signature against a JWKS document (RFC 7517) — the
 *  client-side counterpart of signAgentCard, used when WE consume a remote
 *  card and fetch the signer's /.well-known/jwks.json. Tries the key whose
 *  kid matches the protected header first, then any other ES256-capable EC
 *  key (kid is advisory; a rotated set may republish without it). Returns
 *  false on any parse/verify failure — never throws.
 *
 *  Note: the payload is OUR canonicalization of the card. canonicalizeJson
 *  is JCS-exact for the string/bool/int/array/object domain agent cards use;
 *  a remote card with non-integer numbers could canonicalize differently
 *  than its signer's JCS and fail verification — that's the safe direction. */
export function verifyCardSignatureWithJwks(
  cardWithoutSignatures: Record<string, unknown>,
  signature: AgentCardSignature,
  jwks: { keys?: Array<Record<string, unknown>> },
): boolean {
  try {
    const header = JSON.parse(
      Buffer.from(signature.protected, "base64url").toString("utf8"),
    ) as { alg?: string; kid?: string };
    if (header.alg !== "ES256") return false;
    const ecKeys = (jwks.keys ?? []).filter(
      (k) => k && k.kty === "EC" && (k.crv === undefined || k.crv === "P-256"),
    );
    const candidates = [
      ...ecKeys.filter((k) => header.kid !== undefined && k.kid === header.kid),
      ...ecKeys.filter((k) => header.kid === undefined || k.kid !== header.kid),
    ];
    const payloadB64 = b64url(canonicalizeJson(cardWithoutSignatures));
    const data = Buffer.from(`${signature.protected}.${payloadB64}`);
    const sig = Buffer.from(signature.signature, "base64url");
    for (const jwk of candidates) {
      try {
        const key = createPublicKey({ key: jwk as JsonWebKey, format: "jwk" });
        if (cryptoVerify("sha256", data, { key, dsaEncoding: "ieee-p1363" }, sig)) {
          return true;
        }
      } catch {
        // malformed key in the set — try the next one
      }
    }
    return false;
  } catch {
    return false;
  }
}

/** JWKS document for /.well-known/jwks.json — public half of the signing
 *  key, or an empty key set when signing is off. */
export function jwksDocument(): { keys: Array<Record<string, unknown>> } {
  const k = signingKey();
  if (!k) return { keys: [] };
  const jwk = createPublicKey(k.key).export({ format: "jwk" }) as Record<
    string,
    unknown
  >;
  return {
    keys: [{ ...jwk, kid: k.kid, use: "sig", alg: "ES256" }],
  };
}
