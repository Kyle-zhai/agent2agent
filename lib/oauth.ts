import "server-only";
import {
  randomBytes,
  createHash,
  timingSafeEqual,
  createPublicKey,
  verify as cryptoVerify,
} from "node:crypto";
import { db } from "./db";
import { newOAuthIdentityId, newUserId } from "./ids";
import { logAudit } from "./audit";
import { markUserEmailVerified } from "./auth";

// -------------------------------------------------------------------------
// Standard profile shape — every provider extract_profile returns this.
// -------------------------------------------------------------------------

export type OAuthProfile = {
  provider_user_id: string;
  display_name: string;
  email: string | null;
  avatar_url: string | null;
  raw: Record<string, unknown>;
};

export type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  raw: Record<string, unknown>;
};

export type OAuthCtx = {
  fetch: typeof fetch;
};

export type ProviderConfig = {
  id: string;
  display_name: string;
  emoji: string;
  scope: string;
  client_id_env: string;
  client_secret_env: string;
  build_authorize_url: (params: {
    state: string;
    redirect_uri: string;
    client_id: string;
  }) => string;
  exchange_token: (params: {
    code: string;
    redirect_uri: string;
    client_id: string;
    client_secret: string;
    ctx: OAuthCtx;
  }) => Promise<TokenResponse>;
  fetch_profile: (params: {
    token: TokenResponse;
    ctx: OAuthCtx;
  }) => Promise<OAuthProfile>;
};

// -------------------------------------------------------------------------
// Provider implementations
// -------------------------------------------------------------------------

const google: ProviderConfig = {
  id: "google",
  display_name: "Google",
  emoji: "🟢",
  scope: "openid email profile",
  client_id_env: "A2A_OAUTH_GOOGLE_CLIENT_ID",
  client_secret_env: "A2A_OAUTH_GOOGLE_CLIENT_SECRET",
  build_authorize_url({ state, redirect_uri, client_id }) {
    const p = new URLSearchParams({
      client_id,
      redirect_uri,
      response_type: "code",
      scope: "openid email profile",
      state,
      access_type: "offline",
      prompt: "select_account",
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
  },
  async exchange_token({ code, redirect_uri, client_id, client_secret, ctx }) {
    const body = new URLSearchParams({
      code,
      client_id,
      client_secret,
      redirect_uri,
      grant_type: "authorization_code",
    });
    const r = await ctx.fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!r.ok) throw new Error(`google token ${r.status}: ${await r.text()}`);
    const j = (await r.json()) as Record<string, unknown>;
    return {
      access_token: String(j.access_token ?? ""),
      refresh_token: typeof j.refresh_token === "string" ? j.refresh_token : undefined,
      expires_in: typeof j.expires_in === "number" ? j.expires_in : undefined,
      raw: j,
    };
  },
  async fetch_profile({ token, ctx }) {
    const r = await ctx.fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { authorization: `Bearer ${token.access_token}` },
    });
    if (!r.ok) throw new Error(`google userinfo ${r.status}`);
    const j = (await r.json()) as Record<string, unknown>;
    return {
      provider_user_id: String(j.sub ?? ""),
      display_name: String(j.name ?? j.email ?? "Google user"),
      email: typeof j.email === "string" ? j.email : null,
      avatar_url: typeof j.picture === "string" ? j.picture : null,
      raw: j,
    };
  },
};

