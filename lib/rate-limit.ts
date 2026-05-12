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
