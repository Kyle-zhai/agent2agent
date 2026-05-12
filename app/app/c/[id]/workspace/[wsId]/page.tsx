import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import {
  getConversation,
  listMembers,
  requireUserMember,
} from "@/lib/conversations";
import {
  applyPatch,
  canRead,
  fileDiffSummary,
  getSnapshot,
  getWorkspace,
  listFiles,
  listSnapshotsForWorkspace,
  listSubscribers,
  listWorkspacesForConversation,
  readFileAt,
  shortenSha,
  subscribeAgent,
  unsubscribeAgent,
} from "@/lib/workspaces";
import { listTasksForConversation } from "@/lib/tasks";
import { getAgent } from "@/lib/agents";
import { ConversationTabs } from "@/components/ConversationTabs";

export const dynamic = "force-dynamic";

async function uploadFileAction(formData: FormData) {
  "use server";
  const user = await requireUser();
  const convId = String(formData.get("conversation_id") ?? "");
  const wsId = String(formData.get("workspace_id") ?? "");
  const path = String(formData.get("path") ?? "").trim();
  const content = String(formData.get("content") ?? "");
  const commit = String(formData.get("commit_message") ?? "").trim() || "update";
  const { myAgentId } = requireUserMember(convId, user.id);
  const ws = getWorkspace(wsId);
  if (!ws) notFound();
  try {
    const result = applyPatch({
      workspace_id: ws.id,
      agent_id: myAgentId,
      against_rev: ws.head_snapshot_id!,
      ops: [{ path, op: "create", content }],
      commit_message: commit,
    });
    if (!result.ok) {
      redirect(
        `/app/c/${convId}/workspace/${wsId}?error=${encodeURIComponent(
          "Conflict: head moved (refresh and retry).",
        )}`,
      );
    }
  } catch (err) {
    redirect(
      `/app/c/${convId}/workspace/${wsId}?error=${encodeURIComponent(
        err instanceof Error ? err.message : "Patch failed.",
      )}`,
    );
  }
  revalidatePath(`/app/c/${convId}/workspace/${wsId}`);
  redirect(`/app/c/${convId}/workspace/${wsId}`);
}

async function modifyFileAction(formData: FormData) {
  "use server";
  const user = await requireUser();
  const convId = String(formData.get("conversation_id") ?? "");
  const wsId = String(formData.get("workspace_id") ?? "");
  const againstRev = String(formData.get("against_rev") ?? "");
  const path = String(formData.get("path") ?? "");
  const content = String(formData.get("content") ?? "");
  const commit = String(formData.get("commit_message") ?? "").trim() || "edit";
  const { myAgentId } = requireUserMember(convId, user.id);
  const ws = getWorkspace(wsId);
  if (!ws) notFound();
  try {
    const result = applyPatch({
      workspace_id: ws.id,
      agent_id: myAgentId,
      against_rev: againstRev,
      ops: [{ path, op: "modify", content }],
      commit_message: commit,
    });
    if (!result.ok) {
      redirect(
        `/app/c/${convId}/workspace/${wsId}?error=${encodeURIComponent(
          `Conflict on ${result.conflicting_paths.join(", ")} — head is now ${result.current_head.slice(0, 12)}.`,
        )}`,
      );
    }
  } catch (err) {
    redirect(
      `/app/c/${convId}/workspace/${wsId}?error=${encodeURIComponent(
        err instanceof Error ? err.message : "Edit failed.",
      )}`,
    );
  }
  revalidatePath(`/app/c/${convId}/workspace/${wsId}`);
  redirect(`/app/c/${convId}/workspace/${wsId}?path=${encodeURIComponent(path)}`);
}

async function deleteFileAction(formData: FormData) {
  "use server";
  const user = await requireUser();
  const convId = String(formData.get("conversation_id") ?? "");
  const wsId = String(formData.get("workspace_id") ?? "");
  const path = String(formData.get("path") ?? "");
  const { myAgentId } = requireUserMember(convId, user.id);
  const ws = getWorkspace(wsId);
  if (!ws) notFound();
  try {
    applyPatch({
      workspace_id: ws.id,
      agent_id: myAgentId,
      against_rev: ws.head_snapshot_id!,
      ops: [{ path, op: "delete" }],
      commit_message: `delete ${path}`,
    });
  } catch (err) {
    redirect(
      `/app/c/${convId}/workspace/${wsId}?error=${encodeURIComponent(
        err instanceof Error ? err.message : "Delete failed.",
      )}`,
    );
  }
  revalidatePath(`/app/c/${convId}/workspace/${wsId}`);
  redirect(`/app/c/${convId}/workspace/${wsId}`);
}

