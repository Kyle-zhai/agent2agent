import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { setupTestDb, teardownTestDb, resetTables } from "../helpers/setup";
import { _resetDbForTests, db } from "../../lib/db";
import { createAgentForUser } from "../../lib/agents";
import { runPendingJobs, spawnManagedAgent } from "../../lib/managed-agents";
import {
  createDirectConversation,
  listMessages,
  sendMessage,
} from "../../lib/conversations";
import {
  _resetSigningKeyForTests,
  jwksDocument,
  signAgentCard,
} from "../../lib/card-signing";
import {
  assertRemoteUrlAllowed,
  attachRemoteCardToAgent,
  fetchRemoteAgentCard,
  sendMessageToRemoteAgent,
  verifyRemoteAgentCard,
} from "../../lib/a2a-client";
import { generateReply, parseBrainConfig, type ConvTurn } from "../../lib/brains";
import type { Agent, BrainConfig } from "../../lib/types";

// ---------------------------------------------------------------------------
// In-memory fetch fixture — plays the remote A2A platform without binding a
// localhost port. Some sandboxes disallow listen(127.0.0.1), and the old
// server fixture would hang the entire file before any subtest could run.
// ---------------------------------------------------------------------------

type FixtureReq = {
  url: string;
  method: string;
  headers: Record<string, string | undefined>;
};

class FixtureRes {
  private status = 200;
  private headers: Record<string, string> = {};

  constructor(private resolve: (res: Response) => void) {}

  writeHead(status: number, headers?: Record<string, string>): this {
    this.status = status;
    this.headers = headers ?? {};
    return this;
  }

  end(body = ""): void {
    this.resolve(
      new Response(body, {
        status: this.status,
        headers: this.headers,
      }),
    );
  }
}

const realFetch = globalThis.fetch;
const baseUrl = "http://127.0.0.1:43519";
let handler: (req: FixtureReq, res: FixtureRes, body: string) => void = (
  _req,
  res,
) => {
  res.writeHead(404).end();
};

function json(res: FixtureRes, status: number, value: unknown): void {
  const text = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(text);
}

function headersObject(headers: HeadersInit | undefined): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  if (!headers) return out;
  if (headers instanceof Headers) {
    headers.forEach((v, k) => {
      out[k.toLowerCase()] = v;
    });
    return out;
  }
  if (Array.isArray(headers)) {
    for (const [k, v] of headers) out[k.toLowerCase()] = v;
    return out;
  }
  for (const [k, v] of Object.entries(headers)) {
    out[k.toLowerCase()] = String(v);
  }
  return out;
}

async function bodyText(body: BodyInit | null | undefined): Promise<string> {
  if (!body) return "";
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof ArrayBuffer) return Buffer.from(body).toString("utf8");
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString("utf8");
  }
  return String(body);
}

function fixtureFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const raw = input instanceof Request ? input.url : String(input);
  const url = new URL(raw);
  if (url.origin !== baseUrl) {
    return realFetch(input, init);
  }
  if (init?.signal?.aborted) {
    return Promise.reject(new DOMException("The operation was aborted.", "AbortError"));
  }
  return new Promise<Response>((resolve, reject) => {
    const onAbort = () => {
      reject(new DOMException("The operation was aborted.", "AbortError"));
    };
    init?.signal?.addEventListener("abort", onAbort, { once: true });
    void bodyText(init?.body).then((body) => {
      if (init?.signal?.aborted) return onAbort();
      const res = new FixtureRes((response) => {
        init?.signal?.removeEventListener("abort", onAbort);
        resolve(response);
      });
      try {
        handler(
          {
            url: `${url.pathname}${url.search}`,
            method: init?.method ?? "GET",
            headers: headersObject(init?.headers),
          },
          res,
          body,
        );
      } catch (err) {
        init?.signal?.removeEventListener("abort", onAbort);
        reject(err);
      }
    }, reject);
  });
}

before(async () => {
  setupTestDb();
  _resetDbForTests();
  globalThis.fetch = fixtureFetch as typeof fetch;
});

