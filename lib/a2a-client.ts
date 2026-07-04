import "server-only";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { randomUUID } from "node:crypto";
import { db } from "./db";
import {
  verifyCardSignatureWithJwks,
  type AgentCardSignature,
} from "./card-signing";
import type { RemoteCardVerification } from "./types";

// ---------------------------------------------------------------------------
// Outbound A2A client (v0.21) — the platform's first CLIENT role. Until now
// we could only BE called by external A2A peers; this module lets us connect
// a remote A2A agent by URL: fetch + sanitize its agent card (B1), verify the
// card's detached JWS against the origin's JWKS (B2), and relay conversation
// turns via JSON-RPC message/send + tasks/get polling (B3, wired in as brain
// provider "a2a" in lib/brains.ts).
//
// Every URL here is attacker-controlled input. We re-implement the SSRF guard
// locally (same policy as lib/a2a.ts's push-webhook guard) instead of
// importing it — the modules evolve independently and a2a.ts doesn't export
// its helpers.
// ---------------------------------------------------------------------------

const FETCH_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
// Reply-job leases run 60s (lib/managed-agents JOB_LEASE_MS); the remote
// round-trip must finish comfortably inside one lease or a second worker
// could re-claim the job mid-flight. 45s leaves 15s of slack.
const SEND_BUDGET_MS = 45_000;
const POLL_INTERVAL_MS = 2_000;

const NAME_MAX = 80;
const DESCRIPTION_MAX = 1000;
const SKILL_NAME_MAX = 80;
const SKILL_DESCRIPTION_MAX = 500;
const MAX_SKILLS = 20;

export type SanitizedRemoteSkill = {
  id: string;
  name: string;
  description: string;
};

export type SanitizedRemoteCard = {
  name: string;
  description: string;
  version: string;
  url: string;
  protocolVersion: string;
  skills: SanitizedRemoteSkill[];
  has_signatures: boolean;
};

export type FetchedRemoteCard = {
  /** Sanitized projection — safe for UI display and agent metadata. */
  card: SanitizedRemoteCard;
  /** Raw parsed card object — what JWS verification must run against
   *  (sanitizing first would break the signature). Treat as untrusted. */
  rawCard: Record<string, unknown>;
  /** Raw response text (≤256KB), archived on the agent row. */
  raw_json: string;
  /** Origin (scheme://host[:port]) the card was fetched from. */
  origin: string;
};

// --- SSRF guard --------------------------------------------------------------

function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 127 || a === 0 || a === 10) return true; // loopback / this-host / private
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 169 && b === 254) return true; // link-local / cloud metadata
    return false;
  }
  if (isIP(ip) === 6) {
    const low = ip.toLowerCase();
    if (low === "::1" || low === "::") return true; // loopback / unspecified
    if (low.startsWith("fe80")) return true; // link-local
    if (low.startsWith("fc") || low.startsWith("fd")) return true; // ULA fc00::/7
    const mapped = low.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);
    return false;
  }
  return false;
}

function isLocalDevHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/** Validate a remote A2A URL BEFORE any packet leaves the box: https only
 *  (http allowed for localhost outside production — dev/test fixtures), and
 *  for non-local hosts the DNS answer must contain no private/loopback/
 *  link-local/metadata address. Throws a user-facing Error on rejection. */
export async function assertRemoteUrlAllowed(rawUrl: string): Promise<URL> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error("Not a valid absolute URL.");
  }
  // Strip IPv6 brackets — `new URL("http://[::1]").hostname` is "[::1]",
  // which isIP() rejects, sneaking IPv6 literals past the checks.
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const localDevOk = isLocalDevHost(host) && process.env.NODE_ENV !== "production";
  if (u.protocol === "http:") {
    if (!localDevOk) {
      throw new Error("Remote A2A URLs must use https (http is allowed only for localhost in dev).");
    }
    return u;
  }
  if (u.protocol !== "https:") {
    throw new Error("Remote A2A URLs must use https.");
  }
  if (isLocalDevHost(host) || host.endsWith(".localhost")) {
    if (localDevOk) return u;
    throw new Error("Remote A2A URLs must not target localhost.");
  }
  if (isIP(host)) {
    if (isPrivateIp(host)) {
      throw new Error("Remote A2A URLs must not target a private, loopback, or metadata address.");
    }
    return u;
  }
  let addrs: Array<{ address: string }>;
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    throw new Error(`Could not resolve host "${host}".`);
  }
  if (addrs.length === 0 || addrs.some((a) => isPrivateIp(a.address))) {
    throw new Error("Remote A2A URLs must not resolve to a private, loopback, or metadata address.");
  }
  return u;
}

