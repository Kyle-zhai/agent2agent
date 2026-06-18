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
  Task,
  Workspace,
  WorkspaceFile,
} from "@/lib/types";
import { MessageMarkdown } from "@/components/MessageMarkdown";
import {
  HandoffPanel,
  type HandoffPeerOption,
  type HandoffWorkspaceOption,
} from "@/components/HandoffPanel";
import { HandoffCard, type HandoffCardData } from "@/components/HandoffCard";
import { avatarGradClass } from "@/lib/avatar";

// Aligned with REACTION_EMOJIS in lib/conversations.ts. v0.16 trimmed
// to 5 — the smallest palette that covers yes/no/thinking + done/blocked.
const REACTION_PALETTE = [
  "👍", "👎", "🤔", "✅", "🚧",
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
  addOwnAgent: (formData: FormData) => Promise<void>;
  requestLink: (formData: FormData) => Promise<void>;
  respondLink: (formData: FormData) => Promise<void>;
  revokeLink: (formData: FormData) => Promise<void>;
  removeMember: (formData: FormData) => Promise<void>;
  leave: (formData: FormData) => Promise<void>;
  forward: (formData: FormData) => Promise<void>;
  setPersonaOverride: (formData: FormData) => Promise<void>;
  proposeHandoff: (formData: FormData) => Promise<void>;
  respondHandoff: (formData: FormData) => Promise<void>;
  withdrawHandoff: (formData: FormData) => Promise<void>;
  completeHandoff: (formData: FormData) => Promise<void>;
};

export type AgentLinkRow = {
  id: string;
  agent_a: string;
  agent_b: string;
  conversation_id: string;
  initiated_by_user_id: string;
  status: "pending" | "accepted" | "declined" | "revoked";
  created_at: number;
  responded_at: number | null;
  responded_by_user_id: string | null;
};

type ForwardTarget = { id: string; label: string };
type FileContentPayload = {
  content?: string;
  rev?: string;
  sha?: string;
  path?: string;
};