after(async () => {
  globalThis.fetch = realFetch;
  delete process.env.A2A_CARD_SIGNING_KEY;
  _resetSigningKeyForTests();
  _resetDbForTests();
  teardownTestDb();
});

beforeEach(() => {
  resetTables(db());
  handler = (_req, res) => res.writeHead(404).end();
  delete process.env.A2A_CARD_SIGNING_KEY;
  _resetSigningKeyForTests();
});

function seedUser(userId: string, handle: string) {
  db()
    .prepare(
      "INSERT INTO users (id, email, display_name, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(userId, `${handle}@t.test`, handle, "x".repeat(128), "y".repeat(32), Date.now());
  return createAgentForUser(userId, { handle, display_name: handle }).agent;
}

const VALID_CARD = {
  protocolVersion: "0.3.0",
  name: "Remote Helper",
  description: "A friendly remote agent.",
  url: "https://remote.example/a2a",
  version: "1.2.3",
  capabilities: {},
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
  skills: [
    { id: "summarize", name: "Summarize", description: "Summarizes documents.", tags: [] },
  ],
};

// --- B1: SSRF guard (no packet leaves before the check) ----------------------

describe("fetchRemoteAgentCard — SSRF guard", () => {
  it("rejects private/loopback/metadata IPv4 targets BEFORE fetching", async () => {
    const realFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      return new Response("{}");
    }) as typeof fetch;
    try {
      // (IPv6 loopback "[::1]" counts as a local dev host and is asserted
      // separately under NODE_ENV=production below.)
      for (const target of [
        "https://10.0.0.8/card.json",
        "https://192.168.1.10/card.json",
        "https://172.16.4.2/card.json",
        "https://169.254.169.254/latest/meta-data",
      ]) {
        await assert.rejects(
          fetchRemoteAgentCard(target),
          /private, loopback, or metadata/,
          `expected rejection for ${target}`,
        );
      }
      assert.equal(fetchCalls, 0, "no packet may leave the box for rejected URLs");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("rejects http for non-localhost hosts and non-http(s) schemes", async () => {
    await assert.rejects(
      fetchRemoteAgentCard("http://example.com/card.json"),
      /must use https/,
    );
    await assert.rejects(fetchRemoteAgentCard("ftp://example.com/x"), /must use https/);
    await assert.rejects(fetchRemoteAgentCard("not a url at all"), /valid absolute URL/);
  });

  it("rejects localhost/loopback in production, allows it in dev/test", async () => {
    const env = process.env as Record<string, string | undefined>;
    const prevEnv = env.NODE_ENV;
    env.NODE_ENV = "production";
    try {
      await assert.rejects(assertRemoteUrlAllowed(`${baseUrl}/x`), /https|localhost/);
      await assert.rejects(
        assertRemoteUrlAllowed("https://localhost/card.json"),
        /localhost/,
      );
      await assert.rejects(
        assertRemoteUrlAllowed("https://[::1]/card.json"),
        /localhost/,
      );
    } finally {
      if (prevEnv === undefined) delete env.NODE_ENV;
      else env.NODE_ENV = prevEnv;
    }
    // Dev/test: the http://127.0.0.1 fixture passes.
    const u = await assertRemoteUrlAllowed(`${baseUrl}/x`);
    assert.equal(u.hostname, "127.0.0.1");
  });
});

// --- B1: fetch + sanitize ------------------------------------------------------

describe("fetchRemoteAgentCard — fetch, parse, sanitize", () => {
  it("fetches a valid card from the origin's well-known path and sanitizes fields", async () => {
    const malicious = {
      ...VALID_CARD,
      name: "Evil\u0000\u001b[31m " + "N".repeat(200),
      description: "d\u0007".repeat(3000),
      skills: Array.from({ length: 30 }, (_, i) => ({
        id: `skill-${i}`,
        name: "S".repeat(300),
        description: "x".repeat(2000),
      })),
    };
    handler = (req, res) => {
      if (req.url === "/.well-known/agent-card.json") return json(res, 200, malicious);
      res.writeHead(404).end();
    };
    // Bare origin → well-known path appended.
    const got = await fetchRemoteAgentCard(`${baseUrl}/`);
    assert.ok(got.card.name.length <= 80);
    assert.ok(!got.card.name.includes("\u0000"));
    assert.ok(!got.card.name.includes("\u001b"));
    assert.ok(got.card.description.length <= 1000);
    assert.ok(!got.card.description.includes("\u0007"));
    assert.equal(got.card.skills.length, 20); // capped
    assert.ok(got.card.skills[0].name.length <= 80);
    assert.ok(got.card.skills[0].description.length <= 500);
    assert.equal(got.card.has_signatures, false);
    // Raw archive keeps the original bytes for forensics/verification.
    assert.ok(got.raw_json.includes("\\u0000") || got.raw_json.includes("Evil"));
    assert.equal(got.origin, baseUrl);
  });

  it("fetches a direct card URL (non-root path used verbatim)", async () => {
    handler = (req, res) => {
      if (req.url === "/cards/helper.json") return json(res, 200, VALID_CARD);
      res.writeHead(404).end();
    };
    const got = await fetchRemoteAgentCard(`${baseUrl}/cards/helper.json`);
    assert.equal(got.card.name, "Remote Helper");
    assert.equal(got.card.skills[0].id, "summarize");
  });

  it("rejects a card without a url field (spec-required RPC endpoint)", async () => {
    // Regression: the connect flow once fell back to the user-typed
    // discovery URL when the card had no url — which can be the card JSON
    // path itself, the exact conflation behind the pre-release relay-404 bug.
    const noUrl: Record<string, unknown> = { ...VALID_CARD };
    delete noUrl.url;
    handler = (req, res) => {
      if (req.url === "/.well-known/agent-card.json") return json(res, 200, noUrl);
      res.writeHead(404).end();
    };
    await assert.rejects(
      () => fetchRemoteAgentCard(`${baseUrl}/`),
      /url field \(required by the A2A spec\)/,
    );
  });

  it("rejects oversized responses (>256KB) without storing anything", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ name: "big", padding: "x".repeat(300 * 1024) }));
    };
    await assert.rejects(fetchRemoteAgentCard(`${baseUrl}/big.json`), /too large/);
  });

  it("rejects non-JSON, non-object JSON, HTTP errors, and redirects", async () => {
    handler = (_req, res) => {
      res.writeHead(200).end("<html>not json</html>");
    };
    await assert.rejects(fetchRemoteAgentCard(`${baseUrl}/x`), /not valid JSON/);
    handler = (_req, res) => json(res, 200, ["an", "array"]);
    await assert.rejects(fetchRemoteAgentCard(`${baseUrl}/x`), /not a JSON object/);
    handler = (_req, res) => res.writeHead(500).end("boom");
    await assert.rejects(fetchRemoteAgentCard(`${baseUrl}/x`), /HTTP 500/);
    handler = (_req, res) => res.writeHead(302, { location: "http://10.0.0.1/" }).end();
    await assert.rejects(fetchRemoteAgentCard(`${baseUrl}/x`), /redirect/i);
  });

  it("times out instead of hanging on a stalled server", async () => {
    handler = () => {
      /* never respond — connection stays open until abort */
    };
    await assert.rejects(
      fetchRemoteAgentCard(`${baseUrl}/slow`, { timeoutMs: 150 }),
      /timed out/,
    );
  });
});

