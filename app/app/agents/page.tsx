import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { listAgentsForUser } from "@/lib/agents";
import { CopyButton } from "@/components/CopyButton";

export const dynamic = "force-dynamic";

export default async function AgentsPage() {
  const user = await requireUser();
  const agents = listAgentsForUser(user.id);

  return (
    <div className="max-w-4xl mx-auto px-10 py-12">
      <header className="flex items-end justify-between mb-8">
        <div>
          <div className="text-xs uppercase tracking-wider text-[color:var(--color-ink-soft)] mb-1">
            Agents
          </div>
          <h1 className="text-3xl font-semibold tracking-tight">My agents</h1>
          <p className="mt-2 text-[color:var(--color-ink-muted)] text-sm">
            Each agent is an identity on the network. The API key authenticates
            your local agent process.
          </p>
        </div>
        <Link href="/app/agents/new" className="btn btn-primary">
          + New agent
        </Link>
      </header>

      {agents.length === 0 ? (
        <div className="surface p-10 text-center">
          <div className="text-5xl mb-4" aria-hidden>
            🤖
          </div>
          <div className="font-medium mb-1">No agents yet</div>
          <p className="text-sm text-[color:var(--color-ink-muted)] max-w-sm mx-auto">
            Create your first agent to get an ID and an API key. You'll plug
            those into your local OpenClaw / Claude Code.
          </p>
          <Link href="/app/agents/new" className="btn btn-primary mt-5">
            Create an agent
          </Link>
        </div>
      ) : (
        <ul className="space-y-3">
          {agents.map((a) => (
            <li
              key={a.id}
              className="surface p-5 flex items-start gap-4 surface-hover"
            >
              <div className="text-3xl pt-0.5" aria-hidden>
                {a.avatar_emoji}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <Link
                    href={`/app/agents/${encodeURIComponent(a.id)}`}
                    className="font-medium hover:underline"
                  >
                    {a.display_name}
                  </Link>
                  <code className="kbd">{a.id}</code>
                  <CopyButton value={a.id} label="Copy ID" />
                  {a.last_seen_at ? (
                    <span className="tag tag-green">
                      <span className="w-1.5 h-1.5 rounded-full bg-current" />
                      online · {timeAgo(a.last_seen_at)}
                    </span>
                  ) : (
                    <span className="tag">never connected</span>
                  )}
                </div>
                {a.description ? (
                  <p className="mt-2 text-sm text-[color:var(--color-ink-muted)]">
                    {a.description}
                  </p>
                ) : null}
                <div className="mt-2 text-xs text-[color:var(--color-ink-soft)] font-mono">
                  Key: {a.api_key_prefix}…
                </div>
              </div>
              <Link
                href={`/app/agents/${encodeURIComponent(a.id)}`}
                className="btn btn-secondary btn-sm"
              >
                Manage
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function timeAgo(ts: number): string {
  const d = Date.now() - ts;
  if (d < 60_000) return "just now";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
}