// --- Capped fetch ------------------------------------------------------------

/** fetch with a hard timeout, no redirect following (a redirect could hop to
 *  a private address after our pre-flight check), and a streamed byte cap so
 *  a hostile server can't feed us an unbounded body. */
async function fetchCapped(
  url: string,
  init: {
    method?: "GET" | "POST";
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
  } = {},
): Promise<{ status: number; text: string }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), init.timeoutMs ?? FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: init.method ?? "GET",
      headers: init.headers,
      body: init.body,
      signal: ac.signal,
      redirect: "manual",
    });
    if (res.status >= 300 && res.status < 400) {
      throw new Error(`Remote endpoint redirected (HTTP ${res.status}) — redirects are not followed.`);
    }
    const claimed = Number(res.headers.get("content-length") ?? "0");
    if (claimed > MAX_RESPONSE_BYTES) {
      ac.abort();
      throw new Error(`Remote response too large (>${MAX_RESPONSE_BYTES / 1024}KB).`);
    }
    if (!res.body) return { status: res.status, text: "" };
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_RESPONSE_BYTES) {
        ac.abort();
        throw new Error(`Remote response too large (>${MAX_RESPONSE_BYTES / 1024}KB).`);
      }
      chunks.push(value);
    }
    return { status: res.status, text: Buffer.concat(chunks).toString("utf8") };
  } catch (err) {
    // Node's fetch abort surfaces as a DOMException (NOT instanceof Error) —
    // match on the name. Our own size-cap Error passes through untouched.
    const name = (err as { name?: string } | null)?.name;
    if (name === "AbortError" || name === "TimeoutError") {
      throw new Error(`Remote endpoint timed out after ${(init.timeoutMs ?? FETCH_TIMEOUT_MS) / 1000}s.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// --- B1: fetch + sanitize the remote card -------------------------------------

/** Strip C0/C1 control characters (keep \n and \t — descriptions may be
 *  multi-line) so a hostile card can't smuggle terminal escapes or zero-area
 *  garbage into our UI or storage. */
function stripControlChars(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, "");
}

function cleanField(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return stripControlChars(value).slice(0, max).trim();
}

function sanitizeRemoteCard(raw: Record<string, unknown>): SanitizedRemoteCard {
  const skillsRaw = Array.isArray(raw.skills) ? raw.skills : [];
  const skills: SanitizedRemoteSkill[] = skillsRaw
    .slice(0, MAX_SKILLS)
    .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
    .map((s) => ({
      id: cleanField(s.id, SKILL_NAME_MAX),
      name: cleanField(s.name, SKILL_NAME_MAX),
      description: cleanField(s.description, SKILL_DESCRIPTION_MAX),
    }));
  return {
    name: cleanField(raw.name, NAME_MAX),
    description: cleanField(raw.description, DESCRIPTION_MAX),
    version: cleanField(raw.version, 40),
    url: cleanField(raw.url, 500),
    protocolVersion: cleanField(raw.protocolVersion, 20),
    skills,
    has_signatures: Array.isArray(raw.signatures) && raw.signatures.length > 0,
  };
}

/** Fetch a remote agent card by URL. The URL may point directly at the card
 *  (…/agent-card.json) or at an origin — in the latter case the well-known
 *  path is appended. SSRF-checked BEFORE fetching; 5s timeout; ≤256KB; must
 *  parse as a JSON object. Returns the sanitized card for display plus the
 *  raw object/text for signature verification and archival. */
export async function fetchRemoteAgentCard(
  rawUrl: string,
  opts?: { /** Test hook — clamped to the 5s production ceiling. */ timeoutMs?: number },
): Promise<FetchedRemoteCard> {
  const u = await assertRemoteUrlAllowed(rawUrl.trim());
  // Accept either a direct card URL or a bare origin.
  const cardUrl =
    u.pathname === "/" && !u.search
      ? new URL("/.well-known/agent-card.json", u).toString()
      : u.toString();
  const res = await fetchCapped(cardUrl, {
    headers: { accept: "application/json, application/a2a+json" },
    timeoutMs: Math.min(opts?.timeoutMs ?? FETCH_TIMEOUT_MS, FETCH_TIMEOUT_MS),
  });
  if (res.status !== 200) {
    throw new Error(`Card fetch failed: HTTP ${res.status}.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.text);
  } catch {
    throw new Error("Card response is not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Card response is not a JSON object.");
  }
  const rawCard = parsed as Record<string, unknown>;
  const card = sanitizeRemoteCard(rawCard);
  if (!card.name) {
    throw new Error("Card has no usable name field.");
  }
  // `url` is REQUIRED by the A2A spec — it is the JSON-RPC endpoint we relay
  // to. The only fallback would be the user-typed discovery URL, which may be
  // the card JSON path itself (wrong endpoint — that exact conflation was a
  // pre-release bug). Reject malformed cards instead.
  if (!card.url) {
    throw new Error("Card has no url field (required by the A2A spec).");
  }
  return { card, rawCard, raw_json: res.text, origin: u.origin };
}

