import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { deleteAgentForUser, listAgentsForUser } from "@/lib/agents";
import {
  PERSONA_TEMPLATES,
  spawnManagedAgent,
} from "@/lib/managed-agents";
import {
  createDirectConversation,
} from "@/lib/conversations";
import { defaultBrainConfig } from "@/lib/brains";
import {
  attachRemoteCardToAgent,
  discoverAgentsViaArd,
  fetchRemoteAgentCard,
  verifyRemoteAgentCard,
  type DiscoveredAgent,
  type SanitizedRemoteCard,
} from "@/lib/a2a-client";
import type { RemoteCardVerification } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Derive a default handle from the remote card's (sanitized) name —
 *  lowercase, [a-z0-9-] only, must start with a letter. */
function handleFromCardName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[^a-z]+/, "")
    .replace(/-+$/, "")
    .slice(0, 30);
  return slug.length >= 2 ? slug : "remote";
}

async function connectAction(formData: FormData) {
  "use server";
  const user = await requireUser();
  const handle = String(formData.get("handle") ?? "");
  const display_name = String(formData.get("display_name") ?? "");
  const persona = String(formData.get("persona") ?? "");
  const emoji = String(formData.get("avatar_emoji") ?? "🦀");
  const templateKey = String(formData.get("template_key") ?? "blank");
  const startChatRaw = String(formData.get("start_chat_with") ?? "");
  let agentId: string;
  try {
    const agent = spawnManagedAgent(user.id, {
      handle,
      purpose: "agent",
      display_name,
      persona,
      avatar_emoji: emoji,
      framework: "openclaw",
      description: `Hosted OpenClaw assistant (${templateKey})`,
    });
    agentId = agent.id;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Could not connect.";
    redirect(`/app/agents/connect?error=${encodeURIComponent(msg)}`);
  }
  revalidatePath("/app", "layout");

  // Optional: open a chat with one of your existing agents right away.
  // NOTE: redirect() throws NEXT_REDIRECT — it must stay OUTSIDE the
  // try/catch or the catch swallows the navigation (pre-v0.21 bug).
  if (startChatRaw) {
    let convId: string | null = null;
    try {
      convId = createDirectConversation(user.id, startChatRaw, agentId).id;
    } catch {
      // fall through to detail
    }
    if (convId) redirect(`/app/c/${convId}`);
  }
  redirect(`/app/agents/${encodeURIComponent(agentId)}?ok=Assistant+created`);
}

// --- Remote A2A connect (v0.21, group B) -------------------------------------
// Step 1: paste a URL → previewRemoteA2AAction fetches + verifies the card and
// bounces back with ?a2a_url= (or ?a2a_error=). Step 2: the page re-fetches to
// render the preview + verified/unverified/invalid badge. Step 3:
// connectRemoteA2AAction re-fetches + re-verifies (no TOCTOU on a stale
// preview) and creates the managed proxy agent with brain provider "a2a".

// ARD discovery: given just an ORIGIN, read its /.well-known/ai-catalog.json
// and list the A2A agents it publishes so the user can pick one to preview —
// no need to know each per-agent card URL. Bounces back with ?discover_origin=
// (or ?discover_error=), same round-trip pattern as the preview flow.
async function discoverArdAction(formData: FormData) {
  "use server";
  await requireUser();
  const origin = String(formData.get("discover_origin") ?? "").trim();
  let errMsg: string | null = null;
  try {
    await discoverAgentsViaArd(origin); // validate origin + catalog now
  } catch (err) {
    errMsg = err instanceof Error ? err.message : "Could not read the discovery catalog.";
  }
  if (errMsg) {
    redirect(`/app/agents/connect?discover_error=${encodeURIComponent(errMsg)}#remote`);
  }
  redirect(`/app/agents/connect?discover_origin=${encodeURIComponent(origin)}#remote`);
}

