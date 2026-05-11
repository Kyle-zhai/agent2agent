"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type {
  Agent,
  Conversation,
  ConversationState,
  MessageWithRelations,
  ReactionAggregate,
} from "@/lib/types";
import { MessageMarkdown } from "@/components/MessageMarkdown";

// Aligned with REACTION_EMOJIS in lib/conversations.ts; only 9 shown to keep
// the palette compact. If you add another, mirror it server-side.
const REACTION_PALETTE = [
  "👍", "❤️", "😂", "😮", "🎉", "🚀", "✅", "🤔", "🔥",
] as const;

type ChatActions = {
  send: (formData: FormData) => Promise<void>;
  edit: (formData: FormData) => Promise<void>;
  remove: (formData: FormData) => Promise<void>;
  react: (formData: FormData) => Promise<void>;
  pin: (formData: FormData) => Promise<void>;
  mute: (formData: FormData) => Promise<void>;
  archive: (formData: FormData) => Promise<void>;
  rename: (formData: FormData) => Promise<void>;
  addMember: (formData: FormData) => Promise<void>;
  removeMember: (formData: FormData) => Promise<void>;
  leave: (formData: FormData) => Promise<void>;
  forward: (formData: FormData) => Promise<void>;
  setPersonaOverride: (formData: FormData) => Promise<void>;
};

type ForwardTarget = { id: string; label: string };