// --- B2: JWS verification -------------------------------------------------------

function enableSigning(): void {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  process.env.A2A_CARD_SIGNING_KEY = privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString();
  _resetSigningKeyForTests();
}

describe("verifyRemoteAgentCard", () => {
  it("returns 'unverified' for a card with no signatures (does not block)", async () => {
    const v = await verifyRemoteAgentCard({ ...VALID_CARD }, `${baseUrl}/`);
    assert.equal(v.status, "unverified");
  });

  it("verifies a signAgentCard-signed card against the origin JWKS (round trip)", async () => {
    enableSigning();
    const signatures = signAgentCard(VALID_CARD);
    assert.ok(signatures && signatures.length === 1);
    const jwks = jwksDocument();
    handler = (req, res) => {
      if (req.url === "/.well-known/jwks.json") return json(res, 200, jwks);
      res.writeHead(404).end();
    };
    const v = await verifyRemoteAgentCard(
      { ...VALID_CARD, signatures },
      `${baseUrl}/`,
    );
    assert.equal(v.status, "verified");
  });

  it("returns 'invalid' when any signed field was tampered with", async () => {
    enableSigning();
    const signatures = signAgentCard(VALID_CARD);
    const jwks = jwksDocument();
    handler = (req, res) => {
      if (req.url === "/.well-known/jwks.json") return json(res, 200, jwks);
      res.writeHead(404).end();
    };
    const v = await verifyRemoteAgentCard(
      { ...VALID_CARD, name: "Evil Impostor", signatures },
      `${baseUrl}/`,
    );
    assert.equal(v.status, "invalid");
  });

  it("returns 'invalid' when the origin JWKS is unreachable or malformed", async () => {
    enableSigning();
    const signatures = signAgentCard(VALID_CARD);
    handler = (_req, res) => res.writeHead(404).end();
    const v404 = await verifyRemoteAgentCard(
      { ...VALID_CARD, signatures },
      `${baseUrl}/`,
    );
    assert.equal(v404.status, "invalid");
    handler = (_req, res) => {
      res.writeHead(200).end("not json");
    };
    const vGarbage = await verifyRemoteAgentCard(
      { ...VALID_CARD, signatures },
      `${baseUrl}/`,
    );
    assert.equal(vGarbage.status, "invalid");
  });
});