async function previewRemoteA2AAction(formData: FormData) {
  "use server";
  await requireUser();
  const url = String(formData.get("a2a_url") ?? "").trim();
  let errMsg: string | null = null;
  try {
    const fetched = await fetchRemoteAgentCard(url);
    // Verification result is rendered on the preview pass — run it here too
    // so a hard failure (e.g. SSRF-rejected origin) surfaces as the error
    // banner instead of a half-rendered preview.
    await verifyRemoteAgentCard(fetched.rawCard, url);
  } catch (err) {
    errMsg = err instanceof Error ? err.message : "Could not fetch the agent card.";
  }
  // redirect() throws NEXT_REDIRECT — keep it OUTSIDE the try so our own
  // catch can't swallow it.
  if (errMsg) {
    redirect(`/app/agents/connect?a2a_error=${encodeURIComponent(errMsg)}#remote`);
  }
  redirect(`/app/agents/connect?a2a_url=${encodeURIComponent(url)}#remote`);
}

async function connectRemoteA2AAction(formData: FormData) {
  "use server";
  const user = await requireUser();
  const url = String(formData.get("a2a_url") ?? "").trim();
  const handle = String(formData.get("handle") ?? "").trim();
  const displayName = String(formData.get("display_name") ?? "").trim();
  const authToken = String(formData.get("auth_token") ?? "").trim();
  const overrideInvalid = formData.get("override_invalid") === "on";
  let agentId: string | null = null;
  let errMsg: string | null = null;
  try {
    const fetched = await fetchRemoteAgentCard(url);
    const verification = await verifyRemoteAgentCard(fetched.rawCard, url);
    if (verification.status === "invalid" && !overrideInvalid) {
      throw new Error(
        "Card signature is INVALID — connection blocked. Tick “connect anyway” to override.",
      );
    }
    const agent = spawnManagedAgent(user.id, {
      handle,
      purpose: "a2a",
      display_name: displayName || fetched.card.name,
      // B5 (card poisoning): remote card text must never reach an LLM
      // prompt. Persona stays empty — the remote agent brings its own brain.
      persona: "",
      description: `Remote A2A assistant — ${fetched.card.description}`.slice(0, 280),
      avatar_emoji: "🌐",
      framework: "generic",
      brain: {
        provider: "a2a",
        // The JSON-RPC endpoint is what the card declares in `url` — the
        // user-typed URL is just where we found the card (origin or card
        // path). fetchRemoteAgentCard rejects cards without a url, and
        // sendMessageToRemoteAgent re-runs the SSRF gate on every send, so
        // a hostile card URL still can't reach private ranges.
        url: fetched.card.url,
        ...(authToken ? { auth_token: authToken } : {}),
      },
      capabilities: fetched.card.skills
        .filter((s) => s.id || s.name)
        .map((s) => ({ name: s.id || s.name })),
    });
    try {
      attachRemoteCardToAgent(agent.id, fetched.raw_json, verification.status);
    } catch (attachErr) {
      // Don't leave a half-connected agent behind (created but with no card
      // archive / verification state) — roll the creation back, then surface
      // the failure through the normal error banner.
      try {
        deleteAgentForUser(agent.id, user.id);
      } catch {
        // Best-effort: if the rollback also fails, the error banner below
        // still tells the user the connection failed.
      }
      throw attachErr;
    }
    agentId = agent.id;
  } catch (err) {
    errMsg = err instanceof Error ? err.message : "Could not connect the remote assistant.";
  }
  if (errMsg || !agentId) {
    redirect(
      `/app/agents/connect?a2a_url=${encodeURIComponent(url)}&a2a_error=${encodeURIComponent(
        errMsg ?? "Could not connect the remote assistant.",
      )}#remote`,
    );
  }
  revalidatePath("/app", "layout");
  redirect(`/app/agents/${encodeURIComponent(agentId)}?ok=Remote+assistant+connected`);
}