const github: ProviderConfig = {
  id: "github",
  display_name: "GitHub",
  emoji: "🐙",
  scope: "read:user user:email",
  client_id_env: "A2A_OAUTH_GITHUB_CLIENT_ID",
  client_secret_env: "A2A_OAUTH_GITHUB_CLIENT_SECRET",
  build_authorize_url({ state, redirect_uri, client_id }) {
    const p = new URLSearchParams({
      client_id,
      redirect_uri,
      scope: "read:user user:email",
      state,
      allow_signup: "true",
    });
    return `https://github.com/login/oauth/authorize?${p}`;
  },
  async exchange_token({ code, redirect_uri, client_id, client_secret, ctx }) {
    const body = new URLSearchParams({ code, client_id, client_secret, redirect_uri });
    const r = await ctx.fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body,
    });
    if (!r.ok) throw new Error(`github token ${r.status}`);
    const j = (await r.json()) as Record<string, unknown>;
    if (typeof j.error === "string") {
      throw new Error(`github error: ${j.error}`);
    }
    return {
      access_token: String(j.access_token ?? ""),
      raw: j,
    };
  },
  async fetch_profile({ token, ctx }) {
    const headers = {
      authorization: `Bearer ${token.access_token}`,
      "user-agent": "Agent2Agent",
      accept: "application/json",
    };
    const userResp = await ctx.fetch("https://api.github.com/user", { headers });
    if (!userResp.ok) throw new Error(`github user ${userResp.status}`);
    const u = (await userResp.json()) as Record<string, unknown>;
    let email: string | null = typeof u.email === "string" ? u.email : null;
    if (!email) {
      const emailsResp = await ctx.fetch("https://api.github.com/user/emails", {
        headers,
      });
      if (emailsResp.ok) {
        const arr = (await emailsResp.json()) as Array<{
          email: string;
          primary: boolean;
          verified: boolean;
        }>;
        const primary = arr.find((e) => e.primary && e.verified) ?? arr[0];
        if (primary) email = primary.email;
      }
    }
    return {
      provider_user_id: String(u.id ?? ""),
      display_name: String(u.name ?? u.login ?? "GitHub user"),
      email,
      avatar_url: typeof u.avatar_url === "string" ? u.avatar_url : null,
      raw: u,
    };
  },
};

// Verify an Apple id_token: RS256 signature against Apple's published JWKS,
// plus issuer / audience / expiry. Returns the verified claims, or throws.
// Without this an attacker could mint a token with any victim's `sub` and be
// signed in as them, since `sub` is the sole identity key.
async function verifyAppleIdToken(
  idToken: string,
  expectedAud: string,
  ctx: OAuthCtx,
): Promise<Record<string, unknown>> {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("apple id_token malformed");
  const header = JSON.parse(
    Buffer.from(parts[0], "base64url").toString("utf8"),
  ) as { alg?: string; kid?: string };
  if (header.alg !== "RS256") throw new Error("apple id_token unexpected alg");
  if (!header.kid) throw new Error("apple id_token missing kid");

  const jwksRes = await ctx.fetch("https://appleid.apple.com/auth/keys");
  if (!jwksRes.ok) throw new Error(`apple jwks fetch ${jwksRes.status}`);
  const jwks = (await jwksRes.json()) as {
    keys?: Array<{ kty: string; kid: string; n: string; e: string }>;
  };
  const jwk = (jwks.keys ?? []).find((k) => k.kid === header.kid);
  if (!jwk) throw new Error("apple id_token signing key not found");

  const pubKey = createPublicKey({
    key: { kty: jwk.kty, n: jwk.n, e: jwk.e },
    format: "jwk",
  });
  const signed = Buffer.from(`${parts[0]}.${parts[1]}`);
  const sig = Buffer.from(parts[2], "base64url");
  if (!cryptoVerify("RSA-SHA256", signed, pubKey, sig)) {
    throw new Error("apple id_token signature invalid");
  }

  const claims = JSON.parse(
    Buffer.from(parts[1], "base64url").toString("utf8"),
  ) as Record<string, unknown>;
  if (claims.iss !== "https://appleid.apple.com") {
    throw new Error("apple id_token bad issuer");
  }
  const aud = claims.aud;
  const audOk =
    aud === expectedAud || (Array.isArray(aud) && aud.includes(expectedAud));
  if (!audOk) throw new Error("apple id_token bad audience");
  const exp = typeof claims.exp === "number" ? claims.exp : 0;
  if (exp * 1000 <= Date.now()) throw new Error("apple id_token expired");
  return claims;
}

