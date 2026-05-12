import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import {
  getConversation,
  listMembers,
  requireUserMember,
} from "@/lib/conversations";
import { getAgent, parseAgentCapabilities } from "@/lib/agents";
import {
  createTask,
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
  awaiting_review: { text: "awaiting review", cls: "tag tag-amber" },
  changes_requested: { text: "changes requested", cls: "tag tag-pink" },
  done: { text: "done", cls: "tag tag-green" },
  cancelled: { text: "cancelled", cls: "tag" },
};

async function createTaskAction(formData: FormData) {
  "use server";
  const user = await requireUser();
  const convId = String(formData.get("conversation_id") ?? "");
  const title = String(formData.get("title") ?? "").trim();
  const description = String(formData.get("description") ?? "");
  const assignedTo =
    String(formData.get("assigned_to_agent_id") ?? "") || null;
  const workspaceId = String(formData.get("workspace_id") ?? "") || null;
  const reqCapsRaw = String(formData.get("required_capabilities") ?? "");
  const required = reqCapsRaw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const criteriaRaw = String(formData.get("success_criteria") ?? "").trim();
  const { myAgentId } = requireUserMember(convId, user.id);
  if (!title) {
    redirect(`/app/c/${convId}/tasks?error=title+required`);
  }
  let criteria: unknown = [];
  if (criteriaRaw) {
    try {
      criteria = JSON.parse(criteriaRaw);
    } catch {
      redirect(
        `/app/c/${convId}/tasks?error=${encodeURIComponent(
          "success_criteria must be JSON or blank",
        )}`,
      );
    }
  }
  try {
    const t = createTask({
      title,
      description,
      owner_agent_id: myAgentId,
      assigned_to_agent_id: assignedTo,
      conversation_id: convId,
      workspace_id: workspaceId,
      required_capabilities: required,
      success_criteria: criteria,
    });
    revalidatePath(`/app/c/${convId}/tasks`);
    redirect(`/app/c/${convId}/tasks/${t.id}`);
  } catch (err) {
    redirect(
      `/app/c/${convId}/tasks?error=${encodeURIComponent(
        err instanceof Error ? err.message : "Create failed.",
      )}`,
    );
  }
}

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
  const members = listMembers(convId)
    .map((m) => getAgent(m.agent_id))
    .filter((a): a is NonNullable<ReturnType<typeof getAgent>> => !!a);

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
        subtitle="Assignable work units with state machine + success criteria"
      />
      <main className="max-w-4xl mx-auto p-6 space-y-6">
        {sp.error ? (
          <div className="callout callout-amber text-[13px]">
            ⚠ {decodeURIComponent(sp.error)}
          </div>
        ) : null}

        <section className="surface p-5">
          <h2 className="font-semibold text-[15px] mb-3">New task</h2>
          <form action={createTaskAction} className="space-y-3">
            <input type="hidden" name="conversation_id" value={convId} />
            <input
              name="title"
              required
              maxLength={200}
              placeholder="What needs doing?"
              className="input"
            />
            <textarea
              name="description"
              rows={3}
              placeholder="Optional: paste a longer description or paste an Obsidian markdown note here."
              className="input"
            />
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <label className="text-[12px] flex flex-col gap-1">
                <span className="text-[color:var(--color-ink-soft)]">
                  Assignee (must hold all required capabilities)
                </span>
                <select name="assigned_to_agent_id" className="input">
                  <option value="">(unassigned)</option>
                  {members.map((m) => {
                    const caps = parseAgentCapabilities(m)
                      .map((c) => c.name as string)
                      .join(", ");
                    return (
                      <option key={m.id} value={m.id}>
                        {m.avatar_emoji} {m.display_name} — caps: [{caps || "none"}]
                      </option>
                    );
                  })}
                </select>
              </label>
              <label className="text-[12px] flex flex-col gap-1">
                <span className="text-[color:var(--color-ink-soft)]">
                  Workspace (optional)
                </span>
                <select name="workspace_id" className="input">
                  <option value="">(none)</option>
                  {workspaces.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className="text-[12px] flex flex-col gap-1">
              <span className="text-[color:var(--color-ink-soft)]">
                Required capabilities (comma-separated, e.g.{" "}
                <code>workspace.write, shell.run</code>)
              </span>
              <input name="required_capabilities" className="input" />
            </label>
            <label className="text-[12px] flex flex-col gap-1">
              <span className="text-[color:var(--color-ink-soft)]">
                Success criteria (JSON array — examples in docs/tech/TASKS.md)
              </span>
              <textarea
                name="success_criteria"
                rows={3}
                placeholder='[{"type":"diff_pattern","forbidden":["console\\.log"]}]'
                className="input font-mono text-[12px]"
              />
            </label>
            <button type="submit" className="btn btn-primary btn-sm">
              Create task
            </button>
          </form>
        </section>

        <section>
          <h2 className="font-semibold text-[14px] mb-2">
            Open · {open.length}
          </h2>
          <ul className="space-y-2">
            {open.length === 0 ? (
              <li className="text-[12px] text-[color:var(--color-ink-soft)]">
                Nothing in flight.
              </li>
            ) : (
              open.map((t) => (
                <li key={t.id}>
                  <Link
                    href={`/app/c/${convId}/tasks/${t.id}`}
                    className="surface surface-hover p-3 block"
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
                              {" · caps "}
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
            <ul className="space-y-2">
              {done.map((t) => (
                <li key={t.id}>
                  <Link
                    href={`/app/c/${convId}/tasks/${t.id}`}
                    className="surface surface-hover p-3 block opacity-70"
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
