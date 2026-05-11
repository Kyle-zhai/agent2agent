"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Agent, Conversation, MessageWithRelations } from "@/lib/types";

export function ConversationView({
  conv,
  members,
  messages,
  myAgentId,
  sendAction,
  error,
}: {
  conv: Conversation;
  members: Agent[];
  messages: MessageWithRelations[];
  myAgentId: string;
  sendAction: (formData: FormData) => Promise<void>;
  error?: string;
}) {
  const [showContext, setShowContext] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages.length]);

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      if (document.visibilityState === "visible") {
        router.refresh();
      }
    };
    const id = window.setInterval(tick, 4000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [router]);

  const memberById = Object.fromEntries(members.map((m) => [m.id, m]));
  const myAgent = memberById[myAgentId];

  const title =
    conv.type === "group"
      ? conv.title ?? "Untitled group"
      : (() => {
          const other = members.find((m) => m.id !== myAgentId);
          return other ? `${other.avatar_emoji} ${other.display_name}` : "Direct";
        })();

  const subtitle =
    conv.type === "group"
      ? `${members.length} members`
      : (() => {
          const other = members.find((m) => m.id !== myAgentId);
          return other ? other.id : "";
        })();

  return (
    <div className="h-screen flex flex-col">
      <header className="flex items-center justify-between px-6 py-3 border-b border-[color:var(--color-line)] bg-[color:var(--color-paper)]">
        <div className="min-w-0">
          <div className="font-semibold truncate">{title}</div>
          <div className="text-xs text-[color:var(--color-ink-soft)] font-mono truncate">
            {subtitle}
          </div>
        </div>
        <MembersChip members={members} myAgentId={myAgentId} />
      </header>

      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-6 py-6"
      >
        <div className="max-w-3xl mx-auto space-y-1">
          {messages.length === 0 ? (
            <EmptyState memberCount={members.length} />
          ) : (
            messages.map((m, i) => {
              const prev = messages[i - 1];
              const isStartOfGroup =
                !prev ||
                prev.from_agent_id !== m.from_agent_id ||
                m.created_at - prev.created_at > 5 * 60_000;
              return (
                <MessageRow
                  key={m.id}
                  message={m}
                  author={memberById[m.from_agent_id]}
                  isStartOfGroup={isStartOfGroup}
                  isMine={m.from_agent_id === myAgentId}
                />
              );
            })
          )}
        </div>
      </div>

      <Composer
        conv={conv}
        myAgent={myAgent}
        sendAction={sendAction}
        showContext={showContext}
        onToggleContext={() => setShowContext((v) => !v)}
        error={error}
      />
    </div>
  );
}

function EmptyState({ memberCount }: { memberCount: number }) {
  return (
    <div className="text-center py-20 text-[color:var(--color-ink-muted)]">
      <div className="text-4xl mb-3">💬</div>
      <div className="font-medium">No messages yet</div>
      <div className="text-sm mt-1">
        {memberCount > 2
          ? "Group chat is open — send the first message."
          : "Send the first message to kick things off."}
      </div>
    </div>
  );
}

function MembersChip({
  members,
  myAgentId,
}: {
  members: Agent[];
  myAgentId: string;
}) {
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {members.map((m) => (
        <span
          key={m.id}
          className={`tag ${m.id === myAgentId ? "tag-blue" : ""}`}
          title={m.id}
        >
          <span>{m.avatar_emoji}</span>
          <span className="font-mono text-[11px]">{m.id.split(".")[0]}</span>
        </span>
      ))}
    </div>
  );
}

