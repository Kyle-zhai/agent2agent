"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMemo, useState } from "react";
import { avatarGradClass } from "@/lib/avatar";

export type ConversationListBundle = {
  conversation: { id: string; type: "direct" | "group"; title: string | null };
  member_agent_ids: string[];
  member_emojis?: string[];
  member_names?: string[];
  my_agent_id: string;
  last_message: { text: string; created_at: number } | null;
  unread_count: number;
  state: { pinned_at: number | null; muted_at: number | null; archived_at: number | null };
  workspace_count: number;
  primary_workspace_id?: string | null;
  open_task_count: number;
  my_open_task_count: number;
  streaming?: boolean;
  /** Identity hints for the peer in a 1:1 — rendered as small pills next to
   *  the name (hosted assistant → "AI", a different owner's assistant →
   *  "connected"), mirroring the Lark/Notion reference. The prop values
   *  ("bot" | "external") are part of the component API and stay unchanged;
   *  only the rendered pill text is plain-language. */
  peer_tags?: Array<"bot" | "external">;
};

/**
 * Secondary sidebar panel — 260px wide, sits to the right of the icon rail.
 *
 * Hermes-style: a search box pinned at the top, then Pinned + Conversations,
 * with a foldable Archived section at the bottom. Each row is denser than
 * the previous design, with a 32px avatar tile, last-message preview, and a
 * coloured activity dot (streaming pulse / unread / muted dim).
 *
 * Client-side filter on the search box gives instant local feedback before
 * the user commits to /app/search.
 */
export function SidebarPanel({
  pinned,
  active,
  archived,
  searchAction,
  embedded = false,
}: {
  pinned: ConversationListBundle[];
  active: ConversationListBundle[];
  archived: ConversationListBundle[];
  searchAction?: string;
  /** When true, fills its flex parent (used as the top block of the chat
   *  page's middle column) instead of being a fixed sticky shell panel. */
  embedded?: boolean;
}) {
  const [filter, setFilter] = useState("");
  const pathname = usePathname() ?? "";

  const match = (b: ConversationListBundle) => {
    if (!filter) return true;
    const q = filter.toLowerCase();
    const title =
      b.conversation.title?.toLowerCase() ??
      b.member_agent_ids.join(" ").toLowerCase();
    return title.includes(q);
  };

  const filteredPinned = useMemo(() => pinned.filter(match), [pinned, filter]);
  const filteredActive = useMemo(() => active.filter(match), [active, filter]);
  const filteredArchived = useMemo(
    () => archived.filter(match),
    [archived, filter],
  );

  // The conversation list is part of the messaging workspace, not universal app
  // chrome. Keep it on Home; chat rooms use a workspace-first workbench and
  // need the full content stage for files, preview, execution details and chat.
  // NB: this early return MUST stay below every hook above — otherwise the
  // same instance toggling null↔content across navigation changes the hook
  // count and React throws "Rendered more hooks than during the previous
  // render."
  const isHome = pathname === "/app";
  const isConversationRoute = /^\/app\/c\/[^/]+(\/.*)?$/.test(pathname);
  if (!embedded && !isHome && !isConversationRoute) return null;
  if (!embedded) {
    return (
      <ConversationNavigator
        activePath={pathname}
        pinned={pinned}
        active={active}
        archived={archived}
      />
    );
  }

  // Mobile (<md): there isn't room for the panel AND the page content, so the
  // shell panel only shows on Home ("/app"), where it takes the remaining
  // width as the messages-list screen (Feishu-style).
  return (
    <aside
      className={
        embedded
          ? "panel-float flex flex-col overflow-hidden w-full flex-1 min-h-0"
          : (isHome ? "flex w-full min-w-0" : "hidden") +
            " md:flex md:w-[268px] md:shrink-0 panel-float h-full flex-col overflow-hidden z-20"
      }
    >
      <div className="px-3 pt-3.5 pb-2.5 bg-[color:var(--color-paper-strong)] z-10 border-b border-[color:var(--color-line)]">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-[11px] font-semibold tracking-[0.08em] uppercase text-[color:var(--color-ink-soft)]">
            Conversations
          </h2>
          <Link
            href="/app/collab/new"
            title="Start a collaboration"
            className="w-7 h-7 rounded-md flex items-center justify-center text-[color:var(--color-ink-muted)] hover:bg-[color:var(--color-hover)] hover:text-[color:var(--color-ink)] transition-colors"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.75}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
            </svg>
          </Link>
        </div>
        <form action={searchAction} method="get" role="search" className="relative">
          <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[color:var(--color-ink-soft)] pointer-events-none">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <circle cx="11" cy="11" r="7" />
              <path d="m21 21-4.3-4.3" />
            </svg>
          </span>
          <input
            name="q"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search conversations…"
            className="input !py-2 !text-[12.5px] !pl-8 !rounded-full"
          />
        </form>
      </div>

      <div className="flex-1 overflow-y-auto py-2">
        {filteredPinned.length > 0 ? (
          <Section title="Pinned">
            {filteredPinned.map((b) => (
              <ConvRow
                key={b.conversation.id}
                bundle={b}
                activePath={pathname}
              />
            ))}
          </Section>
        ) : null}

        <Section
          title={filteredPinned.length > 0 ? "Active" : "Conversations"}
        >
          {filteredActive.length === 0 ? (
            <div className="px-3 py-2 text-[12px] text-[color:var(--color-ink-soft)]">
              {filter ? "No matches." : "No conversations yet."}
            </div>
          ) : (
            filteredActive.map((b) => (
              <ConvRow
                key={b.conversation.id}
                bundle={b}
                activePath={pathname}
              />
            ))
          )}
        </Section>

        {filteredArchived.length > 0 ? (
          <details className="px-2 mt-1">
            <summary className="px-2 py-1.5 text-[10px] uppercase tracking-[0.08em] font-medium text-[color:var(--color-ink-soft)] cursor-pointer hover:text-[color:var(--color-ink-muted)] list-none flex items-center justify-between">
              <span>Archived ({filteredArchived.length})</span>
              <span className="text-[9px]">▾</span>
            </summary>
            <div className="flex flex-col mt-1">
              {filteredArchived.map((b) => (
                <ConvRow
                  key={b.conversation.id}
                  bundle={b}
                  activePath={pathname}
                />
              ))}
            </div>
          </details>
        ) : null}
      </div>
    </aside>
  );
}

