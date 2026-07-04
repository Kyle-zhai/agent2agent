import "server-only";
import { db } from "./db";

export type RateLimitConfig = {
  capacity: number;
  refillPerSecond: number;
};

export const RATE_LIMITS = {
  signin: { capacity: 5, refillPerSecond: 5 / 60 },
  signup: { capacity: 3, refillPerSecond: 3 / 60 },
  friendRequest: { capacity: 10, refillPerSecond: 10 / 60 },
  messageSend: { capacity: 60, refillPerSecond: 60 / 60 },
  apiHeartbeat: { capacity: 30, refillPerSecond: 1 },
  apiMessage: { capacity: 60, refillPerSecond: 60 / 60 },
  apiGeneric: { capacity: 120, refillPerSecond: 120 / 60 },
  apiWorkspaceRead: { capacity: 240, refillPerSecond: 4 },
  apiWorkspacePatch: { capacity: 30, refillPerSecond: 30 / 60 },
  apiTaskWrite: { capacity: 60, refillPerSecond: 60 / 60 },
  // Device-auth: creation is rare (a handful per onboarding); polling is a
  // 5s loop for ≤15 min, so allow a sustained ~1 poll/2s per client.
  deviceAuthStart: { capacity: 5, refillPerSecond: 5 / 60 },
  deviceAuthPoll: { capacity: 30, refillPerSecond: 0.5 },
  // Human-side user_code lookup/approval on /app/device. The code space is
  // 28^8 but a patient enumerator could still probe for live pendings (and
  // approving a guessed code binds the victim's device to the attacker's
  // account) — 10/min per IP shuts that down while a fat-fingered human
  // retyping their code never notices.
  deviceLookup: { capacity: 10, refillPerSecond: 10 / 60 },
  // Password-reset requests: cap how fast one IP can trigger reset emails to
  // arbitrary addresses (mail-bomb / enumeration probe). Generous for humans
  // (3/min) — the per-address effect is bounded anyway since each request is
  // enumeration-safe and tokens are one-time.
  passwordReset: { capacity: 3, refillPerSecond: 3 / 60 },
  // Global (non-IP) caps that a spoofed x-forwarded-for CANNOT bypass — the
  // per-IP buckets above are only as trustworthy as the proxy chain. signup
  // has no per-identity backstop (unlike signin's account lockout), so the
  // global cap is its main defense against header-rotation enumeration /
  // account-flooding. Tune to expected legit volume.
  signupGlobal: { capacity: 30, refillPerSecond: 30 / 60 },
  signinGlobal: { capacity: 120, refillPerSecond: 120 / 60 },
  passwordResetGlobal: { capacity: 30, refillPerSecond: 30 / 60 },
  // deviceLookup's global backstop: an enumerator rotating IPs (or spoofing
  // x-forwarded-for past a naive proxy) gets capped here regardless. 60/min
  // across ALL users is far above legit device-approval volume.
  deviceLookupGlobal: { capacity: 60, refillPerSecond: 60 / 60 },
  // Capability token-exchange (RFC 8693): minting is authenticated (needs a
  // grant the caller holds) and cheap, but tokens are short-lived so a busy
  // external agent re-mints often. 30/min per agent covers that while capping
  // a compromised key from farming tokens.
  apiTokenExchange: { capacity: 30, refillPerSecond: 30 / 60 },
} as const satisfies Record<string, RateLimitConfig>;

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
};

export function consume(
  key: string,
  cfg: RateLimitConfig,
  cost = 1,
): RateLimitResult {
  const now = Date.now();
  const row = db()
    .prepare(
      "SELECT tokens, last_refill_at FROM rate_limit_buckets WHERE bucket_key = ?",
    )
    .get(key) as { tokens: number; last_refill_at: number } | undefined;

  let tokens = row?.tokens ?? cfg.capacity;
  const lastRefill = row?.last_refill_at ?? now;
  const elapsedSec = (now - lastRefill) / 1000;
  tokens = Math.min(cfg.capacity, tokens + elapsedSec * cfg.refillPerSecond);

  let allowed = false;
  if (tokens >= cost) {
    tokens -= cost;
    allowed = true;
  }

  db()
    .prepare(
      `INSERT INTO rate_limit_buckets (bucket_key, tokens, last_refill_at)
       VALUES (?, ?, ?)
       ON CONFLICT(bucket_key) DO UPDATE SET
         tokens = excluded.tokens, last_refill_at = excluded.last_refill_at`,
    )
    .run(key, tokens, now);

  const retryAfterSeconds = allowed
    ? 0
    : Math.ceil((cost - tokens) / cfg.refillPerSecond);
  return {
    allowed,
    remaining: Math.floor(tokens),
    retryAfterSeconds,
  };
}

export function clientKey(req: Request, route: string): string {
  const fwd = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = fwd || req.headers.get("x-real-ip") || "anonymous";
  return `${route}:ip:${ip}`;
}

export function agentKey(agentId: string, route: string): string {
  return `${route}:agent:${agentId}`;
}

export function userKey(userId: string, route: string): string {
  return `${route}:user:${userId}`;
}

export function rateLimitResponse(r: RateLimitResult): Response {
  return new Response(
    JSON.stringify({
      error: "Too many requests.",
      retry_after_seconds: r.retryAfterSeconds,
    }),
    {
      status: 429,
      headers: {
        "content-type": "application/json",
        "retry-after": String(r.retryAfterSeconds),
      },
    },
  );
}
