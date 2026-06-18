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
import { WorkspaceUploadButton } from "@/components/WorkspaceUploadButton";
import { MarkdownDoc } from "@/components/MarkdownDoc";

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

  // The client sends a parallel paths_json — JSON-encoded string[] of
  // relative paths matching the order of File entries in "files". This is
  // how folder uploads preserve their structure (webkitRelativePath is
  // dropped by the browser when serialising to FormData). If absent, fall
  // back to f.name.
  let parsedPaths: string[] | null = null;
  const pathsJson = String(formData.get("paths_json") ?? "").trim();
  if (pathsJson) {
    try {
      const v = JSON.parse(pathsJson);
      if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
        parsedPaths = v;
      }
    } catch {
      // ignore malformed sidecar — fall back to filenames
    }
  }

  const files = formData.getAll("files");
  const ops: FileOp[] = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (!(f instanceof File) || f.size === 0) continue;
    if (f.size > MAX_FILE_BYTES) {
      redirect(
        `/app/c/${convId}/workspace/${wsId}?error=${encodeURIComponent(
          `${f.name} is larger than the upload limit (${MAX_FILE_BYTES} bytes).`,
        )}`,
      );
    }
    const buf = Buffer.from(await f.arrayBuffer());
    const rawPath = parsedPaths?.[i] ?? f.name;
    // Per-segment sanitisation: keep folder separators but scrub each
    // segment so dot-prefixed names, control chars, or path traversal
    // (../, /./, leading /) can't sneak in.
    const segments = rawPath
      .split("/")
      .map((seg) => seg.replace(/[^A-Za-z0-9._\- ]/g, "_"))
      .filter((seg) => seg.length > 0 && seg !== "." && seg !== "..");
    if (segments.length === 0) continue;
    const path = prefix
      ? `${prefix.replace(/\/+$/, "")}/${segments.join("/")}`
      : segments.join("/");
    ops.push({ path, op: "create", content: buf });
  }
  if (ops.length === 0) {
    redirect(
      `/app/c/${convId}/workspace/${wsId}?error=${encodeURIComponent(
        "No files were selected.",
      )}`,
    );
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
          "Someone else changed the files at the same time — refresh and try again.",
        )}`,
      );
    }
  } catch (err) {
    redirect(
      `/app/c/${convId}/workspace/${wsId}?error=${encodeURIComponent(
        err instanceof Error ? err.message : "Couldn't upload the files.",
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
        err instanceof Error ? err.message : "Couldn't delete the file.",
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

/** Flat list of file paths in the Finder's display order (folders-first
 *  alphabetical, depth-first) — used by the viewer's Prev/Next links. */
function flattenTreePaths(node: TreeNode, acc: string[] = []): string[] {
  for (const c of sortedChildren(node)) {
    if (c.file) acc.push(c.file.path);
    else flattenTreePaths(c, acc);
  }
  return acc;
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
  searchParams: Promise<{ error?: string; open?: string }>;
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

  // Read-only in-place viewer (?open=<path>). Files are display-only by
  // design — agents edit via tools — but humans reviewing agent work need
  // to READ them without leaving the room.
  const openPath = sp.open && files.some((f) => f.path === sp.open) ? sp.open : null;
  // Prev/Next cycle through files in the Finder's display order.
  const orderedPaths = flattenTreePaths(tree);
  const openIndex = openPath ? orderedPaths.indexOf(openPath) : -1;
  const prevPath = openIndex > 0 ? orderedPaths[openIndex - 1] : null;
  const nextPath =
    openIndex >= 0 && openIndex < orderedPaths.length - 1
      ? orderedPaths[openIndex + 1]
      : null;
  const openFile =
    openPath && ws.head_snapshot_id ? readFileAt(ws.head_snapshot_id, openPath) : null;
  const openKind = openPath ? fileKind(openPath) : "text";
  // Images embed as data URLs (≤2MB) — no extra endpoint, and an <img> can't
  // run scripts even for SVG. Text-ish kinds render inline up to 64KB.
  const openImage =
    openFile && !openFile.missing && openKind === "image" &&
    openFile.content.length <= 2 * 1024 * 1024
      ? `data:${imageMime(openPath!)};base64,${openFile.content.toString("base64")}`
      : null;
  const openText = (() => {
    if (!openFile || openFile.missing || openKind === "image") return null;
    if (openFile.content.length > 64 * 1024) return null;
    if (openFile.content.includes(0)) return null; // NUL byte → binary
    return openFile.content.toString("utf8");
  })();
  const openCsv =
    openText !== null && openKind === "csv" ? parseCsvPreview(openText) : null;

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
        subtitle={`${files.length} file${files.length === 1 ? "" : "s"} · version ${shortenSha(ws.head_snapshot_id ?? "")} · this conversation only`}
      />
      <main className="app-stage-wide grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_300px] gap-5">
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
            openPath={openPath}
          />

          {openPath ? (
            <div id="file-view" className="module-panel overflow-hidden">
              <div className="px-4 py-2.5 border-b border-[color:var(--color-line)] flex items-center justify-between gap-2">
                <div className="font-mono text-[12.5px] truncate">
                  {fileIcon(openPath)} {openPath}
                  {openFile ? (
                    <span className="text-[color:var(--color-ink-soft)] ml-2 text-[11px]">
                      {formatSize(openFile.file.size_bytes)}
                    </span>
                  ) : null}
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  {openIndex >= 0 ? (
                    <span className="flex items-center gap-1.5 text-[12px]">
                      {prevPath ? (
                        <Link
                          href={`/app/c/${convId}/workspace/${ws.id}?open=${encodeURIComponent(prevPath)}#file-view`}
                          className="text-[color:var(--color-ink-soft)] hover:text-[color:var(--color-ink)]"
                          title={`Previous file: ${prevPath}`}
                        >
                          ‹ Prev
                        </Link>
                      ) : (
                        <span className="text-[color:var(--color-ink-soft)] opacity-40 select-none">
                          ‹ Prev
                        </span>
                      )}
                      <span className="text-[11px] text-[color:var(--color-ink-soft)] tabular-nums">
                        {openIndex + 1} / {orderedPaths.length}
                      </span>
                      {nextPath ? (
                        <Link
                          href={`/app/c/${convId}/workspace/${ws.id}?open=${encodeURIComponent(nextPath)}#file-view`}
                          className="text-[color:var(--color-ink-soft)] hover:text-[color:var(--color-ink)]"
                          title={`Next file: ${nextPath}`}
                        >
                          Next ›
                        </Link>
                      ) : (
                        <span className="text-[color:var(--color-ink-soft)] opacity-40 select-none">
                          Next ›
                        </span>
                      )}
                    </span>
                  ) : null}
                  {openFile && !openFile.missing ? (
                    <a
                      href={`/api/v1/workspaces/${ws.id}/files/${openPath
                        .split("/")
                        .map(encodeURIComponent)
                        .join("/")}?download=1`}
                      className="text-[12px] text-[color:var(--color-ink-soft)] hover:text-[color:var(--color-ink)]"
                    >
                      ⬇ Download
                    </a>
                  ) : null}
                  <Link
                    href={`/app/c/${convId}/workspace/${ws.id}`}
                    className="text-[12px] text-[color:var(--color-ink-soft)] hover:text-[color:var(--color-ink)]"
                  >
                    ✕ Close
                  </Link>
                </div>
              </div>
              {!openFile ? (
                <div className="px-4 py-6 text-[12px] text-[color:var(--color-ink-soft)]">
                  File not found at the current version.
                </div>
              ) : openFile.missing ? (
                <div className="px-4 py-6 text-[12px] text-[color:var(--color-amber-ink,#95620a)]">
                  ⚠ This file's content is missing from storage. Re-upload it
                  or restore from a backup.
                </div>
              ) : openImage ? (
                /* eslint-disable-next-line @next/next/no-img-element */
                <div className="p-4 bg-[color:var(--color-canvas)] max-h-[560px] overflow-auto">
                  <img
                    src={openImage}
                    alt={openPath}
                    className="max-w-full h-auto rounded-lg border border-[color:var(--color-line)] bg-white"
                  />
                </div>
              ) : openCsv ? (
                <div className="overflow-auto max-h-[480px]">
                  <table className="w-full text-[12.5px] border-collapse">
                    <thead className="sticky top-0">
                      <tr>
                        {openCsv.header.map((h, i) => (
                          <th
                            key={i}
                            className="text-left font-semibold px-3 py-2 bg-[color:var(--color-paper-strong)] border-b border-[color:var(--color-line)] whitespace-nowrap"
                          >
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {openCsv.rows.map((row, ri) => (
                        <tr key={ri} className="odd:bg-[color:var(--color-canvas)]/60">
                          {row.map((cell, ci) => (
                            <td
                              key={ci}
                              className="px-3 py-1.5 border-b border-[color:var(--color-line)] align-top"
                            >
                              {cell}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {openCsv.truncated ? (
                    <div className="px-3 py-2 text-[11px] text-[color:var(--color-ink-soft)]">
                      Showing the first {openCsv.rows.length} rows — download
                      the file for the rest.
                    </div>
                  ) : null}
                </div>
              ) : openText !== null && openKind === "markdown" ? (
                <div className="px-6 py-5 bg-white max-h-[560px] overflow-y-auto text-[14px] leading-[1.7]">
                  <MarkdownDoc text={openText} />
                </div>
              ) : openText !== null ? (
                <ol className="px-0 py-2 text-[12.5px] leading-[1.6] font-mono max-h-[480px] overflow-auto bg-[color:var(--color-canvas)] list-none m-0">
                  {openText.split("\n").map((line, i) => (
                    <li key={i} className="flex">
                      <span className="select-none w-10 shrink-0 text-right pr-3 text-[color:var(--color-ink-soft)] tabular-nums">
                        {i + 1}
                      </span>
                      <span className="whitespace-pre-wrap break-words flex-1 pr-4">
                        {line || "\u00A0"}
                      </span>
                    </li>
                  ))}
                </ol>
              ) : (
                <div className="px-4 py-6 text-[12px] text-[color:var(--color-ink-soft)]">
                  No inline preview for this file type or size (
                  {formatSize(openFile.file.size_bytes)}) — use Download.
                </div>
              )}
              <div className="px-4 py-2 border-t border-[color:var(--color-line)] text-[11px] text-[color:var(--color-ink-soft)]">
                Read-only — your assistant edits files when you ask it to in
                chat.
              </div>
            </div>
          ) : null}

          {/* Upload — one click, picks files from OS, auto-submits */}
          <WorkspaceUploadButton
            convId={convId}
            wsId={ws.id}
            action={uploadFilesAction}
          />

          {head ? (
            <div className="text-[11px] text-[color:var(--color-ink-soft)] px-1">
              Last change: <b>{head.commit_message || "—"}</b>{" "}
              {head.created_by_agent_id ? (
                <>by <code className="font-mono">{head.created_by_agent_id}</code></>
              ) : null}{" "}
              ·{" "}
              <Link
                href={`/app/c/${convId}/workspace/${ws.id}/snap/${head.id}`}
                className="underline"
              >
                see what changed
              </Link>
              {snaps.length > 1 ? (
                <>
                  {" · "}
                  <details className="inline">
                    <summary className="cursor-pointer inline">
                      {snaps.length} versions
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
        <aside className="module-panel p-3 max-h-[80vh] overflow-y-auto xl:sticky xl:top-4 self-start">
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
                      <option value="none">no access</option>
                      <option value="reader">view</option>
                      <option value="writer">edit</option>
                      <option value="admin">manage</option>
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
            Only members of this conversation can see these files.
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


// ──────────────────────────────────────────────────────────────────────────
// File viewer helpers — Lark-style per-kind presentation
// ──────────────────────────────────────────────────────────────────────────

type FileKind = "markdown" | "image" | "csv" | "text";

function fileKind(path: string): FileKind {
  const ext = (path.split(".").pop() ?? "").toLowerCase();
  if (ext === "md" || ext === "markdown") return "markdown";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)) return "image";
  if (ext === "csv" || ext === "tsv") return "csv";
  return "text";
}

function imageMime(path: string): string {
  const ext = (path.split(".").pop() ?? "").toLowerCase();
  return (
    {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
      svg: "image/svg+xml",
    }[ext] ?? "application/octet-stream"
  );
}

/** Tiny CSV/TSV preview parser: handles quoted fields + embedded commas and
 *  newlines well enough for a table preview; anything beyond 200 rows or 30
 *  columns is truncated (the Download button has the full file). Returns
 *  null when the input doesn't look tabular (≤1 column). */
function parseCsvPreview(
  text: string,
): { header: string[]; rows: string[][]; truncated: boolean } | null {
  const sep = text.includes("\t") && !text.split("\n")[0]?.includes(",") ? "\t" : ",";
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length && rows.length <= 200; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === sep) pushField();
    else if (c === "\n") pushRow();
    else if (c !== "\r") field += c;
  }
  if (field.length > 0 || row.length > 0) pushRow();
  const nonEmpty = rows.filter((r) => r.some((c) => c.trim().length > 0));
  if (nonEmpty.length < 1 || (nonEmpty[0]?.length ?? 0) < 2) return null;
  const truncated = nonEmpty.length > 200;
  const header = nonEmpty[0].slice(0, 30);
  const body = nonEmpty.slice(1, 201).map((r) => {
    const padded = r.slice(0, 30);
    while (padded.length < header.length) padded.push("");
    return padded;
  });
  return { header, rows: body, truncated };
}

function FinderArea({
  root,
  convId,
  wsId,
  fileCount,
  openPath,
}: {
  root: TreeNode;
  convId: string;
  wsId: string;
  fileCount: number;
  openPath: string | null;
}) {
  return (
    <div className="module-panel overflow-hidden">
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
            <Node
              key={c.fullPath}
              node={c}
              depth={0}
              convId={convId}
              wsId={wsId}
              openPath={openPath}
            />
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
  openPath,
}: {
  node: TreeNode;
  depth: number;
  convId: string;
  wsId: string;
  openPath: string | null;
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
        openPath={openPath}
      />
    );
  }
  // Folder. Auto-expand when it contains the currently open file so the
  // highlighted row is always visible.
  const count = countDescendants(node);
  const containsOpen =
    openPath !== null && openPath.startsWith(`${node.fullPath}/`);
  return (
    <li>
      <details open={containsOpen || undefined}>
        <summary
          className="flex items-center gap-1.5 py-1 px-3 cursor-pointer select-none hover:bg-[color:var(--color-canvas)] transition-colors text-[13px]"
          style={{ paddingLeft: 12 + depth * 16 }}
        >
          <span
            className="text-[10px] text-[color:var(--color-ink-soft)] inline-block text-center"
            style={{ width: "0.75rem" }}
          >
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
              openPath={openPath}
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
  openPath,
}: {
  path: string;
  name: string;
  size: number;
  depth: number;
  convId: string;
  wsId: string;
  openPath: string | null;
}) {
  // Files are display-only in the UI per design — agents do the EDITING via
  // tools. But humans reviewing agent work must be able to READ them, so the
  // name links to `?open=<path>` which expands a read-only viewer below the
  // Finder (server-rendered, no client state). The ✕ button submits the
  // hidden delete form rendered in the page's right aside, so we avoid
  // nesting <form> inside <form>.
  const isOpen = openPath === path;
  // Finder-style: files at the same depth align with sibling folders.
  // Both use `paddingLeft: 12 + depth * 16`. The first column is a
  // fixed-width chevron column (empty for files, ▸/▾ for folders) so
  // the icon column lines up identically.
  return (
    <li
      className={`group flex items-center gap-1.5 py-1 px-3 hover:bg-[color:var(--color-canvas)] transition-colors text-[13px] ${
        isOpen ? "bg-[color:var(--color-canvas)]" : ""
      }`}
      style={{ paddingLeft: 12 + depth * 16 }}
    >
      <span
        className="text-[10px] text-[color:var(--color-ink-soft)] inline-block"
        style={{ width: "0.75rem" }}
        aria-hidden="true"
      />
      <span>{fileIcon(name)}</span>
      <Link
        href={
          isOpen
            ? `/app/c/${convId}/workspace/${wsId}`
            : `/app/c/${convId}/workspace/${wsId}?open=${encodeURIComponent(path)}#file-view`
        }
        className={`flex-1 truncate font-mono hover:underline underline-offset-2 ${
          isOpen ? "font-semibold" : ""
        }`}
        title={isOpen ? `Close ${path}` : `View ${path}`}
      >
        {name}
      </Link>
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