function ConversationNavigator({
  activePath,
  pinned,
  active,
  archived,
}: {
  activePath: string;
  pinned: ConversationListBundle[];
  active: ConversationListBundle[];
  archived: ConversationListBundle[];
}) {
  const [filter, setFilter] = useState("");
  const rooms = useMemo(
    () => [...pinned, ...active, ...archived],
    [pinned, active, archived],
  );
  const visibleRooms = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return rooms;
    return rooms.filter((room) => {
      const title = room.conversation.title ?? room.member_names?.join(" ") ?? "";
      return title.toLowerCase().includes(q);
    });
  }, [rooms, filter]);

  return (
    <aside className="z-20 hidden h-full w-[232px] shrink-0 flex-col overflow-hidden border-r border-[color:var(--color-line)] bg-white md:flex">
      <div className="flex h-11 items-center justify-between gap-3 border-b border-[color:var(--color-line)] bg-white px-4">
        <h2 className="text-[14px] font-semibold text-[color:var(--color-ink)]">
          Chats
        </h2>
        <div className="flex items-center gap-1">
          <IconButton href="/app/search" label="Search chats" icon="search" />
          <IconButton href="/app/inbox" label="Chat inbox" icon="filter" />
          <IconButton href="/app/collab/new" label="New chat" icon="plus" />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <div className="mb-3">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search chats..."
            className="input !h-8 !rounded-lg !px-3 !py-1.5 !text-[12px]"
          />
        </div>
        <div className="space-y-1.5">
          {visibleRooms.length > 0 ? (
            visibleRooms.map((room) => (
              <ConversationNavRow
                key={room.conversation.id}
                bundle={room}
                activePath={activePath}
              />
            ))
          ) : (
            <div className="rounded-xl border border-dashed border-[color:var(--color-line)] px-3 py-4 text-[12px] leading-relaxed text-[color:var(--color-ink-soft)]">
              {filter ? "No matching chats." : "No chats yet."}
            </div>
          )}
        </div>
      </div>

      <div className="border-t border-[color:var(--color-line)] px-4 py-3">
        <Link
          href="/app/collab/new"
          className="flex items-center gap-2 rounded-lg px-2 py-2 text-[12px] font-medium text-[color:var(--color-ink-muted)] hover:bg-[color:var(--color-hover)] hover:text-[color:var(--color-ink)]"
          >
          <PlusIcon />
          <span>New chat</span>
        </Link>
        <div className="mt-4 rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-paper-faint)] px-3.5 py-3">
          <div className="text-[12px] font-semibold text-[color:var(--color-ink)]">
            Active chats
          </div>
          <div className="mt-1 text-[11px] text-[color:var(--color-ink-muted)]">
            {rooms.length} chat{rooms.length === 1 ? "" : "s"} available
          </div>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white">
            <div className="h-full w-[42%] rounded-full bg-[color:var(--color-tint-blue-ink)]" />
          </div>
        </div>
      </div>
    </aside>
  );
}