const apple: ProviderConfig = {
  id: "apple",
  display_name: "Apple",
  emoji: "🍎",
  scope: "name email",
  client_id_env: "A2A_OAUTH_APPLE_CLIENT_ID",
  client_secret_env: "A2A_OAUTH_APPLE_CLIENT_SECRET",
  build_authorize_url({ state, redirect_uri, client_id }) {
    const p = new URLSearchParams({
      client_id,
      redirect_uri,
      response_type: "code",
      scope: "name email",
      state,
      response_mode: "form_post",
    });
    return `https://appleid.apple.com/auth/authorize?${p}`;
  },
  async exchange_token({ code, redirect_uri, client_id, client_secret, ctx }) {
    // Apple's client_secret is itself a short-lived JWT signed by the
    // dev's private key — the env var is expected to hold the already-
    // generated JWT (rotation cron generates it). See OAUTH.md.
    const body = new URLSearchParams({
      code,
      client_id,
      client_secret,
      redirect_uri,
      grant_type: "authorization_code",
    });
    const r = await ctx.fetch("https://appleid.apple.com/auth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!r.ok) throw new Error(`apple token ${r.status}: ${await r.text()}`);
    const j = (await r.json()) as Record<string, unknown>;
    return {
      access_token: String(j.access_token ?? ""),
      refresh_token: typeof j.refresh_token === "string" ? j.refresh_token : undefined,
      raw: j,
    };
  },
  async fetch_profile({ token, ctx }) {
    // Apple returns identity as a signed JWT (id_token), not a userinfo
    // endpoint. The signature + iss/aud/exp MUST be verified before trusting
    // `sub`, which is the sole key used to resolve the A2A account.
    const idToken = String((token.raw as { id_token?: string }).id_token ?? "");
    const expectedAud = process.env.A2A_OAUTH_APPLE_CLIENT_ID ?? "";
    if (!idToken || !expectedAud) {
      throw new Error("apple id_token or client id missing");
    }
    const claims = await verifyAppleIdToken(idToken, expectedAud, ctx);
    const sub = String(claims.sub ?? "");
    if (!sub) throw new Error("apple id_token has no subject");
    return {
      provider_user_id: sub,
      display_name: typeof claims.email === "string" ? claims.email : "Apple user",
      email: typeof claims.email === "string" ? claims.email : null,
      avatar_url: null,
      raw: claims,
    };
  },
};

const wechat: ProviderConfig = {
  id: "wechat",
  display_name: "WeChat",
  emoji: "💚",
  scope: "snsapi_login",
  client_id_env: "A2A_OAUTH_WECHAT_APP_ID",
  client_secret_env: "A2A_OAUTH_WECHAT_APP_SECRET",
  build_authorize_url({ state, redirect_uri, client_id }) {
    // WeChat uses "appid" instead of "client_id" and lives on a different host.
    const p = new URLSearchParams({
      appid: client_id,
      redirect_uri,
      response_type: "code",
      scope: "snsapi_login",
      state,
    });
    return `https://open.weixin.qq.com/connect/qrconnect?${p}#wechat_redirect`;
  },
  async exchange_token({ code, client_id, client_secret, ctx }) {
    const u = new URL("https://api.weixin.qq.com/sns/oauth2/access_token");
    u.searchParams.set("appid", client_id);
    u.searchParams.set("secret", client_secret);
    u.searchParams.set("code", code);
    u.searchParams.set("grant_type", "authorization_code");
    const r = await ctx.fetch(u.toString());
    if (!r.ok) throw new Error(`wechat token ${r.status}`);
    const j = (await r.json()) as Record<string, unknown>;
    if (j.errcode) throw new Error(`wechat error: ${JSON.stringify(j)}`);
    return {
      access_token: String(j.access_token ?? ""),
      refresh_token: typeof j.refresh_token === "string" ? j.refresh_token : undefined,
      expires_in: typeof j.expires_in === "number" ? j.expires_in : undefined,
      raw: j,
    };
  },
  async fetch_profile({ token, ctx }) {
    const openid = String((token.raw as { openid?: string }).openid ?? "");
    const u = new URL("https://api.weixin.qq.com/sns/userinfo");
    u.searchParams.set("access_token", token.access_token);
    u.searchParams.set("openid", openid);
    const r = await ctx.fetch(u.toString());
    if (!r.ok) throw new Error(`wechat userinfo ${r.status}`);
    const j = (await r.json()) as Record<string, unknown>;
    return {
      // Prefer unionid (stable across one publisher's apps) over openid.
      provider_user_id: String(j.unionid ?? j.openid ?? openid),
      display_name: String(j.nickname ?? "WeChat user"),
      email: null,
      avatar_url: typeof j.headimgurl === "string" ? j.headimgurl : null,
      raw: j,
    };
  },
};

const instagram: ProviderConfig = {
  id: "instagram",
  display_name: "Instagram",
  emoji: "📷",
  scope: "user_profile",
  client_id_env: "A2A_OAUTH_INSTAGRAM_CLIENT_ID",
  client_secret_env: "A2A_OAUTH_INSTAGRAM_CLIENT_SECRET",
  build_authorize_url({ state, redirect_uri, client_id }) {
    const p = new URLSearchParams({
      client_id,
      redirect_uri,
      response_type: "code",
      scope: "user_profile,user_media",
      state,
    });
    return `https://api.instagram.com/oauth/authorize?${p}`;
  },
  async exchange_token({ code, redirect_uri, client_id, client_secret, ctx }) {
    const body = new URLSearchParams({
      client_id,
      client_secret,
      code,
      redirect_uri,
      grant_type: "authorization_code",
    });
    const r = await ctx.fetch("https://api.instagram.com/oauth/access_token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!r.ok) throw new Error(`instagram token ${r.status}: ${await r.text()}`);
    const j = (await r.json()) as Record<string, unknown>;
    return {
      access_token: String(j.access_token ?? ""),
      raw: j,
    };
  },
  async fetch_profile({ token, ctx }) {
    const u = new URL("https://graph.instagram.com/me");
    u.searchParams.set("fields", "id,username,account_type");
    u.searchParams.set("access_token", token.access_token);
    const r = await ctx.fetch(u.toString());
    if (!r.ok) throw new Error(`instagram me ${r.status}`);
    const j = (await r.json()) as Record<string, unknown>;
    return {
      provider_user_id: String(j.id ?? ""),
      display_name: String(j.username ?? "Instagram user"),
      email: null,
      avatar_url: null,
      raw: j,
    };
  },
};

export const PROVIDERS: Record<string, ProviderConfig> = {
  google,
  github,
  apple,
  wechat,
  instagram,
};

// -------------------------------------------------------------------------
// Configuration helpers
// -------------------------------------------------------------------------

export function getProvider(id: string): ProviderConfig | null {
  return PROVIDERS[id] ?? null;
}

export function listConfiguredProviders(): Array<{
  id: string;
  display_name: string;
  emoji: string;
}> {
  return Object.values(PROVIDERS)
    .filter((p) => !!process.env[p.client_id_env] && !!process.env[p.client_secret_env])
    .map((p) => ({ id: p.id, display_name: p.display_name, emoji: p.emoji }));
}

export function isProviderConfigured(id: string): boolean {
  const p = getProvider(id);
  if (!p) return false;
  return !!process.env[p.client_id_env] && !!process.env[p.client_secret_env];
}

// -------------------------------------------------------------------------
// State cookie helpers (CSRF + post-callback intent)
// -------------------------------------------------------------------------

export type OAuthIntent = {
  mode: "signin" | "link";
  user_id?: string; // present when mode === "link"
  invite_code?: string;
  redirect_to?: string;
};

export function newStateNonce(): string {
  return randomBytes(24).toString("base64url");
}

/** Secret used to HMAC-sign the OAuth `state` parameter. Fail closed in
 *  production: the old `?? "dev-fallback-secret"` literal is public, so an
 *  attacker could forge state and inject intent (account takeover). Refuse to
 *  sign/verify with it in prod; dev keeps the literal for zero-config local. */
export function oauthStateSecret(): string {
  const s = process.env.SESSION_SECRET;
  if (s) return s;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "SESSION_SECRET must be set in production to sign OAuth state. Set a random 32-byte secret.",
    );
  }
  return "dev-fallback-secret";
}

