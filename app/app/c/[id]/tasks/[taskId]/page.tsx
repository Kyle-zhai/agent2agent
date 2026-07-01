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
  addTaskDependency,
  approveTask,
  assignTask,
  createSubtask,
  getTask,
  isTaskBlocked,
  isTransitionAllowed,
  listBlockers,
  listBlocking,
  listChildren,
  listTaskArtifacts,
  listTaskEvents,
  parseRequiredCapabilities,
  parseSuccessCriteria,
  removeTaskDependency,
  requestChanges,
  splitTask,
  transitionTaskStatus,
} from "@/lib/tasks";
import {
  fileDiffSummary,
  getSnapshot,
  listWorkspacesForConversation,
} from "@/lib/workspaces";
import { listSandboxRunsForTask } from "@/lib/sandbox";
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
  awaiting_review: { text: "waiting for review", cls: "tag tag-amber" },
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
        err instanceof Error ? err.message : "Couldn't post the comment.",
      )}`,
    );
  }
  revalidatePath(`/app/c/${convId}/tasks/${taskId}`);
  revalidatePath("/app", "layout");
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
          "Some 'done when' checks didn't pass: " +
            res.criteria_failures.join("; "),
        )}`,
      );
    }
  } catch (err) {
    redirect(
      `/app/c/${convId}/tasks/${taskId}?error=${encodeURIComponent(
        err instanceof Error ? err.message : "Couldn't change the status.",
      )}`,
    );
  }
  revalidatePath(`/app/c/${convId}/tasks/${taskId}`);
  revalidatePath("/app", "layout");
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
        err instanceof Error ? err.message : "Couldn't assign the task.",
      )}`,
    );
  }
  revalidatePath(`/app/c/${convId}/tasks/${taskId}`);
  revalidatePath("/app", "layout");
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
        err instanceof Error ? err.message : "Couldn't approve the task.",
      )}`,
    );
  }
  revalidatePath(`/app/c/${convId}/tasks/${taskId}`);
  revalidatePath("/app", "layout");
  redirect(`/app/c/${convId}/tasks/${taskId}`);
}

async function addDepAction(formData: FormData) {
  "use server";
  const user = await requireUser();
  const convId = String(formData.get("conversation_id") ?? "");
  const taskId = String(formData.get("task_id") ?? "");
  const blockerId = String(formData.get("blocker_task_id") ?? "").trim();
  const { myAgentId } = requireUserMember(convId, user.id);
  try {
    addTaskDependency({
      blocker_task_id: blockerId,
      blocked_task_id: taskId,
      actor_agent_id: myAgentId,
    });
  } catch (err) {
    redirect(
      `/app/c/${convId}/tasks/${taskId}?error=${encodeURIComponent(
        err instanceof Error ? err.message : "Couldn't add the blocker.",
      )}`,
    );
  }
  revalidatePath(`/app/c/${convId}/tasks/${taskId}`);
  revalidatePath("/app", "layout");
  redirect(`/app/c/${convId}/tasks/${taskId}`);
}

async function removeDepAction(formData: FormData) {
  "use server";
  const user = await requireUser();
  const convId = String(formData.get("conversation_id") ?? "");
  const taskId = String(formData.get("task_id") ?? "");
  const blockerId = String(formData.get("blocker_task_id") ?? "");
  const { myAgentId } = requireUserMember(convId, user.id);
  try {
    removeTaskDependency({
      blocker_task_id: blockerId,
      blocked_task_id: taskId,
      actor_agent_id: myAgentId,
    });
  } catch (err) {
    redirect(
      `/app/c/${convId}/tasks/${taskId}?error=${encodeURIComponent(
        err instanceof Error ? err.message : "Couldn't remove the blocker.",
      )}`,
    );
  }
  revalidatePath(`/app/c/${convId}/tasks/${taskId}`);
  revalidatePath("/app", "layout");
  redirect(`/app/c/${convId}/tasks/${taskId}`);
}