function ConversationNavRow({
  bundle,
  activePath,
}: {
  bundle: ConversationListBundle;
  activePath: string;
}) {
  const title =
    bundle.conversation.type === "group"
      ? bundle.conversation.title ?? "Untitled group"
      : (() => {
          const idx = bundle.member_agent_ids.findIndex(
            (id) => id !== bundle.my_agent_id,
          );
          return bundle.member_names?.[idx] ?? "Direct";
        })();
  const href = `/app/c/${bundle.conversation.id}`;
  const isActive = activePath === href || activePath.startsWith(`${href}/`);
  const preview = bundle.last_message?.text || "Open chat";
  return (
    <Link
      href={href}
      className={
        "group flex gap-2.5 rounded-xl px-2.5 py-2.5 transition-colors " +
        (isActive
          ? "bg-[#eaf1ff] text-[color:var(--color-ink)]"
          : "text-[color:var(--color-ink)] hover:bg-[color:var(--color-hover)]")
      }
    >
      <div className={`avatar h-9 w-9 text-[15px] ${avatarGradClass(bundle.conversation.id)}`}>
        {bundle.conversation.type === "group" ? "👥" : "🤖"}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[13px] font-semibold">{title}</span>
          {bundle.unread_count > 0 ? (
            <span className="rounded-full bg-[color:var(--color-accent)] px-1.5 py-0.5 text-[9px] font-semibold text-white">
              {bundle.unread_count}
            </span>
          ) : null}
        </div>
        <div className="mt-0.5 truncate text-[11px] text-[color:var(--color-ink-soft)]">
          {preview}
        </div>
        <div className="mt-1 flex items-center gap-1.5">
          <span className="tag tag-blue !px-1.5 !py-0 !text-[9.5px]">
            {bundle.workspace_count || 0} files
          </span>
          {bundle.open_task_count > 0 ? (
            <span className="tag tag-amber !px-1.5 !py-0 !text-[9.5px]">
              {bundle.open_task_count} tasks
            </span>
          ) : (
            <span className="tag tag-green !px-1.5 !py-0 !text-[9.5px]">
              ready
            </span>
          )}
        </div>
      </div>
    </Link>
  );
}

function IconButton({
  href,
  label,
  icon,
}: {
  href: string;
  label: string;
  icon: "search" | "filter" | "plus";
}) {
  return (
    <Link
      href={href}
      title={label}
      aria-label={label}
      className="grid h-8 w-8 place-items-center rounded-lg text-[color:var(--color-ink-soft)] hover:bg-[color:var(--color-hover)] hover:text-[color:var(--color-ink)]"
    >
      {icon === "search" ? (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <circle cx="11" cy="11" r="7" />
          <path d="m21 21-4.3-4.3" />
        </svg>
      ) : icon === "filter" ? (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M4 6h16" />
          <path d="M7 12h10" />
          <path d="M10 18h4" />
        </svg>
      ) : (
        <PlusIcon />
      )}
    </Link>
  );
}

