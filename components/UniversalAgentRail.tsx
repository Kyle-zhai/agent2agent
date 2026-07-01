"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, type RefObject } from "react";
import {
  demoWorkspaceItems,
  getDemoWorkspaceItems,
  getDemoWorkspaceProfile,
  type DemoWorkspaceProfile,
} from "@/lib/demo-workspace";

export function UniversalAgentRail(_: {
  agentCount: number;
  inboxCount: number;
  roomCount: number;
  requestCount: number;
}) {
  const pathname = usePathname() ?? "";
  const router = useRouter();
  const searchParams = useSearchParams();
  const railMode = searchParams.get("rail");
  const previewFile = searchParams.get("previewFile");
  const [activeTab, setActiveTab] = useState<"team" | "my" | "discussion" | "files">("team");
  const [openMenu, setOpenMenu] = useState<"members" | "add" | null>(null);
  const [selectedUploads, setSelectedUploads] = useState<string[]>([]);
  const [messageDraft, setMessageDraft] = useState("");
  const [groupMessages, setGroupMessages] = useState<string[]>([]);
  const [privateMessages, setPrivateMessages] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const inWorkspaceShell = pathname === "/app" || /^\/app\/c\/[^/]+/.test(pathname);
  const conversationKey =
    searchParams.get("conversation") ?? pathname.match(/^\/app\/c\/([^/]+)/)?.[1] ?? null;
  const workspaceProfile = getDemoWorkspaceProfile(conversationKey);

  useEffect(() => {
    if (railMode === "files") {
      setOpenMenu(null);
      setActiveTab("files");
    }
  }, [railMode]);

  if (!inWorkspaceShell) return null;

  const toolRows = [
    { tool: "read_workspace", time: "92ms", target: `${workspaceProfile.files.filter((file) => file.kind !== "folder").length} files`, status: "Done" },
    { tool: "write_notes", time: "118ms", target: workspaceProfile.files.find((file) => file.kind === "md")?.name ?? "notes.md", status: "Done" },
    { tool: "assign_review", time: "44ms", target: workspaceProfile.agents[1]?.name ?? "Review agent", status: "Done" },
    { tool: "run_checks", time: "14s", target: "workspace, task", status: "Passed" },
    { tool: "close_task", time: "31s", target: "done", status: "Live" },
  ];
  const files = getDemoWorkspaceItems(conversationKey);
  function previewHref(path: string) {
    const next = new URLSearchParams(searchParams.toString());
    next.set("rail", "files");
    next.set("previewFile", path);
    return `${pathname}?${next.toString()}`;
  }
  function selectPreviewFile(path: string) {
    router.replace(previewHref(path), { scroll: false });
  }

  return (
    <aside className="hidden h-full w-[505px] shrink-0 flex-col overflow-visible border-l border-[color:var(--color-line)] bg-white xl:flex">
      <header className="relative overflow-visible border-b border-[color:var(--color-line)] bg-white">
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <h2 className="truncate text-[15px] font-semibold text-[color:var(--color-ink)]">
              {workspaceProfile.title}
            </h2>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="relative">
              <button
                type="button"
                onClick={() =>
                  setOpenMenu((current) =>
                    current === "members" ? null : "members",
                  )
                }
                className="btn btn-secondary btn-sm !gap-1.5"
              >
                <MembersIcon />
                <span>Members</span>
                <span className="rounded-full bg-[color:var(--color-paper-faint)] px-1.5 py-0.5 text-[10px] text-[color:var(--color-ink-muted)]">
                  {workspaceProfile.members.length}
                </span>
              </button>
              {openMenu === "members" ? <MembersPopover profile={workspaceProfile} /> : null}
            </div>
            <div className="relative">
              <button
                type="button"
                onClick={() =>
                  setOpenMenu((current) => (current === "add" ? null : "add"))
                }
                className="grid h-8 w-8 place-items-center rounded-lg border border-[color:var(--color-line)] text-[color:var(--color-ink)] hover:bg-[color:var(--color-hover)]"
                aria-label="Add to this room"
                title="Add to this room"
              >
                <PlusIcon />
              </button>
              {openMenu === "add" ? <AddRoomPopover /> : null}
            </div>
            <button
              type="button"
              onClick={() => {
                setOpenMenu(null);
                setActiveTab(activeTab === "files" ? "team" : "files");
              }}
              className={
                "grid h-8 w-8 place-items-center rounded-lg border border-[color:var(--color-line)] hover:bg-[color:var(--color-hover)] " +
                (activeTab === "files"
                  ? "bg-[#eef4ff] text-[color:var(--color-tint-blue-ink)]"
                  : "text-[color:var(--color-ink)]")
              }
              aria-label="Files"
              title="Files"
            >
              <FileCardIcon />
            </button>
            <Link
              href="/app/settings"
              className="grid h-8 w-8 place-items-center rounded-lg border border-[color:var(--color-line)] text-[color:var(--color-ink)] hover:bg-[color:var(--color-hover)]"
              aria-label="More room actions"
              title="More"
            >
              <DotsIcon />
            </Link>
          </div>
        </div>
        <div className="flex px-4">
          <RailTab active={activeTab === "team"} label="Group Chat" onClick={() => setActiveTab("team")} />
          <RailTab active={activeTab === "my"} label="My Agent" onClick={() => setActiveTab("my")} />
          <RailTab active={activeTab === "discussion"} label="Discussion" onClick={() => setActiveTab("discussion")} />
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {activeTab === "files" ? (
          <FilesPanel
            files={files}
            activeFile={previewFile}
            selectedUploads={selectedUploads}
            fileInputRef={fileInputRef}
            getFileHref={previewHref}
            onSelectFile={selectPreviewFile}
            onFilesSelected={setSelectedUploads}
            profile={workspaceProfile}
          />
        ) : activeTab === "my" ? (
          <MyAgentPanel sentMessages={privateMessages} profile={workspaceProfile} />
        ) : activeTab === "discussion" ? (
          <DiscussionPanel rows={toolRows} />
        ) : (
          <GroupChatPanel sentMessages={groupMessages} profile={workspaceProfile} />
        )}
      </div>

      <footer className="border-t border-[color:var(--color-line)] px-4 py-3">
        <div className="rounded-2xl border border-[color:var(--color-line)] bg-[color:var(--color-paper)] px-3 py-3">
          <textarea
            value={messageDraft}
            onChange={(event) => setMessageDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                const text = messageDraft.trim();
                if (!text) return;
                if (activeTab === "my") {
                  setPrivateMessages((current) => [...current, text]);
                } else {
                  setGroupMessages((current) => [...current, text]);
                  if (activeTab === "files") setActiveTab("team");
                }
                setMessageDraft("");
              }
            }}
            rows={2}
            placeholder={
              activeTab === "my"
                ? "Message your private agent..."
                : "Message the group or assign work..."
            }
            className="min-h-[54px] w-full resize-none bg-transparent text-[13px] leading-relaxed text-[color:var(--color-ink)] outline-none placeholder:text-[color:var(--color-ink-soft)]"
          />
          <div className="mt-3 flex items-center gap-2">
            <FooterButton label="Attach" icon="paperclip" />
            <Link href="/app/collab/new" className="btn btn-secondary btn-sm">
              Handoff
            </Link>
            <FooterButton label="Add person" icon="user-plus" />
            <FooterButton label="Voice" icon="mic" />
            <span className="ml-auto text-[11px] text-[color:var(--color-ink-soft)]">
              Claude 3.5 Sonnet
            </span>
            <button
              type="button"
              disabled={messageDraft.trim().length === 0}
              onClick={() => {
                const text = messageDraft.trim();
                if (!text) return;
                if (activeTab === "my") {
                  setPrivateMessages((current) => [...current, text]);
                } else {
                  setGroupMessages((current) => [...current, text]);
                  if (activeTab === "files") setActiveTab("team");
                }
                setMessageDraft("");
              }}
              className="grid h-9 w-9 place-items-center rounded-xl bg-[color:var(--color-tint-blue-ink)] text-white shadow-[0_10px_26px_-18px_rgba(31,95,200,.65)]"
              aria-label="Send"
            >
              <SendIcon />
            </button>
          </div>
        </div>
      </footer>
    </aside>
  );
}

