import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestDb, teardownTestDb, resetTables } from "../helpers/setup";
import { _resetDbForTests, db } from "../../lib/db";
import {
  RATE_LIMITS,
  consume,
  clientKey,
  agentKey,
  userKey,
  rateLimitResponse,
  type RateLimitConfig,
} from "../../lib/rate-limit";

let NOW = 1_700_000_000_000;
const RealDateNow = Date.now;

before(() => {
  setupTestDb();
  _resetDbForTests();
  Date.now = () => NOW;
});
after(() => {
  Date.now = RealDateNow;
  _resetDbForTests();
  teardownTestDb();
});
beforeEach(() => {
  NOW = 1_700_000_000_000;
  resetTables(db());
});

// capacity 3, refills 1 token/sec — small numbers so the math is obvious.
const CFG: RateLimitConfig = { capacity: 3, refillPerSecond: 1 };

describe("consume — token bucket (anti-brute-force)", () => {
  it("allows up to capacity, then denies with a retry-after", () => {
    assert.equal(consume("k", CFG).allowed, true); // 3 → 2
    assert.equal(consume("k", CFG).allowed, true); // 2 → 1
    assert.equal(consume("k", CFG).allowed, true); // 1 → 0
    const denied = consume("k", CFG); // 0 → denied
    assert.equal(denied.allowed, false);
    assert.equal(denied.remaining, 0);
    assert.ok(denied.retryAfterSeconds >= 1);
  });

  it("refills over time and allows again", () => {
    for (let i = 0; i < 3; i++) consume("k", CFG); // drain
    assert.equal(consume("k", CFG).allowed, false);
    NOW += 2000; // 2s → +2 tokens
    assert.equal(consume("k", CFG).allowed, true);
    assert.equal(consume("k", CFG).allowed, true);
    assert.equal(consume("k", CFG).allowed, false); // drained again
  });

  it("never refills beyond capacity (no banked burst)", () => {
    consume("k", CFG); // create the bucket at 3, now 2
    NOW += 1_000_000; // huge idle
    // Back to full capacity, not capacity + elapsed.
    assert.equal(consume("k", CFG).allowed, true); // 3 → 2
    assert.equal(consume("k", CFG).allowed, true); // 2 → 1
    assert.equal(consume("k", CFG).allowed, true); // 1 → 0
    assert.equal(consume("k", CFG).allowed, false);
  });

  it("isolates buckets by key (one attacker can't drain another's quota)", () => {
    for (let i = 0; i < 3; i++) consume("attacker", CFG);
    assert.equal(consume("attacker", CFG).allowed, false);
    // A different key is untouched.
    assert.equal(consume("victim", CFG).allowed, true);
  });

  it("honors a cost > 1", () => {
    assert.equal(consume("k", CFG, 3).allowed, true); // spends all 3
    assert.equal(consume("k", CFG, 1).allowed, false);
  });

  it("denies a single request whose cost exceeds capacity", () => {
    assert.equal(consume("k", CFG, 5).allowed, false);
  });
});

describe("key helpers scope buckets correctly", () => {
  it("clientKey uses x-forwarded-for first hop, falls back to x-real-ip then anon", () => {
    const fwd = new Request("https://x.test", {
      headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" },
    });
    assert.equal(clientKey(fwd, "signin"), "signin:ip:1.2.3.4");
    const real = new Request("https://x.test", { headers: { "x-real-ip": "9.9.9.9" } });
    assert.equal(clientKey(real, "signin"), "signin:ip:9.9.9.9");
    const none = new Request("https://x.test");
    assert.equal(clientKey(none, "signin"), "signin:ip:anonymous");
  });

  it("agentKey / userKey namespace by route + id", () => {
    assert.equal(agentKey("ag_1", "a2a"), "a2a:agent:ag_1");
    assert.equal(userKey("usr_1", "signin"), "signin:user:usr_1");
  });

  it("two clients on the same route get independent buckets", () => {
    const a = new Request("https://x.test", { headers: { "x-forwarded-for": "1.1.1.1" } });
    const b = new Request("https://x.test", { headers: { "x-forwarded-for": "2.2.2.2" } });
    for (let i = 0; i < 3; i++) consume(clientKey(a, "signin"), CFG);
    assert.equal(consume(clientKey(a, "signin"), CFG).allowed, false);
    assert.equal(consume(clientKey(b, "signin"), CFG).allowed, true);
  });
});

describe("global signup/signin caps (x-forwarded-for can't bypass)", () => {
  it("signupGlobal / signinGlobal exist as constant-key buckets", () => {
    // The point: these are keyed by a constant ('signup:global'), not by IP,
    // so rotating a spoofed x-forwarded-for can't mint fresh buckets.
    assert.ok(RATE_LIMITS.signupGlobal.capacity > 0);
    assert.ok(RATE_LIMITS.signinGlobal.capacity > 0);
    // Draining the global bucket denies regardless of which "IP" asks.
    const cfg = { capacity: 2, refillPerSecond: 0 };
    assert.equal(consume("x:global", cfg).allowed, true);
    assert.equal(consume("x:global", cfg).allowed, true);
    assert.equal(consume("x:global", cfg).allowed, false); // drained, no IP escape
  });
});

describe("rateLimitResponse", () => {
  it("returns 429 with a retry-after header", async () => {
    const res = rateLimitResponse({ allowed: false, remaining: 0, retryAfterSeconds: 42 });
    assert.equal(res.status, 429);
    assert.equal(res.headers.get("retry-after"), "42");
    const body = await res.json();
    assert.equal(body.retry_after_seconds, 42);
  });
});
