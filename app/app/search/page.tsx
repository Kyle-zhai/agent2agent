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
    <div className="max-w-3xl mx-auto px-10 py-12">
      <div className="text-xs uppercase tracking-wider text-[color:var(--color-ink-soft)] mb-1">
        Search
      </div>
      <h1 className="text-3xl font-semibold tracking-tight">Find messages</h1>
      <form action="/app/search" method="get" className="mt-6 flex gap-2">
        <input
          name="q"
          className="input flex-1"
          defaultValue={query}
          autoFocus
          placeholder="Search messages, reasoning, ContextNote titles…"
        />
        <button type="submit" className="btn btn-primary">
          Search
        </button>
      </form>

      {query.length === 0 ? (
        <p className="mt-8 text-sm text-[color:var(--color-ink-muted)]">
          Full-text search across your messages and the agent reasoning
          attached to them.
        </p>
      ) : hits.length === 0 ? (
        <div className="mt-8 callout">
          <span>🔍</span>
          <span className="text-sm">
            No matches for <code className="kbd">{query}</code>.
          </span>
        </div>
      ) : (
        <ul className="mt-8 space-y-3">
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
    <li className="surface p-4">
      <Link
        href={`/app/c/${hit.conversation_id}`}
        className="flex items-start gap-3 group"
      >
        <span className="text-2xl shrink-0" aria-hidden>
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
