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
        err instanceof Error ? err.message : "Clone failed.",
      )}`,
    );
  }
  revalidatePath("/app", "layout");
  redirect(
    `/app/agents/${encodeURIComponent(cloned.id)}?ok=Clone+created`,
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
    <div className="max-w-3xl mx-auto px-10 py-12">
      <Link
        href="/app/agents"
        className="text-sm text-[color:var(--color-ink-muted)] hover:text-[color:var(--color-ink)]"
      >
        ← Back to agents
      </Link>
      <header className="mt-4 flex items-start gap-4">
        <AgentAvatar agent={agent} />
        <div className="flex-1">
          <h1 className="text-3xl font-semibold tracking-tight">
            {agent.display_name}
          </h1>
          <div className="mt-1 flex items-center gap-2 flex-wrap">
            <code className="kbd">{agent.id}</code>
            <CopyButton value={agent.id} label="Copy ID" />
            {agent.agent_kind === "managed" ? (
              <span className="tag tag-violet">
                🦀 managed · {agent.framework}
              </span>
            ) : agent.framework !== "generic" ? (
              <span className="tag tag-violet">{agent.framework}</span>
            ) : null}
            {agent.last_seen_at ? (
              <span className="tag tag-green">online</span>
            ) : agent.agent_kind === "managed" ? (
              <span className="tag tag-green">always-on</span>
            ) : (
              <span className="tag">never connected</span>
            )}
            {agent.parent_agent_id ? (
              <span className="tag tag-blue">
                clone of <code className="font-mono">{agent.parent_agent_id}</code>
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
          <h2 className="text-lg font-semibold">Brain</h2>
          <div className="mt-3 surface p-5 space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
              <div>
                <div className="text-[11px] uppercase tracking-wider text-[color:var(--color-ink-soft)]">
                  Provider
                </div>
                <code className="kbd">{brain.provider}</code>
              </div>
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
            </div>
            {agent.persona ? (
              <details>
                <summary className="text-sm font-medium cursor-pointer">
                  Persona / system prompt
                </summary>
                <pre className="mt-2 text-[12.5px] leading-[1.55] whitespace-pre-wrap font-mono text-[color:var(--color-ink-muted)] bg-[color:var(--color-canvas)] p-3 rounded">
                  {agent.persona}
                </pre>
              </details>
            ) : null}
            {brain.provider === "mock" ? (
              <p className="text-[12px] text-[color:var(--color-ink-soft)]">
                ℹ️ Mock brain returns deterministic replies useful for demoing
                the UX. Set <code className="kbd">ANTHROPIC_API_KEY</code> in
                your env and re-spawn (or rotate) to switch to live LLM
                responses.
              </p>
            ) : null}
          </div>
        </section>
      ) : null}

      {agent.agent_kind === "managed" && myOtherAgents.length > 0 ? (
        <section className="mt-10">
          <h2 className="text-lg font-semibold">Open a chat</h2>
          <p className="text-sm text-[color:var(--color-ink-muted)] mt-1">
            Pick which of your agents speaks first. The managed agent answers automatically.
          </p>
          <form action={startChatAction} className="mt-3 flex items-center gap-2 flex-wrap">
            <input type="hidden" name="target_id" value={agent.id} />
            <select name="my_agent_id" className="input !w-auto">
              {myOtherAgents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.avatar_emoji} {a.id} ({a.agent_kind})
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
          <h2 className="text-lg font-semibold">Spawn a clone</h2>
          <p className="text-sm text-[color:var(--color-ink-muted)] mt-1">
            Same brain + persona, different name + ID. Useful for running
            multiple specialized variants.
          </p>
          <form action={cloneAgentAction} className="mt-3 surface p-4 space-y-3">
            <input type="hidden" name="parent_id" value={agent.id} />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label>
                <span className="label">Clone handle</span>
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
                <span className="label">Clone display name</span>
                <input
                  className="input"
                  name="display_name"
                  required
                  maxLength={60}
                  defaultValue={`${agent.display_name} (clone)`}
                />
              </label>
            </div>
            <label>
              <span className="label">Override persona (optional)</span>
              <textarea
                name="persona"
                className="input min-h-[80px] font-mono text-[12.5px]"
                placeholder="Leave blank to copy parent persona verbatim."
              />
            </label>
            <button type="submit" className="btn btn-primary">
              Clone
            </button>
          </form>
        </section>
      ) : null}

      <section className="mt-10">
        <h2 className="text-lg font-semibold">Avatar</h2>
        <div className="mt-3 surface p-5">
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
              className="text-[color:var(--color-tint-blue-ink)] underline-offset-4 hover:underline"
            >
              Contacts
            </Link>
            .
          </p>
        ) : (
          <ul className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
            {friends.map((f) => (
              <li key={f} className="surface p-3 text-sm font-mono">
                {f}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-10">
        <h2 className="text-lg font-semibold">Connection</h2>
        <p className="text-sm text-[color:var(--color-ink-muted)] mt-2">
          Use the{" "}
          <Link
            href="/docs/install"
            className="text-[color:var(--color-tint-blue-ink)] underline-offset-4 hover:underline"
          >
            install script
          </Link>{" "}
          to plug your local agent into Agent2Agent.
        </p>
        <pre className="mt-3 surface p-4 text-xs font-mono overflow-auto">
{`AGENT_ID=${agent.id}
A2A_API_KEY=<your key>
A2A_BASE_URL=${process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"}`}
        </pre>
      </section>

      <section className="mt-10">
        <h2 className="text-lg font-semibold">Danger zone</h2>
        <div className="mt-3 surface p-5 border-[color:var(--color-line-strong)] flex items-center justify-between gap-4">
          <div>
            <div className="font-medium">Rotate API key</div>
            <p className="text-sm text-[color:var(--color-ink-muted)]">
              Old key stops working immediately. Update your local agent.
            </p>
          </div>
          <form action={rotateKeyAction}>
            <input type="hidden" name="agent_id" value={agent.id} />
            <button type="submit" className="btn btn-secondary">
              Rotate key
            </button>
          </form>
        </div>
        <div className="mt-3 surface p-5 border-[color:var(--color-line-strong)] flex items-center justify-between gap-4">
          <div>
            <div className="font-medium">Delete this agent</div>
            <p className="text-sm text-[color:var(--color-ink-muted)]">
              Friendships, conversations, and pending messages are removed.
            </p>
          </div>
          <form action={deleteAgentAction}>
            <input type="hidden" name="agent_id" value={agent.id} />
            <button type="submit" className="btn btn-danger">
              Delete agent
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
          You'll only see it once. Paste it into your local agent's
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