function PlusIcon() {
  return (
    <svg className="shrink-0" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}

function ChevronIcon({ open = false }: { open?: boolean }) {
  return (
    <svg className="w-3 shrink-0 text-[color:var(--color-ink-soft)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {open ? <path d="m6 9 6 6 6-6" /> : <path d="m9 6 6 6-6 6" />}
    </svg>
  );
}

function FileIcon({ kind }: { kind: string }) {
  if (kind === "html") {
    return (
      <span className="grid h-4 w-4 shrink-0 place-items-center text-[color:var(--color-danger)]">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="m8 9-4 3 4 3" />
          <path d="m16 9 4 3-4 3" />
        </svg>
      </span>
    );
  }
  if (kind === "git") {
    return (
      <span className="grid h-4 w-4 shrink-0 place-items-center text-[color:var(--color-danger)]">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M12 3 3 12l9 9 9-9-9-9Z" />
          <path d="M8 12h8" />
        </svg>
      </span>
    );
  }
  if (kind === "agent") {
    return (
      <span className="grid h-4 w-4 shrink-0 place-items-center text-[color:var(--color-ink-soft)]">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <rect x="6" y="7" width="12" height="10" rx="2" />
          <path d="M12 3v4" />
          <path d="M9 12h.01" />
          <path d="M15 12h.01" />
        </svg>
      </span>
    );
  }
  return (
    <span className="grid h-4 w-4 shrink-0 place-items-center text-[color:var(--color-ink-soft)]">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M4 6.5A1.5 1.5 0 0 1 5.5 5H10l2 2h6.5A1.5 1.5 0 0 1 20 8.5v9A1.5 1.5 0 0 1 18.5 19h-13A1.5 1.5 0 0 1 4 17.5v-11Z" />
      </svg>
    </span>
  );
}

function StatusDot({ tone }: { tone: "green" | "blue" | "muted" }) {
  return (
    <span
      className={
        "h-2 w-2 shrink-0 rounded-full " +
        (tone === "green"
          ? "bg-[color:var(--color-tint-green-ink)]"
          : tone === "blue"
            ? "bg-[color:var(--color-tint-blue-ink)]"
            : "bg-[color:var(--color-line-strong)]")
      }
    />
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="px-2 mb-1">
      <div className="px-2 mb-1 text-[10px] uppercase tracking-[0.08em] font-medium text-[color:var(--color-ink-soft)]">
        {title}
      </div>
      <div className="flex flex-col gap-0.5">{children}</div>
    </div>
  );
}

function ConvRow({
  bundle,
  activePath,
}: {
  bundle: ConversationListBundle;
  activePath: string;
}) {
  const c = bundle;
  const isActive = activePath === `/app/c/${c.conversation.id}`;
  const display =
    c.conversation.type === "group"
      ? c.conversation.title ?? "Untitled group"
      : (() => {
          const idx = c.member_agent_ids.findIndex((id) => id !== c.my_agent_id);
          if (idx < 0) return "Direct";
          return c.member_names?.[idx] ?? c.member_agent_ids[idx] ?? "Direct";
        })();
  const otherEmoji =
    c.conversation.type === "group"
      ? "👥"
      : (() => {
          if (!c.member_emojis) return "🤖";
          const idx = c.member_agent_ids.findIndex(
            (id) => id !== c.my_agent_id,
          );
          return c.member_emojis[idx] ?? "🤖";
        })();
  const gradId =
    c.conversation.type === "group"
      ? c.conversation.id
      : c.member_agent_ids.find((id) => id !== c.my_agent_id) ??
        c.conversation.id;
  const showUnread = c.unread_count > 0 && !c.state.muted_at;
  const dotColor = c.streaming
    ? "bg-[color:var(--color-tint-green-ink)] animate-pulse"
    : showUnread
      ? "bg-[color:var(--color-accent)]"
      : "";

  return (
    <Link
      href={`/app/c/${c.conversation.id}`}
      className={
        "group relative flex items-start gap-2.5 px-2.5 py-2 rounded-xl transition-all " +
        (isActive
          ? "bg-[color:var(--color-hover-strong)] text-[color:var(--color-ink)] shadow-[inset_0_0_0_1px_var(--color-line)]"
          : "hover:bg-[color:var(--color-hover)] text-[color:var(--color-ink)]")
      }
    >
      <div className={`avatar w-9 h-9 text-[15px] ${avatarGradClass(gradId)}`}>
        {otherEmoji}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          {c.state.pinned_at ? (
            <span className="text-[10px] text-[color:var(--color-tint-amber-ink)]" title="Pinned">
              ★
            </span>
          ) : null}
          {c.state.muted_at ? (
            <span className="text-[10px] text-[color:var(--color-ink-soft)]" title="Muted">
              🔕
            </span>
          ) : null}
          <span
            className={
              "truncate min-w-0 text-[13px] font-medium " +
              (showUnread ? "text-[color:var(--color-ink)]" : "")
            }
          >
            {display}
          </span>
          {c.peer_tags?.includes("bot") ? (
            <span className="tag tag-amber shrink-0 !px-1.5 !py-0 !text-[9.5px] leading-tight">
              AI
            </span>
          ) : null}
          {c.peer_tags?.includes("external") ? (
            <span className="tag shrink-0 !px-1.5 !py-0 !text-[9.5px] leading-tight">
              connected
            </span>
          ) : null}
        </div>
        {c.last_message ? (
          <div
            className={
              "text-[11.5px] truncate mt-0.5 " +
              (showUnread
                ? "text-[color:var(--color-ink-muted)] font-medium"
                : "text-[color:var(--color-ink-soft)]")
            }
          >
            {c.last_message.text || "(attachment)"}
          </div>
        ) : (
          <div className="text-[11.5px] italic text-[color:var(--color-ink-soft)] mt-0.5">
            No messages yet
          </div>
        )}
        {c.workspace_count > 0 || c.open_task_count > 0 ? (
          <div className="flex items-center gap-1 mt-1">
            {c.workspace_count > 0 ? (
              <span
                className="text-[9.5px] px-1.5 py-0.5 rounded-full bg-[color:var(--color-tint-violet)] text-[color:var(--color-tint-violet-ink)] inline-flex items-center gap-1"
                title={`${c.workspace_count} workspace(s)`}
              >
                <span>📁</span>
                <span className="font-mono">{c.workspace_count}</span>
              </span>
            ) : null}
            {c.my_open_task_count > 0 ? (
              <span
                className="text-[9.5px] px-1.5 py-0.5 rounded-full bg-[color:var(--color-tint-amber)] text-[color:var(--color-tint-amber-ink)] inline-flex items-center gap-1 font-medium"
                title={`${c.my_open_task_count} task(s) assigned to your assistants`}
              >
                <span>✦</span>
                <span className="font-mono">{c.my_open_task_count}</span>
              </span>
            ) : c.open_task_count > 0 ? (
              <span
                className="text-[9.5px] px-1.5 py-0.5 rounded-full bg-[color:var(--color-tint-green)] text-[color:var(--color-tint-green-ink)] inline-flex items-center gap-1"
                title={`${c.open_task_count} open task(s)`}
              >
                <span>✓</span>
                <span className="font-mono">{c.open_task_count}</span>
              </span>
            ) : null}
          </div>
        ) : null}
      </div>

      {dotColor ? (
        <span
          className={`mt-1.5 shrink-0 w-2 h-2 rounded-full ${dotColor}`}
          aria-label={c.streaming ? "Replying now" : `${c.unread_count} unread`}
        />
      ) : null}
    </Link>
  );
}