async function splitTaskAction(formData: FormData) {
  "use server";
  const user = await requireUser();
  const convId = String(formData.get("conversation_id") ?? "");
  const parentId = String(formData.get("parent_task_id") ?? "");
  const titlesRaw = String(formData.get("titles") ?? "");
  const assigneesRaw = formData.getAll("assignees").map(String);
  const { myAgentId } = requireUserMember(convId, user.id);
  const titles = titlesRaw
    .split(/\r?\n/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (titles.length === 0) {
    redirect(
      `/app/c/${convId}/tasks/${parentId}?error=${encodeURIComponent(
        "Please add at least one title.",
      )}`,
    );
  }
  if (titles.length > assigneesRaw.length && assigneesRaw.length > 0) {
    // pad with last assignee
    while (assigneesRaw.length < titles.length) {
      assigneesRaw.push(assigneesRaw[assigneesRaw.length - 1]);
    }
  }
  try {
    splitTask({
      parent_task_id: parentId,
      actor_agent_id: myAgentId,
      branches: titles.map((t, i) => ({
        title: t,
        assigned_to_agent_id: assigneesRaw[i] || null,
      })),
    });
  } catch (err) {
    redirect(
      `/app/c/${convId}/tasks/${parentId}?error=${encodeURIComponent(
        err instanceof Error ? err.message : "Couldn't split the task.",
      )}`,
    );
  }
  revalidatePath(`/app/c/${convId}/tasks/${parentId}`);
  revalidatePath("/app", "layout");
  redirect(`/app/c/${convId}/tasks/${parentId}`);
}

async function createSubtaskAction(formData: FormData) {
  "use server";
  const user = await requireUser();
  const convId = String(formData.get("conversation_id") ?? "");
  const parentId = String(formData.get("parent_task_id") ?? "");
  const title = String(formData.get("title") ?? "").trim();
  const assignee = String(formData.get("assigned_to_agent_id") ?? "") || null;
  const { myAgentId } = requireUserMember(convId, user.id);
  if (!title) {
    redirect(
      `/app/c/${convId}/tasks/${parentId}?error=${encodeURIComponent(
        "Please add a title.",
      )}`,
    );
  }
  try {
    createSubtask({
      parent_task_id: parentId,
      title,
      owner_agent_id: myAgentId,
      assigned_to_agent_id: assignee,
    });
  } catch (err) {
    redirect(
      `/app/c/${convId}/tasks/${parentId}?error=${encodeURIComponent(
        err instanceof Error ? err.message : "Couldn't create the subtask.",
      )}`,
    );
  }
  revalidatePath(`/app/c/${convId}/tasks/${parentId}`);
  revalidatePath("/app", "layout");
  redirect(`/app/c/${convId}/tasks/${parentId}`);
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
        err instanceof Error ? err.message : "Couldn't send the change request.",
      )}`,
    );
  }
  revalidatePath(`/app/c/${convId}/tasks/${taskId}`);
  revalidatePath("/app", "layout");
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
  const blockers = listBlockers(t.id);
  const blocking = listBlocking(t.id);
  const children = listChildren(t.id);
  const sandboxRuns = listSandboxRunsForTask(t.id);
  const blockState = isTaskBlocked(t.id);
  const parent = t.parent_task_id ? getTask(t.parent_task_id) : null;
  // Candidate blockers for "add dependency" UI = sibling tasks in same conv
  const siblings = listTasksForConversation(convId).filter(
    (x) =>
      x.id !== t.id &&
      x.id !== t.parent_task_id &&
      !blockers.some((b) => b.blocker_task_id === x.id),
  );

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
        subtitle={`status ${STATUS_LABEL[t.status].text} · owner ${t.owner_agent_id.slice(0, 18)}`}
      />
      <main className="app-stage-wide grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_320px] gap-5">
        <section className="space-y-4">
          {sp.error ? (
            <div className="callout callout-amber text-[13px]">
              ⚠ {decodeURIComponent(sp.error)}
            </div>
          ) : null}

          <div className="module-panel p-4 space-y-2">
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
                  <b>Done when:</b>{" "}
                  <code className="font-mono">
                    {JSON.stringify(parseSuccessCriteria(t))}
                  </code>
                </>
              ) : (
                "No 'done when' checks — someone marks this done by hand."
              )}
            </div>
          </div>

          <div className="module-panel p-4">
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
                    ) : e.kind === "debate_argument" &&
                      typeof payload.text === "string" ? (
                      <div className="mt-1">
                        <span
                          className={
                            "tag text-[10px] mr-2 " +
                            (payload.role === "pro"
                              ? "tag-green"
                              : payload.role === "con"
                              ? "tag-pink"
                              : "tag-violet")
                          }
                        >
                          {payload.role === "pro"
                            ? "FOR"
                            : payload.role === "con"
                            ? "AGAINST"
                            : String(payload.role).toUpperCase()}
                        </span>
                        <span className="whitespace-pre-wrap">
                          {payload.text as string}
                        </span>
                      </div>
                    ) : e.kind === "debate_finished" ? (
                      <div className="mt-1 text-[12px]">
                        <span
                          className={
                            "tag text-[10px] mr-2 " +
                            (payload.decision === "approve"
                              ? "tag-green"
                              : "tag-amber")
                          }
                        >
                          ⚖ {payload.decision === "approve"
                            ? "approved"
                            : String(payload.decision)}
                        </span>
                        {typeof payload.reason === "string" ? (
                          <span className="whitespace-pre-wrap">
                            {payload.reason as string}
                          </span>
                        ) : null}
                      </div>
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
            <form action={commentAction} className="module-panel p-3 space-y-2">
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
          <div className="module-panel p-3">
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

          <div className="module-panel p-3">
            <div className="text-[11px] uppercase tracking-wider text-[color:var(--color-ink-soft)] mb-2">
              Change status
            </div>
            <div className="flex flex-wrap gap-1.5">
              {allowed.length === 0 ? (
                <p className="text-[12px] text-[color:var(--color-ink-soft)]">
                  This task is closed — no further changes.
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
            <div className="module-panel p-3 space-y-2">
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

          {sandboxRuns.length > 0 ? (
            <div className="module-panel p-3">
              <div className="text-[11px] uppercase tracking-wider text-[color:var(--color-ink-soft)] mb-2">
                Command runs ({sandboxRuns.length})
              </div>
              <ul className="space-y-2 text-[11px]">
                {sandboxRuns.map((r) => (
                  <li
                    key={r.id}
                    className="border-l-2 border-[color:var(--color-line)] pl-2"
                  >
                    <div className="flex items-center gap-1.5 text-[10px] text-[color:var(--color-ink-soft)]">
                      <span
                        className={
                          r.exit_code === 0
                            ? "tag tag-green"
                            : r.exit_code === null
                            ? "tag"
                            : "tag tag-pink"
                        }
                      >
                        {r.exit_code === 0
                          ? "passed"
                          : r.exit_code === null
                          ? "running"
                          : `failed (exit ${r.exit_code})`}
                      </span>
                      <span>{r.runtime}</span>
                      <span>·</span>
                      <span>{r.duration_ms != null ? `${r.duration_ms}ms` : "running"}</span>
                    </div>
                    <code className="font-mono block mt-0.5 truncate">
                      {r.cmd}
                    </code>
                    {r.stdout || r.stderr ? (
                      <details className="mt-1">
                        <summary className="cursor-pointer text-[10px] text-[color:var(--color-ink-soft)] select-none">
                          show output
                        </summary>
                        {r.stdout ? (
                          <pre className="text-[10px] font-mono whitespace-pre-wrap mt-1 bg-[color:var(--color-tint-green)] p-1.5 rounded">
                            {r.stdout}
                          </pre>
                        ) : null}
                        {r.stderr ? (
                          <pre className="text-[10px] font-mono whitespace-pre-wrap mt-1 bg-[color:var(--color-tint-pink)] p-1.5 rounded">
                            {r.stderr}
                          </pre>
                        ) : null}
                      </details>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {artifacts.length > 0 ? (
            <div className="module-panel p-3">
              <div className="text-[11px] uppercase tracking-wider text-[color:var(--color-ink-soft)] mb-2">
                Outputs
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
                          href={
                            wsId
                              ? `/app?rail=files&conversation=${encodeURIComponent(
                                  convId,
                                )}&workspace=${encodeURIComponent(wsId)}`
                              : `/app?rail=files&conversation=${encodeURIComponent(convId)}`
                          }
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
              href={`/app?rail=files&conversation=${encodeURIComponent(
                convId,
              )}&workspace=${encodeURIComponent(t.workspace_id)}`}
              className="module-panel surface-hover p-3 block text-[12px]"
            >
              ↗ Workspace linked to this task
            </Link>
          ) : null}

          {parent ? (
            <Link
              href={`/app/c/${convId}/tasks/${parent.id}`}
              className="module-panel surface-hover p-3 block text-[12px]"
            >
              ↑ Parent task:{" "}
              <span className="font-medium">{parent.title}</span>{" "}
              <span className={STATUS_LABEL[parent.status].cls}>
                {STATUS_LABEL[parent.status].text}
              </span>
            </Link>
          ) : null}

          <div className="module-panel p-3">
            <div className="text-[11px] uppercase tracking-wider text-[color:var(--color-ink-soft)] mb-2 flex items-center justify-between">
              Blockers ({blockers.length})
              {blockState.blocked ? (
                <span className="tag tag-pink text-[10px]">
                  ⛔ blocked
                </span>
              ) : null}
            </div>
            <ul className="space-y-1.5 text-[12px]">
              {blockers.length === 0 ? (
                <li className="text-[color:var(--color-ink-soft)]">
                  no blockers
                </li>
              ) : (
                blockers.map((b) => {
                  const bt = getTask(b.blocker_task_id);
                  if (!bt) return null;
                  return (
                    <li
                      key={b.blocker_task_id}
                      className="flex items-center justify-between gap-2"
                    >
                      <Link
                        href={`/app/c/${convId}/tasks/${bt.id}`}
                        className="truncate flex-1 underline"
                      >
                        {bt.title}
                      </Link>
                      <span className={STATUS_LABEL[bt.status].cls}>
                        {STATUS_LABEL[bt.status].text}
                      </span>
                      {isOwner ? (
                        <form action={removeDepAction}>
                          <input
                            type="hidden"
                            name="conversation_id"
                            value={convId}
                          />
                          <input type="hidden" name="task_id" value={t.id} />
                          <input
                            type="hidden"
                            name="blocker_task_id"
                            value={bt.id}
                          />
                          <button
                            type="submit"
                            className="btn btn-ghost btn-sm"
                            title="Remove dependency"
                          >
                            ×
                          </button>
                        </form>
                      ) : null}
                    </li>
                  );
                })
              )}
            </ul>
            {isOwner && siblings.length > 0 ? (
              <form action={addDepAction} className="mt-3 flex gap-1.5">
                <input type="hidden" name="conversation_id" value={convId} />
                <input type="hidden" name="task_id" value={t.id} />
                <select
                  name="blocker_task_id"
                  className="input text-[12px] py-0.5 flex-1"
                  defaultValue=""
                >
                  <option value="" disabled>
                    add blocker…
                  </option>
                  {siblings.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.title.slice(0, 40)}
                    </option>
                  ))}
                </select>
                <button type="submit" className="btn btn-secondary btn-sm">
                  Block
                </button>
              </form>
            ) : null}
          </div>

          {blocking.length > 0 ? (
            <div className="module-panel p-3">
              <div className="text-[11px] uppercase tracking-wider text-[color:var(--color-ink-soft)] mb-2">
                Blocking ({blocking.length})
              </div>
              <ul className="space-y-1 text-[12px]">
                {blocking.map((b) => {
                  const bt = getTask(b.blocked_task_id);
                  if (!bt) return null;
                  return (
                    <li
                      key={b.blocked_task_id}
                      className="flex items-center justify-between gap-2"
                    >
                      <Link
                        href={`/app/c/${convId}/tasks/${bt.id}`}
                        className="truncate flex-1 underline"
                      >
                        {bt.title}
                      </Link>
                      <span className={STATUS_LABEL[bt.status].cls}>
                        {STATUS_LABEL[bt.status].text}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}

          <div className="module-panel p-3">
            <div className="text-[11px] uppercase tracking-wider text-[color:var(--color-ink-soft)] mb-2">
              Subtasks ({children.length})
            </div>
            {children.length === 0 ? (
              <p className="text-[12px] text-[color:var(--color-ink-soft)] mb-2">
                Break this into smaller pieces you can assign.
              </p>
            ) : (
              <ul className="space-y-1 text-[12px] mb-2">
                {children.map((c) => (
                  <li
                    key={c.id}
                    className="flex items-center justify-between gap-2"
                  >
                    <Link
                      href={`/app/c/${convId}/tasks/${c.id}`}
                      className="truncate flex-1 underline"
                    >
                      {c.title}
                    </Link>
                    <span className={STATUS_LABEL[c.status].cls}>
                      {STATUS_LABEL[c.status].text}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {isOwner || isAssignee ? (
              <>
                <form
                  action={createSubtaskAction}
                  className="space-y-1.5"
                >
                  <input type="hidden" name="conversation_id" value={convId} />
                  <input type="hidden" name="parent_task_id" value={t.id} />
                  <input
                    name="title"
                    required
                    maxLength={200}
                    placeholder="Subtask title…"
                    className="input text-[12px] py-1"
                  />
                  <select
                    name="assigned_to_agent_id"
                    className="input text-[12px] py-1"
                    defaultValue=""
                  >
                    <option value="">(unassigned)</option>
                    {members.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.avatar_emoji} {m.display_name}
                      </option>
                    ))}
                  </select>
                  <button
                    type="submit"
                    className="btn btn-secondary btn-sm w-full"
                  >
                    + Subtask
                  </button>
                </form>

                <details className="text-[12px] mt-3">
                  <summary className="cursor-pointer text-[color:var(--color-ink-soft)] select-none">
                    🔱 Create several subtasks at once…
                  </summary>
                  <form action={splitTaskAction} className="space-y-1.5 mt-2">
                    <input type="hidden" name="conversation_id" value={convId} />
                    <input type="hidden" name="parent_task_id" value={t.id} />
                    <textarea
                      name="titles"
                      rows={3}
                      placeholder={`One title per line\nResearch market\nResearch competitors\nResearch tech`}
                      className="input text-[12px] font-mono"
                      required
                    />
                    <div className="text-[10px] text-[color:var(--color-ink-soft)]">
                      Pick assignees in order; the first listed assignee gets
                      the first line, etc. Extra titles reuse the last assignee.
                    </div>
                    {members.map((m, i) => (
                      <select
                        key={m.id + i}
                        name="assignees"
                        defaultValue=""
                        className="input text-[12px] py-1"
                      >
                        <option value="">(slot {i + 1}: unassigned)</option>
                        {members.map((mm) => (
                          <option key={mm.id} value={mm.id}>
                            {mm.avatar_emoji} {mm.display_name}
                          </option>
                        ))}
                      </select>
                    ))}
                    <button
                      type="submit"
                      className="btn btn-primary btn-sm w-full"
                    >
                      Split
                    </button>
                  </form>
                </details>
              </>
            ) : null}
          </div>
        </aside>
      </main>
    </div>
  );
}
