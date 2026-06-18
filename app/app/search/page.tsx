import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { searchMessagesForUser, type SearchHit } from "@/lib/search";
import { getAgentsByIds } from "@/lib/agents";

export const dynamic = "force-dynamic";

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const user = await requireUser();
  const { q } = await searchParams;
  const query = q?.trim() ?? "";
  const hits = query.length >= 2 ? searchMessagesForUser(user.id, query) : [];
  const agentIds = Array.from(new Set(hits.map((h) => h.from_agent_id)));
  const agents = Object.fromEntries(
    getAgentsByIds(agentIds).map((a) => [a.id, a]),
  );

  return (
    <div className="app-stage">
      <header className="page-header-row">
        <div>
          <div className="page-kicker">Search</div>
          <h1 className="page-title">Find messages</h1>
          <p className="page-subtitle">
            Search messages, thinking, files, note titles, and review context
            across your assistant workspace.
          </p>
        </div>
      </header>

      <section className="module-panel p-5">
        <form action="/app/search" method="get" className="flex gap-2">
          <input
            name="q"
            className="input flex-1"
            defaultValue={query}
            autoFocus
            placeholder="Search messages, thinking, and note titles…"
          />
          <button type="submit" className="btn btn-primary">
            Search
          </button>
        </form>
      </section>

      {query.length === 0 ? (
        <div className="mt-5 callout">
          <span className="tag">hint</span>
          <span className="text-sm">
            Searches everything in your messages — including the assistant
            thinking attached to them.
          </span>
        </div>
      ) : hits.length === 0 ? (
        <div className="mt-8 callout">
          <span className="tag">0</span>
          <span className="text-sm">
            No matches for <code className="kbd">{query}</code>.
          </span>
        </div>
      ) : (
        <ul className="mt-6 list-panel">
          {hits.map((h) => (
            <SearchHitRow
              key={h.message_id}
              hit={h}
              agent={agents[h.from_agent_id]}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function SearchHitRow({
  hit,
  agent,
}: {
  hit: SearchHit;
  agent?: { id: string; display_name: string; avatar_emoji: string };
}) {
  return (
    <li className="data-row">
      <Link
        href={`/app/c/${hit.conversation_id}`}
        className="flex items-start gap-3 group"
      >
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[color:var(--color-paper-faint)] text-xl" aria-hidden>
          {agent?.avatar_emoji ?? "🤖"}
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="font-medium text-sm">
              {agent?.display_name ?? hit.from_agent_id}
            </span>
            <code className="text-[11px] font-mono text-[color:var(--color-ink-soft)]">
              {hit.from_agent_id}
            </code>
            <span className="text-[11px] text-[color:var(--color-ink-soft)]">
              {new Date(hit.created_at).toLocaleString("en-US", {
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
                timeZone: "UTC",
              })}
            </span>
          </div>
          {hit.snippet_text ? (
            <SnippetLine
              snippet={hit.snippet_text}
              className="mt-1 text-[14px] leading-[1.55]"
            />
          ) : null}
          {hit.snippet_thinking ? (
            <SnippetLine
              snippet={hit.snippet_thinking}
              className="mt-2 text-[12.5px] font-mono italic text-[color:var(--color-tint-violet-ink)]"
              prefix="🧠 "
            />
          ) : null}
        </div>
      </Link>
    </li>
  );
}

function SnippetLine({
  snippet,
  className,
  prefix,
}: {
  snippet: string;
  className?: string;
  prefix?: string;
}) {
  // SQLite FTS snippet() returns text with our literal <mark>...</mark>
  // markers. The raw user text in between can contain HTML, so we MUST NOT
  // use dangerouslySetInnerHTML. Split on markers and render as React text.
  const parts: Array<{ text: string; mark: boolean }> = [];
  let last = 0;
  for (const match of snippet.matchAll(/<mark>([\s\S]*?)<\/mark>/g)) {
    const idx = match.index ?? 0;
    if (idx > last) parts.push({ text: snippet.slice(last, idx), mark: false });
    parts.push({ text: match[1], mark: true });
    last = idx + match[0].length;
  }
  if (last < snippet.length) {
    parts.push({ text: snippet.slice(last), mark: false });
  }
  return (
    <div className={className}>
      {prefix ? <span>{prefix}</span> : null}
      {parts.map((p, i) =>
        p.mark ? (
          <mark
            key={i}
            className="bg-[color:var(--color-tint-amber)] text-[color:var(--color-tint-amber-ink)] px-0.5 rounded-sm"
          >
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </div>
  );
}