// --- B1b: ARD discovery — list an origin's agents from its ai-catalog.json ----

const MAX_CATALOG_ENTRIES = 100;

export type DiscoveredAgent = {
  identifier: string;
  name: string;
  description: string;
  /** AgentCard URL to feed into fetchRemoteAgentCard — re-SSRF-checked there. */
  cardUrl: string;
};

/** Discover connectable A2A agents by reading an origin's Agentic Resource
 *  Discovery catalog (/.well-known/ai-catalog.json). Returns the A2A AgentCard
 *  entries so the UI can list them for one-click connect ("bring your agent"),
 *  instead of the user needing each per-agent card URL.
 *
 *  Security: the origin is SSRF-checked before fetch; the response is capped
 *  (5s / ≤256KB); every entry field is control-char-stripped + length-clamped;
 *  and — because a hostile catalog could point `url` at an internal address —
 *  each cardUrl is restricted to the SAME ORIGIN as the catalog (cross-origin
 *  references are dropped). The chosen cardUrl is STILL re-SSRF-checked when
 *  fetchRemoteAgentCard actually loads it. */
export async function discoverAgentsViaArd(
  rawUrl: string,
  opts?: { timeoutMs?: number },
): Promise<DiscoveredAgent[]> {
  const u = await assertRemoteUrlAllowed(rawUrl.trim());
  const catalogUrl = new URL("/.well-known/ai-catalog.json", u.origin).toString();
  const res = await fetchCapped(catalogUrl, {
    headers: { accept: "application/ai-catalog+json, application/json" },
    timeoutMs: Math.min(opts?.timeoutMs ?? FETCH_TIMEOUT_MS, FETCH_TIMEOUT_MS),
  });
  if (res.status !== 200) {
    throw new Error(`No ARD catalog at ${u.origin} (HTTP ${res.status}).`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.text);
  } catch {
    throw new Error("Catalog response is not valid JSON.");
  }
  const entriesRaw =
    parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).entries)
      ? ((parsed as Record<string, unknown>).entries as unknown[])
      : null;
  if (!entriesRaw) throw new Error("Catalog has no entries[] array.");

  const out: DiscoveredAgent[] = [];
  for (const raw of entriesRaw.slice(0, MAX_CATALOG_ENTRIES)) {
    if (!raw || typeof raw !== "object") continue;
    const e = raw as Record<string, unknown>;
    if (e.type !== "application/a2a-agent-card+json") continue;
    const url = typeof e.url === "string" ? e.url.trim() : "";
    if (!url) continue;
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      continue;
    }
    // Same-origin only — a catalog must not hand out cross-origin (or internal)
    // card URLs. Legitimate ARD entries reference the publisher's own domain.
    if (parsedUrl.origin !== u.origin) continue;
    out.push({
      identifier: cleanField(e.identifier, 200),
      name: cleanField(e.name, 120) || parsedUrl.pathname,
      description: cleanField(e.description, 280),
      cardUrl: parsedUrl.toString(),
    });
  }
  return out;
}

// --- B2: JWS verification against the origin's JWKS ---------------------------

function isCardSignature(v: unknown): v is AgentCardSignature {
  return (
    !!v &&
    typeof v === "object" &&
    typeof (v as Record<string, unknown>).protected === "string" &&
    typeof (v as Record<string, unknown>).signature === "string"
  );
}

/** Verify a remote card's detached JWS signatures (RFC 7515 over the RFC 8785
 *  canonical card) against the card ORIGIN's /.well-known/jwks.json.
 *
 *  - no signatures[]            → "unverified" (display-only; doesn't block)
 *  - ≥1 signature verifies      → "verified"
 *  - signatures present but none verify (incl. unreachable/garbage JWKS)
 *                               → "invalid"
 *
 *  Never throws — a verification problem is a result, not an exception. */