export function ConversationView({
  conv,
  members,
  messages,
  reactionsByMessageId,
  myAgentId,
  state,
  typingAgentIds,
  inviteCandidates,
  forwardTargets,
  myManagedAgentsInRoom,
  personaOverrides,
  actions,
  error,
}: {
  conv: Conversation;
  members: Agent[];
  messages: MessageWithRelations[];
  reactionsByMessageId: Record<string, ReactionAggregate[]>;
  myAgentId: string;
  state: ConversationState;
  typingAgentIds: string[];
  inviteCandidates: Agent[];
  forwardTargets: ForwardTarget[];
  myManagedAgentsInRoom: Agent[];
  personaOverrides: Record<string, string>;
  actions: ChatActions;
  error?: string;
}) {
  const isGroupOwner =
    conv.type === "group" && conv.created_by_agent_id === myAgentId;
  const [showContext, setShowContext] = useState(false);
  const [showThinking, setShowThinking] = useState(false);
  const [replyTo, setReplyTo] = useState<MessageWithRelations | null>(null);
  const [editing, setEditing] = useState<MessageWithRelations | null>(null);
  const [showHeaderMenu, setShowHeaderMenu] = useState(false);
  const [showRename, setShowRename] = useState(false);
  const [showMembers, setShowMembers] = useState(false);
  const [showPersonas, setShowPersonas] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  const memberById = useMemo(
    () => Object.fromEntries(members.map((m) => [m.id, m])) as Record<string, Agent>,
    [members],
  );
  const memberHandles = useMemo(
    () => members.map((m) => m.id.split(".")[0]),
    [members],
  );
  const myAgent = memberById[myAgentId];

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages.length]);

  useEffect(() => {
    let cancelled = false;
    let es: EventSource | null = null;
    let pollTimer: number | null = null;
    function startPolling() {
      pollTimer = window.setInterval(() => {
        if (cancelled) return;
        if (document.visibilityState === "visible") router.refresh();
      }, 4000);
    }
    try {
      es = new EventSource(`/api/v1/conversations/${conv.id}/stream`);
      es.addEventListener("message", () => {
        if (!cancelled && document.visibilityState === "visible") {
          router.refresh();
        }
      });
      es.addEventListener("error", () => {
        if (!cancelled && pollTimer === null) startPolling();
      });
    } catch {
      startPolling();
    }
    return () => {
      cancelled = true;
      es?.close();
      if (pollTimer !== null) window.clearInterval(pollTimer);
    };
  }, [router, conv.id]);

  // Restore the page title on focus / unmount. The unread-count pulse
  // itself lives in NotificationsHook (observes body[data-unread]).
  useEffect(() => {
    const orig = document.title;
    function onVis() {
      if (document.visibilityState === "visible") document.title = orig;
    }
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.title = orig;
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  const title =
    conv.type === "group"
      ? conv.title ?? "Untitled group"
      : (() => {
          const other = members.find((m) => m.id !== myAgentId);
          return other ? `${other.avatar_emoji}  ${other.display_name}` : "Direct";
        })();
  const subtitle =
    conv.type === "group"
      ? `${members.length} members${state.muted_at ? " · muted" : ""}`
      : (() => {
          const other = members.find((m) => m.id !== myAgentId);
          if (!other) return "";
          if (other.agent_kind === "managed") return `🦀 managed · ${other.framework}`;
          if (other.last_seen_at) return `online · ${timeAgo(other.last_seen_at)}`;
          return other.id;
        })();

  const typing = typingAgentIds
    .map((id) => memberById[id])
    .filter((a): a is Agent => !!a && a.id !== myAgentId);

  return (
    <div className="h-screen flex flex-col bg-[color:var(--color-canvas)] tg-bg">
      <header className="relative z-20 flex items-center justify-between px-5 py-2.5 border-b border-[color:var(--color-line)] bg-[color:var(--color-paper)]/95 backdrop-blur">
        <div className="min-w-0 flex items-center gap-3">
          {conv.type === "direct" ? (
            <Avatar agent={members.find((m) => m.id !== myAgentId)} size={36} />
          ) : (
            <div className="w-9 h-9 rounded-full bg-[color:var(--color-tint-violet)] flex items-center justify-center text-base">
              👥
            </div>
          )}
          <div className="min-w-0">
            <div className="font-semibold truncate text-[15px]">{title}</div>
            <div className="text-[12px] text-[color:var(--color-ink-soft)] truncate">
              {subtitle}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {state.pinned_at ? (
            <span className="tag tag-amber" title="Pinned to top of sidebar">📌 pinned</span>
          ) : null}
          {state.archived_at ? (
            <span className="tag" title="Archived">📦 archived</span>
          ) : null}
          {conv.type === "group" ? (
            <div className="hidden md:flex items-center gap-1">
              {members.slice(0, 6).map((m) => (
                <Avatar key={m.id} agent={m} size={22} />
              ))}
              {members.length > 6 ? (
                <span className="text-[11px] text-[color:var(--color-ink-soft)]">
                  +{members.length - 6}
                </span>
              ) : null}
            </div>
          ) : null}
          <div className="relative">
            <button
              type="button"
              onClick={() => setShowHeaderMenu((v) => !v)}
              className="btn btn-ghost btn-sm"
              aria-label="Conversation menu"
            >
              ⋯
            </button>
            {showHeaderMenu ? (
              <div
                className="absolute right-0 top-full mt-1 surface shadow-[var(--shadow-pop)] py-1 w-56 z-30"
                onMouseLeave={() => setShowHeaderMenu(false)}
              >
                <ConvMenuItem
                  label={state.pinned_at ? "Unpin conversation" : "Pin to top"}
                  icon="📌"
                  action={actions.pin}
                  convId={conv.id}
                />
                <ConvMenuItem
                  label={state.muted_at ? "Unmute notifications" : "Mute notifications"}
                  icon="🔕"
                  action={actions.mute}
                  convId={conv.id}
                />
                <ConvMenuItem
                  label={state.archived_at ? "Unarchive" : "Archive"}
                  icon="📦"
                  action={actions.archive}
                  convId={conv.id}
                />
                {conv.type === "group" && isGroupOwner ? (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        setShowHeaderMenu(false);
                        setShowRename(true);
                      }}
                      className="w-full text-left px-3 py-1.5 text-sm hover:bg-[color:var(--color-canvas)] flex items-center gap-2"
                    >
                      <span>✏️</span>
                      <span>Rename group</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setShowHeaderMenu(false);
                        setShowMembers(true);
                      }}
                      className="w-full text-left px-3 py-1.5 text-sm hover:bg-[color:var(--color-canvas)] flex items-center gap-2"
                    >
                      <span>👥</span>
                      <span>Manage members</span>
                    </button>
                  </>
                ) : null}
                {myManagedAgentsInRoom.length > 0 ? (
                  <button
                    type="button"
                    onClick={() => {
                      setShowHeaderMenu(false);
                      setShowPersonas(true);
                    }}
                    className="w-full text-left px-3 py-1.5 text-sm hover:bg-[color:var(--color-canvas)] flex items-center gap-2"
                  >
                    <span>🎭</span>
                    <span>Per-chat persona override</span>
                  </button>
                ) : null}
                {conv.type === "group" && !isGroupOwner ? (
                  <form action={actions.leave}>
                    <input
                      type="hidden"
                      name="conversation_id"
                      value={conv.id}
                    />
                    <button
                      type="submit"
                      className="w-full text-left px-3 py-1.5 text-sm hover:bg-[color:var(--color-danger-tint)] text-[color:var(--color-danger)] flex items-center gap-2"
                    >
                      <span>🚪</span>
                      <span>Leave group</span>
                    </button>
                  </form>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </header>

      {showRename ? (
        <RenameGroupBar
          convId={conv.id}
          current={conv.title ?? ""}
          action={actions.rename}
          onClose={() => setShowRename(false)}
        />
      ) : null}

      {showMembers ? (
        <MemberManagerBar
          convId={conv.id}
          members={members}
          ownerId={conv.created_by_agent_id}
          inviteCandidates={inviteCandidates}
          addAction={actions.addMember}
          removeAction={actions.removeMember}
          onClose={() => setShowMembers(false)}
        />
      ) : null}

      {showPersonas ? (
        <PersonaOverrideBar
          convId={conv.id}
          agents={myManagedAgentsInRoom}
          overrides={personaOverrides}
          action={actions.setPersonaOverride}
          onClose={() => setShowPersonas(false)}
        />
      ) : null}

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 sm:px-6 py-5">
        <div className="max-w-3xl mx-auto space-y-1">
          {messages.length === 0 ? (
            <EmptyState memberCount={members.length} />
          ) : (
            renderWithDateDividers(
              messages,
              memberById,
              myAgentId,
              reactionsByMessageId,
              setReplyTo,
              setEditing,
              actions,
              conv.id,
              memberHandles,
              forwardTargets,
            )
          )}
          {typing.length > 0 ? <TypingRow agents={typing} /> : null}
        </div>
      </div>

      <Composer
        conv={conv}
        myAgent={myAgent}
        send={actions.send}
        showContext={showContext}
        onToggleContext={() => setShowContext((v) => !v)}
        showThinking={showThinking}
        onToggleThinking={() => setShowThinking((v) => !v)}
        replyTo={replyTo}
        onClearReplyTo={() => setReplyTo(null)}
        editing={editing}
        onClearEditing={() => setEditing(null)}
        editAction={actions.edit}
        memberById={memberById}
        error={error}
      />
    </div>
  );
}

function ConvMenuItem({
  label,
  icon,
  action,
  convId,
}: {
  label: string;
  icon: string;
  action: (fd: FormData) => Promise<void>;
  convId: string;
}) {
  return (
    <form action={action}>
      <input type="hidden" name="conversation_id" value={convId} />
      <button
        type="submit"
        className="w-full text-left px-3 py-1.5 text-sm hover:bg-[color:var(--color-canvas)] flex items-center gap-2"
      >
        <span>{icon}</span>
        <span>{label}</span>
      </button>
    </form>
  );
}

function PersonaOverrideBar({
  convId,
  agents,
  overrides,
  action,
  onClose,
}: {
  convId: string;
  agents: Agent[];
  overrides: Record<string, string>;
  action: (fd: FormData) => Promise<void>;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState(agents[0]?.id ?? "");
  const current = overrides[selected] ?? "";
  return (
    <div className="bg-[color:var(--color-tint-violet)]/30 border-b border-[color:var(--color-line)] px-5 py-3">
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center justify-between mb-2">
          <span className="font-medium text-sm">
            Per-chat persona override
          </span>
          <button
            type="button"
            onClick={onClose}
            className="btn btn-ghost btn-sm"
          >
            Close
          </button>
        </div>
        <p className="text-[12px] text-[color:var(--color-ink-muted)] mb-2">
          Make one of your managed agents act differently <em>just in this conversation</em>. Leave the field empty to clear the override and fall back to the agent's base persona.
        </p>
        <form action={action} className="space-y-2" key={selected}>
          <input type="hidden" name="conversation_id" value={convId} />
          <div className="flex items-center gap-2">
            <select
              name="agent_id"
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              className="input !py-1.5 !text-xs font-mono"
            >
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.avatar_emoji} {a.id}
                  {overrides[a.id] ? " (override active)" : ""}
                </option>
              ))}
            </select>
            <span className="text-[11px] text-[color:var(--color-ink-soft)]">
              {current ? `${current.length} chars overriding` : "no override set"}
            </span>
          </div>
          <textarea
            name="persona"
            className="input min-h-[100px] font-mono text-[12px]"
            defaultValue={current}
            placeholder="In this conversation, behave like… (leave blank to clear)"
            maxLength={4000}
          />
          <button type="submit" className="btn btn-primary btn-sm">
            Save override
          </button>
        </form>
      </div>
    </div>
  );
}

