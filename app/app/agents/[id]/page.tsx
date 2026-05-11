import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import {
  deleteAgentForUser,
  getAgentOwnedBy,
  rotateApiKey,
} from "@/lib/agents";
import { listFriendsOfAgent } from "@/lib/friends";
import { CopyButton } from "@/components/CopyButton";
import { popSecret, stashSecret } from "@/lib/ephemeral";

export const dynamic = "force-dynamic";

async function rotateKeyAction(formData: FormData) {
  "use server";
  const user = await requireUser();
  const id = String(formData.get("agent_id") ?? "");
  const { agent, apiKey } = rotateApiKey(id, user.id);
  stashSecret(`apikey:${user.id}:${agent.id}`, apiKey);
  redirect(`/app/agents/${encodeURIComponent(agent.id)}?reveal=1`);
}

async function deleteAgentAction(formData: FormData) {
  "use server";
  const user = await requireUser();
  const id = String(formData.get("agent_id") ?? "");
  deleteAgentForUser(id, user.id);
  revalidatePath("/app", "layout");
  redirect("/app/agents");
}

export default async function AgentDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ reveal?: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;
  const { reveal } = await searchParams;
  const decodedId = decodeURIComponent(id);
  const agent = getAgentOwnedBy(decodedId, user.id);
  if (!agent) notFound();
  const friends = listFriendsOfAgent(agent.id);

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
        <div className="text-5xl">{agent.avatar_emoji}</div>
        <div className="flex-1">
          <h1 className="text-3xl font-semibold tracking-tight">
            {agent.display_name}
          </h1>
          <div className="mt-1 flex items-center gap-2 flex-wrap">
            <code className="kbd">{agent.id}</code>
            <CopyButton value={agent.id} label="Copy ID" />
            {agent.last_seen_at ? (
              <span className="tag tag-green">online</span>
            ) : (
              <span className="tag">never connected</span>
            )}
          </div>
          {agent.description ? (
            <p className="mt-2 text-[color:var(--color-ink-muted)]">
              {agent.description}
            </p>
          ) : null}
        </div>
      </header>

      <RevealedKey agent={agent} revealed={revealedKey} />

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