export function ConversationView({
  conv,
  members,
  messages,
  reactionsByMessageId,
  myAgentId,
  myUserId,
  state,
  typingAgentIds,
  recentFailures,
  inviteCandidates,
  myAgentsForSelfAdd,
  agentLinks,
  workspaces,
  workspaceFiles,
  tasks,
  workspaceCount,
  primaryWorkspaceId,
  openTaskCount,
  forwardTargets,
  myManagedAgentsInRoom,
  personaOverrides,
  handoffs,
  handoffPeers,
  handoffWorkspaces,
  actions,
  error,
}: {
  conv: Conversation;
  members: Agent[];
  messages: MessageWithRelations[];
  reactionsByMessageId: Record<string, ReactionAggregate[]>;
  myAgentId: string;
  myUserId: string;
  state: ConversationState;
  typingAgentIds: string[];
  recentFailures: Array<{
    job_id: string;
    agent_id: string;
    trigger_message_id: string | null;
    last_error: string | null;
    finished_at: number | null;
  }>;
  inviteCandidates: Agent[];
  myAgentsForSelfAdd: Agent[];
  agentLinks: AgentLinkRow[];
  workspaces: Workspace[];
  workspaceFiles: WorkspaceFile[];
  tasks: Task[];
  workspaceCount: number;
  primaryWorkspaceId: string | null;
  openTaskCount: number;
  forwardTargets: ForwardTarget[];
  myManagedAgentsInRoom: Agent[];
  personaOverrides: Record<string, string>;
  handoffs: HandoffCardData[];
  handoffPeers: HandoffPeerOption[];
  handoffWorkspaces: HandoffWorkspaceOption[];
  actions: ChatActions;
  error?: string;
}) {
  const isGroupOwner =
    conv.type === "group" && conv.created_by_agent_id === myAgentId;
  const [showThinking, setShowThinking] = useState(false);
  const [replyTo, setReplyTo] = useState<MessageWithRelations | null>(null);
  const [editing, setEditing] = useState<MessageWithRelations | null>(null);
  const [showHeaderMenu, setShowHeaderMenu] = useState(false);
  const [showRename, setShowRename] = useState(false);
  const [showMembers, setShowMembers] = useState(false);
  const [showPersonas, setShowPersonas] = useState(false);
  const [showHandoff, setShowHandoff] = useState(false);
  // Image lightbox — one shared <dialog> for every inline image attachment.
  const [lightboxImage, setLightboxImage] = useState<{
    src: string;
    name: string;
  } | null>(null);
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

  const didInitialScrollRef = useRef(false);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // First mount: always jump to bottom — that's the universal chat
    // convention. Subsequent updates (SSE-triggered router.refresh): only
    // auto-scroll if the user is already near the bottom, so readers
    // scrolled up looking at history aren't yanked.
    if (!didInitialScrollRef.current) {
      didInitialScrollRef.current = true;
      el.scrollTo({ top: el.scrollHeight, behavior: "auto" });
      return;
    }
    const nearBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    }
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
          if (other.agent_kind === "managed") return `🦀 hosted · ${other.framework}`;
          if (other.last_seen_at) return `online · ${timeAgo(other.last_seen_at)}`;
          return other.id;
        })();

  const typing = typingAgentIds
    .map((id) => memberById[id])
    .filter((a): a is Agent => !!a && a.id !== myAgentId);
  const primaryWorkspace = workspaces[0] ?? null;
  const liveHandoff =
    handoffs.find((h) => h.status === "proposed") ??
    handoffs.find((h) => h.status === "accepted") ??
    handoffs[0] ??
    null;
  const connectedPairs = agentLinks.filter((l) => l.status === "accepted").length;
  const [workspaceOpen, setWorkspaceOpen] = useState(true);
  const [workspaceWidth, setWorkspaceWidth] = useState(480);
  const [isWorkspaceResizing, setIsWorkspaceResizing] = useState(false);
  const resizeRef = useRef<{
    pointerId: number;
    startX: number;
    startWidth: number;
  } | null>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem("a2a:workspace-panel");
      if (!raw) return;
      const saved = JSON.parse(raw) as { open?: boolean; width?: number };
      if (typeof saved.open === "boolean") setWorkspaceOpen(saved.open);
      if (typeof saved.width === "number") {
        setWorkspaceWidth(clampNumber(saved.width, 380, 620));
      }
    } catch {
      /* panel preferences are optional */
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(
        "a2a:workspace-panel",
        JSON.stringify({ open: workspaceOpen, width: workspaceWidth }),
      );
    } catch {
      /* panel preferences are optional */
    }
  }, [workspaceOpen, workspaceWidth]);

  useEffect(() => {
    function onMove(e: PointerEvent) {
      const current = resizeRef.current;
      if (!current) return;
      const next = current.startWidth - (e.clientX - current.startX);
      setWorkspaceWidth(clampNumber(next, 380, 620));
    }
    function onUp() {
      if (!resizeRef.current) return;
      resizeRef.current = null;
      setIsWorkspaceResizing(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, []);

  return (
    <div className="h-full flex flex-col panel-float overflow-hidden bg-[color:var(--color-paper)]">
      <header className="relative z-20 flex items-center justify-between px-5 py-3 border-b border-[color:var(--color-line)] bg-[color:var(--color-paper-strong)]/95">
        <div className="min-w-0 flex items-center gap-3">
          {conv.type === "direct" ? (
            <Avatar agent={members.find((m) => m.id !== myAgentId)} size={38} />
          ) : (
            <div className={`avatar w-9 h-9 text-base ${avatarGradClass(conv.id)}`}>
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
        {/* Action-icon row — monochrome line icons mapped to real functions
            only (workspace, tasks, handoff, members, more). */}
        <div className="flex items-center gap-0.5">
          <Link
            href={
              primaryWorkspaceId
                ? `/app/c/${conv.id}/workspace/${primaryWorkspaceId}`
                : `/app/c/${conv.id}/workspace`
            }
            className={HEADER_BTN}
            aria-label="Shared files"
            title={
              workspaceCount === 0
                ? "Create a shared file area for this room"
                : "Open the shared file area"
            }
          >
            <HdrIcon name="files" />
            {workspaceCount > 0 ? <HdrBadge n={workspaceCount} tint="violet" /> : null}
          </Link>
          <Link
            href={`/app/c/${conv.id}/tasks`}
            className={HEADER_BTN}
            aria-label="Tasks"
            title="Tasks in this conversation"
          >
            <HdrIcon name="tasks" />
            {openTaskCount > 0 ? <HdrBadge n={openTaskCount} tint="amber" /> : null}
          </Link>
          {handoffPeers.length > 0 ? (
            <button
              type="button"
              onClick={() => setShowHandoff((v) => !v)}
              className={
                HEADER_BTN +
                (showHandoff
                  ? " bg-[color:var(--color-hover)] text-[color:var(--color-ink)]"
                  : "")
              }
              aria-label="Hand off to a friend's assistant"
              title="Send work to a friend's assistant — they approve before it starts"
            >
              <HdrIcon name="handoff" />
              {handoffs.some(
                (h) => h.status === "proposed" && h.to_user_id === myUserId,
              ) ? (
                <span
                  className="absolute top-1 right-1 w-2 h-2 rounded-full bg-[color:var(--color-danger)]"
                  aria-hidden
                />
              ) : null}
            </button>
          ) : null}
          {conv.type === "group" ? (
            <button
              type="button"
              onClick={() => setShowMembers((v) => !v)}
              className={
                HEADER_BTN +
                (showMembers
                  ? " bg-[color:var(--color-hover)] text-[color:var(--color-ink)]"
                  : "")
              }
              aria-label={`Members (${members.length})`}
              title={`Members of this group (${members.length})`}
            >
              <HdrIcon name="members" />
              {members.length > 0 ? <HdrBadge n={members.length} tint="neutral" /> : null}
            </button>
          ) : null}
          <div className="relative">
            <button
              type="button"
              onClick={() => setShowHeaderMenu((v) => !v)}
              className={HEADER_BTN}
              aria-label="Conversation menu"
            >
              <HdrIcon name="dots" />
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
                ) : null}
                {conv.type === "group" ? (
                  // v0.14: members panel is useful for any member (self-add,
                  // request interconnect). The bar itself conditionally renders
                  // owner-only forms — the panel is safe for non-owners.
                  <button
                    type="button"
                    onClick={() => {
                      setShowHeaderMenu(false);
                      setShowMembers(true);
                    }}
                    className="w-full text-left px-3 py-1.5 text-sm hover:bg-[color:var(--color-canvas)] flex items-center gap-2"
                  >
                    <span>👥</span>
                    <span>
                      {isGroupOwner
                        ? "Manage members"
                        : "Members & connections"}
                    </span>
                  </button>
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
                    <span>Instructions for this chat</span>
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
          myAgentsForSelfAdd={myAgentsForSelfAdd}
          myUserId={myUserId}
          agentLinks={agentLinks}
          addAction={actions.addMember}
          addOwnAgentAction={actions.addOwnAgent}
          requestLinkAction={actions.requestLink}
          respondLinkAction={actions.respondLink}
          revokeLinkAction={actions.revokeLink}
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

      {showHandoff ? (
        <div className="bg-[color:var(--color-tint-amber)]/30 border-b border-[color:var(--color-line)] px-5 py-3">
          <HandoffPanel
            convId={conv.id}
            myAgentId={myAgentId}
            peers={handoffPeers}
            workspaces={handoffWorkspaces}
            proposeAction={actions.proposeHandoff}
            onClose={() => setShowHandoff(false)}
          />
        </div>
      ) : null}

      <div className="flex-1 min-h-0 flex bg-[linear-gradient(180deg,#fff_0%,#fbfbfc_100%)]">
        <div className="flex-1 min-w-0 flex flex-col">
          <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-4 sm:px-6 py-5">
            <div className="max-w-4xl mx-auto space-y-1">
              {handoffs.length > 0 ? (
                <HandoffStrip
                  handoffs={handoffs}
                  myUserId={myUserId}
                  memberById={memberById}
                  respondAction={actions.respondHandoff}
                  withdrawAction={actions.withdrawHandoff}
                  completeAction={actions.completeHandoff}
                />
              ) : null}
              {messages.length === 0 ? (
                <EmptyState
                  memberCount={members.length}
                  canHandoff={handoffPeers.length > 0}
                  onOpenHandoff={() => setShowHandoff(true)}
                />
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
                  setLightboxImage,
                )
              )}
              {typing.length > 0 ? <TypingRow agents={typing} /> : null}
              {recentFailures.length > 0 ? (
                <FailedRepliesRow
                  failures={recentFailures}
                  memberById={memberById}
                />
              ) : null}
            </div>
          </div>

          <Composer
            conv={conv}
            myAgent={myAgent}
            members={members}
            send={actions.send}
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

        {workspaceOpen ? (
          <>
            <button
              type="button"
              aria-label="Resize workspace panel"
              title="Drag to resize workspace"
              onPointerDown={(e) => {
                resizeRef.current = {
                  pointerId: e.pointerId,
                  startX: e.clientX,
                  startWidth: workspaceWidth,
                };
                e.currentTarget.setPointerCapture(e.pointerId);
                setIsWorkspaceResizing(true);
                document.body.style.cursor = "col-resize";
                document.body.style.userSelect = "none";
              }}
              className={
                "hidden min-[1180px]:flex w-3 shrink-0 cursor-col-resize items-center justify-center bg-transparent transition-colors " +
                (isWorkspaceResizing
                  ? "bg-[color:var(--color-tint-violet)]/45"
                  : "hover:bg-[color:var(--color-tint-violet)]/35")
              }
            >
              <span className="h-12 w-1 rounded-full bg-[color:var(--color-line-strong)]/70" />
            </button>
            <WorkspaceStatusRail
              convId={conv.id}
              workspace={primaryWorkspace}
              files={workspaceFiles}
              tasks={tasks}
              members={members}
              connectedPairs={connectedPairs}
              liveHandoff={liveHandoff}
              openTaskCount={openTaskCount}
              primaryWorkspaceId={primaryWorkspaceId}
              width={workspaceWidth}
              onHide={() => setWorkspaceOpen(false)}
            />
          </>
        ) : (
          <button
            type="button"
            onClick={() => setWorkspaceOpen(true)}
            className="hidden min-[1180px]:flex w-10 shrink-0 items-center justify-center border-l border-[color:var(--color-line)] bg-[color:var(--color-paper-strong)] text-[color:var(--color-ink-soft)] hover:text-[color:var(--color-ink)] hover:bg-[color:var(--color-paper-faint)] transition-colors"
            title="Show workspace"
            aria-label="Show workspace"
          >
            <span className="rotate-90 text-[11px] uppercase tracking-[0.12em] font-semibold">
              Workspace
            </span>
          </button>
        )}
      </div>

      <ImageLightbox
        image={lightboxImage}
        onClose={() => setLightboxImage(null)}
      />
    </div>
  );
}

function WorkspaceStatusRail({
  convId,
  workspace,
  files,
  tasks,
  members,
  connectedPairs,
  liveHandoff,
  openTaskCount,
  primaryWorkspaceId,
  width,
  onHide,
}: {
  convId: string;
  workspace: Workspace | null;
  files: WorkspaceFile[];
  tasks: Task[];
  members: Agent[];
  connectedPairs: number;
  liveHandoff: HandoffCardData | null;
  openTaskCount: number;
  primaryWorkspaceId: string | null;
  width: number;
  onHide: () => void;
}) {
  const openTasks = tasks.filter(
    (t) => t.status !== "done" && t.status !== "cancelled",
  );
  const visibleTasks = openTasks.length > 0 ? openTasks : tasks;
  const workspaceHref = primaryWorkspaceId
    ? `/app/c/${convId}/workspace/${primaryWorkspaceId}`
    : `/app/c/${convId}/workspace`;
  const selectedFile =
    files.find((f) => f.path.endsWith(".csv")) ??
    files.find((f) => f.path.endsWith(".md")) ??
    files[0] ??
    null;
  const [selectedPath, setSelectedPath] = useState<string | null>(
    selectedFile?.path ?? null,
  );
  const [fileQuery, setFileQuery] = useState("");
  const activeFile =
    files.find((f) => f.path === selectedPath) ?? selectedFile ?? null;
  const treeFiles = useMemo(() => {
    const q = fileQuery.trim().toLowerCase();
    return q ? files.filter((file) => file.path.toLowerCase().includes(q)) : files;
  }, [fileQuery, files]);
  const fileTree = useMemo(() => buildWorkspaceTree(treeFiles), [treeFiles]);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(
    () => new Set(files.map((file) => file.path.split("/")[0]).filter(Boolean)),
  );
  const [fileState, setFileState] = useState<{
    path: string;
    loading: boolean;
    error: string | null;
    content: string | null;
    objectUrl?: string;
    kind?: WorkspacePreviewKind;
    mime?: string;
    rev?: string;
    sha?: string;
  }>({
    path: activeFile?.path ?? "",
    loading: false,
    error: null,
    content: null,
  });

  useEffect(() => {
    if (!selectedPath && selectedFile) setSelectedPath(selectedFile.path);
  }, [selectedPath, selectedFile]);

  useEffect(() => {
    if (!activeFile || !workspace) {
      setFileState({
        path: "",
        loading: false,
        error: null,
        content: null,
      });
      return;
    }
    const controller = new AbortController();
    let objectUrl: string | null = null;
    const kind = workspacePreviewKind(activeFile.path);
    const encodedPath = activeFile.path
      .split("/")
      .map(encodeURIComponent)
      .join("/");
    setFileState({
      path: activeFile.path,
      loading: true,
      error: null,
      content: null,
      kind,
      mime: workspaceFileMime(activeFile.path),
    });
    const endpoint = `/api/v1/workspaces/${workspace.id}/files/${encodedPath}`;
    const run = async () => {
      if (kind === "image" || kind === "pdf") {
        const res = await fetch(`${endpoint}?raw=1`, {
          signal: controller.signal,
          headers: { accept: "application/octet-stream" },
        });
        if (!res.ok) throw new Error("Could not read file.");
        const rev = res.headers.get("x-workspace-rev") ?? undefined;
        const sha = res.headers.get("x-content-sha256") ?? undefined;
        const bytes = await res.arrayBuffer();
        const blob = new Blob([bytes], { type: workspaceFileMime(activeFile.path) });
        objectUrl = URL.createObjectURL(blob);
        setFileState({
          path: activeFile.path,
          loading: false,
          error: null,
          content: null,
          objectUrl,
          kind,
          mime: blob.type,
          rev,
          sha,
        });
        return;
      }

      if (kind === "binary") {
        setFileState({
          path: activeFile.path,
          loading: false,
          error: null,
          content: null,
          kind,
          mime: workspaceFileMime(activeFile.path),
        });
        return;
      }

      const res = await fetch(endpoint, {
        signal: controller.signal,
        headers: { accept: "application/json" },
      });
      const body = (await res.json()) as
        | {
            ok?: true;
            data?: FileContentPayload;
            content?: string;
            rev?: string;
            sha?: string;
          }
        | { ok?: false; error?: string };
      if (!res.ok || body.ok === false) {
        throw new Error(
          "error" in body && body.error ? body.error : "Could not read file.",
        );
      }
      const data: FileContentPayload =
        "data" in body && body.data
          ? body.data
          : {
              content: "content" in body ? body.content : "",
              rev: "rev" in body ? body.rev : undefined,
              sha: "sha" in body ? body.sha : undefined,
            };
      setFileState({
        path: activeFile.path,
        loading: false,
        error: null,
        content: data.content ?? "",
        kind,
        mime: workspaceFileMime(activeFile.path),
        rev: data.rev,
        sha: data.sha,
      });
    };

    run().catch((err) => {
      if (controller.signal.aborted) return;
      setFileState({
        path: activeFile.path,
        loading: false,
        error: err instanceof Error ? err.message : "Could not read file.",
        content: null,
        kind,
        mime: workspaceFileMime(activeFile.path),
      });
    });

    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [activeFile, workspace]);

  function toggleFolder(path: string) {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  return (
    <aside
      className="hidden min-[1180px]:flex shrink-0 flex-col border-l border-[color:var(--color-line)] bg-[color:var(--color-paper-strong)] overflow-hidden"
      style={{ width }}
    >
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-[color:var(--color-line)]">
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-[0.12em] font-semibold text-[color:var(--color-ink-soft)]">
            Workspace
          </div>
          <h3 className="mt-1 text-[15px] font-semibold tracking-tight truncate">
            {workspace?.name ?? "Shared files"}
          </h3>
        </div>
        <div className="flex items-center gap-1.5">
          <Link href={workspaceHref} className="btn btn-secondary btn-sm">
            Full view
          </Link>
          <button
            type="button"
            onClick={onHide}
            className="w-8 h-8 rounded-lg inline-flex items-center justify-center text-[color:var(--color-ink-soft)] hover:text-[color:var(--color-ink)] hover:bg-[color:var(--color-hover)]"
            title="Hide workspace"
            aria-label="Hide workspace"
          >
            ×
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="px-4 py-3 grid grid-cols-3 gap-2 border-b border-[color:var(--color-line)]">
          <MiniMetric label="Files" value={String(files.length)} />
          <MiniMetric label="Tasks" value={String(openTaskCount)} tone="amber" />
          <MiniMetric
            label="Scope"
            value={connectedPairs > 0 ? `${connectedPairs} linked` : "manual"}
            tone={connectedPairs > 0 ? "green" : "violet"}
          />
        </div>

        <section className="p-4">
          <div className="rounded-[22px] border border-[color:var(--color-line)] bg-[color:var(--color-paper)] overflow-hidden shadow-[0_16px_44px_-36px_rgba(22,22,40,.5)]">
            <div className="flex items-center justify-between gap-2 px-3.5 py-3 border-b border-[color:var(--color-line)]">
              <div className="min-w-0">
                <div className="text-[10px] uppercase tracking-[0.12em] font-semibold text-[color:var(--color-ink-soft)]">
                  Preview
                </div>
                <div className="mt-0.5 text-[13px] font-semibold truncate">
                  {activeFile?.path ?? "No file selected"}
                </div>
              </div>
              <span className="tag tag-violet !text-[10px] !py-0.5">
                {workspace ? "live" : "empty"}
              </span>
            </div>

            <div className="grid grid-cols-[minmax(132px,38%)_minmax(0,1fr)] min-h-[330px]">
              <div className="border-r border-[color:var(--color-line)] bg-[color:var(--color-paper-faint)]/60 px-2 py-2">
                <div className="flex items-center justify-between gap-2 px-1.5 py-1">
                  <div className="text-[10px] uppercase tracking-[0.12em] font-semibold text-[color:var(--color-ink-soft)]">
                    Project
                  </div>
                  <span className="text-[10px] font-medium text-[color:var(--color-ink-soft)]">
                    {files.length}
                  </span>
                </div>
                <label className="sr-only" htmlFor="workspace-file-filter">
                  Filter workspace files
                </label>
                <input
                  id="workspace-file-filter"
                  value={fileQuery}
                  onChange={(e) => setFileQuery(e.target.value)}
                  placeholder="Find file"
                  className="mt-1 w-full rounded-lg border border-[color:var(--color-line)] bg-white/80 px-2 py-1.5 text-[11px] outline-none focus:border-[color:var(--color-ink-soft)]"
                />
                <div className="mt-1 space-y-0.5">
                  <WorkspaceFileTree
                    nodes={fileTree.children}
                    activePath={activeFile?.path ?? null}
                    expandedFolders={expandedFolders}
                    forceOpen={fileQuery.trim().length > 0}
                    onToggleFolder={toggleFolder}
                    onSelectFile={setSelectedPath}
                  />
                  {treeFiles.length === 0 && fileQuery.trim() ? (
                    <div className="px-1.5 py-3 text-[12px] text-[color:var(--color-ink-soft)]">
                      No files match.
                    </div>
                  ) : null}
                </div>
              </div>

              <div className="min-w-0 p-3.5">
                {activeFile ? (
                  <FilePreview
                    key={activeFile.path}
                    file={activeFile}
                    state={fileState}
                    downloadHref={
                      workspace
                        ? `/api/v1/workspaces/${workspace.id}/files/${activeFile.path
                            .split("/")
                            .map(encodeURIComponent)
                            .join("/")}?download=1`
                        : undefined
                    }
                  />
                ) : (
                  <div className="h-full min-h-[220px] flex items-center justify-center text-center text-[12px] text-[color:var(--color-ink-muted)]">
                    Shared workspace artifacts will appear here.
                  </div>
                )}
              </div>
            </div>
          </div>
        </section>

        <div className="px-4 pb-4 grid grid-cols-1 2xl:grid-cols-2 gap-3">
          <section className="rounded-2xl border border-[color:var(--color-line)] bg-[color:var(--color-paper)] p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="text-[10px] uppercase tracking-[0.12em] font-semibold text-[color:var(--color-ink-soft)]">
                Access
              </div>
              <span className="tag tag-violet !text-[10px] !py-0.5">shared</span>
            </div>
            <div className="mt-2 flex -space-x-2">
              {members.slice(0, 7).map((m) => (
                <div
                  key={m.id}
                  className="rounded-full ring-2 ring-white"
                  title={m.id}
                >
                  <Avatar agent={m} size={28} />
                </div>
              ))}
            </div>
            <div className="mt-3 space-y-1.5">
              <StatusRow label="Assistants" value={`${members.length} in room`} />
              <StatusRow
                label="Connections"
                value={connectedPairs > 0 ? `${connectedPairs} linked` : "manual only"}
                tone={connectedPairs > 0 ? "green" : "neutral"}
              />
            </div>
          </section>

          <section className="rounded-2xl border border-[color:var(--color-line)] bg-[color:var(--color-paper)] p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="text-[10px] uppercase tracking-[0.12em] font-semibold text-[color:var(--color-ink-soft)]">
                Live handoff
              </div>
              <span className={statusTagClass(liveHandoff?.status ?? "open")}>
                {liveHandoff ? handoffStatusLabel(liveHandoff.status) : "quiet"}
              </span>
            </div>
            <div className="mt-2 text-[13px] font-semibold line-clamp-2">
              {liveHandoff?.title ?? "No active handoff"}
            </div>
            <p className="mt-1.5 text-[12px] leading-relaxed text-[color:var(--color-ink-muted)] line-clamp-3">
              {liveHandoff?.brief ??
                "Handoff proposals and grants will stay visible while work moves between assistants."}
            </p>
          </section>
        </div>

        <section className="mx-4 mb-4 rounded-2xl border border-[color:var(--color-line)] bg-[color:var(--color-paper)] overflow-hidden">
          <div className="px-3.5 py-3 flex items-center justify-between">
            <div>
              <div className="text-[10px] uppercase tracking-[0.12em] font-semibold text-[color:var(--color-ink-soft)]">
                Tasks in flight
              </div>
              <div className="mt-1 text-[13px] text-[color:var(--color-ink-muted)]">
                {openTaskCount} waiting on work or review
              </div>
            </div>
            <Link
              href={`/app/c/${convId}/tasks`}
              className="text-[12px] font-medium text-[color:var(--color-ink)] hover:underline underline-offset-2 shrink-0 whitespace-nowrap"
            >
              View all
            </Link>
          </div>
          <div className="divide-y divide-[color:var(--color-line)]">
            {visibleTasks.slice(0, 3).map((task) => (
              <Link
                key={task.id}
                href={`/app/c/${convId}/tasks/${task.id}`}
                className="block px-3.5 py-2.5 hover:bg-[color:var(--color-hover)] transition-colors"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[12.5px] font-medium truncate">
                    {task.title}
                  </span>
                  <span className={statusTagClass(task.status)}>
                    {taskStatusLabel(task.status)}
                  </span>
                </div>
                <div className="mt-1 text-[11px] text-[color:var(--color-ink-soft)] truncate">
                  {task.assigned_to_agent_id
                    ? `Assigned to ${task.assigned_to_agent_id}`
                    : "Unassigned"}
                </div>
              </Link>
            ))}
            {visibleTasks.length === 0 ? (
              <div className="px-3.5 py-4 text-[12px] text-[color:var(--color-ink-muted)]">
                No tasks yet. Use <span className="kbd">/task</span> in chat to create one.
              </div>
            ) : null}
          </div>
        </section>
      </div>
    </aside>
  );
}

type WorkspaceTreeNode = {
  name: string;
  path: string;
  children: WorkspaceTreeNode[];
  file?: WorkspaceFile;
};

function WorkspaceFileTree({
  nodes,
  activePath,
  expandedFolders,
  forceOpen,
  onToggleFolder,
  onSelectFile,
  depth = 0,
}: {
  nodes: WorkspaceTreeNode[];
  activePath: string | null;
  expandedFolders: Set<string>;
  forceOpen: boolean;
  onToggleFolder: (path: string) => void;
  onSelectFile: (path: string) => void;
  depth?: number;
}) {
  if (nodes.length === 0) {
    return (
      <div className="px-1.5 py-2 text-[12px] text-[color:var(--color-ink-soft)]">
        No files yet.
      </div>
    );
  }

  return (
    <div className={depth === 0 ? "space-y-0.5" : "space-y-0.5"}>
      {nodes.map((node) => {
        if (node.file) {
          const active = activePath === node.file.path;
          return (
            <button
              key={node.path}
              type="button"
              onClick={() => onSelectFile(node.file!.path)}
              aria-pressed={active}
              className={
                "group w-full flex items-center gap-1.5 rounded-lg py-1.5 pr-1.5 text-[12px] transition-colors text-left " +
                (active
                  ? "bg-white shadow-[inset_0_0_0_1px_var(--color-line)] text-[color:var(--color-ink)]"
                  : "text-[color:var(--color-ink-muted)] hover:bg-white/70")
              }
              style={{ paddingLeft: 6 + depth * 12 }}
              title={node.file.path}
            >
              <span className="min-w-8 text-[10px] font-semibold text-[color:var(--color-tint-green-ink)]">
                {fileExt(node.file.path)}
              </span>
              <span className="truncate">{node.name}</span>
              <span className="ml-auto text-[10px] text-[color:var(--color-ink-soft)] opacity-0 group-hover:opacity-100">
                {formatBytes(node.file.size_bytes)}
              </span>
            </button>
          );
        }

        const count = countTreeFiles(node);
        const open = forceOpen || expandedFolders.has(node.path);
        return (
          <div key={node.path}>
            <button
              type="button"
              onClick={() => onToggleFolder(node.path)}
              aria-expanded={open}
              className="w-full flex items-center gap-1.5 rounded-lg py-1.5 pr-1.5 text-[12px] text-[color:var(--color-ink-muted)] hover:bg-white/70 transition-colors text-left"
              style={{ paddingLeft: 6 + depth * 12 }}
              title={`${node.path} · ${count} file${count === 1 ? "" : "s"}`}
            >
              <span className="w-3 text-[10px] text-[color:var(--color-ink-soft)]">
                {open ? "▾" : "▸"}
              </span>
              <span className="truncate font-medium text-[color:var(--color-ink)]">
                {node.name}
              </span>
              <span className="ml-auto rounded-full bg-white/80 px-1.5 py-0.5 text-[10px] text-[color:var(--color-ink-soft)]">
                {count}
              </span>
            </button>
            {open ? (
              <WorkspaceFileTree
                nodes={node.children}
                activePath={activePath}
                expandedFolders={expandedFolders}
                forceOpen={forceOpen}
                onToggleFolder={onToggleFolder}
                onSelectFile={onSelectFile}
                depth={depth + 1}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function MiniMetric({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: "neutral" | "violet" | "green" | "amber";
}) {
  const color =
    tone === "green"
      ? "text-[color:var(--color-tint-green-ink)]"
      : tone === "amber"
        ? "text-[color:var(--color-tint-amber-ink)]"
        : tone === "violet"
          ? "text-[color:var(--color-tint-violet-ink)]"
          : "text-[color:var(--color-ink)]";
  return (
    <div className="rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-paper)] px-3 py-2">
      <div className="text-[10px] uppercase tracking-[0.1em] font-semibold text-[color:var(--color-ink-soft)]">
        {label}
      </div>
      <div className={`mt-1 text-[14px] font-semibold ${color}`}>{value}</div>
    </div>
  );
}

function FilePreview({
  file,
  state,
  downloadHref,
}: {
  file: WorkspaceFile;
  state: {
    path: string;
    loading: boolean;
    error: string | null;
    content: string | null;
    objectUrl?: string;
    kind?: WorkspacePreviewKind;
    mime?: string;
    rev?: string;
    sha?: string;
  };
  downloadHref?: string;
}) {
  if (state.loading) {
    return (
      <div>
        <FileHeader file={file} state={state} downloadHref={downloadHref} />
        <div className="mt-3 space-y-2">
          <div className="skeleton-line h-8 w-full" />
          <div className="skeleton-line h-8 w-[92%]" />
          <div className="skeleton-line h-8 w-[80%]" />
        </div>
      </div>
    );
  }

  if (state.error) {
    return (
      <div>
        <FileHeader file={file} state={state} downloadHref={downloadHref} />
        <div className="mt-3 rounded-xl border border-[color:var(--color-danger)]/20 bg-[color:var(--color-danger-tint)]/60 px-3 py-3 text-[12px] text-[color:var(--color-danger)]">
          {state.error}
        </div>
      </div>
    );
  }

  const content = state.content ?? "";
  const kind = state.kind ?? workspacePreviewKind(file.path);

  if (kind === "image") {
    return (
      <div>
        <FileHeader file={file} state={state} downloadHref={downloadHref} />
        <div className="mt-3 rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-paper-faint)] p-2">
          {state.objectUrl ? (
            <img
              src={state.objectUrl}
              alt={file.path}
              className="max-h-[280px] w-full rounded-lg object-contain bg-white"
            />
          ) : (
            <div className="h-[180px] rounded-lg bg-white grid place-items-center text-[12px] text-[color:var(--color-ink-soft)]">
              Image preview unavailable.
            </div>
          )}
        </div>
      </div>
    );
  }

  if (kind === "pdf") {
    return (
      <div>
        <FileHeader file={file} state={state} downloadHref={downloadHref} />
        <div className="mt-3 overflow-hidden rounded-xl border border-[color:var(--color-line)] bg-white">
          {state.objectUrl ? (
            <object
              data={state.objectUrl}
              type="application/pdf"
              className="h-[280px] w-full"
            >
              <div className="p-4 text-[12px] text-[color:var(--color-ink-muted)]">
                PDF preview is not available in this browser.
              </div>
            </object>
          ) : (
            <div className="p-4 text-[12px] text-[color:var(--color-ink-muted)]">
              PDF preview is not available.
            </div>
          )}
        </div>
      </div>
    );
  }

  if (kind === "binary") {
    return (
      <div>
        <FileHeader file={file} state={state} downloadHref={downloadHref} />
        <div className="mt-3 rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-paper-faint)] px-3 py-4">
          <div className="text-[12.5px] font-medium text-[color:var(--color-ink)]">
            Preview not available for this file type.
          </div>
          <p className="mt-1 text-[12px] leading-relaxed text-[color:var(--color-ink-muted)]">
            {fileExt(file.path)} files can still be downloaded safely. Inline
            preview is limited to images, PDF, Markdown, CSV, JSON, SQL, code,
            and plain text.
          </p>
        </div>
      </div>
    );
  }

  if (kind === "csv") {
    const csv = parseCsvPreview(content);
    return (
      <div>
        <FileHeader file={file} state={state} downloadHref={downloadHref} />
        <div className="mt-3 max-h-[270px] overflow-auto rounded-xl border border-[color:var(--color-line)] bg-white">
          <table className="w-full min-w-[360px] text-[11px]">
            <thead className="bg-[color:var(--color-paper-faint)] text-[color:var(--color-ink-muted)]">
              <tr>
                {csv.header.map((h, i) => (
                  <th
                    key={i}
                    className="sticky top-0 z-10 bg-[color:var(--color-paper-faint)] text-left font-medium px-2 py-2 whitespace-nowrap"
                  >
                    {h || `column ${i + 1}`}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-[color:var(--color-line)]">
              {csv.rows.map((row, ri) => (
                <tr key={ri}>
                  {row.map((cell, ci) => (
                    <td
                      key={ci}
                      className={
                        "px-2 py-2 truncate " +
                        (looksPositiveDelta(cell)
                          ? "text-[color:var(--color-tint-green-ink)]"
                          : looksNegativeDelta(cell)
                            ? "text-[color:var(--color-danger)]"
                            : "")
                      }
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {csv.truncated ? (
            <div className="px-2 py-1.5 text-[10px] text-[color:var(--color-ink-soft)] border-t border-[color:var(--color-line)]">
              Showing first {csv.rows.length} rows.
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div>
      <FileHeader file={file} state={state} downloadHref={downloadHref} />
      {kind === "markdown" ? (
        <div className="mt-3 max-h-[270px] overflow-y-auto rounded-xl border border-[color:var(--color-line)] bg-white px-3 py-3 text-[12.5px] leading-[1.7]">
          <MessageMarkdown text={content || "_Empty file_"} memberHandles={[]} />
        </div>
      ) : (
        <pre className="mt-3 max-h-[270px] overflow-auto rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-paper-faint)] p-3 font-mono text-[11px] leading-relaxed text-[color:var(--color-ink-muted)] whitespace-pre-wrap">
          {content || "Empty file"}
        </pre>
      )}
    </div>
  );
}

function FileHeader({
  file,
  state,
  downloadHref,
}: {
  file: WorkspaceFile;
  state: { rev?: string; sha?: string };
  downloadHref?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="text-[13px] font-semibold truncate">{fName(file.path)}</div>
        <div className="mt-0.5 text-[11px] text-[color:var(--color-ink-soft)] truncate">
          {file.path} · {formatBytes(file.size_bytes)}
          {state.rev ? ` · rev ${state.rev.slice(0, 8)}` : ""}
        </div>
        {state.sha ? (
          <div className="mt-1 text-[10px] font-mono text-[color:var(--color-ink-soft)] truncate">
            sha {state.sha.slice(0, 12)}
          </div>
        ) : null}
      </div>
      <div className="flex items-center gap-1.5">
        <span className="tag !text-[10px] !py-0.5">{fileExt(file.path)}</span>
        {downloadHref ? (
          <a
            href={downloadHref}
            className="tag !text-[10px] !py-0.5 hover:bg-[color:var(--color-hover)]"
          >
            Download
          </a>
        ) : null}
      </div>
    </div>
  );
}

function StatusRow({
  label,
  value,
  href,
  tone = "neutral",
}: {
  label: string;
  value: string;
  href?: string;
  tone?: "neutral" | "violet" | "green";
}) {
  const content = (
    <>
      <span className="text-[11px] text-[color:var(--color-ink-soft)]">
        {label}
      </span>
      <span
        className={
          "text-[12px] font-medium truncate " +
          (tone === "violet"
            ? "text-[color:var(--color-tint-violet-ink)]"
            : tone === "green"
              ? "text-[color:var(--color-tint-green-ink)]"
              : "text-[color:var(--color-ink)]")
        }
      >
        {value}
      </span>
    </>
  );
  const cls =
    "flex items-center justify-between gap-3 px-3 py-2 border-b last:border-b-0 border-[color:var(--color-line)]";
  return href ? (
    <Link href={href} className={cls + " hover:bg-[color:var(--color-hover)]"}>
      {content}
    </Link>
  ) : (
    <div className={cls}>{content}</div>
  );
}

function statusTagClass(status: string): string {
  if (status === "done" || status === "accepted" || status === "completed") {
    return "tag tag-green !text-[10px] !py-0.5";
  }
  if (
    status === "awaiting_review" ||
    status === "changes_requested" ||
    status === "proposed"
  ) {
    return "tag tag-amber !text-[10px] !py-0.5";
  }
  if (status === "in_progress" || status === "assigned") {
    return "tag tag-blue !text-[10px] !py-0.5";
  }
  return "tag !text-[10px] !py-0.5";
}

function taskStatusLabel(status: Task["status"]): string {
  return status.replaceAll("_", " ");
}

function handoffStatusLabel(status: HandoffCardData["status"]): string {
  return status.replaceAll("_", " ");
}

type WorkspacePreviewKind =
  | "markdown"
  | "csv"
  | "json"
  | "text"
  | "image"
  | "pdf"
  | "binary";

function workspacePreviewKind(path: string): WorkspacePreviewKind {
  const ext = (path.split(".").pop() ?? "").toLowerCase();
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "csv" || ext === "tsv") return "csv";
  if (ext === "json") return "json";
  if (
    [
      "txt",
      "log",
      "sql",
      "ts",
      "tsx",
      "js",
      "jsx",
      "css",
      "html",
      "xml",
      "yml",
      "yaml",
      "sh",
      "py",
    ].includes(ext)
  ) {
    return "text";
  }
  if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)) return "image";
  if (ext === "pdf") return "pdf";
  return "binary";
}

function workspaceFileMime(path: string): string {
  const ext = (path.split(".").pop() ?? "").toLowerCase();
  return (
    {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
      svg: "image/svg+xml",
      pdf: "application/pdf",
      json: "application/json",
      csv: "text/csv",
      tsv: "text/tab-separated-values",
      md: "text/markdown",
      markdown: "text/markdown",
      txt: "text/plain",
      log: "text/plain",
      sql: "text/plain",
    }[ext] ?? "application/octet-stream"
  );
}

function buildWorkspaceTree(files: WorkspaceFile[]): WorkspaceTreeNode {
  const root: WorkspaceTreeNode = { name: "root", path: "", children: [] };
  for (const file of files) {
    const parts = file.path.split("/").filter(Boolean);
    let current = root;
    parts.forEach((part, index) => {
      const path = parts.slice(0, index + 1).join("/");
      const isFile = index === parts.length - 1;
      let next = current.children.find((child) => child.name === part);
      if (!next) {
        next = {
          name: part,
          path,
          children: [],
          file: isFile ? file : undefined,
        };
        current.children.push(next);
      }
      if (isFile) next.file = file;
      current = next;
    });
  }
  sortWorkspaceTree(root);
  return root;
}

function sortWorkspaceTree(node: WorkspaceTreeNode) {
  node.children.sort((a, b) => {
    if (!!a.file !== !!b.file) return a.file ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
  node.children.forEach(sortWorkspaceTree);
}

function countTreeFiles(node: WorkspaceTreeNode): number {
  if (node.file) return 1;
  return node.children.reduce((total, child) => total + countTreeFiles(child), 0);
}

function fileExt(path: string): string {
  const name = path.split("/").pop() ?? path;
  const ext = name.includes(".") ? name.split(".").pop() ?? "" : "";
  return (ext || "file").slice(0, 4).toUpperCase();
}

function fName(path: string): string {
  return path.split("/").pop() ?? path;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function parseCsvPreview(text: string): {
  header: string[];
  rows: string[][];
  truncated: boolean;
} {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const parsed = lines.slice(0, 13).map(parseCsvLine);
  const header = parsed[0] ?? ["value"];
  return {
    header,
    rows: parsed.slice(1, 9).map((row) =>
      Array.from({ length: header.length }, (_, i) => row[i] ?? ""),
    ),
    truncated: lines.length > 9,
  };
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (ch === "," && !quoted) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function looksPositiveDelta(value: string): boolean {
  return /^\+/.test(value.trim()) || /^-\d/.test(value.trim());
}

function looksNegativeDelta(value: string): boolean {
  return /^-\d/.test(value.trim()) && !value.includes("%");
}

// Built-in persona starter packs — keep aligned with PERSONA_TEMPLATES in
// lib/managed-agents.ts. We don't import that file (server-only) so we
// inline the prose. If the server templates change, mirror them here.
const PERSONA_PRESETS: Array<{ key: string; emoji: string; label: string; prompt: string }> = [
  {
    key: "concise",
    emoji: "✂️",
    label: "Concise",
    prompt:
      "In this conversation, keep every reply under three short paragraphs. Cut filler. Lead with the answer; reasoning second.",
  },
  {
    key: "reviewer",
    emoji: "🔬",
    label: "Skeptical reviewer",
    prompt:
      "In this conversation, act as a skeptical reviewer. Look for failure modes, risky assumptions, and missing edge cases. Never be sycophantic.",
  },
  {
    key: "pm",
    emoji: "🗒️",
    label: "PM coordinator",
    prompt:
      "In this conversation, behave like a PM. Summarize what's decided, name owners, surface unresolved questions, and ask one focused question at a time.",
  },
  {
    key: "designer",
    emoji: "🎨",
    label: "Design eye",
    prompt:
      "In this conversation, evaluate everything through a UX lens. Prioritize clarity over cleverness. Trace the user journey and flag accidental complexity.",
  },
  {
    key: "coder",
    emoji: "💻",
    label: "Pair programmer",
    prompt:
      "In this conversation, act as a pair programmer. Find the smallest correct change, name trade-offs explicitly, and propose patches in concrete diff terms.",
  },
  {
    key: "clear",
    emoji: "🧽",
    label: "Reset",
    prompt: "",
  },
];

function PersonaTemplateChips({
  agentId,
  disabled,
}: {
  agentId: string;
  disabled?: boolean;
}) {
  if (disabled) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      <span className="text-[10px] uppercase tracking-wider text-[color:var(--color-ink-soft)] self-center mr-1">
        Templates
      </span>
      {PERSONA_PRESETS.map((p) => (
        <button
          key={p.key}
          type="button"
          title={p.prompt || "Clears the box — your assistant goes back to its usual instructions."}
          onClick={() => {
            const el = document.getElementById(
              `persona-textarea-${agentId}`,
            ) as HTMLTextAreaElement | null;
            if (el) {
              // Use the native setter so React's controlled-component state
              // observers (which dispatch synthetic events on value change)
              // see the update. Without this React reverts the value on the
              // next render.
              const nativeSet = Object.getOwnPropertyDescriptor(
                HTMLTextAreaElement.prototype,
                "value",
              )?.set;
              nativeSet?.call(el, p.prompt);
              el.dispatchEvent(new Event("input", { bubbles: true }));
              el.focus();
            }
          }}
          className="tag hover:bg-[color:var(--color-tint-violet)] cursor-pointer"
        >
          <span className="mr-1">{p.emoji}</span>
          {p.label}
        </button>
      ))}
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
      <div className="max-w-5xl mx-auto">
        <div className="flex items-center justify-between mb-2">
          <span className="font-medium text-sm">
            Instructions for this chat
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
          Make one of your assistants act differently <em>just in this conversation</em>. Leave the box empty to go back to its usual instructions.
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
                  {overrides[a.id] ? " (custom instructions set)" : ""}
                </option>
              ))}
            </select>
            <span className="text-[11px] text-[color:var(--color-ink-soft)]">
              {current ? `${current.length} characters set` : "no custom instructions yet"}
            </span>
          </div>
          <PersonaTemplateChips
            agentId={selected}
            disabled={!selected}
          />
          <textarea
            name="persona"
            className="input min-h-[100px] font-mono text-[12px]"
            defaultValue={current}
            placeholder="Tap a template above, or write your own… (leave blank to go back to usual instructions)"
            maxLength={4000}
            id={`persona-textarea-${selected}`}
          />
          <button type="submit" className="btn btn-primary btn-sm">
            Save instructions
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
  myAgentsForSelfAdd,
  myUserId,
  agentLinks,
  addAction,
  addOwnAgentAction,
  requestLinkAction,
  respondLinkAction,
  revokeLinkAction,
  removeAction,
  onClose,
}: {
  convId: string;
  members: Agent[];
  ownerId: string;
  inviteCandidates: Agent[];
  myAgentsForSelfAdd: Agent[];
  myUserId: string;
  agentLinks: AgentLinkRow[];
  addAction: (fd: FormData) => Promise<void>;
  addOwnAgentAction: (fd: FormData) => Promise<void>;
  requestLinkAction: (fd: FormData) => Promise<void>;
  respondLinkAction: (fd: FormData) => Promise<void>;
  revokeLinkAction: (fd: FormData) => Promise<void>;
  removeAction: (fd: FormData) => Promise<void>;
  onClose: () => void;
}) {
  // Partition members into mine vs theirs for the interconnect grid.
  const myMembers = members.filter((m) => m.owner_user_id === myUserId);
  const theirMembers = members.filter((m) => m.owner_user_id !== myUserId);
  const linkBetween = (a: string, b: string): AgentLinkRow | null => {
    const [x, y] = a < b ? [a, b] : [b, a];
    return (
      agentLinks.find((l) => l.agent_a === x && l.agent_b === y) ?? null
    );
  };
  return (
    <div className="bg-[color:var(--color-tint-violet)]/40 border-b border-[color:var(--color-line)] px-5 py-3">
      <div className="max-w-5xl mx-auto">
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
          {members.map((m) => {
            const isMyAgent = m.owner_user_id === myUserId;
            // ✕ button: show only when the caller is allowed to remove this
            // row — either the group owner, or the row IS the caller's own
            // agent (self-leave). Hide otherwise so non-owners don't see a
            // button that would always 403 server-side.
            const canRemove =
              (m.id !== ownerId && /* never delete the owner via this UI */
                (members.find((mm) => mm.id === ownerId)?.owner_user_id ===
                  myUserId)) ||
              isMyAgent;
            return (
              <li
                key={m.id}
                className="inline-flex items-center gap-1.5 surface px-2 py-1 text-xs"
              >
                <span>{m.avatar_emoji}</span>
                <span className="font-mono">{m.id}</span>
                {m.id === ownerId ? (
                  <span className="tag tag-amber">owner</span>
                ) : null}
                {isMyAgent && m.id !== ownerId ? (
                  <span className="tag tag-blue">mine</span>
                ) : null}
                {canRemove && m.id !== ownerId ? (
                  <form action={removeAction} className="contents">
                    <input type="hidden" name="conversation_id" value={convId} />
                    <input type="hidden" name="agent_id" value={m.id} />
                    <button
                      type="submit"
                      title={isMyAgent ? "Remove my assistant" : "Remove from group"}
                      className="text-[color:var(--color-ink-soft)] hover:text-[color:var(--color-danger)] ml-0.5"
                    >
                      ✕
                    </button>
                  </form>
                ) : null}
              </li>
            );
          })}
        </ul>

        {/* v0.14: any member can add their own agents into the group */}
        {myAgentsForSelfAdd.length > 0 ? (
          <form
            action={addOwnAgentAction}
            className="flex items-center gap-2 mb-2"
          >
            <input type="hidden" name="conversation_id" value={convId} />
            <select
              name="agent_id"
              className="input !py-1.5 !text-xs flex-1 font-mono"
            >
              {myAgentsForSelfAdd.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.avatar_emoji} {a.id} (mine)
                </option>
              ))}
            </select>
            <button type="submit" className="btn btn-secondary btn-sm">
              Add my assistant
            </button>
          </form>
        ) : null}

        {/* Owner-only: invite a friend's agent */}
        {inviteCandidates.length > 0 ? (
          <form action={addAction} className="flex items-center gap-2 mb-3">
            <input type="hidden" name="conversation_id" value={convId} />
            <select name="agent_id" className="input !py-1.5 !text-xs flex-1 font-mono">
              {inviteCandidates.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.avatar_emoji} {a.id}
                </option>
              ))}
            </select>
            <button type="submit" className="btn btn-primary btn-sm">
              Invite a friend's assistant
            </button>
          </form>
        ) : null}

        {/* v0.14: agent interconnect matrix — only meaningful in groups with
            cross-user members. The interconnect is a social trust signal:
            both sides explicitly opt-in their agents to collab autonomously. */}
        {myMembers.length > 0 && theirMembers.length > 0 ? (
          <div className="mt-2 border-t border-[color:var(--color-line)] pt-2">
            <div className="text-[11px] uppercase tracking-wider text-[color:var(--color-ink-soft)] mb-1.5">
              🔗 Assistant connections
            </div>
            <table className="w-full text-[11px]">
              <tbody>
                {myMembers.map((mine) =>
                  theirMembers.map((theirs) => {
                    const link = linkBetween(mine.id, theirs.id);
                    const youInitiated =
                      link?.initiated_by_user_id === myUserId;
                    return (
                      <tr key={mine.id + theirs.id}>
                        <td className="py-1 pr-2 font-mono truncate">
                          {mine.avatar_emoji} {mine.id}
                        </td>
                        <td className="py-1 px-1 text-[color:var(--color-ink-soft)]">↔</td>
                        <td className="py-1 pr-2 font-mono truncate">
                          {theirs.avatar_emoji} {theirs.id}
                        </td>
                        <td className="py-1 text-right">
                          {link?.status === "accepted" ? (
                            <form action={revokeLinkAction} className="contents">
                              <input type="hidden" name="conversation_id" value={convId} />
                              <input type="hidden" name="link_id" value={link.id} />
                              <span className="tag tag-green mr-1">🔗 connected</span>
                              <button
                                type="submit"
                                className="btn btn-ghost btn-sm"
                                title="Remove connection"
                              >
                                ✕
                              </button>
                            </form>
                          ) : link?.status === "pending" ? (
                            youInitiated ? (
                              <span className="tag tag-amber">waiting for them</span>
                            ) : (
                              <form
                                action={respondLinkAction}
                                className="inline-flex gap-1"
                              >
                                <input type="hidden" name="conversation_id" value={convId} />
                                <input type="hidden" name="link_id" value={link.id} />
                                <button
                                  type="submit"
                                  name="decision"
                                  value="accept"
                                  className="btn btn-primary btn-sm"
                                >
                                  Accept
                                </button>
                                <button
                                  type="submit"
                                  name="decision"
                                  value="decline"
                                  className="btn btn-ghost btn-sm"
                                >
                                  Decline
                                </button>
                              </form>
                            )
                          ) : (
                            <form action={requestLinkAction} className="contents">
                              <input type="hidden" name="conversation_id" value={convId} />
                              <input type="hidden" name="my_agent_id" value={mine.id} />
                              <input type="hidden" name="their_agent_id" value={theirs.id} />
                              <button
                                type="submit"
                                className="btn btn-secondary btn-sm"
                              >
                                Request connection
                              </button>
                            </form>
                          )}
                        </td>
                      </tr>
                    );
                  }),
                )}
              </tbody>
            </table>
            <p className="text-[10px] text-[color:var(--color-ink-soft)] mt-1.5">
              A connection needs a yes from both sides. Both owners must accept
              before their assistants can work together on their own.
            </p>
          </div>
        ) : null}

        {inviteCandidates.length === 0 && myAgentsForSelfAdd.length === 0 ? (
          <div className="text-xs text-[color:var(--color-ink-muted)]">
            Everyone you could add is already in this group.
          </div>
        ) : null}
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
      <form action={action} className="flex items-center gap-2 max-w-5xl mx-auto">
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
  onPreviewImage: (img: { src: string; name: string }) => void,
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
        onPreviewImage={onPreviewImage}
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
      <span className="text-[11px] uppercase tracking-wider px-3 py-1 rounded-full bg-[color:var(--color-paper-strong)] backdrop-blur border border-[color:var(--color-line)] text-[color:var(--color-ink-muted)] font-medium">
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
  onPreviewImage,
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
  onPreviewImage: (img: { src: string; name: string }) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [showReactions, setShowReactions] = useState(false);
  const [showForward, setShowForward] = useState(false);
  const within5min = Date.now() - message.created_at < 5 * 60_000;
  const canEdit = isMine && within5min && !message.deleted_at && message.text;
  const canDelete = isMine && within5min && !message.deleted_at;

  return (
    <div
      className={`flex gap-3 ${isMine ? "flex-row-reverse" : ""} ${
        isStartOfGroup ? "mt-4" : "mt-1"
      }`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => {
        setHovered(false);
        setShowReactions(false);
      }}
    >
      <div className="w-8 shrink-0 flex justify-center">
        {/* Avatar shows at the start of each sender's run — incoming on the
            left, my own on the right (the row is reversed when mine). */}
        {isStartOfGroup ? <Avatar agent={author} size={32} /> : null}
      </div>
      <div className={`flex-1 min-w-0 flex flex-col ${isMine ? "items-end" : "items-start"}`}>
        {isStartOfGroup && !isMine ? (
          <div className="flex items-baseline gap-1.5 mb-1 ml-1 flex-wrap">
            <span className="font-semibold text-[13px] tracking-[-0.005em]">
              {author?.display_name ?? message.from_agent_id}
            </span>
            {author?.agent_kind === "managed" ? (
              <span className="tag tag-violet !py-0 !px-1.5 !text-[9.5px]">agent</span>
            ) : null}
            {message.kind === "agent_to_agent" ? (
              <span
                className="tag tag-violet !py-0 !px-1.5 !text-[9.5px]"
                title="The assistants replied to each other automatically"
              >
                assistant ↔ assistant
              </span>
            ) : null}
          </div>
        ) : null}

        <div className="relative group max-w-[min(720px,90%)]">
          <div
            className={`px-4 py-[11px] rounded-[19px] ${
              isMine
                ? "bg-[linear-gradient(135deg,#222534_0%,#3a3145_100%)] text-white rounded-br-md shadow-[0_10px_26px_-18px_rgba(0,0,0,.62)]"
                : "bg-[linear-gradient(180deg,rgba(255,255,255,.98)_0%,rgba(250,250,252,.92)_100%)] border border-[color:var(--color-line)] text-[color:var(--color-ink)] rounded-bl-md shadow-[0_14px_34px_-30px_rgba(22,22,40,.58)]"
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
              <div className="text-[14.5px] leading-[1.68] break-words whitespace-pre-wrap tracking-[0.001em]">
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
                    <button
                      key={a.id}
                      type="button"
                      onClick={() =>
                        onPreviewImage({
                          src: `/api/v1/blobs/${a.id}`,
                          name: a.filename,
                        })
                      }
                      className="block rounded-lg overflow-hidden border border-black/5 max-w-[280px] cursor-zoom-in"
                      title={`${a.filename} · ${formatBytes(a.size_bytes)} · click to enlarge`}
                      aria-label={`Enlarge image ${a.filename}`}
                    >
                      <img
                        src={`/api/v1/blobs/${a.id}`}
                        alt={a.filename}
                        className="block max-h-[320px] w-auto"
                        loading="lazy"
                      />
                    </button>
                  ) : (
                    <a
                      key={a.id}
                      href={`/api/v1/blobs/${a.id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-lg text-[12px] ${
                        isMine
                          ? "bg-white/15 hover:bg-white/25 text-white"
                          : "bg-[color:var(--color-hover)] hover:bg-[color:var(--color-hover-strong)]"
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
                  isMine ? "bg-white/15 hover:bg-white/25 text-white" : "bg-[color:var(--color-hover)] hover:bg-[color:var(--color-hover-strong)]"
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
                isMine ? "justify-end text-white/65" : "text-[color:var(--color-ink-soft)]"
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
            ? "bg-[color:var(--color-ink)] border-transparent text-white"
            : "bg-[color:var(--color-paper)] border-[color:var(--color-line)] hover:bg-[color:var(--color-paper-faint)]"
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
      className={`mb-1.5 px-2.5 py-1 rounded-lg text-[12px] ${
        isMine
          ? "bg-white/12 text-white/80"
          : "bg-[color:var(--color-hover)] text-[color:var(--color-ink-muted)]"
      }`}
    >
      <div className={`font-medium ${isMine ? "text-white" : "text-[color:var(--color-ink)]"}`}>
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
    <div className="mb-1">
      {/* Quiet inline toggle — no full-width colored bar, no token count, so a
          thread of agent replies stays calm. Expands to a subtle reasoning box. */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex items-center gap-1 text-[11px] font-medium transition-colors ${
          isMine
            ? "text-white/65 hover:text-white"
            : "text-[color:var(--color-ink-soft)] hover:text-[color:var(--color-ink-muted)]"
        }`}
      >
        <span className="text-[9px] leading-none">{open ? "▾" : "▸"}</span>
        <span>Thinking</span>
      </button>
      {open ? (
        <pre
          className={`mt-1 px-2.5 py-1.5 rounded-lg text-[12px] leading-[1.5] whitespace-pre-wrap font-mono ${
            isMine
              ? "bg-white/10 text-white/80"
              : "bg-[color:var(--color-paper-faint)] text-[color:var(--color-ink-muted)]"
          }`}
        >
          {text}
        </pre>
      ) : null}
    </div>
  );
}

function FailedRepliesRow({
  failures,
  memberById,
}: {
  failures: Array<{
    job_id: string;
    agent_id: string;
    last_error: string | null;
    finished_at: number | null;
  }>;
  memberById: Record<string, Agent>;
}) {
  return (
    <div className="mt-3 space-y-1">
      {failures.map((f) => {
        const a = memberById[f.agent_id];
        return (
          <div
            key={f.job_id}
            className="flex items-start gap-2 text-[12px] text-[color:var(--color-ink-muted)] px-3 py-1.5 surface bg-[color:var(--color-danger-tint)]/40 border-[color:var(--color-danger)]/20"
          >
            <span aria-hidden>⚠️</span>
            <div className="flex-1 min-w-0">
              <span className="font-medium">
                {a?.display_name ?? f.agent_id}
              </span>{" "}
              tried to reply and gave up
              {f.last_error ? (
                <>
                  : <code className="font-mono text-[11px]">{f.last_error}</code>
                </>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function TypingRow({ agents }: { agents: Agent[] }) {
  const label = agents.length === 1
    ? `${agents[0].display_name} is typing`
    : `${agents.length} assistants are typing`;
  return (
    <div className="flex gap-2 mt-3">
      <div className="w-8 shrink-0 flex justify-center">
        <Avatar agent={agents[0]} size={32} />
      </div>
      <div className="rounded-[var(--radius-bubble)] rounded-bl-md bg-[color:var(--color-paper-faint)] border border-[color:var(--color-line)] px-3.5 py-2.5 flex items-center gap-2">
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

function EmptyState({
  memberCount,
  canHandoff,
  onOpenHandoff,
}: {
  memberCount: number;
  canHandoff: boolean;
  onOpenHandoff: () => void;
}) {
  return (
    <div className="text-center py-16 text-[color:var(--color-ink-muted)]">
      <div className="text-4xl mb-3">💬</div>
      <div className="font-medium text-[color:var(--color-ink)]">No messages yet</div>
      <div className="text-sm mt-1 max-w-md mx-auto leading-relaxed">
        {memberCount > 2
          ? "Group chat is open. Talk to your own assistant, or hand a task off to a friend's assistant."
          : "Send the first message to kick things off."}
      </div>
      {canHandoff ? (
        <button
          type="button"
          onClick={onOpenHandoff}
          className="btn btn-primary btn-sm mt-4"
        >
          📨 Hand off a task
        </button>
      ) : null}
    </div>
  );
}

function HandoffStrip({
  handoffs,
  myUserId,
  memberById,
  respondAction,
  withdrawAction,
  completeAction,
}: {
  handoffs: HandoffCardData[];
  myUserId: string;
  memberById: Record<string, Agent>;
  respondAction: (fd: FormData) => Promise<void>;
  withdrawAction: (fd: FormData) => Promise<void>;
  completeAction: (fd: FormData) => Promise<void>;
}) {
  // Pinned-style strip showing the most recent handoffs (proposed first,
  // then accepted, then everything else). Compact accepted/declined rows;
  // full HandoffCard for anything still "proposed".
  const sorted = [...handoffs].sort((a, b) => {
    const wA = a.status === "proposed" ? 0 : a.status === "accepted" ? 1 : 2;
    const wB = b.status === "proposed" ? 0 : b.status === "accepted" ? 1 : 2;
    if (wA !== wB) return wA - wB;
    return b.created_at - a.created_at;
  });
  const top = sorted.slice(0, 5);
  if (top.length === 0) return null;
  return (
    <section className="mb-4">
      <div className="text-[10px] uppercase tracking-wider font-medium text-[color:var(--color-ink-soft)] px-1 mb-1">
        Handoffs ({handoffs.length})
      </div>
      <div className="space-y-2">
        {top.map((h) => {
          const view =
            h.to_user_id === myUserId
              ? "recipient"
              : h.from_user_id === myUserId
                ? "sender"
                : "observer";
          const fromAgent = memberById[h.from_agent_id];
          const toAgent = memberById[h.to_agent_id];
          return (
            <HandoffCard
              key={h.id}
              handoff={h}
              view={view}
              agentLabel={{
                from: fromAgent ? fromAgent.id : h.from_agent_id,
                to: toAgent ? toAgent.id : h.to_agent_id,
              }}
              respondAction={respondAction}
              withdrawAction={withdrawAction}
              completeAction={completeAction}
            />
          );
        })}
      </div>
    </section>
  );
}

function Avatar({ agent, size = 32 }: { agent?: Agent; size?: number }) {
  if (!agent) {
    return (
      <div
        className="avatar bg-[color:var(--color-paper-faint)] border border-[color:var(--color-line)]"
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
  return (
    <div
      className={`avatar ${avatarGradClass(agent.id)}`}
      style={{ width: size, height: size, fontSize: Math.floor(size * 0.45) }}
    >
      {agent.avatar_emoji}
    </div>
  );
}

function ImageLightbox({
  image,
  onClose,
}: {
  image: { src: string; name: string } | null;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  // Native <dialog>: showModal() gives us Escape-to-close, focus trapping,
  // and a ::backdrop for free. We sync the imperative open/close with the
  // `image` state; the dialog's `close` event flows back via onClose.
  useEffect(() => {
    const dlg = dialogRef.current;
    if (!dlg) return;
    if (image && !dlg.open) dlg.showModal();
    else if (!image && dlg.open) dlg.close();
  }, [image]);

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onClick={(e) => {
        // Clicks on the backdrop hit the <dialog> element itself; clicks on
        // the content hit children. Only the former should close.
        if (e.target === e.currentTarget) e.currentTarget.close();
      }}
      className="m-auto p-0 bg-transparent outline-none backdrop:bg-black/75"
      aria-label="Image preview"
    >
      {image ? (
        <div className="flex flex-col items-center gap-2 p-2">
          <div className="flex items-center gap-3 w-full max-w-[90vw]">
            <span
              className="flex-1 min-w-0 truncate text-[13px] font-medium text-white"
              title={image.name}
            >
              {image.name}
            </span>
            <a
              href={image.src}
              download={image.name}
              className="text-[12px] text-white/80 hover:text-white underline underline-offset-2 shrink-0"
            >
              Download
            </a>
            <button
              type="button"
              onClick={() => dialogRef.current?.close()}
              aria-label="Close preview"
              className="w-7 h-7 rounded-full inline-flex items-center justify-center text-white/80 hover:text-white hover:bg-white/15 shrink-0"
            >
              ✕
            </button>
          </div>
          <img
            src={image.src}
            alt={image.name}
            className="max-w-[90vw] max-h-[85vh] object-contain rounded-lg"
          />
        </div>
      ) : null}
    </dialog>
  );
}

function Composer({
  conv,
  myAgent,
  members,
  send,
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
  members: Agent[];
  send: (fd: FormData) => Promise<void>;
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

  // Unsent drafts persist per conversation (Feishu-style): debounced save on
  // change + save on blur, restore on mount, clear after a successful send.
  // The textarea is uncontrolled, so restore writes through the ref.
  const draftKey = `a2a:draft:${conv.id}`;
  const draftTimerRef = useRef<number | null>(null);
  function saveDraft(value: string) {
    try {
      if (value) localStorage.setItem(draftKey, value);
      else localStorage.removeItem(draftKey);
    } catch {
      /* localStorage unavailable (private mode / quota) — drafts just off */
    }
  }
  function clearDraft() {
    if (draftTimerRef.current !== null) {
      window.clearTimeout(draftTimerRef.current);
      draftTimerRef.current = null;
    }
    try {
      localStorage.removeItem(draftKey);
    } catch {
      /* noop */
    }
  }
  useEffect(() => {
    // Restore when the main composer is showing and still empty. Re-runs when
    // an edit session ends so the draft comes back into the fresh textarea.
    if (editing) return;
    const el = textRef.current;
    if (!el || el.value) return;
    try {
      const draft = localStorage.getItem(draftKey);
      if (draft) el.value = draft;
    } catch {
      /* noop */
    }
  }, [draftKey, editing]);
  useEffect(() => {
    return () => {
      if (draftTimerRef.current !== null) {
        window.clearTimeout(draftTimerRef.current);
      }
    };
  }, []);

  // When editing starts, prefill text + focus.
  useEffect(() => {
    if (editing && textRef.current) {
      textRef.current.value = editing.text;
      textRef.current.focus();
    }
  }, [editing]);

  if (editing) {
    return (
      <div className="border-t border-[color:var(--color-line)] bg-[linear-gradient(180deg,rgba(255,255,255,.92)_0%,rgba(248,248,250,.98)_100%)] px-5 py-3">
        <div className="max-w-5xl mx-auto">
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
                if (e.key === "Escape") {
                  onClearEditing();
                  return;
                }
                if (e.key !== "Enter") return;
                // IME safety: an Enter that commits a composition candidate
                // (Chinese/Japanese/Korean input) must never submit.
                if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229)
                  return;
                if (e.shiftKey) return; // Shift+Enter inserts a newline
                e.preventDefault(); // plain Enter or ⌘/Ctrl+Enter saves
                editRef.current?.requestSubmit();
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
      <div className="max-w-5xl mx-auto">
        {error ? <ErrorBanner error={error} /> : null}
        {replyTo ? (
          <div className="surface px-3 py-1.5 mb-2 flex items-start gap-2 text-[12px]">
            <span className="mt-0.5">↩</span>
            <div className="flex-1 min-w-0">
              <div className="font-medium text-[color:var(--color-ink)]">
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
              // Only reached on success — a failed send keeps the draft.
              clearDraft();
              formRef.current?.reset();
              setPendingFiles([]);
              onClearReplyTo();
            } finally {
              setSending(false);
            }
          }}
          className="rounded-2xl border border-[color:var(--color-line)] bg-white/90 px-3 py-2 shadow-[0_18px_46px_-38px_rgba(22,22,40,.62)] focus-within:border-[color:var(--color-line-strong)] focus-within:bg-white transition-colors"
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
              if (e.key !== "Enter") return;
              // IME safety: an Enter that commits a composition candidate
              // (Chinese/Japanese/Korean input) must never send the message.
              if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229)
                return;
              if (e.shiftKey) return; // Shift+Enter inserts a newline
              e.preventDefault(); // plain Enter or ⌘/Ctrl+Enter sends
              formRef.current?.requestSubmit();
            }}
            onChange={(e) => {
              const value = e.target.value;
              if (draftTimerRef.current !== null) {
                window.clearTimeout(draftTimerRef.current);
              }
              draftTimerRef.current = window.setTimeout(() => {
                draftTimerRef.current = null;
                saveDraft(value);
              }, 300);
            }}
            onBlur={(e) => {
              if (draftTimerRef.current !== null) {
                window.clearTimeout(draftTimerRef.current);
                draftTimerRef.current = null;
              }
              saveDraft(e.target.value);
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
                <span
                  key={i}
                  className="inline-flex max-w-[220px] items-center gap-1 rounded-full border border-[color:var(--color-line)] bg-[color:var(--color-paper-faint)] px-2 py-0.5 text-[11px] text-[color:var(--color-ink-muted)]"
                  title={f.name}
                >
                  <span className="shrink-0">📎</span>
                  <span className="truncate">{f.name}</span>
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
                placeholder="Your thinking — everyone in the room can see this…"
              />
            </div>
          ) : null}
          {/* v0.16 UI subtraction: ContextNote composer surface removed
              because the Handoff flow + file attachments now cover the
              same intent with better security (scoped grants) and less
              typing (selection-mark-private button). The backend
              `context_notes` table + /api/v1/contexts route remain for
              external agents that still POST the structured form. */}
          <div className="mt-2 flex items-center justify-between gap-2 flex-wrap pt-2 border-t border-[color:var(--color-line)]">
            <div className="flex items-center gap-1">
              <ComposerPill
                onClick={() => fileInputRef.current?.click()}
                title="Attach files"
                active={pendingFiles.length > 0}
                badge={pendingFiles.length > 0 ? pendingFiles.length : undefined}
              >
                <svg
                  width="17"
                  height="17"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                >
                  <path d="M20 11.5 12 19.5a5 5 0 0 1-7-7l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.4 8.4a1.6 1.6 0 0 1-2.3-2.3l7.7-7.7" />
                </svg>
              </ComposerPill>
              <ComposerPill
                onClick={onToggleThinking}
                title="Share your thinking with the room"
                active={showThinking}
              >
                <svg
                  width="17"
                  height="17"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                >
                  <path d="M12 3.5 13.7 8.3 18.5 10l-4.8 1.7L12 16.5l-1.7-4.8L5.5 10l4.8-1.7z" />
                  <path d="M18.6 15.4l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z" />
                </svg>
              </ComposerPill>
              <span className="ml-1.5 text-[10.5px] text-[color:var(--color-ink-soft)] hidden 2xl:inline-flex items-center gap-1">
                <span className="kbd">↵</span>
                <span className="ml-1 text-[color:var(--color-ink-soft)]">to send</span>
                <span className="ml-1 text-[color:var(--color-ink-soft)]">
                  · <span className="kbd">shift</span>
                  <span className="kbd">↵</span> for a new line
                </span>
                <span className="ml-2 text-[color:var(--color-ink-soft)]">
                  · <span className="kbd">/task</span> creates a task — @ an
                  assistant to put them on it
                </span>
              </span>
            </div>
            <button
              type="submit"
              disabled={sending}
              title="Send (↵)"
              aria-label="Send"
              className="group relative w-9 h-9 rounded-[12px] inline-flex items-center justify-center text-white transition-all disabled:opacity-50"
              style={{
                background: sending
                  ? "var(--color-ink-soft)"
                  : "var(--color-accent)",
                boxShadow: sending
                  ? "none"
                  : "0 1px 2px rgba(0,0,0,0.3), 0 6px 18px -8px var(--color-accent-glow)",
              }}
            >
              <span className="text-[15px] transition-transform group-hover:translate-x-[1px]">
                {sending ? "…" : "↑"}
              </span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function ErrorBanner({ error }: { error: string }) {
  // Room errors arrive via the ?error= query param (server redirect). This
  // banner only controls visibility client-side: ✕ dismisses immediately,
  // and it auto-fades after ~8s. With prefers-reduced-motion we skip the
  // fade animation but still hide.
  const [hidden, setHidden] = useState(false);
  const [fading, setFading] = useState(false);

  useEffect(() => {
    setHidden(false);
    setFading(false);
    const reduceMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const timers: number[] = [];
    if (reduceMotion) {
      timers.push(window.setTimeout(() => setHidden(true), 8000));
    } else {
      timers.push(window.setTimeout(() => setFading(true), 8000));
      timers.push(window.setTimeout(() => setHidden(true), 8500));
    }
    return () => {
      for (const t of timers) window.clearTimeout(t);
    };
  }, [error]);

  if (hidden) return null;
  return (
    <div
      role="alert"
      className={`callout callout-amber mb-2 text-sm items-start transition-opacity duration-500 ${
        fading ? "opacity-0" : "opacity-100"
      }`}
    >
      <span aria-hidden>⚠️</span>
      <span className="flex-1 min-w-0">{error}</span>
      <button
        type="button"
        onClick={() => setHidden(true)}
        aria-label="Dismiss error"
        className="shrink-0 -my-0.5 px-1.5 rounded-md text-[color:var(--color-ink-soft)] hover:text-[color:var(--color-ink)] hover:bg-black/5"
      >
        ✕
      </button>
    </div>
  );
}

function ComposerPill({
  onClick,
  title,
  active,
  badge,
  children,
}: {
  onClick: () => void;
  title: string;
  active?: boolean;
  badge?: number;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={!!active}
      className={
        "relative inline-flex items-center justify-center w-8 h-8 rounded-lg text-[14px] transition-all " +
        (active
          ? "bg-[color:var(--color-ink)] text-white"
          : "text-[color:var(--color-ink-muted)] hover:bg-[color:var(--color-hover)] hover:text-[color:var(--color-ink)]")
      }
    >
      <span aria-hidden>{children}</span>
      {badge ? (
        <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] px-1 rounded-full bg-[color:var(--color-danger)] text-white text-[9px] font-semibold flex items-center justify-center">
          {badge}
        </span>
      ) : null}
    </button>
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

// --- chat-header action icons ------------------------------------------------
const HEADER_BTN =
  "relative w-9 h-9 rounded-[10px] inline-flex items-center justify-center text-[color:var(--color-ink-muted)] hover:bg-[color:var(--color-hover)] hover:text-[color:var(--color-ink)] transition-colors";

const HDR_ICONS: Record<string, React.ReactNode> = {
  files: (
    <path d="M5 4.5h6l2 2.5h6V19a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 3 19V6a1.5 1.5 0 0 1 1.5-1.5Z" />
  ),
  tasks: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="2.5" />
      <path d="m8.5 12 2.2 2.2L16 9" />
    </>
  ),
  handoff: (
    <>
      <path d="M3 12h13" />
      <path d="m12 7 5 5-5 5" />
      <path d="M21 5v14" />
    </>
  ),
  members: (
    <>
      <circle cx="9" cy="9" r="3" />
      <path d="M3.5 19c0-3 2.5-5 5.5-5s5.5 2 5.5 5" />
      <path d="M16 6.2A3 3 0 0 1 16 12" />
      <path d="M17.5 14.2c2.3.5 4 2.4 4 4.8" />
    </>
  ),
  dots: (
    <>
      <circle cx="5" cy="12" r="1.4" />
      <circle cx="12" cy="12" r="1.4" />
      <circle cx="19" cy="12" r="1.4" />
    </>
  ),
};

function HdrIcon({
  name,
  size = 19,
}: {
  name: keyof typeof HDR_ICONS;
  size?: number;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {HDR_ICONS[name]}
    </svg>
  );
}

function HdrBadge({
  n,
  tint,
}: {
  n: number;
  tint?: "violet" | "amber" | "neutral";
}) {
  const cls =
    tint === "violet"
      ? "bg-[color:var(--color-tint-violet)] text-[color:var(--color-tint-violet-ink)]"
      : tint === "amber"
        ? "bg-[color:var(--color-tint-amber)] text-[color:var(--color-tint-amber-ink)]"
        : "bg-[color:var(--color-ink)] text-white";
  return (
    <span
      className={
        "absolute -top-0.5 -right-0.5 min-w-[15px] h-[15px] px-1 rounded-full text-[9px] font-semibold inline-flex items-center justify-center tabular-nums " +
        cls
      }
    >
      {n}
    </span>
  );
}