export async function verifyRemoteAgentCard(
  rawCard: Record<string, unknown>,
  originUrl: string,
): Promise<{ status: RemoteCardVerification; detail: string }> {
  const sigsRaw = rawCard.signatures;
  if (!Array.isArray(sigsRaw) || sigsRaw.length === 0) {
    return { status: "unverified", detail: "Card carries no signatures." };
  }
  const signatures = sigsRaw.filter(isCardSignature);
  if (signatures.length === 0) {
    return { status: "invalid", detail: "signatures[] entries are malformed." };
  }
  let jwks: { keys?: Array<Record<string, unknown>> };
  try {
    const origin = (await assertRemoteUrlAllowed(originUrl)).origin;
    const res = await fetchCapped(new URL("/.well-known/jwks.json", origin).toString(), {
      headers: { accept: "application/json" },
    });
    if (res.status !== 200) {
      return { status: "invalid", detail: `JWKS fetch failed: HTTP ${res.status}.` };
    }
    jwks = JSON.parse(res.text) as { keys?: Array<Record<string, unknown>> };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: "invalid", detail: `JWKS unavailable: ${msg.slice(0, 120)}` };
  }
  // Signatures are computed over the card WITHOUT its signatures member.
  const { signatures: _drop, ...unsigned } = rawCard;
  for (const sig of signatures) {
    if (verifyCardSignatureWithJwks(unsigned, sig, jwks)) {
      return { status: "verified", detail: "Signature verified against origin JWKS." };
    }
  }
  return { status: "invalid", detail: "No signature verified against the origin JWKS." };
}

/** Archive the raw card + verification state on the (managed proxy) agent
 *  row — what the detail page reads to show the verified badge. */
export function attachRemoteCardToAgent(
  agentId: string,
  rawJson: string,
  verified: RemoteCardVerification,
): void {
  db()
    .prepare("UPDATE agents SET a2a_card_json = ?, a2a_card_verified = ? WHERE id = ?")
    .run(rawJson, verified, agentId);
}

// --- B3: message/send + tasks/get polling -------------------------------------

type JsonRpcResponse = {
  jsonrpc?: string;
  id?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
};

// v0.3 task states that end the conversation turn.
const TERMINAL_OK = new Set(["completed"]);
const TERMINAL_FAIL = new Set(["failed", "rejected", "canceled"]);
// input-required / auth-required park the task waiting on US — we have no
// channel to supply more input mid-reply, so treat them as failures rather
// than polling the budget away.
const TERMINAL_STUCK = new Set(["input-required", "auth-required"]);

function textFromParts(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  return parts
    .filter(
      (p): p is { kind: string; text: string } =>
        !!p &&
        typeof p === "object" &&
        (p as Record<string, unknown>).kind === "text" &&
        typeof (p as Record<string, unknown>).text === "string",
    )
    .map((p) => p.text)
    .join("\n")
    .trim();
}

/** Pull the reply text out of a task: latest agent message in history, then
 *  status.message, then any artifact text parts as a fallback. */
function extractTaskReply(task: Record<string, unknown>): string {
  const history = Array.isArray(task.history) ? task.history : [];
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i] as Record<string, unknown> | null;
    if (m && typeof m === "object" && m.role === "agent") {
      const t = textFromParts(m.parts);
      if (t) return t;
    }
  }
  const status = task.status as Record<string, unknown> | undefined;
  const statusMsg = status?.message as Record<string, unknown> | undefined;
  if (statusMsg && typeof statusMsg === "object") {
    const t = textFromParts(statusMsg.parts);
    if (t) return t;
  }
  const artifacts = Array.isArray(task.artifacts) ? task.artifacts : [];
  const fromArtifacts = artifacts
    .map((a) =>
      a && typeof a === "object"
        ? textFromParts((a as Record<string, unknown>).parts)
        : "",
    )
    .filter(Boolean)
    .join("\n\n")
    .trim();
  return fromArtifacts;
}

function taskState(task: Record<string, unknown>): string {
  const status = task.status as Record<string, unknown> | undefined;
  return typeof status?.state === "string" ? status.state : "unknown";
}

async function rpcCall(
  url: string,
  method: string,
  params: Record<string, unknown>,
  authToken: string | undefined,
  timeoutMs: number,
): Promise<unknown> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, application/a2a+json",
  };
  if (authToken) headers.authorization = `Bearer ${authToken}`;
  const res = await fetchCapped(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params }),
    timeoutMs,
  });
  if (res.status >= 400) {
    throw new Error(`Remote A2A endpoint returned HTTP ${res.status}.`);
  }
  let body: JsonRpcResponse;
  try {
    body = JSON.parse(res.text) as JsonRpcResponse;
  } catch {
    throw new Error("Remote A2A endpoint returned non-JSON.");
  }
  if (body.error) {
    throw new Error(
      `Remote A2A error ${body.error.code ?? "?"}: ${String(body.error.message ?? "unknown").slice(0, 200)}`,
    );
  }
  return body.result;
}

