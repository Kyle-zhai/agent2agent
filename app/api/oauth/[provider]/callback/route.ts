import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { createSession } from "@/lib/auth";
import {
  getProvider,
  handleCallbackProfile,
  isProviderConfigured,
  oauthStateSecret,
  verifyState,
} from "@/lib/oauth";
import { logAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

const STATE_COOKIE = "a2a_oauth_state";

/** Only allow same-origin relative redirect targets. The attacker can craft
 *  the start URL themselves (`?next=https://evil.com`), so the signed state's
 *  integrity doesn't make the target safe — we must validate it here, at the
 *  post-auth redirect. Rejects absolute URLs and protocol-relative `//` /
 *  backslash tricks. */
function safeNext(next: string | undefined): string {
  if (next && /^\/(?![/\\])/.test(next)) return next;
  return "/app";
}

async function handleCallback(
  req: Request,
  providerId: string,
  code: string | null,
  stateRaw: string | null,
  errorParam: string | null,
): Promise<Response> {
  const provider = getProvider(providerId);
  if (!provider || !isProviderConfigured(providerId)) {
    return new Response("Provider not configured.", { status: 404 });
  }
  if (errorParam) {
    logAudit("auth.oauth_callback_fail", {
      detail: { provider: providerId, error: errorParam },
    });
    redirect(`/sign-in?error=${encodeURIComponent(errorParam)}`);
  }
  if (!code || !stateRaw) {
    redirect(`/sign-in?error=${encodeURIComponent("missing_code_or_state")}`);
  }

  const secret = oauthStateSecret();
  const verified = verifyState(stateRaw!, secret);
  if (!verified.ok) {
    logAudit("auth.oauth_callback_fail", {
      detail: { provider: providerId, reason: verified.error },
    });
    redirect(`/sign-in?error=${encodeURIComponent(verified.error)}`);
  }
  const jar = await cookies();
  const nonceCookie = jar.get(STATE_COOKIE)?.value;
  if (!nonceCookie || nonceCookie !== verified.nonce) {
    logAudit("auth.oauth_callback_fail", {
      detail: { provider: providerId, reason: "nonce_mismatch" },
    });
    redirect(`/sign-in?error=${encodeURIComponent("state_nonce_mismatch")}`);
  }
  jar.delete(STATE_COOKIE);

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

  const redirectTo = safeNext(verified.intent.redirect_to);
  if (verified.intent.invite_code) {
    redirect(
      `/invite/${encodeURIComponent(verified.intent.invite_code)}?just_signed_in=1`,
    );
  }
  redirect(redirectTo);
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ provider: string }> },
): Promise<Response> {
  const { provider } = await params;
  const url = new URL(req.url);
  return handleCallback(
    req,
    provider,
    url.searchParams.get("code"),
    url.searchParams.get("state"),
    url.searchParams.get("error"),
  );
}

// Apple's response_mode=form_post sends the callback as a POST form. We
// accept it on the same route so the rest of the provider abstraction
// doesn't have to branch on transport. content-type is x-www-form-urlencoded.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ provider: string }> },
): Promise<Response> {
  const { provider } = await params;
  const ct = req.headers.get("content-type") ?? "";
  if (!ct.includes("application/x-www-form-urlencoded")) {
    return new Response("Unsupported content-type for OAuth callback POST.", {
      status: 415,
    });
  }
  const form = await req.formData();
  return handleCallback(
    req,
    provider,
    typeof form.get("code") === "string" ? (form.get("code") as string) : null,
    typeof form.get("state") === "string" ? (form.get("state") as string) : null,
    typeof form.get("error") === "string" ? (form.get("error") as string) : null,
  );
}
