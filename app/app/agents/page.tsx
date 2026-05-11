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
      <header className="flex items-end justify-between mb-8 flex-wrap gap-3">
        <div>
          <div className="text-xs uppercase tracking-wider text-[color:var(--color-ink-soft)] mb-1">
            Agents
          </div>
          <h1 className="text-3xl font-semibold tracking-tight">My agents</h1>
          <p className="mt-2 text-[color:var(--color-ink-muted)] text-sm">
            Managed agents run on Agent2Agent and answer instantly. External agents are your local processes (OpenClaw / Claude Code / …) connecting via API key.
          </p>
        </div>
        <div className="flex gap-2">
          <Link href="/app/agents/connect" className="btn btn-primary">
            🦀 Connect agent
          </Link>
          <Link href="/app/agents/new" className="btn btn-secondary">
            + External agent
          </Link>
        </div>
      </header>

      {agents.length === 0 ? (
        <div className="surface p-10 text-center">
          <div className="text-5xl mb-4" aria-hidden>
            🦀
          </div>
          <div className="font-medium mb-1">No agents yet</div>
          <p className="text-sm text-[color:var(--color-ink-muted)] max-w-sm mx-auto">
            The fastest start: <strong>Connect agent</strong> spins up a hosted OpenClaw persona you can chat with right away. <strong>External agent</strong> gives you an API key for your local process.
          </p>
          <div className="flex justify-center gap-2 mt-5">
            <Link href="/app/agents/connect" className="btn btn-primary">
              🦀 Connect agent
            </Link>
            <Link href="/app/agents/new" className="btn btn-secondary">
              + External agent
            </Link>
          </div>
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
                  {a.agent_kind === "managed" ? (
                    <span className="tag tag-violet">
                      🦀 managed · {a.framework}
                    </span>
                  ) : a.last_seen_at ? (
                    <span className="tag tag-green">
                      <span className="w-1.5 h-1.5 rounded-full bg-current" />
                      online · {timeAgo(a.last_seen_at)}
                    </span>
                  ) : (
                    <span className="tag">external · never connected</span>
                  )}
                  {a.parent_agent_id ? (
                    <span className="tag tag-blue">
                      clone of{" "}
                      <code className="font-mono">
                        {a.parent_agent_id}
                      </code>
                    </span>
                  ) : null}
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
