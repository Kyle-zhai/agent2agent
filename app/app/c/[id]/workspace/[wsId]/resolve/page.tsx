import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import {
  getConversation,
  requireUserMember,
} from "@/lib/conversations";
import {
  applyPatch,
  canRead,
  getWorkspace,
  listWorkspacesForConversation,
  readFileAt,
  shortenSha,
} from "@/lib/workspaces";
import { listTasksForConversation } from "@/lib/tasks";
import { diffLines, type DiffLine } from "@/lib/diff";
import { ConversationTabs } from "@/components/ConversationTabs";

export const dynamic = "force-dynamic";

async function resolveAction(formData: FormData) {
  "use server";
  const user = await requireUser();
  const convId = String(formData.get("conversation_id") ?? "");
  const wsId = String(formData.get("workspace_id") ?? "");
  const path = String(formData.get("path") ?? "");
  const choice = String(formData.get("choice") ?? "");
  const manualContent = String(formData.get("manual_content") ?? "");
  const { myAgentId } = requireUserMember(convId, user.id);
  const ws = getWorkspace(wsId);
  if (!ws) notFound();

  let content: string;
  if (choice === "mine") {
    content = String(formData.get("my_content") ?? "");
  } else if (choice === "theirs") {
    // No change needed — just don't write. Bail out without an apply.
    redirect(
      `/app/c/${convId}/workspace/${wsId}?path=${encodeURIComponent(path)}&kept=theirs`,
    );
  } else if (choice === "manual") {
    content = manualContent;
  } else {
    redirect(
      `/app/c/${convId}/workspace/${wsId}/resolve?path=${encodeURIComponent(path)}&my_content=${encodeURIComponent(
        String(formData.get("my_content") ?? ""),
      )}&error=${encodeURIComponent("Please pick one of the three options.")}`,
    );
  }

  try {
    const r = applyPatch({
      workspace_id: ws.id,
      agent_id: myAgentId,
      against_rev: ws.head_snapshot_id!,
      ops: [{ path, op: "modify", content: content! }],
      commit_message: `resolve conflict on ${path}`,
    });
    if (!r.ok) {
      redirect(
        `/app/c/${convId}/workspace/${wsId}/resolve?path=${encodeURIComponent(path)}` +
          `&my_content=${encodeURIComponent(content!)}` +
          `&error=${encodeURIComponent(
            `The files changed again while you were resolving — please redo this against version ${r.current_head.slice(0, 12)}.`,
          )}`,
      );
    }
  } catch (err) {
    redirect(
      `/app/c/${convId}/workspace/${wsId}/resolve?path=${encodeURIComponent(path)}&error=${encodeURIComponent(
        err instanceof Error ? err.message : "Couldn't save the resolution.",
      )}`,
    );
  }
  revalidatePath(`/app/c/${convId}/workspace/${wsId}`);
  redirect(
    `/app/c/${convId}/workspace/${wsId}?path=${encodeURIComponent(path)}`,
  );
}

