"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { Agent, MessageWithRelations } from "@/lib/types";
import { avatarGradClass } from "@/lib/avatar";

/**
 * OwnAgentDock — a private chat with the user's own managed agent, rendered
 * inside /app/c/[id]. Sends go to a 1:1 direct conversation that the managed
 * agent reply pipeline auto-responds in; the dock subscribes to that
 * conversation's SSE stream so replies appear without a page reload.
 *
 * Two presentations:
 *   - `floating` (default on the chat page) — a real floating window you can
 *     drag, resize, minimise, maximise, and close to a launcher pill. Its
 *     geometry + open/minimised state persist to localStorage.
 *   - `embedded` / docked — fills its flex slot (legacy in-column layout).
 */

type Box = { x: number; y: number; w: number; h: number };
type Drag = {
  mode: "move" | "resize";
  sx: number;
  sy: number;
  ox: number;
  oy: number;
  ow: number;
  oh: number;
};

const WIN_MIN = { w: 264, h: 340 };
const WIN_MAX = { w: 560, h: 920 };
const STORAGE_KEY = "a2a_agent_window_v2";

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));

// Where the window OPENS by default — over the chat stage (so it doesn't
// start on top of the conversation list). The window can then be dragged
// anywhere in the viewport. Measured from the chat column (page.tsx tags it
// with id="a2a-chat-stage"); falls back to the known shell metrics if absent.
function chatBounds(): { left: number; right: number } {
  if (typeof document !== "undefined") {
    const el = document.getElementById("a2a-chat-stage");
    if (el) {
      const r = el.getBoundingClientRect();
      if (r.width > 0) {
        return { left: Math.round(r.left) + 8, right: Math.round(r.right) - 8 };
      }
    }
  }
  // Fallback: shell padding (10) + rail (72) + gap (10) + list (320) + gap (10).
  const left = 430;
  const right =
    typeof window !== "undefined" ? window.innerWidth - 16 : left + 600;
  return { left, right };
}

