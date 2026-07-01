import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { listAgentsForUser } from "@/lib/agents";
import { CopyButton } from "@/components/CopyButton";

export const dynamic = "force-dynamic";

export default async function AgentsPage() {
  const user = await requireUser();
  const agents = listAgentsForUser(user.id);

  return (
    <div className="app-stage">
      <header className="page-header-row">
        <div>
          <div className="page-kicker">Add my agent</div>
          <h1 className="page-title">My agents</h1>
          <p className="page-subtitle">
            Bring a hosted assistant or a local runtime into your rooms and
            workspaces. Your agents can join rooms as readers first, then ask
            before writing.
          </p>
        </div>
        <div className="action-bar">
          <Link href="/app/agents/connect" className="btn btn-primary">
            Create hosted assistant
          </Link>
          <Link href="/app/agents/new" className="btn btn-secondary">
            Connect local agent
          </Link>
        </div>
      </header>

      {agents.length === 0 ? (
        <div className="module-panel-strong p-10 text-center">
          <div className="tag tag-violet mb-4">agent directory</div>
          <div className="font-medium mb-1">No agents yet</div>
          <p className="text-sm text-[color:var(--color-ink-muted)] max-w-sm mx-auto">
            The fastest start creates a hosted assistant you can chat with
            right away. Connecting a local agent links Claude Code, OpenClaw or
            another runtime running on your computer.
          </p>
          <div className="flex justify-center gap-2 mt-5">
            <Link href="/app/agents/connect" className="btn btn-primary">
              Create hosted assistant
            </Link>
            <Link href="/app/agents/new" className="btn btn-secondary">
              Connect local agent
            </Link>
          </div>
        </div>
      ) : (
        <ul className="list-panel">
          {agents.map((a) => (
            <li
              key={a.id}
              className="data-row surface-hover"
            >
              <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[color:var(--color-paper-faint)] text-2xl" aria-hidden>
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
                      hosted · {a.framework}
                    </span>
                  ) : a.last_seen_at ? (
                    <span className="tag tag-green">
                      <span className="w-1.5 h-1.5 rounded-full bg-current" />
                      online · {timeAgo(a.last_seen_at)}
                    </span>
                  ) : (
                    <span className="tag">not connected yet</span>
                  )}
                  {a.parent_agent_id ? (
                    <span className="tag tag-blue">
                      duplicate of{" "}
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
                  API key: {a.api_key_prefix}…
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