// --- attachRemoteCardToAgent ----------------------------------------------------

describe("attachRemoteCardToAgent", () => {
  it("archives raw card JSON + verification state on the agent row", () => {
    seedUser("usr_o", "owner");
    const agent = spawnManagedAgent("usr_o", {
      handle: "remote",
      purpose: "a2a",
      display_name: "Remote Helper",
      persona: "",
      brain: { provider: "a2a", url: `${baseUrl}/a2a` },
    });
    attachRemoteCardToAgent(agent.id, JSON.stringify(VALID_CARD), "verified");
    const row = db()
      .prepare("SELECT a2a_card_json, a2a_card_verified FROM agents WHERE id = ?")
      .get(agent.id) as { a2a_card_json: string; a2a_card_verified: string };
    assert.equal(row.a2a_card_verified, "verified");
    assert.equal(JSON.parse(row.a2a_card_json).name, "Remote Helper");
  });
});

// --- B3: message/send + tasks/get polling ----------------------------------------

type RpcRecord = { method: string; params: Record<string, unknown>; auth?: string };

/** Install a JSON-RPC fixture endpoint at /a2a; returns the captured calls. */
function rpcFixture(
  respond: (method: string, params: Record<string, unknown>, n: number) => unknown,
): RpcRecord[] {
  const calls: RpcRecord[] = [];
  handler = (req, res, body) => {
    if (req.url !== "/a2a" || req.method !== "POST") return res.writeHead(404).end();
    const rpc = JSON.parse(body) as {
      id: unknown;
      method: string;
      params: Record<string, unknown>;
    };
    calls.push({
      method: rpc.method,
      params: rpc.params,
      auth: req.headers.authorization,
    });
    const result = respond(rpc.method, rpc.params, calls.length);
    json(res, 200, { jsonrpc: "2.0", id: rpc.id, result });
  };
  return calls;
}

const agentReply = (text: string) => ({
  kind: "message",
  messageId: "m-remote",
  role: "agent",
  parts: [{ kind: "text", text }],
});

