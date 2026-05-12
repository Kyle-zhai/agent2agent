import { notFound } from "next/navigation";
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import {
  getConversation,
  requireUserMember,
} from "@/lib/conversations";
import {
  canRead,
  fileDiffSummary,
  getSnapshot,
  getWorkspace,
  listSubscribers,
  listWorkspacesForConversation,
  readFileAt,
  shortenSha,
  subscribeAgent,
} from "@/lib/workspaces";
import { listTasksForConversation } from "@/lib/tasks";
import { ConversationTabs } from "@/components/ConversationTabs";
import { DiffViewer } from "@/components/DiffViewer";

export const dynamic = "force-dynamic";

export default async function SnapshotDiffPage({
  params,
}: {
  params: Promise<{ id: string; wsId: string; snapId: string }>;
}) {
  const user = await requireUser();
  const { id: convId, wsId, snapId } = await params;
  const conv = getConversation(convId);
  if (!conv) notFound();
  const { myAgentId } = requireUserMember(convId, user.id);
  const ws = getWorkspace(wsId);
  if (!ws) notFound();
  if (!canRead(ws.id, myAgentId)) {
    subscribeAgent(ws.id, myAgentId, "reader");
  }
  const snap = getSnapshot(snapId);
  if (!snap || snap.workspace_id !== ws.id) notFound();

  const diff = fileDiffSummary(snap.parent_snapshot_id, snap.id);
  void listSubscribers; // (kept for future side-panel)

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
        title={`Snapshot ${shortenSha(snap.id)}`}
        subtitle={`in ${ws.name} · ${diff.length} file(s) changed`}
      />
      <main className="max-w-5xl mx-auto p-6 space-y-4">
        <div className="surface p-4 text-[13px]">
          <div className="font-medium mb-1">{snap.commit_message || "(no message)"}</div>
          <div className="text-[12px] text-[color:var(--color-ink-soft)] flex items-center gap-2 flex-wrap">
            <span>
              by <b>{snap.created_by_agent_id ?? "system"}</b>
            </span>
            <span>·</span>
            <span>{new Date(snap.created_at).toLocaleString()}</span>
            {snap.parent_snapshot_id ? (
              <>
                <span>·</span>
                <span>
                  parent{" "}
                  <Link
                    href={`/app/c/${convId}/workspace/${ws.id}/snap/${snap.parent_snapshot_id}`}
                    className="font-mono underline"
                  >
                    {shortenSha(snap.parent_snapshot_id)}
                  </Link>
                </span>
              </>
            ) : (
              <>
                <span>·</span>
                <span>(initial)</span>
              </>
            )}
            {snap.task_id ? (
              <>
                <span>·</span>
                <Link
                  href={`/app/c/${convId}/tasks/${snap.task_id}`}
                  className="underline"
                >
                  task {snap.task_id.slice(0, 14)}…
                </Link>
              </>
            ) : null}
          </div>
          {snap.thinking ? (
            <details className="mt-2 text-[12px] text-[color:var(--color-ink-soft)]">
              <summary className="cursor-pointer">show thinking</summary>
              <pre className="mt-1 whitespace-pre-wrap">{snap.thinking}</pre>
            </details>
          ) : null}
        </div>

        {diff.length === 0 ? (
          <div className="surface p-6 text-center text-[13px] text-[color:var(--color-ink-soft)]">
            No file changes in this snapshot.
          </div>
        ) : (
          diff.map((d) => {
            const before =
              d.status === "added" || !snap.parent_snapshot_id
                ? null
                : readFileAt(snap.parent_snapshot_id!, d.path)?.content.toString("utf8") ?? null;
            const after =
              d.status === "deleted"
                ? null
                : readFileAt(snap.id, d.path)?.content.toString("utf8") ?? null;
            return (
              <DiffViewer
                key={d.path}
                path={d.path}
                before={before}
                after={after}
              />
            );
          })
        )}

        <div>
          <Link
            href={`/app/c/${convId}/workspace/${ws.id}`}
            className="btn btn-secondary btn-sm"
          >
            ← Back to workspace
          </Link>
        </div>
      </main>
    </div>
  );
}