function MemberManagerBar({
  convId,
  members,
  ownerId,
  inviteCandidates,
  addAction,
  removeAction,
  onClose,
}: {
  convId: string;
  members: Agent[];
  ownerId: string;
  inviteCandidates: Agent[];
  addAction: (fd: FormData) => Promise<void>;
  removeAction: (fd: FormData) => Promise<void>;
  onClose: () => void;
}) {
  return (
    <div className="bg-[color:var(--color-tint-violet)]/40 border-b border-[color:var(--color-line)] px-5 py-3">
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center justify-between mb-2">
          <span className="font-medium text-sm">Members ({members.length})</span>
          <button
            type="button"
            onClick={onClose}
            className="btn btn-ghost btn-sm"
          >
            Close
          </button>
        </div>
        <ul className="flex flex-wrap gap-1.5 mb-3">
          {members.map((m) => (
            <li key={m.id} className="inline-flex items-center gap-1.5 surface px-2 py-1 text-xs">
              <span>{m.avatar_emoji}</span>
              <span className="font-mono">{m.id}</span>
              {m.id === ownerId ? <span className="tag tag-amber">owner</span> : null}
              {m.id !== ownerId ? (
                <form action={removeAction} className="contents">
                  <input type="hidden" name="conversation_id" value={convId} />
                  <input type="hidden" name="agent_id" value={m.id} />
                  <button
                    type="submit"
                    title="Remove from group"
                    className="text-[color:var(--color-ink-soft)] hover:text-[color:var(--color-danger)] ml-0.5"
                  >
                    ✕
                  </button>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
        {inviteCandidates.length > 0 ? (
          <form action={addAction} className="flex items-center gap-2">
            <input type="hidden" name="conversation_id" value={convId} />
            <select name="agent_id" className="input !py-1.5 !text-xs flex-1 font-mono">
              {inviteCandidates.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.avatar_emoji} {a.id}
                </option>
              ))}
            </select>
            <button type="submit" className="btn btn-primary btn-sm">
              Add to group
            </button>
          </form>
        ) : (
          <div className="text-xs text-[color:var(--color-ink-muted)]">
            All your friend agents are already in this group.
          </div>
        )}
      </div>
    </div>
  );
}

function RenameGroupBar({
  convId,
  current,
  action,
  onClose,
}: {
  convId: string;
  current: string;
  action: (fd: FormData) => Promise<void>;
  onClose: () => void;
}) {
  return (
    <div className="bg-[color:var(--color-tint-blue)] border-b border-[color:var(--color-line)] px-5 py-2">
      <form action={action} className="flex items-center gap-2 max-w-3xl mx-auto">
        <input type="hidden" name="conversation_id" value={convId} />
        <input
          name="title"
          defaultValue={current}
          maxLength={80}
          className="input flex-1 !py-1.5"
          placeholder="Group title"
          autoFocus
        />
        <button type="submit" className="btn btn-primary btn-sm">
          Save
        </button>
        <button type="button" onClick={onClose} className="btn btn-ghost btn-sm">
          Cancel
        </button>
      </form>
    </div>
  );
}

function renderWithDateDividers(
  messages: MessageWithRelations[],
  memberById: Record<string, Agent>,
  myAgentId: string,
  reactionsByMessageId: Record<string, ReactionAggregate[]>,
  setReplyTo: (m: MessageWithRelations | null) => void,
  setEditing: (m: MessageWithRelations | null) => void,
  actions: ChatActions,
  convId: string,
  memberHandles: string[],
  forwardTargets: ForwardTarget[],
): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let prevDay = "";
  let prevSender = "";
  let prevTime = 0;
  for (const m of messages) {
    const day = dayKey(m.created_at);
    const isStartOfGroup =
      day !== prevDay ||
      prevSender !== m.from_agent_id ||
      m.created_at - prevTime > 5 * 60_000;
    if (day !== prevDay) {
      out.push(<DateDivider key={`d-${day}`} day={day} ts={m.created_at} />);
      prevDay = day;
    }
    out.push(
      <Bubble
        key={m.id}
        message={m}
        author={memberById[m.from_agent_id]}
        isMine={m.from_agent_id === myAgentId}
        isStartOfGroup={isStartOfGroup}
        reactions={reactionsByMessageId[m.id] ?? []}
        replyToMessage={
          m.reply_to_message_id
            ? messages.find((x) => x.id === m.reply_to_message_id) ?? null
            : null
        }
        replyToAuthor={
          m.reply_to_message_id
            ? memberById[
                messages.find((x) => x.id === m.reply_to_message_id)?.from_agent_id ?? ""
              ]
            : undefined
        }
        myAgentId={myAgentId}
        memberHandles={memberHandles}
        forwardTargets={forwardTargets}
        onReply={() => setReplyTo(m)}
        onEdit={() => setEditing(m)}
        actions={actions}
        convId={convId}
      />,
    );
    prevSender = m.from_agent_id;
    prevTime = m.created_at;
  }
  return out;
}

function DateDivider({ day, ts }: { day: string; ts: number }) {
  const label = (() => {
    const d = new Date(ts);
    const today = dayKey(Date.now());
    const yest = dayKey(Date.now() - 86400_000);
    if (day === today) return "Today";
    if (day === yest) return "Yesterday";
    return d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: d.getFullYear() !== new Date().getFullYear() ? "numeric" : undefined,
    });
  })();
  return (
    <div className="sticky top-0 z-10 flex justify-center my-3">
      <span className="text-[11px] uppercase tracking-wider px-3 py-1 rounded-full bg-[color:var(--color-paper)]/85 backdrop-blur border border-[color:var(--color-line)] text-[color:var(--color-ink-muted)] font-medium">
        {label}
      </span>
    </div>
  );
}

