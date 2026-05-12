import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { createSession } from "@/lib/auth";
import {
  getProvider,
  handleCallbackProfile,
  isProviderConfigured,
  verifyState,
} from "@/lib/oauth";
import { logAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

const STATE_COOKIE = "a2a_oauth_state";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ provider: string }> },
): Promise<Response> {
  const { provider: providerId } = await params;
  const provider = getProvider(providerId);
  if (!provider || !isProviderConfigured(providerId)) {
    return new Response("Provider not configured.", { status: 404 });
  }
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const stateRaw = url.searchParams.get("state");
  const errorParam = url.searchParams.get("error");

  if (errorParam) {
    logAudit("auth.oauth_callback_fail", {
      detail: { provider: providerId, error: errorParam },
    });
    redirect(`/sign-in?error=${encodeURIComponent(errorParam)}`);
  }
  if (!code || !stateRaw) {
    redirect(`/sign-in?error=${encodeURIComponent("missing_code_or_state")}`);
  }

  const secret = process.env.SESSION_SECRET ?? "dev-fallback-secret";
  const verified = verifyState(stateRaw!, secret);
  if (!verified.ok) {
    logAudit("auth.oauth_callback_fail", {
      detail: { provider: providerId, reason: verified.error },
    });
    redirect(`/sign-in?error=${encodeURIComponent(verified.error)}`);
  }
  // Cross-check the nonce cookie. If absent or mismatched, treat as CSRF.
  const jar = await cookies();
  const nonceCookie = jar.get(STATE_COOKIE)?.value;
  if (!nonceCookie || nonceCookie !== verified.nonce) {
    logAudit("auth.oauth_callback_fail", {
      detail: { provider: providerId, reason: "nonce_mismatch" },
    });
    redirect(`/sign-in?error=${encodeURIComponent("state_nonce_mismatch")}`);
  }
  jar.delete(STATE_COOKIE);

  // Exchange code → token → profile.
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? new URL(req.url).origin;
  const redirectUri = `${baseUrl}/api/oauth/${provider.id}/callback`;
  const clientId = process.env[provider.client_id_env]!;
  const clientSecret = process.env[provider.client_secret_env]!;
  const ctx = { fetch };
  let token, profile;
  try {
    token = await provider.exchange_token({
      code: code!,
      redirect_uri: redirectUri,
      client_id: clientId,
      client_secret: clientSecret,
      ctx,
    });
    profile = await provider.fetch_profile({ token, ctx });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("oauth callback exchange failed", {
      provider: providerId,
      err: msg,
    });
    logAudit("auth.oauth_callback_fail", {
      detail: { provider: providerId, reason: "exchange_failed", err: msg },
    });
    redirect(`/sign-in?error=${encodeURIComponent("exchange_failed")}`);
  }

  let result;
  try {
    result = handleCallbackProfile(providerId, profile!, verified.intent);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logAudit("auth.oauth_callback_fail", {
      detail: { provider: providerId, reason: "handle_failed", err: msg },
    });
    redirect(`/sign-in?error=${encodeURIComponent(msg)}`);
  }

  await createSession(result!.user_id);

  const redirectTo = verified.intent.redirect_to ?? "/app";
  if (verified.intent.invite_code) {
    redirect(
      `/invite/${encodeURIComponent(verified.intent.invite_code)}?just_signed_in=1`,
    );
  }
  redirect(redirectTo);
}