export default async function ConnectAgentPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    template?: string;
    a2a_url?: string;
    a2a_error?: string;
    discover_origin?: string;
    discover_error?: string;
  }>;
}) {
  const user = await requireUser();
  const { error, template, a2a_url, a2a_error, discover_origin, discover_error } =
    await searchParams;
  const myAgents = listAgentsForUser(user.id);
  const cfg = defaultBrainConfig();
  const tpl =
    PERSONA_TEMPLATES.find((t) => t.key === template) ??
    PERSONA_TEMPLATES[0];

  // Remote A2A preview (step 2): re-fetch + re-verify the card for display.
  // Errors degrade to the banner — never a half-rendered preview.
  let remotePreview:
    | { card: SanitizedRemoteCard; verification: RemoteCardVerification; detail: string }
    | null = null;
  let remoteError = a2a_error ?? null;
  if (a2a_url && !remoteError) {
    try {
      const fetched = await fetchRemoteAgentCard(a2a_url);
      const v = await verifyRemoteAgentCard(fetched.rawCard, a2a_url);
      remotePreview = { card: fetched.card, verification: v.status, detail: v.detail };
    } catch (err) {
      remoteError = err instanceof Error ? err.message : "Could not fetch the agent card.";
    }
  }

  // ARD discovery results (step 2): re-read the catalog for display.
  let discovered: DiscoveredAgent[] = [];
  let discoverErr = discover_error ?? null;
  if (discover_origin && !discoverErr) {
    try {
      discovered = await discoverAgentsViaArd(discover_origin);
    } catch (err) {
      discoverErr = err instanceof Error ? err.message : "Could not read the catalog.";
    }
  }

  return (
    <div className="app-stage">
      <Link
        href="/app/agents"
        className="text-sm text-[color:var(--color-ink-muted)] hover:text-[color:var(--color-ink)]"
      >
        ← Back to my agents
      </Link>
      <header className="mt-4 page-header-row">
        <div>
        <div className="page-kicker">Add my agent</div>
        <h1 className="page-title">Create a hosted assistant</h1>
        <p className="page-subtitle">
          Create an assistant that runs on Agent2Agent. Nothing to install:
          chat with it right away, then add it to rooms and workspaces.
        </p>
        <span className="tag tag-violet">like adding a Telegram bot</span>
        </div>
      </header>
      <p className="mt-1 text-xs text-[color:var(--color-ink-soft)]">
        Model: <code className="kbd">{cfg.provider}</code>
        {cfg.model ? <> · <code className="kbd">{cfg.model}</code></> : null}
        {cfg.provider === "mock" ? (
          <> · set <code className="kbd">ANTHROPIC_API_KEY</code> for live AI replies</>
        ) : null}
      </p>

      {error ? (
        <div className="callout callout-amber mt-6 text-sm">
          <span>⚠️</span>
          <span>{error}</span>
        </div>
      ) : null}

      <section className="mt-8">
        <h2 className="font-medium mb-3">Pick a template</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {PERSONA_TEMPLATES.map((t) => (
            <Link
              key={t.key}
              href={`/app/agents/connect?template=${encodeURIComponent(t.key)}`}
              className={`module-panel p-4 surface-hover block ${
                t.key === tpl.key
                  ? "border-[color:var(--color-ink)] shadow-[var(--shadow-pop)]"
                  : ""
              }`}
            >
              <div className="text-2xl mb-1">{t.emoji}</div>
              <div className="font-medium text-sm">{t.display_name}</div>
              <div className="text-xs text-[color:var(--color-ink-muted)] mt-1">
                {t.description}
              </div>
            </Link>
          ))}
        </div>
      </section>

      <form action={connectAction} className="mt-8 module-panel p-5 space-y-4">
        <input type="hidden" name="template_key" value={tpl.key} />
        <div className="grid grid-cols-1 sm:grid-cols-[80px_1fr_1fr] gap-3">
          <label>
            <span className="label">Emoji</span>
            <input
              className="input"
              name="avatar_emoji"
              defaultValue={tpl.emoji}
              maxLength={4}
            />
          </label>
          <label>
            <span className="label">Display name</span>
            <input
              className="input"
              name="display_name"
              required
              maxLength={60}
              defaultValue={tpl.display_name}
            />
          </label>
          <label>
            <span className="label">Handle</span>
            <input
              className="input"
              name="handle"
              required
              minLength={2}
              maxLength={30}
              pattern="^[a-z][a-z0-9-]{1,29}$"
              defaultValue={tpl.key.replace(/-/g, "")}
            />
            <span className="text-[11px] text-[color:var(--color-ink-soft)] mt-1 block">
              Becomes part of the assistant&apos;s ID.
            </span>
          </label>
        </div>
        <label>
          <span className="label">Instructions</span>
          <textarea
            name="persona"
            className="input min-h-[140px] font-mono text-[12.5px]"
            defaultValue={tpl.persona}
            placeholder="What this assistant is, how it should behave, what it should focus on…"
          />
        </label>
        {myAgents.length > 0 ? (
          <label>
            <span className="label">Open a chat right after creating</span>
            <select name="start_chat_with" className="input" defaultValue="">
              <option value="">(no — just create it)</option>
              {myAgents
                .filter((a) => a.agent_kind === "external")
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    chat as {a.avatar_emoji} {a.id}
                  </option>
                ))}
            </select>
            <span className="text-[11px] text-[color:var(--color-ink-soft)] mt-1 block">
              Either way, the new assistant is automatically added as a contact for all your existing assistants.
            </span>
          </label>
        ) : null}
        <div className="flex gap-3">
          <button type="submit" className="btn btn-primary btn-lg">
            Create hosted assistant
          </button>
          <Link href="/app/agents" className="btn btn-secondary btn-lg">
            Cancel
          </Link>
        </div>
      </form>

      <section id="remote" className="mt-12">
        <div className="flex items-baseline gap-3 flex-wrap">
          <h2 className="text-xl font-semibold tracking-tight">
            Connect an assistant from another service (A2A)
          </h2>
          <span className="tag tag-blue">cross-platform · by URL</span>
        </div>
        <p className="mt-2 text-sm text-[color:var(--color-ink-muted)]">
          If an assistant lives on another website or service that speaks the
          A2A protocol, you can link it here by URL. Paste its agent-card URL
          (or just the site address) — we fetch its card, verify the
          signature, and create a stand-in assistant that forwards messages to
          it. It joins conversations like any other assistant.
        </p>

        {remoteError ? (
          <div className="callout callout-amber mt-4 text-sm">
            <span>⚠️</span>
            <span>{remoteError}</span>
          </div>
        ) : null}

        {/* Discovery-first: point at an ORIGIN, list its published agents. */}
        <form action={discoverArdAction} className="mt-4 module-panel p-5">
          <label>
            <span className="label">Discover from an origin (ARD)</span>
            <input
              className="input font-mono text-[12.5px]"
              name="discover_origin"
              type="url"
              required
              placeholder="https://agents.example.com"
              defaultValue={discover_origin ?? ""}
            />
          </label>
          <p className="mt-1.5 text-[11px] text-[color:var(--color-ink-soft)]">
            Reads the origin’s <span className="font-mono">/.well-known/ai-catalog.json</span> and
            lists the A2A agents it publishes.
          </p>
          <div className="mt-3">
            <button type="submit" className="btn btn-secondary">
              Discover agents
            </button>
          </div>
        </form>

        {discoverErr ? (
          <div className="callout callout-amber mt-3 text-sm">
            <span>⚠️</span>
            <span>{discoverErr}</span>
          </div>
        ) : null}

        {discover_origin && !discoverErr ? (
          <div className="mt-3 module-panel p-5">
            <div className="text-[12px] text-[color:var(--color-ink-soft)]">
              {discovered.length} agent{discovered.length === 1 ? "" : "s"} published at{" "}
              <span className="font-mono">{discover_origin}</span>
            </div>
            <div className="mt-3 space-y-2">
              {discovered.map((d) => (
                <div
                  key={d.identifier || d.cardUrl}
                  className="flex items-center gap-3 rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-paper)] px-3 py-2.5"
                >
                  <div className="text-lg">🌐</div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{d.name}</div>
                    {d.description ? (
                      <div className="truncate text-[11px] text-[color:var(--color-ink-muted)]">
                        {d.description}
                      </div>
                    ) : null}
                  </div>
                  <Link
                    href={`/app/agents/connect?a2a_url=${encodeURIComponent(d.cardUrl)}#remote`}
                    className="btn btn-secondary btn-sm shrink-0"
                  >
                    Preview
                  </Link>
                </div>
              ))}
              {discovered.length === 0 ? (
                <p className="text-[12px] text-[color:var(--color-ink-muted)]">
                  No A2A agents in this origin’s catalog.
                </p>
              ) : null}
            </div>
          </div>
        ) : null}

        <form action={previewRemoteA2AAction} className="mt-4 module-panel p-5">
          <label>
            <span className="label">…or paste an agent card URL directly</span>
            <input
              className="input font-mono text-[12.5px]"
              name="a2a_url"
              type="url"
              required
              placeholder="https://agents.example.com/.well-known/agent-card.json"
              defaultValue={a2a_url ?? ""}
            />
          </label>
          <div className="mt-3">
            <button type="submit" className="btn btn-secondary">
              Preview
            </button>
          </div>
        </form>

        {remotePreview && a2a_url ? (
          <div className="mt-4 module-panel p-5">
            <div className="flex items-start gap-3">
              <div className="text-2xl">🌐</div>
              <div className="flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium">{remotePreview.card.name}</span>
                  {remotePreview.verification === "verified" ? (
                    <span className="tag tag-green">✓ signature verified</span>
                  ) : remotePreview.verification === "unverified" ? (
                    <span className="tag">unsigned card</span>
                  ) : (
                    <span className="tag tag-amber">✗ signature INVALID</span>
                  )}
                  {remotePreview.card.version ? (
                    <span className="tag">v{remotePreview.card.version}</span>
                  ) : null}
                </div>
                <p className="mt-1 text-[11px] text-[color:var(--color-ink-soft)]">
                  {remotePreview.detail}
                </p>
                {remotePreview.card.description ? (
                  <p className="mt-2 text-sm text-[color:var(--color-ink-muted)]">
                    {remotePreview.card.description}
                  </p>
                ) : null}
                {remotePreview.card.skills.length > 0 ? (
                  <div className="mt-3 flex gap-2 flex-wrap">
                    {remotePreview.card.skills.map((s, i) => (
                      <span key={`${s.id}-${i}`} className="tag tag-violet">
                        {s.name || s.id}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>

            <form action={connectRemoteA2AAction} className="mt-5 space-y-4 border-t border-[color:var(--color-line)] pt-4">
              <input type="hidden" name="a2a_url" value={a2a_url} />
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <label>
                  <span className="label">Display name</span>
                  <input
                    className="input"
                    name="display_name"
                    required
                    maxLength={60}
                    defaultValue={remotePreview.card.name.slice(0, 60)}
                  />
                </label>
                <label>
                  <span className="label">Handle</span>
                  <input
                    className="input"
                    name="handle"
                    required
                    minLength={2}
                    maxLength={30}
                    pattern="^[a-z][a-z0-9-]{1,29}$"
                    defaultValue={handleFromCardName(remotePreview.card.name)}
                  />
                </label>
              </div>
              <label>
                <span className="label">Access token (optional)</span>
                <input
                  className="input font-mono text-[12.5px]"
                  name="auth_token"
                  type="password"
                  autoComplete="off"
                  placeholder="Only if the remote service requires one — never shown again"
                />
              </label>
              {remotePreview.verification === "invalid" ? (
                <label className="flex items-start gap-2 text-sm callout callout-amber p-3">
                  <input type="checkbox" name="override_invalid" className="mt-0.5" />
                  <span>
                    The card&apos;s signature did <strong>not</strong> verify —
                    it may be tampered with or impersonated. Connect anyway at
                    my own risk.
                  </span>
                </label>
              ) : null}
              <div className="flex gap-3">
                <button type="submit" className="btn btn-primary btn-lg">
                  Connect remote assistant
                </button>
              </div>
            </form>
          </div>
        ) : null}
      </section>
    </div>
  );
}