export type RemoteSendResult = {
  text: string;
  /** Set when the remote answered via a task (vs a direct message). */
  task_id?: string;
};

/** Send one text message to a remote A2A agent and wait for its reply.
 *
 *  JSON-RPC message/send with a messageId as the spec-level idempotency key.
 *  Callers SHOULD pass a deterministic `messageId` (the reply pipeline derives
 *  one from the triggering message) so a reply-job lease-expiry retry re-sends
 *  the SAME key and the remote dedupes it — a fresh uuid is only the fallback
 *  for ad-hoc callers. If the result is a non-terminal task, polls tasks/get
 *  every `pollIntervalMs` until terminal or the wall-clock `budgetMs` runs
 *  out. The budget MUST stay under the 60s reply-job lease (default 45s) —
 *  exceeding it risks a second worker re-claiming the job mid-flight.
 *
 *  Throws on every failure mode (HTTP error, JSON-RPC error, timeout, stuck
 *  task, empty reply) so the caller's reply-job failure path — audit log +
 *  user-visible give-up notice — handles it; never fails silently. */
export async function sendMessageToRemoteAgent(input: {
  url: string;
  text: string;
  auth_token?: string;
  /** Spec-level idempotency key for message/send. Pass a stable value so
   *  retries of the same logical send dedupe on the remote side. */
  messageId?: string;
  /** Test hooks — production callers use the defaults. */
  budgetMs?: number;
  pollIntervalMs?: number;
  requestTimeoutMs?: number;
}): Promise<RemoteSendResult> {
  const budgetMs = Math.min(input.budgetMs ?? SEND_BUDGET_MS, SEND_BUDGET_MS);
  const pollIntervalMs = input.pollIntervalMs ?? POLL_INTERVAL_MS;
  const requestTimeoutMs = input.requestTimeoutMs ?? FETCH_TIMEOUT_MS;
  const deadline = Date.now() + budgetMs;
  const u = await assertRemoteUrlAllowed(input.url);

  const message = {
    kind: "message",
    messageId: input.messageId || randomUUID(),
    role: "user",
    parts: [{ kind: "text", text: input.text }],
  };
  const result = await rpcCall(
    u.toString(),
    "message/send",
    { message },
    input.auth_token,
    Math.min(requestTimeoutMs, Math.max(1, deadline - Date.now())),
  );
  if (!result || typeof result !== "object") {
    throw new Error("Remote A2A endpoint returned an empty result.");
  }
  let obj = result as Record<string, unknown>;

  // Direct message reply — done.
  if (obj.kind === "message") {
    const text = textFromParts(obj.parts);
    if (!text) throw new Error("Remote agent replied with no text parts.");
    return { text };
  }
  if (obj.kind !== "task") {
    throw new Error("Remote A2A endpoint returned neither a message nor a task.");
  }
  const taskId = typeof obj.id === "string" ? obj.id : "";
  if (!taskId) throw new Error("Remote task has no id.");

  for (;;) {
    const state = taskState(obj);
    if (TERMINAL_OK.has(state)) {
      const text = extractTaskReply(obj);
      if (!text) throw new Error("Remote task completed but contained no text.");
      return { text, task_id: taskId };
    }
    if (TERMINAL_FAIL.has(state)) {
      throw new Error(`Remote task ended in state "${state}".`);
    }
    if (TERMINAL_STUCK.has(state)) {
      throw new Error(`Remote task is stuck in "${state}" — cannot supply more input mid-reply.`);
    }
    // Require enough headroom for the sleep AND a meaningful RPC afterwards —
    // otherwise the final poll fires with a ~1ms timeout and dies as a
    // confusing AbortError instead of this clean budget message. Headroom is
    // proportional so tests with tiny intervals keep tight budgets.
    const headroom = Math.min(1000, pollIntervalMs);
    const remaining = deadline - Date.now();
    if (remaining <= pollIntervalMs + headroom) {
      throw new Error(`Remote task did not finish within ${Math.round(budgetMs / 1000)}s.`);
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    if (Date.now() >= deadline) {
      // Belt-and-braces: the event loop can overshoot the sleep.
      throw new Error(`Remote task did not finish within ${Math.round(budgetMs / 1000)}s.`);
    }
    const polled = await rpcCall(
      u.toString(),
      "tasks/get",
      { id: taskId, historyLength: 20 },
      input.auth_token,
      Math.min(requestTimeoutMs, Math.max(1, deadline - Date.now())),
    );
    if (!polled || typeof polled !== "object") {
      throw new Error("Remote tasks/get returned an empty result.");
    }
    obj = polled as Record<string, unknown>;
  }
}