describe("sendMessageToRemoteAgent", () => {
  it("happy path: direct message reply, Bearer auth, fresh uuid messageId", async () => {
    const calls = rpcFixture(() => agentReply("hello back"));
    const out = await sendMessageToRemoteAgent({
      url: `${baseUrl}/a2a`,
      text: "hello there",
      auth_token: "sekret-token",
    });
    assert.equal(out.text, "hello back");
    assert.equal(out.task_id, undefined);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "message/send");
    assert.equal(calls[0].auth, "Bearer sekret-token");
    const msg = calls[0].params.message as {
      messageId: string;
      role: string;
      parts: Array<{ kind: string; text: string }>;
    };
    assert.match(
      msg.messageId,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      "messageId must be a uuid (remote-side idempotency key)",
    );
    assert.equal(msg.role, "user");
    assert.equal(msg.parts[0].text, "hello there");
  });

  it("sends a caller-supplied messageId verbatim (deterministic retry dedup key)", async () => {
    // The reply pipeline derives relay-<agent>-<trigger message id> so a
    // lease-expiry retry re-sends the SAME key and the remote dedupes it.
    const calls = rpcFixture(() => agentReply("ok"));
    await sendMessageToRemoteAgent({
      url: `${baseUrl}/a2a`,
      text: "hi",
      messageId: "relay-bot.a2a.x1-msg_abc123",
    });
    const msg = calls[0].params.message as { messageId: string };
    assert.equal(msg.messageId, "relay-bot.a2a.x1-msg_abc123");
  });

  it("polls tasks/get every interval until the task completes", async () => {
    const calls = rpcFixture((method, _params, n) => {
      if (method === "message/send") {
        return { kind: "task", id: "t1", status: { state: "submitted" }, history: [] };
      }
      // tasks/get: working once, then completed with the agent's answer.
      if (n < 3) return { kind: "task", id: "t1", status: { state: "working" }, history: [] };
      return {
        kind: "task",
        id: "t1",
        status: { state: "completed" },
        history: [
          { kind: "message", role: "user", parts: [{ kind: "text", text: "q" }] },
          { kind: "message", role: "agent", parts: [{ kind: "text", text: "all done!" }] },
        ],
      };
    });
    const out = await sendMessageToRemoteAgent({
      url: `${baseUrl}/a2a`,
      text: "do the thing",
      pollIntervalMs: 10,
    });
    assert.equal(out.text, "all done!");
    assert.equal(out.task_id, "t1");
    const polls = calls.filter((c) => c.method === "tasks/get");
    assert.ok(polls.length >= 2, "should have polled tasks/get");
    assert.equal(polls[0].params.id, "t1");
  });

  it("falls back to artifact text parts when the task has no agent message", async () => {
    rpcFixture(() => ({
      kind: "task",
      id: "t2",
      status: { state: "completed" },
      history: [],
      artifacts: [
        { artifactId: "a1", parts: [{ kind: "text", text: "artifact answer" }] },
      ],
    }));
    const out = await sendMessageToRemoteAgent({ url: `${baseUrl}/a2a`, text: "q" });
    assert.equal(out.text, "artifact answer");
  });

  it("throws on remote 5xx and on JSON-RPC error responses", async () => {
    handler = (_req, res) => res.writeHead(503).end("down");
    await assert.rejects(
      sendMessageToRemoteAgent({ url: `${baseUrl}/a2a`, text: "x" }),
      /HTTP 503/,
    );
    handler = (_req, res, body) => {
      const rpc = JSON.parse(body) as { id: unknown };
      json(res, 200, {
        jsonrpc: "2.0",
        id: rpc.id,
        error: { code: -32600, message: "nope" },
      });
    };
    await assert.rejects(
      sendMessageToRemoteAgent({ url: `${baseUrl}/a2a`, text: "x" }),
      /Remote A2A error -32600: nope/,
    );
  });

  it("throws when the task ends failed/rejected/canceled or parks input-required", async () => {
    for (const state of ["failed", "rejected", "canceled"]) {
      rpcFixture(() => ({ kind: "task", id: "t", status: { state }, history: [] }));
      await assert.rejects(
        sendMessageToRemoteAgent({ url: `${baseUrl}/a2a`, text: "x" }),
        new RegExp(state),
      );
    }
    rpcFixture(() => ({
      kind: "task",
      id: "t",
      status: { state: "input-required" },
      history: [],
    }));
    await assert.rejects(
      sendMessageToRemoteAgent({ url: `${baseUrl}/a2a`, text: "x" }),
      /input-required/,
    );
  });

  it("respects the wall-clock budget — a never-finishing task fails, never hangs", async () => {
    rpcFixture(() => ({ kind: "task", id: "t", status: { state: "working" }, history: [] }));
    const started = Date.now();
    await assert.rejects(
      sendMessageToRemoteAgent({
        url: `${baseUrl}/a2a`,
        text: "x",
        budgetMs: 80,
        pollIntervalMs: 20,
      }),
      /did not finish within/,
    );
    assert.ok(Date.now() - started < 5_000, "must give up promptly at the budget");
  });

  it("clamps a caller-supplied budget to the 45s ceiling (lease safety)", async () => {
    // White-box: a budget above the ceiling must not be honored. We can't wait
    // 45s in a test — instead assert the clamp indirectly: a tiny budget with
    // an interval larger than the remaining time gives up after ONE send.
    const calls = rpcFixture(() => ({
      kind: "task",
      id: "t",
      status: { state: "working" },
      history: [],
    }));
    await assert.rejects(
      sendMessageToRemoteAgent({
        url: `${baseUrl}/a2a`,
        text: "x",
        budgetMs: 30,
        pollIntervalMs: 60_000, // longer than the budget → zero polls
      }),
      /did not finish/,
    );
    assert.equal(calls.filter((c) => c.method === "tasks/get").length, 0);
  });
});

