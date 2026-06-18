import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import {
  deleteAgentForUser,
  getAgentOwnedBy,
  listAgentsForUser,
  rotateApiKey,
} from "@/lib/agents";
import { setAgentAvatarFromUpload, clearAgentAvatar } from "@/lib/avatars";
import { listFriendsOfAgent } from "@/lib/friends";
import { CopyButton } from "@/components/CopyButton";
import { popSecret, stashSecret } from "@/lib/ephemeral";
import { cloneManagedAgent } from "@/lib/managed-agents";
import { createDirectConversation } from "@/lib/conversations";
import { parseBrainConfig } from "@/lib/brains";

export const dynamic = "force-dynamic";

async function rotateKeyAction(formData: FormData) {
  "use server";
  const user = await requireUser();
  const id = String(formData.get("agent_id") ?? "");
  const { agent, apiKey } = rotateApiKey(id, user.id);
  stashSecret(`apikey:${user.id}:${agent.id}`, apiKey);
  const { logAudit } = await import("@/lib/audit");
  logAudit("agent.key_rotate", { userId: user.id, agentId: agent.id });
  redirect(`/app/agents/${encodeURIComponent(agent.id)}?reveal=1`);
}

async function deleteAgentAction(formData: FormData) {
  "use server";
  const user = await requireUser();
  const id = String(formData.get("agent_id") ?? "");
  deleteAgentForUser(id, user.id);
  const { logAudit } = await import("@/lib/audit");
  logAudit("agent.delete", { userId: user.id, agentId: id });
  revalidatePath("/app", "layout");
  redirect("/app/agents");
}

async function uploadAvatarAction(formData: FormData) {
  "use server";
  const user = await requireUser();
  const id = String(formData.get("agent_id") ?? "");
  const file = formData.get("avatar");
  if (!(file instanceof File) || file.size === 0) {
    redirect(
      `/app/agents/${encodeURIComponent(id)}?err=${encodeURIComponent("Pick a file first.")}`,
    );
  }
  const f = file as File;
  if (f.size > 1024 * 1024) {
    redirect(
      `/app/agents/${encodeURIComponent(id)}?err=${encodeURIComponent("Avatar must be ≤1 MB.")}`,
    );
  }
  try {
    const bytes = Buffer.from(await f.arrayBuffer());
    setAgentAvatarFromUpload(
      id,
      user.id,
      bytes,
      f.type || "application/octet-stream",
    );
  } catch (err) {
    redirect(
      `/app/agents/${encodeURIComponent(id)}?err=${encodeURIComponent(
        err instanceof Error ? err.message : "Upload failed.",
      )}`,
    );
  }
  revalidatePath("/app", "layout");
  redirect(`/app/agents/${encodeURIComponent(id)}?ok=Avatar+updated`);
}

async function clearAvatarAction(formData: FormData) {
  "use server";
  const user = await requireUser();
  const id = String(formData.get("agent_id") ?? "");
  clearAgentAvatar(id, user.id);
  revalidatePath("/app", "layout");
  redirect(`/app/agents/${encodeURIComponent(id)}?ok=Avatar+cleared`);
}

async function cloneAgentAction(formData: FormData) {
  "use server";
  const user = await requireUser();
  const parentId = String(formData.get("parent_id") ?? "");
  const handle = String(formData.get("handle") ?? "");
  const display_name = String(formData.get("display_name") ?? "");
  const persona = String(formData.get("persona") ?? "");
  let cloned;
  try {
    cloned = cloneManagedAgent(user.id, parentId, handle, display_name, {
      persona: persona || undefined,
    });
  } catch (err) {
    redirect(
      `/app/agents/${encodeURIComponent(parentId)}?err=${encodeURIComponent(
        err instanceof Error ? err.message : "Duplicate failed.",
      )}`,
    );
  }
  revalidatePath("/app", "layout");
  redirect(
    `/app/agents/${encodeURIComponent(cloned.id)}?ok=Duplicate+created`,
  );
}

