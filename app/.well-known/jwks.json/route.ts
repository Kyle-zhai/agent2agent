import { jwksDocument } from "@/lib/card-signing";

export const dynamic = "force-dynamic";

// Public JWKS for verifying our JWS-signed Agent Cards (A2A v1.0). Empty key
// set when A2A_CARD_SIGNING_KEY is unset — verifiers treat our cards as
// unsigned. Keys rotate by `kid` (public-key fingerprint).
export async function GET(): Promise<Response> {
  return new Response(JSON.stringify(jwksDocument(), null, 2), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=300",
    },
  });
}