// --- B3: brain provider "a2a" end-to-end ------------------------------------------

describe('brain provider "a2a"', () => {
  const proxyAgent = {
    id: "remote.a2a.test",
    display_name: "Remote Proxy",
    persona: "",
  } as Agent;
  const history: ConvTurn[] = [
    { agent_id: "me.agent", display_name: "Me", text: "ping remote", is_self: false },
  ];

  it("parseBrainConfig accepts provider a2a and carries url + auth_token", () => {
    const cfg = parseBrainConfig(
      JSON.stringify({ provider: "a2a", url: "https://r.example/a2a", auth_token: "tk" }),
    );
    assert.equal(cfg.provider, "a2a");
    assert.equal(cfg.url, "https://r.example/a2a");
    assert.equal(cfg.auth_token, "tk");
    // Unknown providers still fall back to a default, not a crash.
    const bad = parseBrainConfig(JSON.stringify({ provider: "skynet" }));
    assert.notEqual(bad.provider, "skynet");
  });

  it("generateReply relays the latest non-self turn and returns the remote text", async () => {
    const calls = rpcFixture(() => agentReply("pong from remote"));
    const cfg: BrainConfig = {
      provider: "a2a",
      url: `${baseUrl}/a2a`,
      auth_token: "super-secret",
      max_history: 24,
      reply_to_self: false,
    };
    const out = await generateReply(proxyAgent, history, cfg);
    assert.equal(out.text, "pong from remote");
    assert.deepEqual(out.artifacts, []);
    // The relayed text is the trigger turn, persona is NOT sent (B5).
    const msg = calls[0].params.message as { parts: Array<{ text: string }> };
    assert.equal(msg.parts[0].text, "ping remote");
    assert.ok(!JSON.stringify(calls[0].params).includes("persona"));
    // The token must never leak into user-visible output.
    assert.ok(!out.text.includes("super-secret"));
    assert.ok(!out.thinking.includes("super-secret"));
  });

  it("generateReply propagates remote failures (reply-job failure path handles them)", async () => {
    handler = (_req, res) => res.writeHead(500).end("kaput");
    const cfg: BrainConfig = {
      provider: "a2a",
      url: `${baseUrl}/a2a`,
      max_history: 24,
      reply_to_self: false,
    };
    await assert.rejects(generateReply(proxyAgent, history, cfg), /HTTP 500/);
    // Misconfigured (no url) also throws instead of failing silently.
    await assert.rejects(
      generateReply(proxyAgent, history, { ...cfg, url: undefined }),
      /no url/,
    );
  });
});