function MessageRow({
  message,
  author,
  isStartOfGroup,
  isMine,
}: {
  message: MessageWithRelations;
  author?: Agent;
  isStartOfGroup: boolean;
  isMine: boolean;
}) {
  return (
    <div className={`flex gap-3 ${isStartOfGroup ? "mt-5" : "mt-0.5"}`}>
      <div className="w-8 shrink-0">
        {isStartOfGroup ? (
          <div className="w-8 h-8 rounded-full bg-[color:var(--color-canvas)] border border-[color:var(--color-line)] flex items-center justify-center text-base">
            {author?.avatar_emoji ?? "🤖"}
          </div>
        ) : null}
      </div>
      <div className="flex-1 min-w-0">
        {isStartOfGroup ? (
          <div className="flex items-baseline gap-2 mb-0.5">
            <span className={`font-medium text-sm ${isMine ? "text-[color:var(--color-tint-blue-ink)]" : ""}`}>
              {author?.display_name ?? message.from_agent_id}
            </span>
            <span className="text-[11px] font-mono text-[color:var(--color-ink-soft)]">
              {author?.id ?? message.from_agent_id}
            </span>
            <span className="text-[11px] text-[color:var(--color-ink-soft)]">
              {fmtTime(message.created_at)}
            </span>
          </div>
        ) : null}
        {message.text ? (
          <div className="text-[15px] leading-[1.6] whitespace-pre-wrap break-words">
            {message.text}
          </div>
        ) : null}
        {message.attachments.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-2">
            {message.attachments.map((a) => (
              <a
                key={a.id}
                className="surface px-3 py-2 text-xs flex items-center gap-2 hover:bg-[color:var(--color-canvas)]"
                href={`/api/v1/blobs/${a.id}`}
                title={a.filename}
              >
                <span>📎</span>
                <span className="font-medium truncate max-w-[200px]">{a.filename}</span>
                <span className="text-[color:var(--color-ink-soft)]">
                  {formatBytes(a.size_bytes)}
                </span>
              </a>
            ))}
          </div>
        ) : null}
        {message.context_note ? (
          <Link
            href={`/api/v1/contexts/${message.context_note.id}`}
            target="_blank"
            className="mt-2 surface p-3 block hover:bg-[color:var(--color-canvas)] transition-colors"
          >
            <div className="flex items-center gap-2 text-xs text-[color:var(--color-ink-soft)] mb-1">
              <span>📒</span>
              <span>ContextNote ·</span>
              <span className="font-mono">{message.context_note.id}</span>
              <span>·</span>
              <span>{formatBytes(message.context_note.size_bytes)}</span>
            </div>
            <div className="font-medium text-sm">
              {message.context_note.title}
            </div>
          </Link>
        ) : null}
      </div>
    </div>
  );
}

function Composer({
  conv,
  myAgent,
  sendAction,
  showContext,
  onToggleContext,
  error,
}: {
  conv: Conversation;
  myAgent?: Agent;
  sendAction: (formData: FormData) => Promise<void>;
  showContext: boolean;
  onToggleContext: () => void;
  error?: string;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);

  return (
    <div className="border-t border-[color:var(--color-line)] bg-[color:var(--color-paper)] px-6 py-4">
      <div className="max-w-3xl mx-auto">
        {error ? (
          <div className="callout callout-amber mb-3 text-sm">
            <span>⚠️</span>
            <span>{error}</span>
          </div>
        ) : null}
        <form
          ref={formRef}
          action={async (fd) => {
            setSending(true);
            try {
              await sendAction(fd);
              formRef.current?.reset();
              setPendingFiles([]);
            } finally {
              setSending(false);
            }
          }}
          className="surface p-3"
        >
          <input type="hidden" name="conversation_id" value={conv.id} />
          <textarea
            name="text"
            className="w-full text-[15px] leading-[1.55] outline-none resize-none bg-transparent placeholder:text-[color:var(--color-ink-soft)] min-h-[44px] max-h-48"
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
            onChange={(e) =>
              setPendingFiles(Array.from(e.target.files ?? []))
            }
          />
          {pendingFiles.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-2">
              {pendingFiles.map((f, i) => (
                <span
                  key={i}
                  className="tag"
                  title={f.name}
                >
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
          {showContext ? (
            <div className="mt-3 border-t border-[color:var(--color-line)] pt-3 space-y-2">
              <input
                name="context_note_title"
                className="input"
                placeholder="ContextNote title (e.g. Project X handoff)"
              />
              <textarea
                name="context_note_body"
                className="input min-h-[160px] font-mono text-[13px]"
                placeholder={`# Title

> [!summary]
> 1-2 sentence TL;DR.

## Key decisions
- ...

## Open questions
- ...

## For the receiving agent
- ...`}
              />
            </div>
          ) : null}
          <div className="mt-3 flex items-center justify-between gap-2">
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="btn btn-ghost btn-sm"
                title="Attach files"
              >
                📎 File
              </button>
              <button
                type="button"
                onClick={onToggleContext}
                className={`btn btn-sm ${showContext ? "btn-secondary" : "btn-ghost"}`}
                title="Attach ContextNote"
              >
                📒 ContextNote
              </button>
              <span className="text-[11px] text-[color:var(--color-ink-soft)] hidden sm:inline">
                <span className="kbd">⌘</span>
                <span className="kbd ml-1">↵</span>
                <span className="ml-1">to send</span>
              </span>
            </div>
            <button
              type="submit"
              className="btn btn-primary btn-sm"
              disabled={sending}
            >
              {sending ? "Sending…" : "Send →"}
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
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}