export default async function ResolveConflictPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; wsId: string }>;
  searchParams: Promise<{
    path?: string;
    my_content?: string;
    against_rev?: string;
    error?: string;
  }>;
}) {
  const user = await requireUser();
  const { id: convId, wsId } = await params;
  const sp = await searchParams;
  const conv = getConversation(convId);
  if (!conv) notFound();
  const { myAgentId } = requireUserMember(convId, user.id);
  const ws = getWorkspace(wsId);
  if (!ws) notFound();
  if (!canRead(ws.id, myAgentId)) notFound();

  const path = sp.path ?? "";
  const myContent = sp.my_content ?? "";
  if (!path) {
    redirect(`/app/c/${convId}/workspace/${wsId}`);
  }

  const headRev = ws.head_snapshot_id!;
  const headFile = readFileAt(headRev, path);
  const headContent = headFile?.content.toString("utf8") ?? "";

  const ancestorRev = sp.against_rev ?? null;
  const ancestorContent = ancestorRev
    ? readFileAt(ancestorRev, path)?.content.toString("utf8") ?? ""
    : "";

  const yoursVsHead = diffLines(headContent, myContent);

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
        title={`Resolve conflict on ${path}`}
        subtitle={`someone saved a newer version (${shortenSha(headRev)}) while you were editing`}
      />
      <main className="app-stage-wide space-y-4">
        {sp.error ? (
          <div className="callout callout-amber text-[13px]">
            ⚠ {decodeURIComponent(sp.error)}
          </div>
        ) : null}

        <div className="callout callout-amber text-[13px]">
          <div>
            Someone else saved changes to <code>{path}</code> while you were
            editing. Choose what to keep:
          </div>
        </div>

        <form action={resolveAction} className="space-y-4">
          <input type="hidden" name="conversation_id" value={convId} />
          <input type="hidden" name="workspace_id" value={wsId} />
          <input type="hidden" name="path" value={path} />
          <input type="hidden" name="my_content" value={myContent} />

          <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Pane
              title="🟢 Their version (latest saved)"
              hint={shortenSha(headRev)}
              content={headContent}
              hideEditor
            />
            <Pane
              title="🔵 Your version (not saved yet)"
              hint="unsaved"
              content={myContent}
              hideEditor
            />
          </section>

          <section className="module-panel">
            <div className="px-3 py-2 border-b border-[color:var(--color-line)] text-[12px] font-medium">
              What changed: 🟢 theirs → 🔵 yours
            </div>
            <pre className="text-[12px] font-mono leading-snug overflow-x-auto m-0">
              {yoursVsHead.ok
                ? yoursVsHead.lines.slice(0, 800).map((l, i) => (
                    <DiffRow key={i} line={l} />
                  ))
                : `(comparison unavailable: ${yoursVsHead.reason})`}
            </pre>
          </section>

          <section className="module-panel p-4 space-y-3">
            <h2 className="font-medium text-[14px]">Choose what to keep</h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
              <button
                type="submit"
                name="choice"
                value="mine"
                className="btn btn-primary btn-sm"
              >
                ⏩ Keep mine (replace theirs)
              </button>
              <button
                type="submit"
                name="choice"
                value="theirs"
                className="btn btn-secondary btn-sm"
              >
                ⏸ Keep theirs (discard mine)
              </button>
              <button
                type="submit"
                name="choice"
                value="manual"
                className="btn btn-secondary btn-sm"
              >
                ✎ Merge by hand (edit below)
              </button>
            </div>
            <textarea
              name="manual_content"
              rows={18}
              defaultValue={
                ancestorContent || headContent + "\n\n// === yours ===\n" + myContent
              }
              className="input text-[12px] font-mono w-full"
              placeholder="Edit the combined result here, then click 'Merge by hand'"
            />
          </section>

          <Link
            href={`/app/c/${convId}/workspace/${wsId}?path=${encodeURIComponent(path)}`}
            className="text-[12px] underline"
          >
            ← Cancel and go back
          </Link>
        </form>
      </main>
    </div>
  );
}

function Pane({
  title,
  hint,
  content,
  hideEditor,
}: {
  title: string;
  hint: string;
  content: string;
  hideEditor?: boolean;
}) {
  return (
    <div className="module-panel">
      <div className="px-3 py-2 border-b border-[color:var(--color-line)] flex items-center justify-between text-[12px]">
        <span className="font-medium">{title}</span>
        <span className="text-[color:var(--color-ink-soft)] font-mono text-[11px]">
          {hint}
        </span>
      </div>
      {hideEditor ? (
        <pre className="text-[12px] font-mono leading-snug overflow-x-auto m-0 p-3 max-h-72">
          {content || "(empty)"}
        </pre>
      ) : (
        <textarea
          rows={18}
          defaultValue={content}
          className="input text-[12px] font-mono w-full"
        />
      )}
    </div>
  );
}

function DiffRow({ line }: { line: DiffLine }) {
  const palette =
    line.kind === "add"
      ? "bg-[color:var(--color-tint-green)] text-[color:var(--color-tint-green-ink)]"
      : line.kind === "del"
      ? "bg-[color:var(--color-tint-pink)] text-[color:var(--color-tint-pink-ink)]"
      : "";
  const marker = line.kind === "add" ? "+" : line.kind === "del" ? "−" : " ";
  return (
    <div className={`grid grid-cols-[18px_1fr] ${palette}`}>
      <span className="text-center select-none">{marker}</span>
      <span className="px-2 whitespace-pre-wrap break-all">
        {line.text || " "}
      </span>
    </div>
  );
}