async function setRoleAction(formData: FormData) {
  "use server";
  const user = await requireUser();
  const convId = String(formData.get("conversation_id") ?? "");
  const wsId = String(formData.get("workspace_id") ?? "");
  const agentId = String(formData.get("agent_id") ?? "");
  const role = String(formData.get("role") ?? "writer") as
    | "reader"
    | "writer"
    | "admin"
    | "none";
  requireUserMember(convId, user.id);
  const ws = getWorkspace(wsId);
  if (!ws) notFound();
  if (role === "none") {
    unsubscribeAgent(ws.id, agentId);
  } else {
    subscribeAgent(ws.id, agentId, role);
  }
  revalidatePath(`/app/c/${convId}/workspace/${wsId}`);
  redirect(`/app/c/${convId}/workspace/${wsId}`);
}

export default async function WorkspaceDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; wsId: string }>;
  searchParams: Promise<{ error?: string; path?: string; rev?: string }>;
}) {
  const user = await requireUser();
  const { id: convId, wsId } = await params;
  const sp = await searchParams;
  const conv = getConversation(convId);
  if (!conv) notFound();
  const { myAgentId } = requireUserMember(convId, user.id);
  const ws = getWorkspace(wsId);
  if (!ws) notFound();
  if (!canRead(ws.id, myAgentId)) {
    // auto-subscribe room members as writer so the page works frictionlessly
    subscribeAgent(ws.id, myAgentId, "writer");
  }

  const head = ws.head_snapshot_id ? getSnapshot(ws.head_snapshot_id) : null;
  const files = ws.head_snapshot_id ? listFiles(ws.head_snapshot_id) : [];
  const snaps = listSnapshotsForWorkspace(ws.id, 30);
  const subs = listSubscribers(ws.id);

  const selectedPath = sp.path ?? files[0]?.path;
  const selectedRev = sp.rev ?? ws.head_snapshot_id;
  const selectedFile = selectedPath && selectedRev
    ? readFileAt(selectedRev, selectedPath)
    : null;

  const members = listMembers(convId)
    .map((m) => getAgent(m.agent_id))
    .filter((a): a is NonNullable<ReturnType<typeof getAgent>> => !!a);

  const workspaceCount = listWorkspacesForConversation(convId).length;
  const openTasks = listTasksForConversation(convId).filter(
    (t) => t.status !== "done" && t.status !== "cancelled",
  ).length;

  return (
    <div className="min-h-screen bg-[color:var(--color-canvas)]">
      <ConversationTabs
        convId={convId}
        active="workspace"
        workspaceCount={workspaceCount}
        openTaskCount={openTasks}
        title={ws.name}
        subtitle={`head ${shortenSha(ws.head_snapshot_id ?? "")} · ${files.length} files`}
      />
      <main className="max-w-6xl mx-auto p-6 grid grid-cols-1 md:grid-cols-[260px_1fr_300px] gap-5">
        {/* file tree */}
        <aside className="surface p-3 max-h-[70vh] overflow-y-auto">
          <div className="text-[11px] uppercase tracking-wider text-[color:var(--color-ink-soft)] mb-2 px-1">
            Files
          </div>
          {files.length === 0 ? (
            <p className="text-[12px] text-[color:var(--color-ink-soft)] px-1">
              empty — add a file ↓
            </p>
          ) : (
            <ul className="space-y-0.5">
              {files.map((f) => {
                const active = selectedPath === f.path;
                return (
                  <li key={f.path}>
                    <Link
                      href={`/app/c/${convId}/workspace/${ws.id}?path=${encodeURIComponent(f.path)}`}
                      className={
                        "block px-2 py-1 rounded text-[12px] font-mono truncate " +
                        (active
                          ? "bg-[color:var(--color-tint-violet)] text-[color:var(--color-ink)]"
                          : "hover:bg-[color:var(--color-canvas)]")
                      }
                    >
                      {f.path}
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
          <form action={uploadFileAction} className="mt-3 pt-3 border-t border-[color:var(--color-line)] space-y-1.5">
            <input type="hidden" name="conversation_id" value={convId} />
            <input type="hidden" name="workspace_id" value={ws.id} />
            <input
              name="path"
              placeholder="path/new.txt"
              required
              className="input text-[12px] py-1"
            />
            <textarea
              name="content"
              rows={3}
              placeholder="file contents…"
              className="input text-[12px] font-mono"
            />
            <input
              name="commit_message"
              placeholder="commit message"
              className="input text-[12px] py-1"
            />
            <button type="submit" className="btn btn-primary btn-sm w-full">
              Add file
            </button>
          </form>
        </aside>

        {/* selected file / overview */}
        <section className="space-y-4">
          {sp.error ? (
            <div className="callout callout-amber text-[13px]">
              ⚠ {decodeURIComponent(sp.error)}
            </div>
          ) : null}
          {head ? (
            <div className="text-[12px] text-[color:var(--color-ink-soft)]">
              Last commit: <b>{head.commit_message || "—"}</b>{" "}
              {head.created_by_agent_id ? `by ${head.created_by_agent_id}` : ""}
              {" · "}
              <code className="font-mono">{shortenSha(head.id)}</code>
            </div>
          ) : null}

          {selectedFile ? (
            <div className="surface">
              <div className="px-4 py-2 border-b border-[color:var(--color-line)] flex items-center justify-between text-[12px]">
                <div>
                  <code className="font-mono text-[12px]">
                    {selectedFile.file.path}
                  </code>
                  <span className="text-[color:var(--color-ink-soft)] ml-2">
                    {selectedFile.file.size_bytes} bytes ·{" "}
                    {shortenSha(selectedFile.file.content_sha256)}
                  </span>
                </div>
                <form action={deleteFileAction}>
                  <input type="hidden" name="conversation_id" value={convId} />
                  <input type="hidden" name="workspace_id" value={ws.id} />
                  <input
                    type="hidden"
                    name="path"
                    value={selectedFile.file.path}
                  />
                  <button type="submit" className="btn btn-ghost btn-sm">
                    Delete
                  </button>
                </form>
              </div>
              <form action={modifyFileAction} className="p-3 space-y-2">
                <input type="hidden" name="conversation_id" value={convId} />
                <input type="hidden" name="workspace_id" value={ws.id} />
                <input
                  type="hidden"
                  name="against_rev"
                  value={ws.head_snapshot_id ?? ""}
                />
                <input
                  type="hidden"
                  name="path"
                  value={selectedFile.file.path}
                />
                <textarea
                  name="content"
                  rows={18}
                  defaultValue={selectedFile.content.toString("utf8")}
                  className="input text-[12px] font-mono w-full"
                />
                <div className="flex gap-2">
                  <input
                    name="commit_message"
                    placeholder="commit message"
                    className="input text-[12px] py-1 flex-1"
                  />
                  <button type="submit" className="btn btn-primary btn-sm">
                    Commit edit
                  </button>
                </div>
              </form>
            </div>
          ) : (
            <div className="surface p-6 text-center text-[13px] text-[color:var(--color-ink-soft)]">
              Pick a file on the left or add one to begin.
            </div>
          )}

          <section className="surface p-4">
            <div className="font-medium text-[13px] mb-2">Recent snapshots</div>
            <ul className="space-y-2 text-[12px]">
              {snaps.map((s) => {
                const diff = fileDiffSummary(s.parent_snapshot_id, s.id);
                return (
                  <li
                    key={s.id}
                    className="flex items-start justify-between gap-2"
                  >
                    <div className="min-w-0">
                      <div>
                        <code className="font-mono">{shortenSha(s.id)}</code>
                        <span className="ml-2">{s.commit_message || "—"}</span>
                      </div>
                      <div className="text-[11px] text-[color:var(--color-ink-soft)] mt-0.5 flex flex-wrap gap-1">
                        {diff.length === 0 ? (
                          <span>no file changes</span>
                        ) : (
                          diff.slice(0, 6).map((d) => (
                            <span
                              key={d.path}
                              className={
                                d.status === "added"
                                  ? "tag tag-green"
                                  : d.status === "modified"
                                  ? "tag tag-amber"
                                  : "tag tag-pink"
                              }
                            >
                              {d.status === "added"
                                ? "+"
                                : d.status === "deleted"
                                ? "−"
                                : "Δ"}{" "}
                              {d.path}
                            </span>
                          ))
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        </section>

        {/* members panel */}
        <aside className="surface p-3 max-h-[70vh] overflow-y-auto">
          <div className="text-[11px] uppercase tracking-wider text-[color:var(--color-ink-soft)] mb-2 px-1">
            Access ({subs.length})
          </div>
          <ul className="space-y-1.5">
            {members.map((m) => {
              const role = subs.find((s) => s.agent_id === m.id)?.role ?? "none";
              return (
                <li key={m.id} className="px-1">
                  <div className="text-[12px] flex items-center gap-2 mb-1">
                    <span>{m.avatar_emoji}</span>
                    <span className="font-mono truncate">{m.id}</span>
                  </div>
                  <form
                    action={setRoleAction}
                    className="flex items-center gap-1.5"
                  >
                    <input type="hidden" name="conversation_id" value={convId} />
                    <input type="hidden" name="workspace_id" value={ws.id} />
                    <input type="hidden" name="agent_id" value={m.id} />
                    <select
                      name="role"
                      defaultValue={role}
                      className="input text-[12px] py-0.5 flex-1"
                    >
                      <option value="none">none</option>
                      <option value="reader">reader</option>
                      <option value="writer">writer</option>
                      <option value="admin">admin</option>
                    </select>
                    <button type="submit" className="btn btn-secondary btn-sm">
                      Set
                    </button>
                  </form>
                </li>
              );
            })}
          </ul>
        </aside>
      </main>
    </div>
  );
}