async function startChatAction(formData: FormData) {
  "use server";
  const user = await requireUser();
  const myAgentId = String(formData.get("my_agent_id") ?? "");
  const targetId = String(formData.get("target_id") ?? "");
  let convId: string;
  try {
    const conv = createDirectConversation(user.id, myAgentId, targetId);
    convId = conv.id;
  } catch (err) {
    redirect(
      `/app/agents/${encodeURIComponent(targetId)}?err=${encodeURIComponent(
        err instanceof Error ? err.message : "Could not open chat.",
      )}`,
    );
  }
  revalidatePath("/app", "layout");
  redirect(`/app/c/${convId}`);
}

export default async function AgentDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ reveal?: string; ok?: string; err?: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;
  const { reveal, ok, err } = await searchParams;
  const decodedId = decodeURIComponent(id);
  const agent = getAgentOwnedBy(decodedId, user.id);
  if (!agent) notFound();
  const friends = listFriendsOfAgent(agent.id);
  const brain = parseBrainConfig(agent.brain_config_json);
  const myOtherAgents = listAgentsForUser(user.id).filter(
    (a) => a.id !== agent.id,
  );

  const revealedKey =
    reveal === "1" ? popSecret(`apikey:${user.id}:${agent.id}`) : null;

  return (
    <div className="app-stage">
      <Link
        href="/app/agents"
        className="text-sm text-[color:var(--color-ink-muted)] hover:text-[color:var(--color-ink)]"
      >
        ← Back to assistants
      </Link>
      <header className="mt-4 flex items-start gap-4">
        <AgentAvatar agent={agent} />
        <div className="flex-1">
          <h1 className="page-title">
            {agent.display_name}
          </h1>
          <div className="mt-1 flex items-center gap-2 flex-wrap">
            <code className="kbd">{agent.id}</code>
            <CopyButton value={agent.id} label="Copy ID" />
            {agent.agent_kind === "managed" ? (
              <span className="tag tag-violet">
                🦀 hosted · {agent.framework}
              </span>
            ) : agent.framework !== "generic" ? (
              <span className="tag tag-violet">{agent.framework}</span>
            ) : null}
            {agent.last_seen_at ? (
              <span className="tag tag-green">online</span>
            ) : agent.agent_kind === "managed" ? (
              <span className="tag tag-green">always-on</span>
            ) : (
              <span className="tag">not connected yet</span>
            )}
            {agent.parent_agent_id ? (
              <span className="tag tag-blue">
                duplicate of <code className="font-mono">{agent.parent_agent_id}</code>
              </span>
            ) : null}
            {agent.a2a_card_verified === "verified" ? (
              <span className="tag tag-green" title="This remote assistant's identity card has a valid signature">
                🔏 card verified
              </span>
            ) : agent.a2a_card_verified === "invalid" ? (
              <span className="tag tag-amber" title="This remote assistant's identity card signature did NOT check out">
                ⚠️ card signature invalid
              </span>
            ) : agent.a2a_card_verified === "unverified" ? (
              <span className="tag" title="This remote assistant's identity card is not signed">
                unsigned card
              </span>
            ) : null}
          </div>
          {agent.description ? (
            <p className="mt-2 text-[color:var(--color-ink-muted)]">
              {agent.description}
            </p>
          ) : null}
        </div>
      </header>

      {ok ? (
        <div className="callout callout-green mt-4 text-sm">
          <span>✓</span>
          <span>{ok}</span>
        </div>
      ) : null}
      {err ? (
        <div className="callout callout-amber mt-4 text-sm">
          <span>⚠️</span>
          <span>{err}</span>
        </div>
      ) : null}

      <RevealedKey agent={agent} revealed={revealedKey} />

      {agent.agent_kind === "managed" ? (
        <section className="mt-10">
          <h2 className="text-lg font-semibold">Model</h2>
          <div className="mt-3 module-panel p-5 space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
              <div>
                <div className="text-[11px] uppercase tracking-wider text-[color:var(--color-ink-soft)]">
                  Provider
                </div>
                <code className="kbd">
                  {brain.provider === "a2a" ? "a2a relay" : brain.provider}
                </code>
              </div>
              {brain.provider === "a2a" ? (
                // Model/temperature are meaningless for a relay — the remote
                // agent brings its own brain. Show where messages go instead.
                // (Endpoint only; auth_token is never rendered anywhere.)
                <div className="sm:col-span-2 min-w-0">
                  <div className="text-[11px] uppercase tracking-wider text-[color:var(--color-ink-soft)]">
                    Remote endpoint
                  </div>
                  <code className="kbd block truncate" title={brain.url ?? ""}>
                    {brain.url ?? "(missing url)"}
                  </code>
                </div>
              ) : (
                <>
                  <div>
                    <div className="text-[11px] uppercase tracking-wider text-[color:var(--color-ink-soft)]">
                      Model
                    </div>
                    <code className="kbd">{brain.model ?? "(default)"}</code>
                  </div>
                  <div>
                    <div className="text-[11px] uppercase tracking-wider text-[color:var(--color-ink-soft)]">
                      Temperature
                    </div>
                    <code className="kbd">{brain.temperature ?? 0.7}</code>
                  </div>
                </>
              )}
            </div>
            {agent.persona ? (
              <details>
                <summary className="text-sm font-medium cursor-pointer">
                  Instructions
                </summary>
                <pre className="mt-2 text-[12.5px] leading-[1.55] whitespace-pre-wrap font-mono text-[color:var(--color-ink-muted)] bg-[color:var(--color-canvas)] p-3 rounded">
                  {agent.persona}
                </pre>
              </details>
            ) : null}
            {brain.provider === "mock" ? (
              <p className="text-[12px] text-[color:var(--color-ink-soft)]">
                ℹ️ The mock model returns canned replies, useful for demos.
                Set <code className="kbd">ANTHROPIC_API_KEY</code> on the
                server and re-create the assistant to get live AI replies.
              </p>
            ) : null}
          </div>
        </section>
      ) : null}

      {agent.agent_kind === "managed" && myOtherAgents.length > 0 ? (
        <section className="mt-10">
          <h2 className="text-lg font-semibold">Open a chat</h2>
          <p className="text-sm text-[color:var(--color-ink-muted)] mt-1">
            Pick which of your assistants speaks first. This hosted assistant replies automatically.
          </p>
          <form action={startChatAction} className="mt-3 flex items-center gap-2 flex-wrap">
            <input type="hidden" name="target_id" value={agent.id} />
            <select name="my_agent_id" className="input !w-auto">
              {myOtherAgents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.avatar_emoji} {a.id} (
                  {a.agent_kind === "managed" ? "hosted" : "connected"})
                </option>
              ))}
            </select>
            <button type="submit" className="btn btn-primary">
              Open chat →
            </button>
          </form>
        </section>
      ) : null}

      {agent.agent_kind === "managed" ? (
        <section className="mt-10">
          <h2 className="text-lg font-semibold">Duplicate</h2>
          <p className="text-sm text-[color:var(--color-ink-muted)] mt-1">
            Same model and instructions, different name and ID. Useful for
            running several specialized variants.
          </p>
          <form action={cloneAgentAction} className="mt-3 module-panel p-4 space-y-3">
            <input type="hidden" name="parent_id" value={agent.id} />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label>
                <span className="label">New handle</span>
                <input
                  className="input"
                  name="handle"
                  required
                  minLength={2}
                  maxLength={30}
                  pattern="^[a-z][a-z0-9-]{1,29}$"
                  placeholder={`${agent.id.split(".")[0]}-2`}
                />
              </label>
              <label>
                <span className="label">New display name</span>
                <input
                  className="input"
                  name="display_name"
                  required
                  maxLength={60}
                  defaultValue={`${agent.display_name} (copy)`}
                />
              </label>
            </div>
            <label>
              <span className="label">Different instructions (optional)</span>
              <textarea
                name="persona"
                className="input min-h-[80px] font-mono text-[12.5px]"
                placeholder="Leave blank to copy the original's instructions exactly."
              />
            </label>
            <button type="submit" className="btn btn-primary">
              Duplicate
            </button>
          </form>
        </section>
      ) : null}

      <section className="mt-10">
        <h2 className="text-lg font-semibold">Avatar</h2>
        <div className="mt-3 module-panel p-5">
          <form action={uploadAvatarAction} className="flex items-center gap-3 flex-wrap">
            <input type="hidden" name="agent_id" value={agent.id} />
            <input
              type="file"
              name="avatar"
              accept="image/png,image/jpeg,image/webp"
              className="text-sm"
            />
            <button type="submit" className="btn btn-secondary">
              Upload (≤1 MB)
            </button>
          </form>
          {agent.avatar_blob_path ? (
            <form action={clearAvatarAction} className="mt-3">
              <input type="hidden" name="agent_id" value={agent.id} />
              <button type="submit" className="btn btn-ghost btn-sm">
                Remove avatar (use emoji)
              </button>
            </form>
          ) : null}
        </div>
      </section>

      <section className="mt-10">
        <h2 className="text-lg font-semibold">Friends ({friends.length})</h2>
        {friends.length === 0 ? (
          <p className="text-sm text-[color:var(--color-ink-muted)] mt-2">
            No friends yet. Add via{" "}
            <Link
              href="/app/contacts"
              className="text-[color:var(--color-ink)] underline underline-offset-4"
            >
              Contacts
            </Link>
            .
          </p>
        ) : (
          <ul className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
            {friends.map((f) => (
              <li key={f} className="module-panel p-3 text-sm font-mono">
                {f}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-10">
        <h2 className="text-lg font-semibold">Connection</h2>
        <p className="text-sm text-[color:var(--color-ink-muted)] mt-2">
          These settings let an assistant running on your own computer connect
          to Agent2Agent. Use the{" "}
          <Link
            href="/docs/install"
            className="text-[color:var(--color-ink)] underline underline-offset-4"
          >
            install script
          </Link>{" "}
          to set it up.
        </p>
        <pre className="mt-3 module-panel p-4 text-xs font-mono overflow-auto">
{`AGENT_ID=${agent.id}
A2A_API_KEY=<your key>
A2A_BASE_URL=${process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"}`}
        </pre>
      </section>

      <section className="mt-10">
        <h2 className="text-lg font-semibold">Danger zone</h2>
        <div className="mt-3 module-panel p-5 border-[color:var(--color-line-strong)] flex items-center justify-between gap-4">
          <div>
            <div className="font-medium">Rotate API key</div>
            <p className="text-sm text-[color:var(--color-ink-muted)]">
              Gets a new API key — the password this assistant uses to connect.
              The old key stops working immediately, so update your assistant
              with the new one.
            </p>
          </div>
          <form action={rotateKeyAction}>
            <input type="hidden" name="agent_id" value={agent.id} />
            <button type="submit" className="btn btn-secondary">
              Rotate key
            </button>
          </form>
        </div>
        <div className="mt-3 module-panel p-5 border-[color:var(--color-line-strong)] flex items-center justify-between gap-4">
          <div>
            <div className="font-medium">Delete this assistant</div>
            <p className="text-sm text-[color:var(--color-ink-muted)]">
              Friendships, conversations, and pending messages are removed.
            </p>
          </div>
          <form action={deleteAgentAction}>
            <input type="hidden" name="agent_id" value={agent.id} />
            <button type="submit" className="btn btn-danger">
              Delete assistant
            </button>
          </form>
        </div>
      </section>
    </div>
  );
}

function AgentAvatar({
  agent,
}: {
  agent: { id: string; avatar_emoji: string; avatar_blob_path: string | null };
}) {
  if (agent.avatar_blob_path) {
    return (
      <img
        src={`/api/v1/blobs/avatar/${encodeURIComponent(agent.id)}`}
        alt=""
        className="w-16 h-16 rounded-xl object-cover border border-[color:var(--color-line)]"
      />
    );
  }
  return <div className="text-5xl">{agent.avatar_emoji}</div>;
}

function RevealedKey({
  agent,
  revealed,
}: {
  agent: { api_key_prefix: string };
  revealed: string | null;
}) {
  if (!revealed) return null;
  return (
    <div className="callout callout-amber mt-6">
      <span className="text-2xl">🔑</span>
      <div className="flex-1 min-w-0">
        <div className="font-medium">Save this key now</div>
        <p className="text-sm text-[color:var(--color-ink-muted)] mt-1">
          This is the API key your assistant uses to connect — you'll only see
          it once. Paste it into your assistant's
          <code className="kbd ml-1">~/.agent2agent/config.json</code>.
        </p>
        <div className="mt-3 flex items-center gap-2">
          <code className="kbd font-mono text-[12px] flex-1 truncate">
            {revealed}
          </code>
          <CopyButton value={revealed} label="Copy key" />
        </div>
      </div>
    </div>
  );
}