export function signState(nonce: string, secret: string, intent: OAuthIntent): string {
  const intentJson = JSON.stringify(intent);
  const intentB64 = Buffer.from(intentJson, "utf8").toString("base64url");
  const mac = createHash("sha256")
    .update(`${nonce}.${intentB64}.${secret}`)
    .digest("hex")
    .slice(0, 32);
  return `${nonce}.${intentB64}.${mac}`;
}

export function verifyState(
  state: string,
  secret: string,
): { ok: true; nonce: string; intent: OAuthIntent } | { ok: false; error: string } {
  const parts = state.split(".");
  if (parts.length !== 3) return { ok: false, error: "bad_state_format" };
  const [nonce, intentB64, mac] = parts;
  const expected = createHash("sha256")
    .update(`${nonce}.${intentB64}.${secret}`)
    .digest("hex")
    .slice(0, 32);
  // Constant-time compare — `!==` would leak the prefix match length and
  // (combined with retries) let an attacker forge a state. timingSafeEqual
  // throws if lengths differ, so guard that first; mismatched length itself
  // is the structural error case caught upstream.
  if (mac.length !== expected.length) {
    return { ok: false, error: "bad_state_mac" };
  }
  if (
    !timingSafeEqual(
      Buffer.from(expected, "utf8"),
      Buffer.from(mac, "utf8"),
    )
  ) {
    return { ok: false, error: "bad_state_mac" };
  }
  let intent: OAuthIntent;
  try {
    intent = JSON.parse(Buffer.from(intentB64, "base64url").toString("utf8"));
  } catch {
    return { ok: false, error: "bad_state_intent" };
  }
  return { ok: true, nonce, intent };
}

