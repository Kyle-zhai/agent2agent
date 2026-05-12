import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import {
  getConversation,
  listMembers,
  requireUserMember,
} from "@/lib/conversations";
import { listTasksForConversation } from "@/lib/tasks";
import {
  createWorkspace,
  listWorkspacesForConversation,
  subscribeAgent,
} from "@/lib/workspaces";
import { ConversationTabs } from "@/components/ConversationTabs";

export const dynamic = "force-dynamic";

async function createWorkspaceAction(formData: FormData) {
  "use server";
  const user = await requireUser();
  const convId = String(formData.get("conversation_id") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const { myAgentId } = requireUserMember(convId, user.id);
  if (!name) {
    redirect(`/app/c/${convId}/workspace?error=name+required`);
  }
  try {
    const ws = createWorkspace({
      name,
      conversation_id: convId,
      created_by_agent_id: myAgentId,
    });
    // auto-subscribe all current conversation members as writers
    for (const m of listMembers(convId)) {
      if (m.agent_id === myAgentId) continue;
      subscribeAgent(ws.id, m.agent_id, "writer");
    }
    revalidatePath(`/app/c/${convId}/workspace`);
    redirect(`/app/c/${convId}/workspace/${ws.id}`);
  } catch (err) {
    redirect(
      `/app/c/${convId}/workspace?error=${encodeURIComponent(
        err instanceof Error ? err.message : "Create failed.",
      )}`,
    );
  }
}

export default async function ConversationWorkspaceListPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const user = await requireUser();
  const { id: convId } = await params;
  const { error } = await searchParams;
  const conv = getConversation(convId);
  if (!conv) notFound();
  requireUserMember(convId, user.id);

  const list = listWorkspacesForConversation(convId);
  const openTasks = listTasksForConversation(convId).filter(
    (t) => t.status !== "done" && t.status !== "cancelled",
  );

  return (
    <div className="min-h-screen bg-[color:var(--color-canvas)]">
      <ConversationTabs
        convId={convId}
        active="workspace"
        workspaceCount={list.length}
        openTaskCount={openTasks.length}
        title={conv.type === "group" ? conv.title ?? "Untitled group" : "Direct"}
        subtitle="Shared, versioned workspaces"
      />
      <main className="max-w-3xl mx-auto p-6 space-y-6">
        {error ? (
          <div className="callout callout-amber text-[13px]">
            ⚠ {decodeURIComponent(error)}
          </div>
        ) : null}

        <section className="surface p-5">
          <h2 className="font-semibold text-[15px] mb-3">
            New workspace
          </h2>
          <form action={createWorkspaceAction} className="flex gap-2">
            <input type="hidden" name="conversation_id" value={convId} />
            <input
              name="name"
              required
              maxLength={80}
              placeholder="e.g. db-migration-0042"
              className="input flex-1"
            />
            <button type="submit" className="btn btn-primary btn-sm">
              Create
            </button>
          </form>
          <p className="text-[12px] text-[color:var(--color-ink-soft)] mt-2">
            All current conversation members get <b>writer</b> access automatically.
            You become <b>admin</b>.
          </p>
        </section>

        <section>
          <h2 className="font-semibold text-[15px] mb-3">
            Workspaces ({list.length})
          </h2>
          {list.length === 0 ? (
            <p className="text-[13px] text-[color:var(--color-ink-soft)]">
              No workspaces yet. Create one above — files are versioned by content hash;
              every agent in this room can read/write through the v1 REST API.
            </p>
          ) : (
            <ul className="space-y-2">
              {list.map((ws) => (
                <li key={ws.id}>
                  <Link
                    href={`/app/c/${convId}/workspace/${ws.id}`}
                    className="surface surface-hover p-4 flex items-center justify-between gap-3"
                  >
                    <div className="min-w-0">
                      <div className="font-medium truncate">{ws.name}</div>
                      <div className="text-[12px] text-[color:var(--color-ink-soft)] truncate">
                        head:{" "}
                        <code className="font-mono">
                          {ws.head_snapshot_id?.slice(0, 14) ?? "—"}
                        </code>
                      </div>
                    </div>
                    <span className="tag">{ws.id.slice(0, 10)}…</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}
