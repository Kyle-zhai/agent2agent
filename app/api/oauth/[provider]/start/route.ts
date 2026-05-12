import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import {
  getProvider,
  isProviderConfigured,
  newStateNonce,
  signState,
  type OAuthIntent,
} from "@/lib/oauth";
import { getCurrentUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

const STATE_COOKIE = "a2a_oauth_state";
const STATE_TTL_S = 600;

export async function GET(
  req: Request,
  { params }: { params: Promise<{ provider: string }> },
): Promise<Response> {
  const { provider: providerId } = await params;
  const provider = getProvider(providerId);
  if (!provider || !isProviderConfigured(providerId)) {
    return new Response(
      `OAuth provider "${providerId}" is not configured on this server. ` +
        `Set ${provider?.client_id_env ?? "<provider>"} and ` +
        `${provider?.client_secret_env ?? "<secret>"} env vars first.`,
      { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }

  const url = new URL(req.url);
  const mode = (url.searchParams.get("mode") ?? "signin") as "signin" | "link";
  const inviteCode = url.searchParams.get("invite") ?? undefined;
  const redirectTo = url.searchParams.get("next") ?? undefined;

  let intent: OAuthIntent;
  if (mode === "link") {
    const user = await getCurrentUser();
    if (!user) {
      // can't link without being logged in
      redirect("/sign-in?error=login_first");
    }
    intent = {
      mode: "link",
      user_id: user.id,
      redirect_to: redirectTo,
    };
  } else {
    intent = { mode: "signin", invite_code: inviteCode, redirect_to: redirectTo };
  }

  const clientId = process.env[provider.client_id_env]!;
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? new URL(req.url).origin;
  const redirectUri = `${baseUrl}/api/oauth/${provider.id}/callback`;
  const nonce = newStateNonce();
  const secret = process.env.SESSION_SECRET ?? "dev-fallback-secret";
  const state = signState(nonce, secret, intent);

  const jar = await cookies();
  jar.set(STATE_COOKIE, nonce, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: STATE_TTL_S,
    secure: process.env.NODE_ENV === "production",
  });

  const authorizeUrl = provider.build_authorize_url({
    state,
    redirect_uri: redirectUri,
    client_id: clientId,
  });
  redirect(authorizeUrl);
}