export function OwnAgentDock({
  convId,
  myExternalAgentId,
  managedAgent,
  messages,
  sendAction,
  embedded = false,
  floating = false,
}: {
  convId: string;
  myExternalAgentId: string;
  managedAgent: Agent;
  messages: MessageWithRelations[];
  sendAction: (formData: FormData) => Promise<void>;
  /** Fills its flex slot as a docked block (legacy in-column layout). */
  embedded?: boolean;
  /** Renders as a draggable/resizable floating window over the chat stage. */
  floating?: boolean;
}) {
  const router = useRouter();
  const scrollRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState("");
  const [collapsed, setCollapsed] = useState(false);

  // --- floating-window state (unused in docked/embedded modes) ---------------
  const [mounted, setMounted] = useState(false);
  const [box, setBox] = useState<Box>({ x: 0, y: 0, w: 344, h: 560 });
  const [open, setOpen] = useState(!floating);
  const [minimized, setMinimized] = useState(false);
  const [maximized, setMaximized] = useState(false);
  // Below this width the free-floating window would overlap the (cramped)
  // list/chat, so it auto-docks to a fixed bottom sheet instead.
  const [narrow, setNarrow] = useState(false);
  const dragRef = useRef<Drag | null>(null);
  const preMax = useRef<Box | null>(null);

  // Draft persistence: restore an unsent draft for this private conversation
  // on mount, then mirror edits to localStorage (cleared when emptied/sent).
  useEffect(() => {
    try {
      const saved = localStorage.getItem(`a2a:dock-draft:${convId}`);
      if (saved) setDraft(saved);
    } catch {
      /* storage unavailable — drafts just won't persist */
    }
  }, [convId]);

  useEffect(() => {
    try {
      const key = `a2a:dock-draft:${convId}`;
      if (draft.length > 0) localStorage.setItem(key, draft);
      else localStorage.removeItem(key);
    } catch {
      /* storage unavailable — drafts just won't persist */
    }
  }, [convId, draft]);

  // Auto-scroll to bottom on new messages.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < 200;
    // Always pin to bottom on first mount; only when near bottom afterwards.
    if (!el.dataset.everScrolled) {
      el.scrollTop = el.scrollHeight;
      el.dataset.everScrolled = "1";
      return;
    }
    if (nearBottom) {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    }
  }, [messages.length, minimized, open]);

  // SSE-driven refresh for the dock's own private conversation. Falls back
  // to 4s polling when the EventSource constructor throws or the connection
  // dies. We reuse the same SSE endpoint the group chat uses — Next.js
  // route is per-conversation-id.
  useEffect(() => {
    let cancelled = false;
    let es: EventSource | null = null;
    let pollTimer: number | null = null;
    const startPolling = () => {
      pollTimer = window.setInterval(() => {
        if (cancelled) return;
        if (document.visibilityState === "visible") router.refresh();
      }, 4000);
    };
    try {
      es = new EventSource(`/api/v1/conversations/${convId}/stream`);
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
  }, [router, convId]);

  // Floating: restore saved geometry on mount, else default to the top-right
  // of the chat stage. Gated on `mounted` so the server render and first
  // client render agree (no hydration mismatch from localStorage/window).
  useEffect(() => {
    if (!floating) return;
    setMounted(true);
    setNarrow(window.innerWidth < 1100);
    const b = chatBounds();
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const s = JSON.parse(raw) as Partial<Box> & {
          open?: boolean;
          minimized?: boolean;
        };
        if (typeof s.x === "number" && typeof s.y === "number") {
          const w = clamp(s.w ?? 344, WIN_MIN.w, WIN_MAX.w);
          const h = clamp(s.h ?? 560, WIN_MIN.h, WIN_MAX.h);
          // Only clamp into the viewport (keep the title bar grabbable) — the
          // user can park the window anywhere, including over the list.
          setBox({
            x: clamp(s.x, 8, Math.max(8, window.innerWidth - 80)),
            y: clamp(s.y, 8, Math.max(8, window.innerHeight - 44)),
            w,
            h,
          });
          if (typeof s.open === "boolean") setOpen(s.open);
          if (typeof s.minimized === "boolean") setMinimized(s.minimized);
          return;
        }
      }
    } catch {
      /* fall through to default placement */
    }
    const w = 344;
    const h = Math.min(620, Math.max(WIN_MIN.h, window.innerHeight - 132));
    // Default: top of the chat stage, right-aligned.
    setBox({ x: Math.max(b.left, b.right - w - 8), y: 92, w, h });
  }, [floating]);

  // Mobile triage: the expanded dock would cover most of a phone viewport,
  // so on small screens it always STARTS minimized (overriding any saved
  // state — that may have been written on a desktop). This effect runs after
  // the restore effect above in the same commit, so its setMinimized wins.
  useEffect(() => {
    if (!floating) return;
    if (window.matchMedia("(max-width: 767px)").matches) {
      setMinimized(true);
    }
  }, [floating]);

  // Persist geometry + open/minimised state.
  useEffect(() => {
    if (!floating || !mounted) return;
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ ...box, open, minimized }),
      );
    } catch {
      /* storage unavailable — geometry just won't persist */
    }
  }, [floating, mounted, box, open, minimized]);

  // Pointer-driven move / resize (listeners live on window so the drag keeps
  // tracking even when the cursor outruns the small window).
  useEffect(() => {
    if (!floating) return;
    function onMove(e: MouseEvent) {
      const d = dragRef.current;
      if (!d) return;
      e.preventDefault();
      const dx = e.clientX - d.sx;
      const dy = e.clientY - d.sy;
      if (d.mode === "move") {
        // Free movement anywhere in the viewport; only keep enough of the
        // window on-screen that the title bar stays grabbable.
        setBox((b) => ({
          ...b,
          x: clamp(d.ox + dx, 8, Math.max(8, window.innerWidth - 80)),
          y: clamp(d.oy + dy, 8, Math.max(8, window.innerHeight - 44)),
        }));
      } else {
        setBox((b) => ({
          ...b,
          w: clamp(
            d.ow + dx,
            WIN_MIN.w,
            Math.min(WIN_MAX.w, window.innerWidth - b.x - 12),
          ),
          h: clamp(
            d.oh + dy,
            WIN_MIN.h,
            Math.min(WIN_MAX.h, window.innerHeight - b.y - 12),
          ),
        }));
      }
    }
    function onUp() {
      if (dragRef.current) {
        dragRef.current = null;
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
      }
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [floating]);

  // Keep the window inside the viewport when the browser is resized.
  useEffect(() => {
    if (!floating) return;
    function onResize() {
      setNarrow(window.innerWidth < 1100);
      setBox((b) => ({
        ...b,
        x: clamp(b.x, 8, Math.max(8, window.innerWidth - 80)),
        y: clamp(b.y, 8, Math.max(8, window.innerHeight - 44)),
      }));
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [floating]);

  function startDrag(e: React.MouseEvent, mode: "move" | "resize") {
    if (maximized && mode === "move") return;
    dragRef.current = {
      mode,
      sx: e.clientX,
      sy: e.clientY,
      ox: box.x,
      oy: box.y,
      ow: box.w,
      oh: box.h,
    };
    document.body.style.userSelect = "none";
    document.body.style.cursor = mode === "move" ? "grabbing" : "nwse-resize";
  }

  function toggleMax() {
    if (maximized) {
      setMaximized(false);
      if (preMax.current) setBox(preMax.current);
    } else {
      preMax.current = box;
      setMaximized(true);
      setMinimized(false);
    }
  }

  // Shared title-bar identity (avatar + "Your agent · private" + name),
  // reused by the floating window and the narrow bottom sheet.
  const agentIdentity = (
    <div className="min-w-0 flex items-center gap-2">
      <div
        className={`avatar w-8 h-8 text-sm ${avatarGradClass(managedAgent.id)}`}
      >
        {managedAgent.avatar_emoji}
      </div>
      <div className="min-w-0">
        <div className="text-[10px] uppercase tracking-wider text-[color:var(--color-ink-soft)] leading-none mb-0.5 flex items-center gap-1">
          <span
            className="w-1.5 h-1.5 rounded-full bg-[color:var(--color-tint-green-ink)]"
            aria-hidden
          />
          Your assistant · private notes
        </div>
        <div className="text-[13px] font-semibold truncate">
          {managedAgent.display_name}
        </div>
      </div>
    </div>
  );

  // Shared body: the message thread + the wired composer. Only one render
  // path mounts these at a time, so reusing the same refs is safe.
  const messagesArea = (
    <div
      ref={scrollRef}
      className="flex-1 min-h-0 overflow-y-auto px-3 py-3 space-y-2"
    >
      {messages.length === 0 ? (
        <EmptyState managedName={managedAgent.display_name} />
      ) : (
        messages.map((m) => (
          <DockMessage
            key={m.id}
            message={m}
            isMine={m.from_agent_id === myExternalAgentId}
          />
        ))
      )}
    </div>
  );

  const composer = (
    <form
      action={sendAction}
      className="border-t border-[color:var(--color-line)] p-2 space-y-1.5"
      onSubmit={() => {
        // Clear local draft state on submit so the textarea visually resets
        // even if the server action's redirect rehydrates with the same
        // React state preserved by the router.
        setDraft("");
      }}
    >
      <input type="hidden" name="conversation_id" value={convId} />
      <textarea
        ref={textRef}
        name="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={`Ask ${managedAgent.display_name.split(" ")[0]}…`}
        className="input !py-1.5 !text-[13px] min-h-[52px] resize-none"
        maxLength={4000}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          // IME guard: while composing (Chinese/Japanese/Korean input), Enter
          // commits the candidate — it must NEVER send the message. keyCode
          // 229 is the legacy "IME processing" signal some browsers still use.
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          // Shift+Enter inserts a newline (default behaviour).
          if (e.shiftKey) return;
          // Plain Enter sends; ⌘/Ctrl+Enter keeps working as before.
          e.preventDefault();
          if (draft.trim().length > 0) {
            (e.currentTarget.form as HTMLFormElement)?.requestSubmit();
          }
        }}
      />
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-[color:var(--color-ink-soft)]">
          <kbd className="kbd">↵</kbd> send · <kbd className="kbd">⇧↵</kbd>{" "}
          newline
        </span>
        <button
          type="submit"
          disabled={draft.trim().length === 0}
          className="btn btn-primary btn-sm"
        >
          Send →
        </button>
      </div>
    </form>
  );

  // --- floating window -------------------------------------------------------
  if (floating) {
    if (!mounted) return null;

    // Closed → a small launcher pill that reopens the window. Bottom-right
    // when narrow, otherwise at the window's last position.
    if (!open) {
      return (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className={
            "fixed z-[55] flex items-center gap-2 panel-float !rounded-full px-3.5 py-2 pop-in hover:shadow-[var(--shadow-pop)] transition-shadow" +
            // On phones the pill sits ABOVE the chat composer (which occupies
            // the bottom ~140px) so it never covers the send controls.
            (narrow ? " right-3 bottom-36 md:bottom-3" : "")
          }
          style={narrow ? undefined : { left: box.x, top: box.y }}
          title="Chat privately with your assistant"
        >
          <span
            className={`avatar w-6 h-6 text-[11px] ${avatarGradClass(managedAgent.id)}`}
          >
            {managedAgent.avatar_emoji}
          </span>
          <span className="text-[12.5px] font-semibold">Your assistant</span>
          <span className="tag tag-violet !px-1.5 !py-0 !text-[9.5px]">
            private
          </span>
        </button>
      );
    }

    // Narrow screens → dock to a fixed bottom sheet (no drag / resize /
    // maximize). Keeps minimise + close-to-pill.
    if (narrow) {
      return (
        <div
          className={
            "fixed z-[55] panel-float flex flex-col overflow-hidden pop-in " +
            // Minimised → a compact right-anchored pill that sits ABOVE the
            // chat composer on phones (so it never blocks the send controls);
            // expanded → the full-width bottom sheet.
            (minimized
              ? "right-2.5 bottom-36 md:bottom-2.5 max-w-[300px]"
              : "left-2.5 right-2.5 bottom-2.5")
          }
          style={{ height: minimized ? "auto" : "min(58vh, 460px)" }}
          role="dialog"
          aria-label="Private chat with your assistant"
        >
          <div
            className="shrink-0 px-3.5 py-2.5 border-b border-[color:var(--color-line)] flex items-center justify-between gap-2"
            style={{ background: "var(--grad-violet)" }}
          >
            {agentIdentity}
            <div className="flex items-center gap-0.5 shrink-0">
              <WinButton
                label={minimized ? "Expand" : "Minimise"}
                onClick={() => setMinimized((v) => !v)}
              >
                {minimized ? <path d="M5 9l5 5 5-5" /> : <path d="M5 12h10" />}
              </WinButton>
              <WinButton label="Close" onClick={() => setOpen(false)}>
                <path d="M5 5l9 9M14 5l-9 9" />
              </WinButton>
            </div>
          </div>
          {!minimized ? (
            <>
              {messagesArea}
              {composer}
            </>
          ) : null}
        </div>
      );
    }

    const pos: React.CSSProperties = maximized
      ? { left: 14, top: 14, width: "calc(100% - 28px)", height: "calc(100% - 28px)" }
      : {
          left: box.x,
          top: box.y,
          width: box.w,
          height: minimized ? "auto" : box.h,
        };

    return (
      <div
        className="fixed z-[55] panel-float flex flex-col overflow-hidden pop-in"
        style={pos}
        role="dialog"
        aria-label="Private chat with your agent"
      >
        {/* Title bar = drag handle */}
        <div
          onMouseDown={(e) => startDrag(e, "move")}
          className="shrink-0 px-3.5 py-2.5 border-b border-[color:var(--color-line)] flex items-center justify-between gap-2 select-none"
          style={{
            background: "var(--grad-violet)",
            cursor: maximized ? "default" : "grab",
          }}
        >
          {agentIdentity}
          <div
            className="flex items-center gap-0.5 shrink-0"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <WinButton
              label={minimized ? "Expand" : "Minimise"}
              onClick={() => {
                setMinimized((v) => !v);
                setMaximized(false);
              }}
            >
              {minimized ? (
                <path d="M5 9l5 5 5-5" />
              ) : (
                <path d="M5 12h10" />
              )}
            </WinButton>
            <WinButton
              label={maximized ? "Restore" : "Maximise"}
              onClick={toggleMax}
            >
              {maximized ? (
                <>
                  <rect x="6" y="6" width="9" height="9" rx="1.5" />
                  <path d="M13 6V4.5A1.5 1.5 0 0 0 11.5 3h-7A1.5 1.5 0 0 0 3 4.5v7A1.5 1.5 0 0 0 4.5 13H6" />
                </>
              ) : (
                <rect x="4" y="4" width="11" height="11" rx="1.5" />
              )}
            </WinButton>
            <WinButton label="Close" onClick={() => setOpen(false)}>
              <path d="M5 5l9 9M14 5l-9 9" />
            </WinButton>
          </div>
        </div>

        {!minimized ? (
          <>
            {messagesArea}
            {composer}
          </>
        ) : null}

        {/* Resize grip */}
        {!minimized && !maximized ? (
          <div
            onMouseDown={(e) => startDrag(e, "resize")}
            title="Resize"
            className="absolute right-1 bottom-1 w-4 h-4 flex items-end justify-end text-[color:var(--color-ink-soft)]"
            style={{ cursor: "nwse-resize" }}
          >
            <svg
              width="11"
              height="11"
              viewBox="0 0 12 12"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.4}
              strokeLinecap="round"
            >
              <path d="M11 5 5 11M11 9l-2 2" />
            </svg>
          </div>
        ) : null}
      </div>
    );
  }

  // --- collapsed docked rail (legacy) ----------------------------------------
  if (collapsed && !embedded) {
    return (
      <aside
        className="shrink-0 w-11 panel-float h-full flex flex-col items-center py-3"
        aria-label="Your assistant (collapsed)"
      >
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          title="Chat privately with your assistant"
          className="btn btn-ghost btn-sm !px-1.5"
        >
          💬
        </button>
        <div
          className="text-[10px] text-[color:var(--color-ink-soft)] uppercase tracking-wider mt-2"
          style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}
        >
          Your assistant
        </div>
      </aside>
    );
  }

  // --- docked / embedded (legacy) --------------------------------------------
  return (
    <aside
      className={
        (embedded ? "w-full" : "shrink-0 w-[280px]") +
        " panel-float h-full flex flex-col overflow-hidden"
      }
    >
      <div
        className="px-3.5 py-3 border-b border-[color:var(--color-line)] flex items-center justify-between gap-2"
        style={{ background: "var(--grad-violet)" }}
      >
        <div className="min-w-0 flex items-center gap-2">
          <div className={`avatar w-8 h-8 text-sm ${avatarGradClass(managedAgent.id)}`}>
            {managedAgent.avatar_emoji}
          </div>
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-wider text-[color:var(--color-ink-soft)] leading-none mb-0.5 flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-[color:var(--color-tint-green-ink)]" aria-hidden />
              Your assistant
            </div>
            <div className="text-[13px] font-semibold truncate">
              {managedAgent.display_name}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Link
            href={`/app/c/${convId}`}
            title="Open full-screen"
            className="btn btn-ghost btn-sm !px-1.5"
          >
            ⤢
          </Link>
          {!embedded ? (
            <button
              type="button"
              onClick={() => setCollapsed(true)}
              title="Collapse"
              className="btn btn-ghost btn-sm !px-1.5"
            >
              «
            </button>
          ) : null}
        </div>
      </div>

      {messagesArea}
      {composer}
    </aside>
  );
}

