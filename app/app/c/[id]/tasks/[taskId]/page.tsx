import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import {
  getConversation,
  listMembers,
  requireUserMember,
} from "@/lib/conversations";
import { getAgent } from "@/lib/agents";
import {
  addTaskComment,
  approveTask,
  assignTask,
  getTask,
  isTransitionAllowed,
  listTaskArtifacts,
  listTaskEvents,
  parseRequiredCapabilities,
  parseSuccessCriteria,
  requestChanges,
  transitionTaskStatus,
} from "@/lib/tasks";
import {
  fileDiffSummary,
  getSnapshot,
  listWorkspacesForConversation,
} from "@/lib/workspaces";
import {
  listTasksForConversation,
} from "@/lib/tasks";
import { ConversationTabs } from "@/components/ConversationTabs";
import { ConversationSSE } from "@/components/ConversationSSE";
import type { TaskStatus } from "@/lib/types";

export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<TaskStatus, { text: string; cls: string }> = {
  open: { text: "open", cls: "tag" },
  assigned: { text: "assigned", cls: "tag tag-blue" },
  in_progress: { text: "in progress", cls: "tag tag-violet" },
  awaiting_review: { text: "awaiting review", cls: "tag tag-amber" },
  changes_requested: { text: "changes requested", cls: "tag tag-pink" },
  done: { text: "done", cls: "tag tag-green" },
  cancelled: { text: "cancelled", cls: "tag" },
};

async function commentAction(formData: FormData) {
  "use server";
  const user = await requireUser();
  const convId = String(formData.get("conversation_id") ?? "");
  const taskId = String(formData.get("task_id") ?? "");
  const body = String(formData.get("body") ?? "");
  const { myAgentId } = requireUserMember(convId, user.id);
  try {
    addTaskComment(taskId, myAgentId, body);
  } catch (err) {
    redirect(
      `/app/c/${convId}/tasks/${taskId}?error=${encodeURIComponent(
        err instanceof Error ? err.message : "Comment failed.",
      )}`,
    );
  }
  revalidatePath(`/app/c/${convId}/tasks/${taskId}`);
  redirect(`/app/c/${convId}/tasks/${taskId}`);
}

async function transitionAction(formData: FormData) {
  "use server";
  const user = await requireUser();
  const convId = String(formData.get("conversation_id") ?? "");
  const taskId = String(formData.get("task_id") ?? "");
  const to = String(formData.get("to") ?? "") as TaskStatus;
  const { myAgentId } = requireUserMember(convId, user.id);
  try {
    const res = await transitionTaskStatus({
      task_id: taskId,
      to_status: to,
      actor_agent_id: myAgentId,
    });
    if (res.criteria_failures && res.criteria_failures.length > 0) {
      redirect(
        `/app/c/${convId}/tasks/${taskId}?error=${encodeURIComponent(
          "Criteria not met: " + res.criteria_failures.join("; "),
        )}`,
      );
    }
  } catch (err) {
    redirect(
      `/app/c/${convId}/tasks/${taskId}?error=${encodeURIComponent(
        err instanceof Error ? err.message : "Transition failed.",
      )}`,
    );
  }
  revalidatePath(`/app/c/${convId}/tasks/${taskId}`);
  redirect(`/app/c/${convId}/tasks/${taskId}`);
}

async function assignAction(formData: FormData) {
  "use server";
  const user = await requireUser();
  const convId = String(formData.get("conversation_id") ?? "");
  const taskId = String(formData.get("task_id") ?? "");
  const assignee = String(formData.get("assignee") ?? "") || null;
  const { myAgentId } = requireUserMember(convId, user.id);
  try {
    assignTask({
      task_id: taskId,
      assignee_agent_id: assignee,
      actor_agent_id: myAgentId,
    });
  } catch (err) {
    redirect(
      `/app/c/${convId}/tasks/${taskId}?error=${encodeURIComponent(
        err instanceof Error ? err.message : "Assign failed.",
      )}`,
    );
  }
  revalidatePath(`/app/c/${convId}/tasks/${taskId}`);
  redirect(`/app/c/${convId}/tasks/${taskId}`);
}

async function approveAction(formData: FormData) {
  "use server";
  const user = await requireUser();
  const convId = String(formData.get("conversation_id") ?? "");
  const taskId = String(formData.get("task_id") ?? "");
  const { myAgentId } = requireUserMember(convId, user.id);
  try {
    approveTask(taskId, myAgentId);
  } catch (err) {
    redirect(
      `/app/c/${convId}/tasks/${taskId}?error=${encodeURIComponent(
        err instanceof Error ? err.message : "Approval failed.",
      )}`,
    );
  }
  revalidatePath(`/app/c/${convId}/tasks/${taskId}`);
  redirect(`/app/c/${convId}/tasks/${taskId}`);
}

