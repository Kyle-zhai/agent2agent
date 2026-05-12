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
  MAX_FILE_BYTES,
  type FileOp,
} from "@/lib/workspaces";
import { listTasksForConversation } from "@/lib/tasks";
import { getAgent } from "@/lib/agents";
import { ConversationTabs } from "@/components/ConversationTabs";
import { ConversationSSE } from "@/components/ConversationSSE";

export const dynamic = "force-dynamic";

const PREVIEW_BYTE_CAP = 200 * 1024;

// ──────────────────────────────────────────────────────────────────────────
// Server actions
// ──────────────────────────────────────────────────────────────────────────

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
      // Route to the resolve page with the user's content preserved.
      const u = new URLSearchParams({
        path,
        my_content: content,
        against_rev: againstRev,
      });
      redirect(`/app/c/${convId}/workspace/${wsId}/resolve?${u}`);
    }
  } catch (err) {
    redirect(
      `/app/c/${convId}/workspace/${wsId}?error=${encodeURIComponent(
        err instanceof Error ? err.message : "Edit failed.",
      )}`,
    );
  }
  revalidatePath(`/app/c/${convId}/workspace/${wsId}`);
  redirect(
    `/app/c/${convId}/workspace/${wsId}?open=${encodeURIComponent(path)}`,
  );
}

async function uploadFilesAction(formData: FormData) {
  "use server";
  const user = await requireUser();
  const convId = String(formData.get("conversation_id") ?? "");
  const wsId = String(formData.get("workspace_id") ?? "");
  const prefix = String(formData.get("prefix") ?? "").trim();
  const { myAgentId } = requireUserMember(convId, user.id);
  const ws = getWorkspace(wsId);
  if (!ws) notFound();

  const ops: FileOp[] = [];
  for (const f of formData.getAll("files")) {
    if (!(f instanceof File) || f.size === 0) continue;
    if (f.size > MAX_FILE_BYTES) {
      redirect(
        `/app/c/${convId}/workspace/${wsId}?error=${encodeURIComponent(
          `${f.name} > ${MAX_FILE_BYTES} bytes`,
        )}`,
      );
    }
    const buf = Buffer.from(await f.arrayBuffer());
    const safeName = f.name.replace(/[^A-Za-z0-9._\- ]/g, "_");
    const path = prefix ? `${prefix.replace(/\/+$/, "")}/${safeName}` : safeName;
    ops.push({ path, op: "create", content: buf });
  }
  if (ops.length === 0) {
    redirect(`/app/c/${convId}/workspace/${wsId}?error=no+files`);
  }
  try {
    const r = applyPatch({
      workspace_id: ws.id,
      agent_id: myAgentId,
      against_rev: ws.head_snapshot_id!,
      ops,
      commit_message:
        ops.length === 1
          ? `upload ${ops[0].path}`
          : `upload ${ops.length} files`,
    });
    if (!r.ok) {
      redirect(
        `/app/c/${convId}/workspace/${wsId}?error=${encodeURIComponent(
          `conflict — refresh and try again`,
        )}`,
      );
    }
  } catch (err) {
    redirect(
      `/app/c/${convId}/workspace/${wsId}?error=${encodeURIComponent(
        err instanceof Error ? err.message : "Upload failed.",
      )}`,
    );
  }
  revalidatePath(`/app/c/${convId}/workspace/${wsId}`);
  redirect(`/app/c/${convId}/workspace/${wsId}`);
}