function ExecutionPanel({
  rows,
}: {
  rows: Array<{ tool: string; time: string; target: string; status: string }>;
}) {
  return (
    <section>
      <h3 className="text-[12px] font-semibold text-[color:var(--color-ink)]">
        Execution details
      </h3>
      <div className="mt-2 space-y-1.5">
        {rows.map((row) => (
          <div
            key={row.tool}
            className="flex items-center gap-2 rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-paper)] px-2.5 py-2"
          >
            <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-[color:var(--color-paper-faint)] text-[color:var(--color-ink-soft)]">
              <ToolIcon />
            </span>
            <span className="min-w-0 flex-1 truncate text-[12px] font-semibold">
              {row.tool}
            </span>
            <span className="text-[11px] text-[color:var(--color-ink-soft)]">
              {row.time}
            </span>
            <span className="rounded-md bg-[color:var(--color-paper-faint)] px-2 py-1 text-[11px] text-[color:var(--color-ink-muted)]">
              {row.target}
            </span>
            <span className="tag tag-green !py-0.5 !text-[10px]">
              {row.status}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function FilesPanel({
  files,
  activeFile,
  selectedUploads,
  fileInputRef,
  getFileHref,
  onSelectFile,
  onFilesSelected,
  profile,
}: {
  files: typeof demoWorkspaceItems;
  activeFile: string | null;
  selectedUploads: string[];
  fileInputRef: RefObject<HTMLInputElement | null>;
  getFileHref: (path: string) => string;
  onSelectFile: (path: string) => void;
  onFilesSelected: (names: string[]) => void;
  profile: DemoWorkspaceProfile;
}) {
  const [openFolders, setOpenFolders] = useState<Set<string>>(
    () => new Set(files.filter((item) => item.kind === "folder").map((item) => item.path)),
  );
  useEffect(() => {
    setOpenFolders(new Set(files.filter((item) => item.kind === "folder").map((item) => item.path)));
  }, [files]);
  const visibleItems = files.filter((item) => {
    if (!item.parent) return true;
    return openFolders.has(item.parent);
  });
  const toggleFolder = (path: string) => {
    setOpenFolders((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-[13px] font-semibold text-[color:var(--color-ink)]">
            Files
          </h3>
          <p className="text-[11px] text-[color:var(--color-ink-soft)]">
            {profile.subtitle}
          </p>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="sr-only"
          onChange={(event) => {
            onFilesSelected(
              Array.from(event.currentTarget.files ?? []).map((file) => file.name),
            );
          }}
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="btn btn-primary btn-sm"
        >
          <PlusIcon />
          <span>Add files</span>
        </button>
      </div>

      <div className="rounded-2xl border border-[color:var(--color-line)] bg-white p-2">
        <div
          className="mb-1 flex w-full items-center gap-2 rounded-lg bg-[#eaf1ff] px-2.5 py-2 text-left text-[12.5px] font-semibold text-[color:var(--color-ink)]"
        >
          <TreeChevronIcon open />
          <TreeFileIcon kind="folder" />
          <span className="min-w-0 flex-1 truncate">{profile.title}</span>
          <span className="ml-auto text-[11px] text-[color:var(--color-ink-soft)]">
            {profile.id}
          </span>
        </div>
        <div className="space-y-0.5">
          {visibleItems.map((file) => {
            const isFolder = file.kind === "folder";
            const selected = !isFolder && file.path === activeFile;
            const depth = file.parent ? 2 : 1;
            const className =
              "flex w-full items-center gap-2 rounded-lg py-2 pr-2 text-left text-[12.5px] transition-colors " +
              (selected
                ? "bg-[#eaf1ff] text-[color:var(--color-ink)]"
                : "text-[color:var(--color-ink-muted)] hover:bg-[color:var(--color-hover)] hover:text-[color:var(--color-ink)]");
            const content = (
              <>
                {isFolder ? (
                  <TreeChevronIcon open={openFolders.has(file.path)} />
                ) : (
                  <span className="w-3 shrink-0" />
                )}
                <TreeFileIcon kind={file.kind} />
                <span className="min-w-0 flex-1 truncate font-medium">
                  {file.name}
                </span>
                {file.status === "review" ? (
                  <span className="tag tag-amber !px-1.5 !py-0 !text-[10px]">
                    review
                  </span>
                ) : selected ? (
                  <span className="h-2 w-2 shrink-0 rounded-full bg-[color:var(--color-tint-blue-ink)]" />
                ) : isFolder && !file.parent ? (
                  <span className="h-2 w-2 shrink-0 rounded-full bg-[color:var(--color-line-strong)]" />
                ) : null}
              </>
            );

            return isFolder ? (
              <button
                key={file.path}
                type="button"
                onClick={() => toggleFolder(file.path)}
                className={className}
                style={{ paddingLeft: 10 + depth * 16 }}
                aria-expanded={openFolders.has(file.path)}
              >
                {content}
              </button>
            ) : (
              <a
                key={file.path}
                href={getFileHref(file.path)}
                onPointerDown={() => onSelectFile(file.path)}
                onMouseDown={() => onSelectFile(file.path)}
                onClick={() => onSelectFile(file.path)}
                className={className}
                style={{ paddingLeft: 10 + depth * 16 }}
                aria-label={`Preview ${file.path}`}
              >
                {content}
              </a>
            );
          })}
        </div>
      </div>

      {selectedUploads.length > 0 ? (
        <div className="rounded-xl border border-[#bfd3ff] bg-[#eef4ff] px-3 py-2.5">
          <div className="text-[12px] font-semibold text-[color:var(--color-tint-blue-ink)]">
            Selected from local computer
          </div>
          <div className="mt-1 space-y-0.5">
            {selectedUploads.slice(0, 4).map((name) => (
              <div key={name} className="truncate text-[11px] text-[color:var(--color-tint-blue-ink)]">
                {name}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function GroupChatPanel({
  sentMessages,
  profile,
}: {
  sentMessages: string[];
  profile: DemoWorkspaceProfile;
}) {
  const attachedFile =
    profile.files.find((file) => file.kind !== "folder" && file.status === "review") ??
    profile.files.find((file) => file.kind !== "folder");
  return (
    <section className="space-y-3">
      <h3 className="text-[13px] font-semibold text-[color:var(--color-ink)]">
        Group Chat
      </h3>
      {profile.notes.map((note) => (
        <AgentNote key={note} workspace={profile.title}>
          {note}
        </AgentNote>
      ))}
      <div className="ml-7 rounded-2xl border border-[color:var(--color-line)] bg-[color:var(--color-paper)] px-3 py-3">
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-paper-faint)] text-[color:var(--color-ink-muted)]">
            <FileCardIcon />
          </span>
          <div>
            <div className="text-[13px] font-semibold text-[color:var(--color-ink)]">
              {attachedFile?.name ?? "workspace-notes.md"}
            </div>
            <div className="text-[12px] text-[color:var(--color-ink-soft)]">
              {attachedFile?.kind.toUpperCase() ?? "MD"} · shared evidence
            </div>
          </div>
        </div>
      </div>
      {sentMessages.map((message, index) => (
        <div
          key={`${message}-${index}`}
          className="ml-7 rounded-2xl bg-[color:var(--color-tint-blue-ink)] px-3 py-2 text-[13px] leading-relaxed text-white"
        >
          {message}
        </div>
      ))}
    </section>
  );
}

function MyAgentPanel({
  sentMessages,
  profile,
}: {
  sentMessages: string[];
  profile: DemoWorkspaceProfile;
}) {
  const primaryAgent = profile.agents[0] ?? { name: "My agent", role: "workspace.read" };
  return (
    <section className="space-y-3">
      <h3 className="text-[13px] font-semibold text-[color:var(--color-ink)]">
        Private Agent Chat
      </h3>
      <div className="rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-paper)] px-3 py-3">
        <div className="flex items-center gap-2">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-[color:var(--color-tint-blue)] text-[color:var(--color-tint-blue-ink)]">
            <AgentGlyph />
          </span>
          <div>
            <div className="text-[13px] font-semibold">{primaryAgent.name}</div>
            <div className="text-[11px] text-[color:var(--color-ink-soft)]">
              {primaryAgent.role}
            </div>
          </div>
        </div>
        <p className="mt-3 text-[12px] leading-relaxed text-[color:var(--color-ink-muted)]">
          Private workspace for you and {primaryAgent.name}. Messages here stay out of
          the group thread until you choose to share work back.
        </p>
      </div>
      <div className="rounded-2xl border border-[color:var(--color-line)] bg-white px-3 py-3">
        <div className="text-[11px] text-[color:var(--color-ink-soft)]">
          {primaryAgent.name}
        </div>
        <p className="mt-1 text-[13px] leading-relaxed text-[color:var(--color-ink)]">
          I can inspect files in {profile.title}, draft a task, or prepare a
          private review note before you send anything to the group.
        </p>
      </div>
      {sentMessages.map((message, index) => (
        <div
          key={`${message}-${index}`}
          className="ml-10 rounded-2xl bg-[color:var(--color-tint-blue-ink)] px-3 py-2 text-[13px] leading-relaxed text-white"
        >
          {message}
        </div>
      ))}
      <Link href="/app/agents" className="btn btn-secondary btn-sm">
        Manage agents
      </Link>
    </section>
  );
}

function DiscussionPanel({
  rows,
}: {
  rows: Array<{ tool: string; time: string; target: string; status: string }>;
}) {
  return (
    <section className="space-y-3">
      <h3 className="text-[13px] font-semibold text-[color:var(--color-ink)]">
        Discussion
      </h3>
      <ExecutionPanel rows={rows} />
      <section className="flex items-center gap-3 rounded-xl border border-[#bfd3ff] bg-[#eef4ff] px-3 py-3">
        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-[color:var(--color-tint-blue-ink)]">
          <InfoIcon />
        </span>
        <div className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-[color:var(--color-tint-blue-ink)]">
          Partner onboarding is ready for member review.
        </div>
        <Link href="/app/contacts" className="btn btn-primary btn-sm">
          Invite
        </Link>
      </section>
    </section>
  );
}

function RailTab({
  label,
  active = false,
  onClick,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "border-b-2 px-3 py-2 text-[12px] font-medium " +
        (active
          ? "border-[color:var(--color-tint-blue-ink)] text-[color:var(--color-tint-blue-ink)]"
          : "border-transparent text-[color:var(--color-ink-soft)]")
      }
    >
      {label}
    </button>
  );
}

function AgentNote({
  children,
  workspace,
}: {
  children: React.ReactNode;
  workspace: string;
}) {
  return (
    <div className="flex gap-3">
      <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-md text-[color:var(--color-ink)]">
        <AgentGlyph />
      </span>
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center gap-2 text-[11px] text-[color:var(--color-ink-soft)]">
          <span>{workspace}</span>
          <span className="tag tag-blue !px-1.5 !py-0 !text-[10px]">
            Agent
          </span>
          <span>Yesterday 11:36</span>
        </div>
        <p className="text-[13px] leading-relaxed text-[color:var(--color-ink)]">
          {children}
        </p>
      </div>
    </div>
  );
}

function FooterButton({ label, icon }: { label: string; icon: "paperclip" | "user-plus" | "mic" }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      className="grid h-8 w-8 place-items-center rounded-lg text-[color:var(--color-ink-muted)] hover:bg-[color:var(--color-hover)] hover:text-[color:var(--color-ink)]"
    >
      {icon === "paperclip" ? <PaperclipIcon /> : icon === "user-plus" ? <UserPlusIcon /> : <MicIcon />}
    </button>
  );
}

function MembersPopover({ profile }: { profile: DemoWorkspaceProfile }) {
  const people = profile.members.filter((member) => !member.role.toLowerCase().includes("agent"));
  const agentMembers = profile.agents;
  return (
    <div className="fixed right-4 top-[124px] z-[100] w-[420px] max-w-[calc(100vw-32px)] rounded-xl border border-[color:var(--color-line)] bg-white p-3 shadow-[var(--shadow-pop)]">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <div className="text-[13px] font-semibold text-[color:var(--color-ink)]">
            Members
          </div>
          <div className="text-[11px] text-[color:var(--color-ink-soft)]">
            {profile.title} · {people.length} people · {agentMembers.length} agents
          </div>
        </div>
        <span className="rounded-full bg-[color:var(--color-paper-faint)] px-2 py-1 text-[11px] font-medium text-[color:var(--color-ink-muted)]">
          {profile.members.length} total
        </span>
      </div>
      <div className="grid grid-cols-[1fr_1.25fr] gap-3">
        <section className="rounded-xl border border-[color:var(--color-line)] bg-white p-2.5">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-[color:var(--color-ink-soft)]">
            People
          </div>
          <div className="space-y-2">
            {(people.length ? people : profile.members.slice(0, 3)).map((member, index) => (
              <MemberPerson
                key={member.name}
                name={member.name}
                role={member.role}
                initials={member.emoji}
                muted={index === profile.members.length - 1}
              />
            ))}
          </div>
        </section>
        <section className="rounded-xl border border-[color:var(--color-line)] bg-white p-2.5">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-[color:var(--color-ink-soft)]">
            Agents
          </div>
          <div className="space-y-2">
            {agentMembers.map((agent) => (
              <MemberAgent key={agent.name} name={agent.name} role={agent.role} />
            ))}
          </div>
          <div className="mt-3 grid gap-2">
            <Link href="/app/contacts" className="btn btn-secondary btn-sm w-full justify-center">
              Invite collaborator
            </Link>
            <Link href="/app/agents" className="btn btn-secondary btn-sm w-full justify-center">
              Add my agent
            </Link>
          </div>
        </section>
      </div>
    </div>
  );
}

function MemberPerson({
  name,
  role,
  initials,
  muted = false,
}: {
  name: string;
  role?: string;
  initials: string;
  muted?: boolean;
}) {
  return (
    <div className="flex items-center gap-2 rounded-lg px-1.5 py-1">
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[color:var(--color-paper-faint)] text-[10px] font-semibold text-[color:var(--color-ink)] ring-1 ring-[color:var(--color-line)]">
        {initials}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12px] font-medium text-[color:var(--color-ink)]">
          {name}
        </div>
        {role ? (
          <div className="text-[10px] text-[color:var(--color-ink-soft)]">
            {role}
          </div>
        ) : null}
      </div>
      <span
        className={
          "h-2 w-2 shrink-0 rounded-full " +
          (muted
            ? "border border-[color:var(--color-ink-soft)] bg-white"
            : "bg-[color:var(--color-tint-green-ink)]")
        }
      />
    </div>
  );
}

function MemberAgent({ name, role }: { name: string; role: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg px-1.5 py-1">
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-[color:var(--color-tint-blue)] text-[color:var(--color-tint-blue-ink)]">
        <AgentGlyph />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12px] font-medium text-[color:var(--color-ink)]">
          {name}
        </div>
        <div className="text-[10px] text-[color:var(--color-ink-soft)]">
          {role}
        </div>
      </div>
      <span className="h-2 w-2 shrink-0 rounded-full bg-[color:var(--color-tint-green-ink)]" />
    </div>
  );
}

function AddRoomPopover() {
  return (
    <div className="fixed right-4 top-[124px] z-[100] w-[230px] max-w-[calc(100vw-32px)] rounded-xl border border-[color:var(--color-line)] bg-white py-2 shadow-[var(--shadow-pop)]">
      <div className="px-4 pb-2 text-[13px] font-semibold text-[color:var(--color-ink)]">
        Add to this room
      </div>
      <AddMenuItem
        title="Friend's agent"
        body="Invite another person's agent from your trusted network"
        icon="person"
      />
      <AddMenuItem
        title="My local agent"
        body="Connect your own local or hosted agent"
        icon="agent"
      />
      <AddMenuItem
        title="Remote A2A agent URL"
        body="Add an agent using an A2A endpoint URL"
        icon="shield"
      />
    </div>
  );
}

function AddMenuItem({
  title,
  body,
  icon,
}: {
  title: string;
  body: string;
  icon: "person" | "agent" | "shield";
}) {
  return (
    <Link
      href={icon === "person" ? "/app/contacts" : icon === "agent" ? "/app/agents" : "/app/agents/connect"}
      className="flex gap-3 px-4 py-2.5 hover:bg-[color:var(--color-hover)]"
    >
      <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg text-[color:var(--color-ink)]">
        {icon === "person" ? (
          <UserPlusIcon />
        ) : icon === "agent" ? (
          <AgentGlyph />
        ) : (
          <ShieldIcon />
        )}
      </span>
      <span className="min-w-0">
        <span className="block text-[12.5px] font-semibold text-[color:var(--color-ink)]">
          {title}
        </span>
        <span className="mt-0.5 block text-[10.5px] leading-snug text-[color:var(--color-ink-muted)]">
          {body}
        </span>
      </span>
    </Link>
  );
}

function MembersIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}

function DotsIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="5" cy="12" r="1.3" />
      <circle cx="12" cy="12" r="1.3" />
      <circle cx="19" cy="12" r="1.3" />
    </svg>
  );
}

function ToolIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="11" cy="11" r="6" />
      <path d="m16 16 4 4" />
    </svg>
  );
}

function FileCardIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M7 3h7l4 4v14H7z" />
      <path d="M14 3v5h5" />
      <path d="M9.5 13h5" />
      <path d="M9.5 16h5" />
    </svg>
  );
}

function TreeChevronIcon({ open = false }: { open?: boolean }) {
  return (
    <svg className="w-3 shrink-0 text-[color:var(--color-ink-soft)]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {open ? <path d="m6 9 6 6 6-6" /> : <path d="m9 6 6 6-6 6" />}
    </svg>
  );
}

function TreeFileIcon({ kind }: { kind: string }) {
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

function AgentGlyph() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="6" y="7" width="12" height="10" rx="2" />
      <path d="M12 3v4" />
      <path d="M9 12h.01" />
      <path d="M15 12h.01" />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 3 19 6v5c0 4.4-2.8 8.1-7 9.4-4.2-1.3-7-5-7-9.4V6l7-3Z" />
      <path d="m9.5 12 1.6 1.6 3.7-4" />
    </svg>
  );
}

function InfoIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5" />
      <path d="M12 8h.01" />
    </svg>
  );
}

function PaperclipIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m21.4 11.6-8.8 8.8a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 1 1-2.8-2.8l8.8-8.8" />
    </svg>
  );
}

function UserPlusIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="9" cy="8" r="3" />
      <path d="M3.5 20c0-3.2 2.4-5.5 5.5-5.5" />
      <path d="M17 11v6" />
      <path d="M14 14h6" />
    </svg>
  );
}

function MicIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v3" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m22 2-7 20-4-9-9-4Z" />
      <path d="M22 2 11 13" />
    </svg>
  );
}
