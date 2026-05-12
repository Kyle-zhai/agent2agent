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

// ──────────────────────────────────────────────────────────────────────────
// Server actions
// ──────────────────────────────────────────────────────────────────────────

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
          "conflict — refresh and try again",
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
// Tree helpers
// ──────────────────────────────────────────────────────────────────────────

type FileMeta = {
  path: string;
  content_sha256: string;
  size_bytes: number;
};

type TreeNode = {
  name: string;
  fullPath: string;
  file?: FileMeta;
  children?: Map<string, TreeNode>;
};

function buildTree(files: FileMeta[]): TreeNode {
  const root: TreeNode = {
    name: "",
    fullPath: "",
    children: new Map(),
  };
  for (const f of files) {
    const parts = f.path.split("/").filter((p) => p.length > 0);
    let cur = root;
    for (let i = 0; i < parts.length; i++) {
      const isLeaf = i === parts.length - 1;
      const name = parts[i];
      if (!cur.children) cur.children = new Map();
      let next = cur.children.get(name);
      if (!next) {
        next = {
          name,
          fullPath: parts.slice(0, i + 1).join("/"),
          ...(isLeaf ? { file: f } : { children: new Map() }),
        };
        cur.children.set(name, next);
      }
      cur = next;
    }
  }
  return root;
}