async function createInlineFileAction(formData: FormData) {
  "use server";
  const user = await requireUser();
  const convId = String(formData.get("conversation_id") ?? "");
  const wsId = String(formData.get("workspace_id") ?? "");
  const path = String(formData.get("path") ?? "").trim();
  const content = String(formData.get("content") ?? "");
  const { myAgentId } = requireUserMember(convId, user.id);
  const ws = getWorkspace(wsId);
  if (!ws) notFound();
  if (!path) {
    redirect(`/app/c/${convId}/workspace/${wsId}?error=path+required`);
  }
  try {
    applyPatch({
      workspace_id: ws.id,
      agent_id: myAgentId,
      against_rev: ws.head_snapshot_id!,
      ops: [{ path, op: "create", content }],
      commit_message: `add ${path}`,
    });
  } catch (err) {
    redirect(
      `/app/c/${convId}/workspace/${wsId}?error=${encodeURIComponent(
        err instanceof Error ? err.message : "Add failed.",
      )}`,
    );
  }
  revalidatePath(`/app/c/${convId}/workspace/${wsId}`);
  redirect(
    `/app/c/${convId}/workspace/${wsId}?open=${encodeURIComponent(path)}`,
  );
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

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

function fileIcon(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (
    ext === "png" ||
    ext === "jpg" ||
    ext === "jpeg" ||
    ext === "gif" ||
    ext === "webp"
  )
    return "🖼";
  if (ext === "md") return "📝";
  if (ext === "json") return "⚙";
  if (ext === "sql") return "🗄";
  if (ext === "sh" || ext === "bash") return "💻";
  if (ext === "py" || ext === "ts" || ext === "tsx" || ext === "js")
    return "🧩";
  if (ext === "pdf") return "📕";
  return "📄";
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function isLikelyText(buf: Buffer): boolean {
  // Quick heuristic: any NUL byte in the first 8KB → binary.
  const slice = buf.subarray(0, Math.min(buf.length, 8192));
  for (let i = 0; i < slice.length; i++) {
    if (slice[i] === 0) return false;
  }
  return true;
}

// ──────────────────────────────────────────────────────────────────────────
// Page
// ──────────────────────────────────────────────────────────────────────────

export default async function WorkspaceDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; wsId: string }>;
  searchParams: Promise<{ error?: string; open?: string; rev?: string }>;
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
    subscribeAgent(ws.id, myAgentId, "writer");
  }

  const head = ws.head_snapshot_id ? getSnapshot(ws.head_snapshot_id) : null;
  const files = ws.head_snapshot_id ? listFiles(ws.head_snapshot_id) : [];
  const snaps = listSnapshotsForWorkspace(ws.id, 20);
  const subs = listSubscribers(ws.id);
  const members = listMembers(convId)
    .map((m) => getAgent(m.agent_id))
    .filter((a): a is NonNullable<ReturnType<typeof getAgent>> => !!a);

  const openPath = sp.open ?? null;

  const workspaceCount = listWorkspacesForConversation(convId).length;
  const openTasks = listTasksForConversation(convId).filter(
    (t) => t.status !== "done" && t.status !== "cancelled",
  ).length;

  return (
    <div className="min-h-screen bg-[color:var(--color-canvas)]">
      <ConversationSSE
        convId={convId}
        relevantKinds={["workspace.changed", "task.status_changed"]}
      />
      <ConversationTabs
        convId={convId}
        active="workspace"
        workspaceCount={workspaceCount}
        openTaskCount={openTasks}
        title={ws.name}
        subtitle={`${files.length} file${files.length === 1 ? "" : "s"} · head ${shortenSha(ws.head_snapshot_id ?? "")} · this room only`}
      />
      <main className="max-w-6xl mx-auto p-6 grid grid-cols-1 md:grid-cols-[1fr_280px] gap-5">
        {/* ─── LEFT: big files area ─────────────────────── */}
        <section className="space-y-3">
          {sp.error ? (
            <div className="callout callout-amber text-[13px]">
              ⚠ {decodeURIComponent(sp.error)}
            </div>
          ) : null}

          {head ? (
            <div className="text-[12px] text-[color:var(--color-ink-soft)]">
              Last commit:{" "}
              <b className="text-[color:var(--color-ink)]">
                {head.commit_message || "—"}
              </b>
              {head.created_by_agent_id ? (
                <> by <code className="font-mono">{head.created_by_agent_id}</code></>
              ) : null}{" "}
              · {new Date(head.created_at).toLocaleString()} ·{" "}
              <Link
                href={`/app/c/${convId}/workspace/${ws.id}/snap/${head.id}`}
                className="underline"
              >
                diff
              </Link>
            </div>
          ) : null}

          <div className="surface overflow-hidden">
            <div className="px-4 py-2.5 border-b border-[color:var(--color-line)] flex items-center justify-between">
              <div className="font-semibold text-[14px]">
                📁 Files{" "}
                <span className="text-[color:var(--color-ink-soft)] font-normal">
                  ({files.length})
                </span>
              </div>
              <div className="text-[11px] text-[color:var(--color-ink-soft)]">
                live · refresh on agent changes
              </div>
            </div>

            {files.length === 0 ? (
              <div className="px-4 py-10 text-center text-[13px] text-[color:var(--color-ink-soft)]">
                This workspace is empty. Upload files below or have one of your
                agents call <code className="font-mono">workspace.write_file</code>.
              </div>
            ) : (
              <ul className="divide-y divide-[color:var(--color-line)]">
                {files.map((f) => {
                  const expanded = openPath === f.path;
                  const isImage = /\.(png|jpe?g|gif|webp)$/i.test(f.path);
                  const isBinary = !isImage; // refined inside on read
                  void isBinary;
                  return (
                    <li key={f.path} id={`f-${encodeURIComponent(f.path)}`}>
                      <FileRow
                        f={f}
                        expanded={expanded}
                        convId={convId}
                        wsId={ws.id}
                        headRev={ws.head_snapshot_id!}
                      />
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* ─── Bottom: upload + add by path ─────────────── */}
          <div className="surface p-4 space-y-3">
            <div className="text-[13px] font-medium">⬆ Upload local files</div>
            <form action={uploadFilesAction} className="space-y-2">
              <input type="hidden" name="conversation_id" value={convId} />
              <input type="hidden" name="workspace_id" value={ws.id} />
              <input
                type="file"
                name="files"
                multiple
                className="text-[12px] block"
              />
              <input
                name="prefix"
                placeholder="optional folder prefix, e.g. notes/"
                className="input text-[12px] py-1"
              />
              <button type="submit" className="btn btn-primary btn-sm w-full">
                Upload to workspace
              </button>
              <p className="text-[11px] text-[color:var(--color-ink-soft)]">
                Single file ≤ {formatSize(MAX_FILE_BYTES)}. Agents see the new
                file immediately and can re-organize it.
              </p>
            </form>

            <details className="text-[12px] mt-1">
              <summary className="cursor-pointer text-[color:var(--color-ink-soft)] select-none">
                Or add a text file by path…
              </summary>
              <form
                action={createInlineFileAction}
                className="space-y-1.5 mt-2"
              >
                <input type="hidden" name="conversation_id" value={convId} />
                <input type="hidden" name="workspace_id" value={ws.id} />
                <input
                  name="path"
                  required
                  placeholder="path/new.md"
                  className="input text-[12px] py-1"
                />
                <textarea
                  name="content"
                  rows={4}
                  placeholder="content…"
                  className="input text-[12px] font-mono"
                />
                <button type="submit" className="btn btn-secondary btn-sm w-full">
                  Create
                </button>
              </form>
            </details>
          </div>

          <details className="surface text-[12px]">
            <summary className="px-4 py-2 cursor-pointer select-none flex items-center justify-between">
              <span>Recent snapshots ({snaps.length})</span>
              <span className="text-[10px] text-[color:var(--color-ink-soft)]">
                history
              </span>
            </summary>
            <ul className="px-4 pb-3 space-y-1.5">
              {snaps.map((s) => {
                const diff = fileDiffSummary(s.parent_snapshot_id, s.id);
                return (
                  <li
                    key={s.id}
                    className="flex items-center justify-between gap-2"
                  >
                    <div className="min-w-0">
                      <Link
                        href={`/app/c/${convId}/workspace/${ws.id}/snap/${s.id}`}
                        className="font-mono underline"
                      >
                        {shortenSha(s.id)}
                      </Link>{" "}
                      <span>{s.commit_message || "—"}</span>
                    </div>
                    <span className="text-[10px] text-[color:var(--color-ink-soft)]">
                      {diff.length} file{diff.length === 1 ? "" : "s"}
                    </span>
                  </li>
                );
              })}
            </ul>
          </details>
        </section>

        {/* ─── RIGHT: Access panel (preserved) ─────────── */}
        <aside className="surface p-3 max-h-[80vh] overflow-y-auto md:sticky md:top-4 self-start">
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
          <p className="text-[10px] text-[color:var(--color-ink-soft)] mt-3 px-1 leading-relaxed">
            This workspace is bound to this conversation. Only members of the
            room reach it; agents on the outside cannot.
          </p>
        </aside>
      </main>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// File row — collapsed by default, expanded preview when ?open=path
// ──────────────────────────────────────────────────────────────────────────

function FileRow({
  f,
  expanded,
  convId,
  wsId,
  headRev,
}: {
  f: {
    snapshot_id: string;
    path: string;
    content_sha256: string;
    size_bytes: number;
  };
  expanded: boolean;
  convId: string;
  wsId: string;
  headRev: string;
}) {
  const isImage = /\.(png|jpe?g|gif|webp)$/i.test(f.path);
  // Cap preview reads so a huge file doesn't tank the page.
  const tooLarge = f.size_bytes > PREVIEW_BYTE_CAP;
  let bodyText = "";
  let binary = false;
  let missing = false;
  if (expanded && !tooLarge) {
    const rf = readFileAt(headRev, f.path);
    if (rf) {
      missing = !!rf.missing;
      binary = !isLikelyText(rf.content);
      if (!binary) bodyText = rf.content.toString("utf8");
    }
  }
  const closeUrl = `/app/c/${convId}/workspace/${wsId}`;
  const openUrl = `/app/c/${convId}/workspace/${wsId}?open=${encodeURIComponent(f.path)}`;

  return (
    <>
      <Link
        href={expanded ? closeUrl : openUrl}
        className="flex items-center gap-2 px-4 py-2 hover:bg-[color:var(--color-canvas)] transition-colors"
      >
        <span className="text-base">{fileIcon(f.path)}</span>
        <span className="font-mono text-[13px] truncate flex-1">{f.path}</span>
        <span className="text-[11px] text-[color:var(--color-ink-soft)] tabular-nums">
          {formatSize(f.size_bytes)}
        </span>
        <span className="text-[color:var(--color-ink-soft)] text-[12px]">
          {expanded ? "▴" : "▾"}
        </span>
      </Link>
      {expanded ? (
        <div className="px-4 pb-4 pt-1 bg-[color:var(--color-canvas)]/40 border-t border-[color:var(--color-line)]">
          {tooLarge ? (
            <p className="text-[12px] text-[color:var(--color-ink-soft)] italic">
              File too large to preview ({formatSize(f.size_bytes)}). Use the
              v1 REST API to fetch raw bytes.
            </p>
          ) : isImage ? (
            <p className="text-[12px] text-[color:var(--color-ink-soft)] italic">
              Image preview is not yet wired through the workspace blob route —
              v1 REST returns raw bytes if you need them.
            </p>
          ) : missing ? (
            <p className="text-[12px] text-[color:var(--color-tint-pink-ink)]">
              Blob missing on disk — DB row exists, file lost. Re-upload to
              restore.
            </p>
          ) : binary ? (
            <p className="text-[12px] text-[color:var(--color-ink-soft)] italic">
              Binary file — preview suppressed.
            </p>
          ) : (
            <form action={modifyFileAction} className="space-y-2">
              <input type="hidden" name="conversation_id" value={convId} />
              <input type="hidden" name="workspace_id" value={wsId} />
              <input type="hidden" name="against_rev" value={headRev} />
              <input type="hidden" name="path" value={f.path} />
              <textarea
                name="content"
                defaultValue={bodyText}
                rows={Math.min(28, Math.max(6, bodyText.split("\n").length + 1))}
                className="input text-[12px] font-mono w-full"
              />
              <div className="flex items-center gap-2">
                <input
                  name="commit_message"
                  placeholder="commit message (optional)"
                  className="input text-[12px] py-1 flex-1"
                />
                <button type="submit" className="btn btn-primary btn-sm">
                  Save
                </button>
                <form action={deleteFileAction} className="contents">
                  <input type="hidden" name="conversation_id" value={convId} />
                  <input type="hidden" name="workspace_id" value={wsId} />
                  <input type="hidden" name="path" value={f.path} />
                  <button type="submit" className="btn btn-ghost btn-sm">
                    Delete
                  </button>
                </form>
              </div>
              <p className="text-[10px] text-[color:var(--color-ink-soft)]">
                Edits commit a new snapshot. SSE pushes the change to everyone
                viewing this room.
              </p>
            </form>
          )}
        </div>
      ) : null}
    </>
  );
}
