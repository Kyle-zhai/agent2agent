import { notFound } from "next/navigation";
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import {
  getConversation,
  requireUserMember,
} from "@/lib/conversations";
import {
  listTasksForConversation,
  parseRequiredCapabilities,
} from "@/lib/tasks";
import {
  listWorkspacesForConversation,
} from "@/lib/workspaces";
import { ConversationTabs } from "@/components/ConversationTabs";
import { ConversationSSE } from "@/components/ConversationSSE";
import type { TaskStatus } from "@/lib/types";

export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<TaskStatus, { text: string; cls: string }> = {
  open: { text: "open", cls: "tag" },
  assigned: { text: "assigned", cls: "tag tag-blue" },
  in_progress: { text: "in progress", cls: "tag tag-violet" },
  awaiting_review: { text: "waiting for review", cls: "tag tag-amber" },
  changes_requested: { text: "changes requested", cls: "tag tag-pink" },
  done: { text: "done", cls: "tag tag-green" },
  cancelled: { text: "cancelled", cls: "tag" },
};

export default async function ConversationTasksPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const user = await requireUser();
  const { id: convId } = await params;
  const sp = await searchParams;
  const conv = getConversation(convId);
  if (!conv) notFound();
  const { myAgentId } = requireUserMember(convId, user.id);
  void myAgentId;

  const tasks = listTasksForConversation(convId);
  const open = tasks.filter(
    (t) => t.status !== "done" && t.status !== "cancelled",
  );
  const done = tasks.filter(
    (t) => t.status === "done" || t.status === "cancelled",
  );
  const workspaces = listWorkspacesForConversation(convId);

  return (
    <div className="min-h-screen bg-[color:var(--color-canvas)]">
      <ConversationSSE
        convId={convId}
        relevantKinds={[
          "task.created",
          "task.assigned",
          "task.status_changed",
          "task.commented",
        ]}
      />
      <ConversationTabs
        convId={convId}
        active="tasks"
        workspaceCount={workspaces.length}
        openTaskCount={open.length}
        title={conv.type === "group" ? conv.title ?? "Untitled group" : "Direct"}
        subtitle="Work items you can assign, track, and check off"
      />
      <main className="app-stage-wide space-y-6">
        {sp.error ? (
          <div className="callout callout-amber text-[13px]">
            ⚠ {decodeURIComponent(sp.error)}
          </div>
        ) : null}

        {/* Task creation lives in the chat — no form here. This page is for
            tracking and reviewing. (The old "New task" form was removed on
            user request; assistants can still attach machine checks via the
            API/tools when needed.) */}
        <section className="module-panel px-5 py-4 flex items-center gap-3 flex-wrap text-[13px]">
          <span className="tag tag-violet">chat command</span>
          <span>
            Create tasks from the chat — type{" "}
            <code className="kbd font-mono">/task What needs doing @assistant</code>{" "}
            in the conversation. Only the assistant you @ will work on it.
          </span>
          <Link
            href={`/app/c/${convId}`}
            className="btn btn-secondary btn-sm ml-auto"
          >
            Go to chat
          </Link>
        </section>

        <section>
          <h2 className="font-semibold text-[14px] mb-2">
            Open · {open.length}
          </h2>
          <ul className="list-panel">
            {open.length === 0 ? (
              <li className="text-[12px] text-[color:var(--color-ink-soft)]">
                No open tasks yet.
              </li>
            ) : (
              open.map((t) => (
                <li key={t.id}>
                  <Link
                    href={`/app/c/${convId}/tasks/${t.id}`}
                    className="data-row surface-hover"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="font-medium truncate">{t.title}</div>
                        <div className="text-[11px] text-[color:var(--color-ink-soft)] mt-0.5">
                          owner {t.owner_agent_id.slice(0, 22)}{" "}
                          {t.assigned_to_agent_id ? (
                            <>
                              · assignee{" "}
                              <b>{t.assigned_to_agent_id.slice(0, 22)}</b>
                            </>
                          ) : (
                            "· unassigned"
                          )}
                          {parseRequiredCapabilities(t).length > 0 ? (
                            <>
                              {" · skills "}
                              <code className="font-mono">
                                {parseRequiredCapabilities(t).join(",")}
                              </code>
                            </>
                          ) : null}
                        </div>
                      </div>
                      <span className={STATUS_LABEL[t.status].cls}>
                        {STATUS_LABEL[t.status].text}
                      </span>
                    </div>
                  </Link>
                </li>
              ))
            )}
          </ul>
        </section>

        {done.length > 0 ? (
          <section>
            <h2 className="font-semibold text-[14px] mb-2 text-[color:var(--color-ink-soft)]">
              Closed · {done.length}
            </h2>
            <ul className="list-panel">
              {done.map((t) => (
                <li key={t.id}>
                  <Link
                    href={`/app/c/${convId}/tasks/${t.id}`}
                    className="data-row surface-hover opacity-70"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="truncate">{t.title}</div>
                      <span className={STATUS_LABEL[t.status].cls}>
                        {STATUS_LABEL[t.status].text}
                      </span>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </main>
    </div>
  );
}