/** Small monochrome window-control button (24px) used in the floating title
 *  bar. Children are the inner SVG path(s) on a 0 0 20 20 viewBox. */
function WinButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="w-6 h-6 rounded-md flex items-center justify-center text-[color:var(--color-ink-muted)] hover:bg-[color:var(--color-hover)] hover:text-[color:var(--color-ink)] transition-colors"
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 20 20"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        {children}
      </svg>
    </button>
  );
}

function EmptyState({ managedName }: { managedName: string }) {
  return (
    <div className="text-center py-6 text-[color:var(--color-ink-muted)] text-[12px] leading-relaxed">
      <div className="text-3xl mb-2">💭</div>
      <div className="font-medium text-[color:var(--color-ink)] text-[13px]">
        Think out loud with {managedName}
      </div>
      <p className="mt-1 text-[11.5px]">
        This is your private 1:1 — nothing here is visible in the group room.
        Draft handoffs, brainstorm, or just ask for a second opinion.
      </p>
    </div>
  );
}

function DockMessage({
  message,
  isMine,
}: {
  message: MessageWithRelations;
  isMine: boolean;
}) {
  if (message.deleted_at) {
    return (
      <div className="text-[11px] italic text-[color:var(--color-ink-soft)] text-center">
        (deleted)
      </div>
    );
  }
  const text = message.text || (message.thinking ? "(thinking only)" : "");
  return (
    <div className={"flex " + (isMine ? "justify-end" : "justify-start")}>
      <div
        className={
          "max-w-[230px] px-3 py-2 rounded-[14px] text-[12.5px] leading-snug whitespace-pre-wrap " +
          (isMine
            ? "bg-[color:var(--color-bubble-out)] text-white rounded-br-sm"
            : "bg-[color:var(--color-paper-faint)] border border-[color:var(--color-line)] text-[color:var(--color-ink)] rounded-bl-sm")
        }
      >
        {text}
      </div>
    </div>
  );
}