function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function Bubble({
  message,
  author,
  isMine,
  isStartOfGroup,
  reactions,
  replyToMessage,
  replyToAuthor,
  myAgentId,
  memberHandles,
  forwardTargets,
  onReply,
  onEdit,
  actions,
  convId,
}: {
  message: MessageWithRelations;
  author?: Agent;
  isMine: boolean;
  isStartOfGroup: boolean;
  reactions: ReactionAggregate[];
  replyToMessage: MessageWithRelations | null;
  replyToAuthor?: Agent;
  myAgentId: string;
  memberHandles: string[];
  forwardTargets: ForwardTarget[];
  onReply: () => void;
  onEdit: () => void;
  actions: ChatActions;
  convId: string;
}) {
  const [hovered, setHovered] = useState(false);
  const [showReactions, setShowReactions] = useState(false);
  const [showForward, setShowForward] = useState(false);
  const within5min = Date.now() - message.created_at < 5 * 60_000;
  const canEdit = isMine && within5min && !message.deleted_at && message.text;
  const canDelete = isMine && within5min && !message.deleted_at;

  return (
    <div
      className={`flex gap-2 ${isMine ? "flex-row-reverse" : ""} ${
        isStartOfGroup ? "mt-3" : "mt-0.5"
      }`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => {
        setHovered(false);
        setShowReactions(false);
      }}
    >
      <div className="w-8 shrink-0 flex justify-center">
        {isStartOfGroup && !isMine ? <Avatar agent={author} size={32} /> : null}
      </div>
      <div className={`flex-1 min-w-0 flex flex-col ${isMine ? "items-end" : "items-start"}`}>
        {isStartOfGroup && !isMine ? (
          <div className="flex items-baseline gap-1.5 mb-0.5 ml-3 flex-wrap">
            <span className="font-medium text-[13px]">
              {author?.display_name ?? message.from_agent_id}
            </span>
            {author?.agent_kind === "managed" ? (
              <span className="tag tag-violet !py-0 !px-1.5 !text-[10px]">🦀</span>
            ) : null}
            {message.kind === "agent_to_agent" ? (
              <span
                className="tag tag-violet !py-0 !px-1.5 !text-[10px]"
                title="Autonomous agent reply"
              >
                agent ↔ agent
              </span>
            ) : null}
          </div>
        ) : null}

        <div className="relative group max-w-[min(720px,90%)]">
          <div
            className={`rounded-2xl px-3 py-2 ${
              isMine
                ? "bg-[color:var(--color-ink)] text-white rounded-br-md"
                : "bg-[color:var(--color-paper)] border border-[color:var(--color-line)] rounded-bl-md"
            } ${message.deleted_at ? "italic opacity-60" : ""}`}
          >
            {replyToMessage ? (
              <ReplyQuote
                message={replyToMessage}
                author={replyToAuthor}
                isMine={isMine}
              />
            ) : null}
            {message.thinking && !message.deleted_at ? (
              <Thinking text={message.thinking} isMine={isMine} />
            ) : null}
            {message.deleted_at ? (
              <span className="text-[13.5px]">message deleted</span>
            ) : message.text ? (
              <div className="text-[14.5px] leading-[1.45] break-words whitespace-pre-wrap">
                <MessageMarkdown
                  text={message.text}
                  memberHandles={memberHandles}
                />
              </div>
            ) : null}
            {message.attachments.length > 0 && !message.deleted_at ? (
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {message.attachments.map((a) =>
                  a.mime_type.startsWith("image/") ? (
                    <a
                      key={a.id}
                      href={`/api/v1/blobs/${a.id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block rounded-lg overflow-hidden border border-black/5 max-w-[280px]"
                      title={`${a.filename} · ${formatBytes(a.size_bytes)}`}
                    >
                      <img
                        src={`/api/v1/blobs/${a.id}`}
                        alt={a.filename}
                        className="block max-h-[320px] w-auto"
                        loading="lazy"
                      />
                    </a>
                  ) : (
                    <a
                      key={a.id}
                      href={`/api/v1/blobs/${a.id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-lg text-[12px] ${
                        isMine
                          ? "bg-white/15 hover:bg-white/25"
                          : "bg-black/5 hover:bg-black/10"
                      }`}
                    >
                      <span>📎</span>
                      <span className="font-medium truncate max-w-[180px]">
                        {a.filename}
                      </span>
                      <span className="opacity-70">{formatBytes(a.size_bytes)}</span>
                    </a>
                  ),
                )}
              </div>
            ) : null}
            {message.context_note && !message.deleted_at ? (
              <a
                href={`/api/v1/contexts/${message.context_note.id}`}
                target="_blank"
                rel="noopener noreferrer"
                className={`mt-2 block px-2.5 py-1.5 rounded-lg text-[12px] ${
                  isMine ? "bg-white/15 hover:bg-white/25" : "bg-black/5 hover:bg-black/10"
                }`}
              >
                <div className="opacity-70 flex items-center gap-1">
                  <span>📒</span>
                  <span>ContextNote · {formatBytes(message.context_note.size_bytes)}</span>
                </div>
                <div className="font-medium">{message.context_note.title}</div>
              </a>
            ) : null}
            <div
              className={`mt-1 flex items-center gap-1.5 text-[10.5px] ${
                isMine ? "text-white/70 justify-end" : "text-[color:var(--color-ink-soft)]"
              }`}
            >
              <span>{fmtTime(message.created_at)}</span>
              {message.edited_at ? <span>· edited</span> : null}
            </div>
          </div>

          {hovered && !message.deleted_at ? (
            <HoverActions
              isMine={isMine}
              canEdit={!!canEdit}
              canDelete={canDelete}
              messageId={message.id}
              text={message.text}
              onReply={onReply}
              onEdit={onEdit}
              onTogglePicker={() => setShowReactions((v) => !v)}
              showPicker={showReactions}
              onToggleForward={() => setShowForward((v) => !v)}
              showForward={showForward}
              forwardTargets={forwardTargets}
              actions={actions}
              convId={convId}
            />
          ) : null}
        </div>

        {reactions.length > 0 ? (
          <div className={`mt-1 flex flex-wrap gap-1 ${isMine ? "justify-end" : ""}`}>
            {reactions.map((r) => (
              <ReactionChip
                key={r.emoji}
                reaction={r}
                mine={r.agent_ids.includes(myAgentId)}
                messageId={message.id}
                action={actions.react}
              />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function HoverActions({
  isMine,
  canEdit,
  canDelete,
  messageId,
  text,
  onReply,
  onEdit,
  onTogglePicker,
  showPicker,
  onToggleForward,
  showForward,
  forwardTargets,
  actions,
  convId,
}: {
  isMine: boolean;
  canEdit: boolean;
  canDelete: boolean;
  messageId: string;
  text: string;
  onReply: () => void;
  onEdit: () => void;
  onTogglePicker: () => void;
  showPicker: boolean;
  onToggleForward: () => void;
  showForward: boolean;
  forwardTargets: ForwardTarget[];
  actions: ChatActions;
  convId: string;
}) {
  return (
    <div
      className={`absolute -top-3 ${isMine ? "left-2" : "right-2"} flex items-center gap-0.5 surface shadow-[var(--shadow-pop)] px-1 py-0.5 rounded-full text-[12px] z-10`}
    >
      <ActionIcon title="React" onClick={onTogglePicker}>😊</ActionIcon>
      <ActionIcon title="Reply" onClick={onReply}>↩</ActionIcon>
      {forwardTargets.length > 0 ? (
        <ActionIcon title="Forward" onClick={onToggleForward}>↪</ActionIcon>
      ) : null}
      {text ? (
        <ActionIcon
          title="Copy"
          onClick={() => {
            try {
              navigator.clipboard.writeText(text);
            } catch {
              /* noop */
            }
          }}
        >
          ⧉
        </ActionIcon>
      ) : null}
      {canEdit ? <ActionIcon title="Edit (5 min)" onClick={onEdit}>✏️</ActionIcon> : null}
      {canDelete ? (
        <form action={actions.remove} className="contents">
          <input type="hidden" name="conversation_id" value={convId} />
          <input type="hidden" name="message_id" value={messageId} />
          <button
            type="submit"
            title="Delete (5 min)"
            className="px-1.5 hover:bg-[color:var(--color-danger-tint)] rounded-full"
          >
            🗑
          </button>
        </form>
      ) : null}
      {showPicker ? (
        <div className="absolute -top-12 left-1/2 -translate-x-1/2 surface shadow-[var(--shadow-pop)] p-1 flex gap-0.5 rounded-full">
          {REACTION_PALETTE.map((e) => (
            <form key={e} action={actions.react} className="contents">
              <input type="hidden" name="conversation_id" value={convId} />
              <input type="hidden" name="message_id" value={messageId} />
              <input type="hidden" name="emoji" value={e} />
              <button
                type="submit"
                className="w-7 h-7 rounded-full hover:bg-[color:var(--color-canvas)] text-base"
              >
                {e}
              </button>
            </form>
          ))}
        </div>
      ) : null}
      {showForward ? (
        <div className="absolute top-full mt-2 right-0 surface shadow-[var(--shadow-pop)] py-1 w-64 max-h-72 overflow-y-auto z-20">
          <div className="px-3 py-1.5 text-[11px] uppercase tracking-wider text-[color:var(--color-ink-soft)]">
            Forward to…
          </div>
          {forwardTargets.map((t) => (
            <form key={t.id} action={actions.forward}>
              <input type="hidden" name="conversation_id" value={convId} />
              <input type="hidden" name="message_id" value={messageId} />
              <input type="hidden" name="target_conversation_id" value={t.id} />
              <button
                type="submit"
                className="w-full text-left px-3 py-1.5 text-[13px] hover:bg-[color:var(--color-canvas)] truncate"
              >
                {t.label}
              </button>
            </form>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ActionIcon({
  children,
  title,
  onClick,
}: {
  children: React.ReactNode;
  title: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="px-1.5 hover:bg-[color:var(--color-canvas)] rounded-full"
    >
      {children}
    </button>
  );
}

function ReactionChip({
  reaction,
  mine,
  messageId,
  action,
}: {
  reaction: ReactionAggregate;
  mine: boolean;
  messageId: string;
  action: (fd: FormData) => Promise<void>;
}) {
  return (
    <form action={action} className="contents">
      <input type="hidden" name="message_id" value={messageId} />
      <input type="hidden" name="emoji" value={reaction.emoji} />
      <button
        type="submit"
        className={`text-[12px] px-1.5 py-0.5 rounded-full border transition-colors ${
          mine
            ? "bg-[color:var(--color-tint-blue)] border-[color:var(--color-tint-blue-ink)]/30 text-[color:var(--color-tint-blue-ink)]"
            : "bg-[color:var(--color-paper)] border-[color:var(--color-line)] hover:bg-[color:var(--color-canvas)]"
        }`}
        title={reaction.agent_ids.join(", ")}
      >
        {reaction.emoji} {reaction.count}
      </button>
    </form>
  );
}

function ReplyQuote({
  message,
  author,
  isMine,
}: {
  message: MessageWithRelations;
  author?: Agent;
  isMine: boolean;
}) {
  return (
    <div
      className={`mb-1.5 pl-2 border-l-2 ${
        isMine
          ? "border-white/40 text-white/85"
          : "border-[color:var(--color-tint-blue-ink)] text-[color:var(--color-ink-muted)]"
      } text-[12px]`}
    >
      <div className="font-medium">
        ↩ {author?.display_name ?? message.from_agent_id}
      </div>
      <div className="truncate max-w-[300px]">
        {message.deleted_at ? "(deleted)" : message.text || "(attachment)"}
      </div>
    </div>
  );
}

function Thinking({ text, isMine }: { text: string; isMine: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div
      className={`mb-1.5 rounded-lg overflow-hidden ${
        isMine ? "bg-white/10" : "bg-[color:var(--color-tint-violet)]/40"
      }`}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`w-full flex items-center gap-1.5 px-2 py-1 text-[11.5px] font-medium ${
          isMine ? "text-white/85 hover:bg-white/10" : "text-[color:var(--color-tint-violet-ink)]"
        }`}
      >
        <span>{open ? "▾" : "▸"}</span>
        <span>Reasoning</span>
        <span className="ml-auto opacity-70">{text.length}</span>
      </button>
      {open ? (
        <pre
          className={`px-2 pb-2 text-[12px] leading-[1.5] whitespace-pre-wrap font-mono ${
            isMine ? "text-white/80" : "text-[color:var(--color-ink-muted)]"
          }`}
        >
          {text}
        </pre>
      ) : null}
    </div>
  );
}

function TypingRow({ agents }: { agents: Agent[] }) {
  const label = agents.length === 1
    ? `${agents[0].display_name} is typing`
    : `${agents.length} agents are typing`;
  return (
    <div className="flex gap-2 mt-3">
      <div className="w-8 shrink-0 flex justify-center">
        <Avatar agent={agents[0]} size={32} />
      </div>
      <div className="rounded-2xl rounded-bl-md bg-[color:var(--color-paper)] border border-[color:var(--color-line)] px-3 py-2 flex items-center gap-2">
        <TypingDots />
        <span className="text-[12px] text-[color:var(--color-ink-soft)]">
          {label}
        </span>
      </div>
    </div>
  );
}

function TypingDots() {
  return (
    <span className="inline-flex gap-1" aria-label="typing">
      <span className="w-1.5 h-1.5 rounded-full bg-[color:var(--color-ink-soft)] tg-dot" style={{ animationDelay: "0ms" }} />
      <span className="w-1.5 h-1.5 rounded-full bg-[color:var(--color-ink-soft)] tg-dot" style={{ animationDelay: "180ms" }} />
      <span className="w-1.5 h-1.5 rounded-full bg-[color:var(--color-ink-soft)] tg-dot" style={{ animationDelay: "360ms" }} />
    </span>
  );
}

function EmptyState({ memberCount }: { memberCount: number }) {
  return (
    <div className="text-center py-20 text-[color:var(--color-ink-muted)]">
      <div className="text-4xl mb-3">💬</div>
      <div className="font-medium">No messages yet</div>
      <div className="text-sm mt-1">
        {memberCount > 2
          ? "Group chat is open. Managed agents will reply autonomously when you message."
          : "Send the first message to kick things off."}
      </div>
    </div>
  );
}

function Avatar({ agent, size = 32 }: { agent?: Agent; size?: number }) {
  if (!agent) {
    return (
      <div
        className="rounded-full bg-[color:var(--color-canvas)] border border-[color:var(--color-line)] flex items-center justify-center"
        style={{ width: size, height: size, fontSize: Math.floor(size * 0.45) }}
      >
        🤖
      </div>
    );
  }
  if (agent.avatar_blob_path) {
    return (
      <img
        src={`/api/v1/blobs/avatar/${encodeURIComponent(agent.id)}`}
        alt=""
        className="rounded-full object-cover border border-[color:var(--color-line)]"
        style={{ width: size, height: size }}
      />
    );
  }
  const tone = avatarTone(agent.id);
  return (
    <div
      className="rounded-full flex items-center justify-center"
      style={{
        width: size,
        height: size,
        background: tone.bg,
        color: tone.fg,
        fontSize: Math.floor(size * 0.45),
      }}
    >
      {agent.avatar_emoji}
    </div>
  );
}

function avatarTone(id: string): { bg: string; fg: string } {
  const palette = [
    { bg: "#FDF1E6", fg: "#B9591B" },
    { bg: "#EBF5FB", fg: "#337EA9" },
    { bg: "#EBF5EE", fg: "#2C7048" },
    { bg: "#F9EAF3", fg: "#A3357F" },
    { bg: "#F0ECF9", fg: "#6940A5" },
  ];
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return palette[h % palette.length];
}

function Composer({
  conv,
  myAgent,
  send,
  showContext,
  onToggleContext,
  showThinking,
  onToggleThinking,
  replyTo,
  onClearReplyTo,
  editing,
  onClearEditing,
  editAction,
  memberById,
  error,
}: {
  conv: Conversation;
  myAgent?: Agent;
  send: (fd: FormData) => Promise<void>;
  showContext: boolean;
  onToggleContext: () => void;
  showThinking: boolean;
  onToggleThinking: () => void;
  replyTo: MessageWithRelations | null;
  onClearReplyTo: () => void;
  editing: MessageWithRelations | null;
  onClearEditing: () => void;
  editAction: (fd: FormData) => Promise<void>;
  memberById: Record<string, Agent>;
  error?: string;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const editRef = useRef<HTMLFormElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);

  // When editing starts, prefill text + focus.
  useEffect(() => {
    if (editing && textRef.current) {
      textRef.current.value = editing.text;
      textRef.current.focus();
    }
  }, [editing]);

  if (editing) {
    return (
      <div className="border-t border-[color:var(--color-line)] bg-[color:var(--color-paper)] px-5 py-3">
        <div className="max-w-3xl mx-auto">
          <div className="text-[11.5px] text-[color:var(--color-ink-soft)] mb-1.5">
            Editing your message
          </div>
          <form
            ref={editRef}
            action={async (fd) => {
              setSending(true);
              try {
                await editAction(fd);
                onClearEditing();
              } finally {
                setSending(false);
              }
            }}
            className="surface px-3 py-2 flex items-end gap-2"
          >
            <input type="hidden" name="conversation_id" value={conv.id} />
            <input type="hidden" name="message_id" value={editing.id} />
            <textarea
              ref={textRef}
              name="text"
              required
              className="flex-1 outline-none resize-none bg-transparent text-[14.5px] leading-[1.45] min-h-[36px] max-h-40"
              defaultValue={editing.text}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  editRef.current?.requestSubmit();
                }
                if (e.key === "Escape") onClearEditing();
              }}
              disabled={sending}
            />
            <button type="submit" className="btn btn-primary btn-sm" disabled={sending}>
              {sending ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              onClick={onClearEditing}
              className="btn btn-ghost btn-sm"
            >
              Cancel
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="border-t border-[color:var(--color-line)] bg-[color:var(--color-paper)] px-5 py-3">
      <div className="max-w-3xl mx-auto">
        {error ? (
          <div className="callout callout-amber mb-2 text-sm">
            <span>⚠️</span>
            <span>{error}</span>
          </div>
        ) : null}
        {replyTo ? (
          <div className="surface px-3 py-1.5 mb-2 flex items-start gap-2 text-[12px]">
            <span className="mt-0.5">↩</span>
            <div className="flex-1 min-w-0">
              <div className="font-medium text-[color:var(--color-tint-blue-ink)]">
                Replying to {memberById[replyTo.from_agent_id]?.display_name ?? replyTo.from_agent_id}
              </div>
              <div className="truncate text-[color:var(--color-ink-muted)]">
                {replyTo.text || "(attachment)"}
              </div>
            </div>
            <button
              type="button"
              onClick={onClearReplyTo}
              className="text-[color:var(--color-ink-soft)] hover:text-[color:var(--color-ink)]"
              title="Cancel reply"
            >
              ✕
            </button>
          </div>
        ) : null}
        <form
          ref={formRef}
          action={async (fd) => {
            setSending(true);
            try {
              if (replyTo) fd.set("reply_to_message_id", replyTo.id);
              await send(fd);
              formRef.current?.reset();
              setPendingFiles([]);
              onClearReplyTo();
            } finally {
              setSending(false);
            }
          }}
          className="surface px-3 py-2"
        >
          <input type="hidden" name="conversation_id" value={conv.id} />
          <textarea
            ref={textRef}
            name="text"
            className="w-full text-[14.5px] leading-[1.45] outline-none resize-none bg-transparent placeholder:text-[color:var(--color-ink-soft)] min-h-[36px] max-h-48"
            placeholder={
              myAgent ? `Message as ${myAgent.id}…` : "Message…"
            }
            rows={1}
            disabled={sending}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                formRef.current?.requestSubmit();
              }
            }}
          />
          <input
            ref={fileInputRef}
            type="file"
            name="attachments"
            multiple
            className="hidden"
            onChange={(e) => setPendingFiles(Array.from(e.target.files ?? []))}
          />
          {pendingFiles.length > 0 ? (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {pendingFiles.map((f, i) => (
                <span key={i} className="tag" title={f.name}>
                  📎 {f.name}
                </span>
              ))}
              <button
                type="button"
                className="text-[11px] text-[color:var(--color-ink-soft)] hover:text-[color:var(--color-ink)]"
                onClick={() => {
                  setPendingFiles([]);
                  if (fileInputRef.current) fileInputRef.current.value = "";
                }}
              >
                clear
              </button>
            </div>
          ) : null}
          {showThinking ? (
            <div className="mt-2 border-t border-[color:var(--color-line)] pt-2">
              <textarea
                name="thinking"
                className="input min-h-[80px] font-mono text-[12px] bg-[color:var(--color-tint-violet)]/30"
                placeholder="Reasoning the room can see (collapsible)…"
              />
            </div>
          ) : null}
          {showContext ? (
            <div className="mt-2 border-t border-[color:var(--color-line)] pt-2 space-y-2">
              <input
                name="context_note_title"
                className="input"
                placeholder="ContextNote title…"
              />
              <textarea
                name="context_note_body"
                className="input min-h-[140px] font-mono text-[12.5px]"
                placeholder="# Title&#10;&#10;> [!summary]&#10;> 1-2 sentence TL;DR.&#10;&#10;## Key decisions&#10;- ..."
              />
            </div>
          ) : null}
          <div className="mt-2 flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-0.5">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="btn btn-ghost btn-sm !px-2"
                title="Attach files"
              >
                📎
              </button>
              <button
                type="button"
                onClick={onToggleThinking}
                className={`btn btn-sm !px-2 ${showThinking ? "btn-secondary" : "btn-ghost"}`}
                title="Add reasoning visible to all members"
              >
                🧠
              </button>
              <button
                type="button"
                onClick={onToggleContext}
                className={`btn btn-sm !px-2 ${showContext ? "btn-secondary" : "btn-ghost"}`}
                title="Attach ContextNote"
              >
                📒
              </button>
              <span className="text-[11px] text-[color:var(--color-ink-soft)] hidden md:inline ml-1">
                <span className="kbd">⌘</span>
                <span className="kbd ml-1">↵</span>
              </span>
            </div>
            <button
              type="submit"
              className="btn btn-primary btn-sm"
              disabled={sending}
            >
              {sending ? "…" : "Send →"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "UTC",
  });
}

function timeAgo(ts: number): string {
  const d = Date.now() - ts;
  if (d < 60_000) return "just now";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}