function sortedChildren(node: TreeNode): TreeNode[] {
  if (!node.children) return [];
  return [...node.children.values()].sort((a, b) => {
    // Folders first, then files; alphabetical within each.
    const aIsFolder = !a.file;
    const bIsFolder = !b.file;
    if (aIsFolder !== bIsFolder) return aIsFolder ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function countDescendants(node: TreeNode): number {
  if (node.file) return 1;
  let n = 0;
  for (const c of node.children?.values() ?? []) n += countDescendants(c);
  return n;
}

function fileIcon(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) return "🖼";
  if (ext === "md") return "📝";
  if (ext === "json") return "⚙";
  if (ext === "sql") return "🗄";
  if (["sh", "bash"].includes(ext)) return "💻";
  if (["py", "ts", "tsx", "js"].includes(ext)) return "🧩";
  if (ext === "pdf") return "📕";
  return "📄";
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

// ──────────────────────────────────────────────────────────────────────────
// Page
// ──────────────────────────────────────────────────────────────────────────

export default async function WorkspaceDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; wsId: string }>;
  searchParams: Promise<{ error?: string }>;
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

  const tree = buildTree(files);

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
        subtitle={`${files.length} file${files.length === 1 ? "" : "s"} · ${shortenSha(ws.head_snapshot_id ?? "")} · this room only`}
      />
      <main className="max-w-5xl mx-auto p-6 grid grid-cols-1 md:grid-cols-[1fr_240px] gap-5">
        {/* ─── LEFT: Finder-style file area ─────────────── */}
        <section className="space-y-3">
          {sp.error ? (
            <div className="callout callout-amber text-[13px]">
              ⚠ {decodeURIComponent(sp.error)}
            </div>
          ) : null}

          <FinderArea
            root={tree}
            convId={convId}
            wsId={ws.id}
            fileCount={files.length}
          />

          {/* Upload */}
          <form
            action={uploadFilesAction}
            className="surface p-3 flex items-center gap-2 flex-wrap"
          >
            <input type="hidden" name="conversation_id" value={convId} />
            <input type="hidden" name="workspace_id" value={ws.id} />
            <input
              type="file"
              name="files"
              multiple
              className="text-[12px] flex-1 min-w-[180px]"
            />
            <input
              name="prefix"
              placeholder="folder/ (optional)"
              className="input text-[12px] py-1 w-[160px]"
            />
            <button type="submit" className="btn btn-primary btn-sm">
              Upload
            </button>
          </form>

          {head ? (
            <div className="text-[11px] text-[color:var(--color-ink-soft)] px-1">
              Last commit: <b>{head.commit_message || "—"}</b>{" "}
              {head.created_by_agent_id ? (
                <>by <code className="font-mono">{head.created_by_agent_id}</code></>
              ) : null}{" "}
              ·{" "}
              <Link
                href={`/app/c/${convId}/workspace/${ws.id}/snap/${head.id}`}
                className="underline"
              >
                view diff
              </Link>
              {snaps.length > 1 ? (
                <>
                  {" · "}
                  <details className="inline">
                    <summary className="cursor-pointer inline">
                      {snaps.length} snapshots
                    </summary>
                    <ul className="mt-1 ml-2 space-y-0.5">
                      {snaps.map((s) => (
                        <li key={s.id}>
                          <Link
                            href={`/app/c/${convId}/workspace/${ws.id}/snap/${s.id}`}
                            className="font-mono underline"
                          >
                            {shortenSha(s.id)}
                          </Link>{" "}
                          {s.commit_message || "—"}
                        </li>
                      ))}
                    </ul>
                  </details>
                </>
              ) : null}
            </div>
          ) : null}
        </section>

        {/* ─── RIGHT: Access ─────────── */}
        <aside className="surface p-3 max-h-[80vh] overflow-y-auto md:sticky md:top-4 self-start">
          <div className="text-[10px] uppercase tracking-wider text-[color:var(--color-ink-soft)] mb-2 px-1">
            Access ({subs.length})
          </div>
          <ul className="space-y-1.5">
            {members.map((m) => {
              const role =
                subs.find((s) => s.agent_id === m.id)?.role ?? "none";
              return (
                <li key={m.id} className="px-1">
                  <div className="text-[12px] flex items-center gap-1.5 mb-0.5 truncate">
                    <span>{m.avatar_emoji}</span>
                    <span className="font-mono truncate">{m.id}</span>
                  </div>
                  <form action={setRoleAction} className="flex items-center gap-1">
                    <input type="hidden" name="conversation_id" value={convId} />
                    <input type="hidden" name="workspace_id" value={ws.id} />
                    <input type="hidden" name="agent_id" value={m.id} />
                    <select
                      name="role"
                      defaultValue={role}
                      className="input text-[11px] py-0.5 flex-1"
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
            Bound to this conversation. Outsiders can't reach it.
          </p>

          {/* Hidden delete forms — one per file. We render them in the aside
              so the visible delete buttons in FileRow can target them via
              `form="del-<id>"` without nesting <form> in <form>. */}
          {files.map((f) => (
            <form
              key={`delform-${f.path}`}
              id={`del-${cssIdFor(f.path)}`}
              action={deleteFileAction}
              className="hidden"
            >
              <input type="hidden" name="conversation_id" value={convId} />
              <input type="hidden" name="workspace_id" value={ws.id} />
              <input type="hidden" name="path" value={f.path} />
            </form>
          ))}
        </aside>
      </main>
    </div>
  );
}

// CSS-safe id for use in `form=` attribute referencing.
function cssIdFor(path: string): string {
  return path.replace(/[^A-Za-z0-9_-]/g, "_");
}

// ──────────────────────────────────────────────────────────────────────────
// Finder-style file area
// ──────────────────────────────────────────────────────────────────────────

function FinderArea({
  root,
  convId,
  wsId,
  fileCount,
}: {
  root: TreeNode;
  convId: string;
  wsId: string;
  fileCount: number;
}) {
  return (
    <div className="surface overflow-hidden">
      <div className="px-4 py-2.5 border-b border-[color:var(--color-line)] flex items-center justify-between">
        <div className="font-semibold text-[13px]">
          📁 Files{" "}
          <span className="text-[color:var(--color-ink-soft)] font-normal">
            ({fileCount})
          </span>
        </div>
        <div className="text-[10px] text-[color:var(--color-ink-soft)]">
          live
        </div>
      </div>
      {fileCount === 0 ? (
        <div className="px-4 py-10 text-center text-[12px] text-[color:var(--color-ink-soft)]">
          Empty — upload below.
        </div>
      ) : (
        <ul className="py-1">
          {sortedChildren(root).map((c) => (
            <Node key={c.fullPath} node={c} depth={0} convId={convId} wsId={wsId} />
          ))}
        </ul>
      )}
    </div>
  );
}

function Node({
  node,
  depth,
  convId,
  wsId,
}: {
  node: TreeNode;
  depth: number;
  convId: string;
  wsId: string;
}) {
  if (node.file) {
    return (
      <FileLeaf
        path={node.file.path}
        name={node.name}
        size={node.file.size_bytes}
        depth={depth}
        convId={convId}
        wsId={wsId}
      />
    );
  }
  // Folder
  const count = countDescendants(node);
  return (
    <li>
      <details>
        <summary
          className="flex items-center gap-1.5 py-1 px-3 cursor-pointer select-none hover:bg-[color:var(--color-canvas)] transition-colors text-[13px]"
          style={{ paddingLeft: 12 + depth * 16 }}
        >
          <span className="text-[10px] text-[color:var(--color-ink-soft)] inline-block w-3">
            ▸
          </span>
          <span>📁</span>
          <span className="flex-1 truncate">{node.name}</span>
          <span className="text-[11px] text-[color:var(--color-ink-soft)] tabular-nums">
            {count} item{count === 1 ? "" : "s"}
          </span>
        </summary>
        <ul>
          {sortedChildren(node).map((c) => (
            <Node
              key={c.fullPath}
              node={c}
              depth={depth + 1}
              convId={convId}
              wsId={wsId}
            />
          ))}
        </ul>
      </details>
    </li>
  );
}

function FileLeaf({
  path,
  name,
  size,
  depth,
  convId,
  wsId,
}: {
  path: string;
  name: string;
  size: number;
  depth: number;
  convId: string;
  wsId: string;
}) {
  // Note: we do NOT render an inline edit form here (per design — files are
  // display-only in the UI; agents do the editing via tools). The ✕ button
  // submits the hidden delete form rendered in the page's right aside, so we
  // avoid nesting <form> inside <form>.
  void convId;
  void wsId;
  return (
    <li
      className="group flex items-center gap-1.5 py-1 px-3 hover:bg-[color:var(--color-canvas)] transition-colors text-[13px]"
      style={{ paddingLeft: 12 + (depth + 0.6) * 16 }}
    >
      <span className="text-[10px] text-[color:var(--color-ink-soft)] inline-block w-3">
        {" "}
      </span>
      <span>{fileIcon(name)}</span>
      <span className="flex-1 truncate font-mono">{name}</span>
      <span className="text-[11px] text-[color:var(--color-ink-soft)] tabular-nums">
        {formatSize(size)}
      </span>
      <button
        type="submit"
        form={`del-${cssIdFor(path)}`}
        title={`Delete ${path}`}
        className="opacity-0 group-hover:opacity-100 transition-opacity text-[color:var(--color-ink-soft)] hover:text-[color:var(--color-danger)] px-1 text-[12px]"
      >
        ✕
      </button>
    </li>
  );
}