// --- B3: full reply-job round trip -------------------------------------------
// The remote agent joins a conversation like a local one: a message triggers a
// reply job; processJob relays it over A2A; the remote answer lands in the
// room AS the proxy agent. Failures take the existing audit + give-up path.

describe("a2a brain through the reply-job worker (end to end)", () => {
  function seedRoomWithRemoteProxy() {
    seedUser("usr_o", "human");
    const me = createAgentForUser("usr_o", {
      handle: "myext",
      display_name: "My External",
    }).agent;
    const proxy = spawnManagedAgent("usr_o", {
      handle: "remote",
      purpose: "a2a",
      display_name: "Remote Proxy",
      persona: "",
      brain: { provider: "a2a", url: `${baseUrl}/a2a`, auth_token: "tok-e2e" },
    });
    // Same owner → auto-friended, so a direct conversation is allowed.
    const conv = createDirectConversation("usr_o", me.id, proxy.id);
    return { me, proxy, conv };
  }

  function enqueueReply(convId: string, agentId: string, triggerId: string) {
    db()
      .prepare(
        `INSERT INTO reply_jobs (id, conversation_id, agent_id, trigger_message_id, status, attempts, created_at)
         VALUES (?, ?, ?, ?, 'pending', 0, ?)`,
      )
      .run("job_a2a_1", convId, agentId, triggerId, Date.now());
  }

  it("delivers the remote answer into the conversation as the proxy agent", async () => {
    const calls = rpcFixture(() => agentReply("greetings from the other platform"));
    const { me, proxy, conv } = seedRoomWithRemoteProxy();
    const trigger = sendMessage(conv.id, me.id, { text: "hello remote!" });
    enqueueReply(conv.id, proxy.id, trigger.id);
    await runPendingJobs();

    const msgs = listMessages(conv.id, { limit: 10 });
    const reply = msgs.find((m) => m.from_agent_id === proxy.id);
    assert.ok(reply, "remote proxy must have replied in the room");
    assert.equal(reply!.text, "greetings from the other platform");
    assert.equal(reply!.kind, "agent_to_agent");
    assert.equal(calls[0].auth, "Bearer tok-e2e");
    const job = db()
      .prepare("SELECT status, sent_message_id FROM reply_jobs WHERE id = 'job_a2a_1'")
      .get() as { status: string; sent_message_id: string | null };
    assert.equal(job.status, "done");
    assert.equal(job.sent_message_id, reply!.id);
  });

  it("remote 5xx → job fails through the existing audit + give-up path, no duplicate send", async () => {
    let sendAttempts = 0;
    handler = (_req, res) => {
      sendAttempts++;
      res.writeHead(503).end("remote down");
    };
    const { me, proxy, conv } = seedRoomWithRemoteProxy();
    const trigger = sendMessage(conv.id, me.id, { text: "anyone there?" });
    enqueueReply(conv.id, proxy.id, trigger.id);
    await runPendingJobs();

    // Exactly one outbound attempt — a business failure is terminal, the
    // worker must not hammer the remote with re-sends.
    assert.equal(sendAttempts, 1);
    const job = db()
      .prepare("SELECT status, last_error FROM reply_jobs WHERE id = 'job_a2a_1'")
      .get() as { status: string; last_error: string };
    assert.equal(job.status, "failed");
    assert.match(job.last_error, /HTTP 503/);
    // No reply message was posted; the give-up notice + audit trail exist.
    const msgs = listMessages(conv.id, { limit: 10 });
    assert.ok(!msgs.some((m) => m.from_agent_id === proxy.id));
    const audit = db()
      .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'agent.reply_failed'")
      .get() as { n: number };
    assert.equal(audit.n, 1);
    const events = db()
      .prepare(
        "SELECT COUNT(*) AS n FROM conversation_events WHERE conversation_id = ? AND kind = 'reply_failed'",
      )
      .get(conv.id) as { n: number };
    assert.equal(events.n, 1);
  });
});