async function requestChangesAction(formData: FormData) {
  "use server";
  const user = await requireUser();
  const convId = String(formData.get("conversation_id") ?? "");
  const taskId = String(formData.get("task_id") ?? "");
  const comment = String(formData.get("comment") ?? "");
  const { myAgentId } = requireUserMember(convId, user.id);
  try {
    await requestChanges(taskId, myAgentId, comment);
  } catch (err) {
    redirect(
      `/app/c/${convId}/tasks/${taskId}?error=${encodeURIComponent(
        err instanceof Error ? err.message : "Request changes failed.",
      )}`,
    );
  }
  revalidatePath(`/app/c/${convId}/tasks/${taskId}`);
  redirect(`/app/c/${convId}/tasks/${taskId}`);
}

export default async function TaskDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; taskId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const user = await requireUser();
  const { id: convId, taskId } = await params;
  const sp = await searchParams;
  const conv = getConversation(convId);
  if (!conv) notFound();
  const { myAgentId } = requireUserMember(convId, user.id);

  const t = getTask(taskId);
  if (!t || t.conversation_id !== convId) notFound();

  const isOwner = t.owner_agent_id === myAgentId;
  const isAssignee = t.assigned_to_agent_id === myAgentId;

  const events = listTaskEvents(t.id);
  const artifacts = listTaskArtifacts(t.id);
  const members = listMembers(convId)
    .map((m) => getAgent(m.agent_id))
    .filter((a): a is NonNullable<ReturnType<typeof getAgent>> => !!a);

  const workspaces = listWorkspacesForConversation(convId);
  const openCount = listTasksForConversation(convId).filter(
    (x) => x.status !== "done" && x.status !== "cancelled",
  ).length;

  const allTransitions: TaskStatus[] = [
    "assigned",
    "in_progress",
    "awaiting_review",
    "changes_requested",
    "done",
    "cancelled",
    "open",
  ];
  const allowed = allTransitions.filter((to) => isTransitionAllowed(t.status, to));

  return (
    <div className="min-h-screen bg-[color:var(--color-canvas)]">
      <ConversationSSE
        convId={convId}
        relevantKinds={[
          "task.status_changed",
          "task.commented",
          "task.assigned",
          "workspace.changed",
        ]}
      />
      <ConversationTabs
        convId={convId}
        active="tasks"
        workspaceCount={workspaces.length}
        openTaskCount={openCount}
        title={t.title}
        subtitle={`status ${t.status} · owner ${t.owner_agent_id.slice(0, 18)}`}
      />
      <main className="max-w-4xl mx-auto p-6 grid grid-cols-1 md:grid-cols-[1fr_280px] gap-5">
        <section className="space-y-4">
          {sp.error ? (
            <div className="callout callout-amber text-[13px]">
              ⚠ {decodeURIComponent(sp.error)}
            </div>
          ) : null}

          <div className="surface p-4 space-y-2">
            <div className="flex items-center gap-2">
              <span className={STATUS_LABEL[t.status].cls}>
                {STATUS_LABEL[t.status].text}
              </span>
              {parseRequiredCapabilities(t).map((c) => (
                <span key={c} className="tag tag-violet font-mono text-[11px]">
                  {c}
                </span>
              ))}
            </div>
            <h1 className="text-[18px] font-semibold">{t.title}</h1>
            {t.description ? (
              <pre className="whitespace-pre-wrap text-[13px] leading-relaxed text-[color:var(--color-ink)]">
                {t.description}
              </pre>
            ) : null}
            <div className="text-[12px] text-[color:var(--color-ink-soft)]">
              {parseSuccessCriteria(t).length > 0 ? (
                <>
                  <b>Success criteria:</b>{" "}
                  <code className="font-mono">
                    {JSON.stringify(parseSuccessCriteria(t))}
                  </code>
                </>
              ) : (
                "No success criteria — done = manual close."
              )}
            </div>
          </div>

          <div className="surface p-4">
            <div className="font-medium text-[13px] mb-2">Activity</div>
            <ul className="space-y-2 text-[13px]">
              {events.map((e) => {
                let payload: Record<string, unknown> = {};
                try {
                  payload = JSON.parse(e.payload_json);
                } catch {
                  /* ignore */
                }
                return (
                  <li
                    key={e.id}
                    className="border-l-2 border-[color:var(--color-line)] pl-3"
                  >
                    <div className="flex items-center gap-2 text-[12px] text-[color:var(--color-ink-soft)]">
                      <code className="font-mono">{e.kind}</code>
                      <span>·</span>
                      <span>{e.actor_agent_id ?? "system"}</span>
                      <span>·</span>
                      <span>{new Date(e.created_at).toLocaleString()}</span>
                    </div>
                    {e.kind === "comment" && typeof payload.body === "string" ? (
                      <p className="mt-1 whitespace-pre-wrap">
                        {payload.body as string}
                      </p>
                    ) : (
                      <pre className="text-[11px] text-[color:var(--color-ink-soft)] mt-1 whitespace-pre-wrap">
                        {Object.keys(payload).length > 0
                          ? JSON.stringify(payload)
                          : ""}
                      </pre>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>

          {isOwner || isAssignee ? (
            <form action={commentAction} className="surface p-3 space-y-2">
              <input type="hidden" name="conversation_id" value={convId} />
              <input type="hidden" name="task_id" value={t.id} />
              <textarea
                name="body"
                rows={2}
                placeholder="Comment (visible to owner + assignee)"
                className="input text-[13px]"
                required
              />
              <button type="submit" className="btn btn-primary btn-sm">
                Comment
              </button>
            </form>
          ) : null}
        </section>

        <aside className="space-y-3">
          <div className="surface p-3">
            <div className="text-[11px] uppercase tracking-wider text-[color:var(--color-ink-soft)] mb-2">
              Assign
            </div>
            <form action={assignAction} className="flex gap-1.5">
              <input type="hidden" name="conversation_id" value={convId} />
              <input type="hidden" name="task_id" value={t.id} />
              <select
                name="assignee"
                defaultValue={t.assigned_to_agent_id ?? ""}
                className="input text-[12px] py-1 flex-1"
              >
                <option value="">(unassigned)</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.avatar_emoji} {m.display_name}
                  </option>
                ))}
              </select>
              <button type="submit" className="btn btn-secondary btn-sm">
                Set
              </button>
            </form>
            {!isOwner ? (
              <p className="text-[11px] text-[color:var(--color-ink-soft)] mt-1">
                Only the owner can reassign.
              </p>
            ) : null}
          </div>

          <div className="surface p-3">
            <div className="text-[11px] uppercase tracking-wider text-[color:var(--color-ink-soft)] mb-2">
              Transition
            </div>
            <div className="flex flex-wrap gap-1.5">
              {allowed.length === 0 ? (
                <p className="text-[12px] text-[color:var(--color-ink-soft)]">
                  Terminal state.
                </p>
              ) : (
                allowed.map((to) => (
                  <form key={to} action={transitionAction}>
                    <input
                      type="hidden"
                      name="conversation_id"
                      value={convId}
                    />
                    <input type="hidden" name="task_id" value={t.id} />
                    <input type="hidden" name="to" value={to} />
                    <button
                      type="submit"
                      className="btn btn-secondary btn-sm"
                    >
                      → {STATUS_LABEL[to].text}
                    </button>
                  </form>
                ))
              )}
            </div>
          </div>

          {t.status === "awaiting_review" && !isOwner ? (
            <div className="surface p-3 space-y-2">
              <div className="text-[11px] uppercase tracking-wider text-[color:var(--color-ink-soft)]">
                Review
              </div>
              <form action={approveAction}>
                <input type="hidden" name="conversation_id" value={convId} />
                <input type="hidden" name="task_id" value={t.id} />
                <button type="submit" className="btn btn-primary btn-sm w-full">
                  ✓ Approve
                </button>
              </form>
              <form action={requestChangesAction} className="space-y-1.5">
                <input type="hidden" name="conversation_id" value={convId} />
                <input type="hidden" name="task_id" value={t.id} />
                <textarea
                  name="comment"
                  rows={2}
                  placeholder="What needs changing?"
                  className="input text-[12px]"
                  required
                />
                <button
                  type="submit"
                  className="btn btn-secondary btn-sm w-full"
                >
                  ✎ Request changes
                </button>
              </form>
            </div>
          ) : null}

          {artifacts.length > 0 ? (
            <div className="surface p-3">
              <div className="text-[11px] uppercase tracking-wider text-[color:var(--color-ink-soft)] mb-2">
                Artifacts
              </div>
              <ul className="space-y-1 text-[12px]">
                {artifacts.map((a) => {
                  if (a.kind === "snapshot") {
                    const snap = getSnapshot(a.ref_id);
                    const diff = snap
                      ? fileDiffSummary(snap.parent_snapshot_id, snap.id)
                      : [];
                    const wsId = snap?.workspace_id;
                    return (
                      <li key={a.ref_id} className="space-y-0.5">
                        <Link
                          href={`/app/c/${convId}/workspace/${wsId ?? ""}`}
                          className="font-mono underline"
                        >
                          {a.ref_id.slice(0, 14)}…
                        </Link>{" "}
                        <span className="text-[11px] text-[color:var(--color-ink-soft)]">
                          ({diff.length} files)
                        </span>
                      </li>
                    );
                  }
                  return (
                    <li key={`${a.kind}:${a.ref_id}`} className="font-mono">
                      [{a.kind}] {a.ref_id.slice(0, 14)}…
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}

          {t.workspace_id ? (
            <Link
              href={`/app/c/${convId}/workspace/${t.workspace_id}`}
              className="surface surface-hover p-3 block text-[12px]"
            >
              ↗ Workspace bound to this task
            </Link>
          ) : null}
        </aside>
      </main>
    </div>
  );
}