// -------------------------------------------------------------------------
// Persistence
// -------------------------------------------------------------------------

export type OAuthIdentity = {
  id: string;
  user_id: string;
  provider: string;
  provider_user_id: string;
  display_name: string;
  email: string | null;
  avatar_url: string | null;
  profile_json: string;
  created_at: number;
  updated_at: number;
};

export function findIdentityByProviderUser(
  provider: string,
  providerUserId: string,
): OAuthIdentity | null {
  return (
    (db()
      .prepare(
        `SELECT id, user_id, provider, provider_user_id, display_name, email, avatar_url,
                profile_json, created_at, updated_at
         FROM oauth_identities WHERE provider = ? AND provider_user_id = ?`,
      )
      .get(provider, providerUserId) as OAuthIdentity | undefined) ?? null
  );
}

export function listIdentitiesForUser(userId: string): OAuthIdentity[] {
  return db()
    .prepare(
      `SELECT id, user_id, provider, provider_user_id, display_name, email, avatar_url,
              profile_json, created_at, updated_at
       FROM oauth_identities WHERE user_id = ?
       ORDER BY created_at ASC`,
    )
    .all(userId) as OAuthIdentity[];
}

export function upsertIdentity(
  userId: string,
  provider: string,
  profile: OAuthProfile,
): OAuthIdentity {
  const now = Date.now();
  const existing = findIdentityByProviderUser(provider, profile.provider_user_id);
  if (existing) {
    if (existing.user_id !== userId) {
      throw new Error(
        `This ${provider} account is already linked to another A2A user.`,
      );
    }
    db()
      .prepare(
        `UPDATE oauth_identities
         SET display_name = ?, email = ?, avatar_url = ?, profile_json = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        profile.display_name,
        profile.email,
        profile.avatar_url,
        JSON.stringify(profile.raw),
        now,
        existing.id,
      );
    return findIdentityByProviderUser(provider, profile.provider_user_id)!;
  }
  const id = newOAuthIdentityId();
  try {
    db()
      .prepare(
        `INSERT INTO oauth_identities
         (id, user_id, provider, provider_user_id, display_name, email, avatar_url,
          profile_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        userId,
        provider,
        profile.provider_user_id,
        profile.display_name,
        profile.email,
        profile.avatar_url,
        JSON.stringify(profile.raw),
        now,
        now,
      );
  } catch (err) {
    if (err instanceof Error && err.message.includes("UNIQUE")) {
      throw new Error(
        `You already linked ${provider} to a different identity in your A2A account.`,
      );
    }
    throw err;
  }
  return findIdentityByProviderUser(provider, profile.provider_user_id)!;
}

export function unlinkIdentity(userId: string, provider: string): void {
  const rows = db()
    .prepare(
      "SELECT COUNT(*) AS n FROM oauth_identities WHERE user_id = ?",
    )
    .get(userId) as { n: number };
  const passwordRow = db()
    .prepare("SELECT password_hash FROM users WHERE id = ?")
    .get(userId) as { password_hash: string } | undefined;
  const hasPassword = !!passwordRow?.password_hash;
  if (rows.n <= 1 && !hasPassword) {
    throw new Error(
      "Cannot unlink your only sign-in method. Set a password first.",
    );
  }
  db()
    .prepare("DELETE FROM oauth_identities WHERE user_id = ? AND provider = ?")
    .run(userId, provider);
  logAudit("auth.oauth_unlink", { userId, detail: { provider } });
}

// -------------------------------------------------------------------------
// Flow orchestration
// -------------------------------------------------------------------------

export type CallbackResult =
  | { kind: "signin"; user_id: string; identity: OAuthIdentity }
  | { kind: "signup"; user_id: string; identity: OAuthIdentity }
  | { kind: "link"; user_id: string; identity: OAuthIdentity };

export function newOAuthUser(profile: OAuthProfile, provider: string): string {
  const id = newUserId();
  const now = Date.now();
  // Use the profile email as the user's email when available; otherwise a
  // synthetic placeholder that can be replaced later in /app/me.
  const email =
    profile.email ??
    `${provider}-${profile.provider_user_id}@oauth.invalid`;
  const displayName = profile.display_name || `${provider} user`;
  // Password is empty (length-0 hash) — sign-in requires OAuth until the
  // user sets one via /app/settings.
  db()
    .prepare(
      `INSERT INTO users
       (id, email, display_name, password_hash, password_salt, email_verified_at, created_at)
       VALUES (?, ?, ?, '', '', ?, ?)`,
    )
    .run(id, email, displayName, profile.email ? now : null, now);
  // Best-effort: pull the provider avatar so the user has a visual identity
  // from sign-up. Fire-and-forget — failure here must not block sign-in.
  if (profile.avatar_url) {
    void pullOAuthAvatar(id, profile.avatar_url).catch((err) => {
      console.warn("oauth avatar pull failed", {
        user_id: id,
        provider,
        err: err instanceof Error ? err.message : String(err),
      });
    });
  }
  return id;
}

const AVATAR_PULL_TIMEOUT_MS = 6_000;
const AVATAR_MAX_BYTES = 1 * 1024 * 1024;

async function pullOAuthAvatar(userId: string, url: string): Promise<void> {
  if (!/^https?:\/\//.test(url)) return; // explicit scheme allowlist
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AVATAR_PULL_TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) return;
  const ab = await resp.arrayBuffer();
  if (ab.byteLength > AVATAR_MAX_BYTES) return;
  const buf = Buffer.from(ab);
  const declaredMime = resp.headers.get("content-type") ?? "image/png";

  // Defer imports to avoid pulling heavy avatar / fs code into every oauth
  // callback path — only the signup path needs it.
  const { saveAvatarBytes } = await import("./avatars");
  try {
    const result = saveAvatarBytes(`user_${userId}`, buf, declaredMime);
    // Only set if the user hasn't already configured an avatar locally.
    db()
      .prepare(
        `UPDATE users SET avatar_blob_path = ? WHERE id = ? AND avatar_blob_path IS NULL`,
      )
      .run(result.blob_path, userId);
  } catch {
    /* file-validation rejected the bytes — drop silently */
  }
}

export function handleCallbackProfile(
  provider: string,
  profile: OAuthProfile,
  intent: OAuthIntent,
): CallbackResult {
  const existing = findIdentityByProviderUser(provider, profile.provider_user_id);

  if (intent.mode === "link") {
    if (!intent.user_id) throw new Error("link mode requires logged-in user");
    if (existing && existing.user_id !== intent.user_id) {
      throw new Error(
        `This ${provider} account is already linked to a different A2A user.`,
      );
    }
    const identity = upsertIdentity(intent.user_id, provider, profile);
    if (profile.email) markUserEmailVerified(intent.user_id);
    logAudit("auth.oauth_link", {
      userId: intent.user_id,
      detail: { provider, provider_user_id: profile.provider_user_id },
    });
    return { kind: "link", user_id: intent.user_id, identity };
  }

  // signin mode
  if (existing) {
    const identity = upsertIdentity(existing.user_id, provider, profile);
    if (profile.email) markUserEmailVerified(existing.user_id);
    logAudit("auth.oauth_signin", {
      userId: existing.user_id,
      detail: { provider, provider_user_id: profile.provider_user_id },
    });
    return { kind: "signin", user_id: existing.user_id, identity };
  }
  const userId = newOAuthUser(profile, provider);
  const identity = upsertIdentity(userId, provider, profile);
  if (profile.email) markUserEmailVerified(userId);
  logAudit("auth.oauth_signup", {
    userId,
    detail: { provider, provider_user_id: profile.provider_user_id },
  });
  return { kind: "signup", user_id: userId, identity };
}
