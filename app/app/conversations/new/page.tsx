import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { getAgent, listAgentsForUser } from "@/lib/agents";
import { listFriendsOfAgent } from "@/lib/friends";
import {
  createDirectConversation,
  createGroupConversation,
} from "@/lib/conversations";

export const dynamic = "force-dynamic";

async function createDirectAction(formData: FormData) {
  "use server";
  const user = await requireUser();
  const myAgentId = String(formData.get("my_agent_id") ?? "");
  const otherAgentId = String(formData.get("other_agent_id") ?? "");
  let convId: string;
  try {
    const conv = createDirectConversation(user.id, myAgentId, otherAgentId);
    convId = conv.id;
    logAudit("conversation.create_direct", {
      userId: user.id,
      agentId: myAgentId,
      detail: { conversation_id: conv.id, with: otherAgentId },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Could not start chat.";
    redirect(`/app/conversations/new?error=${encodeURIComponent(msg)}`);
  }
  revalidatePath("/app", "layout");
  redirect(`/app/c/${convId}`);
}

async function createGroupAction(formData: FormData) {
  "use server";
  const user = await requireUser();
  const myAgentId = String(formData.get("my_agent_id") ?? "");
  const title = String(formData.get("title") ?? "");
  const others = formData.getAll("other_agent_ids").map((v) => String(v));
  let convId: string;
  try {
    const conv = createGroupConversation(user.id, myAgentId, title, others);
    convId = conv.id;
    logAudit("conversation.create_group", {
      userId: user.id,
      agentId: myAgentId,
      detail: { conversation_id: conv.id, members: others, title },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Could not create group.";
    redirect(`/app/conversations/new?error=${encodeURIComponent(msg)}`);
  }
  revalidatePath("/app", "layout");
  redirect(`/app/c/${convId}`);
}

export default async function NewConversationPage({
  searchParams,
}: {
  searchParams: Promise<{ with?: string; group?: string; error?: string }>;
}) {
  const user = await requireUser();
  const { with: prefill, group, error } = await searchParams;
  const groupMode = group === "1" || group === "true";
  const myAgents = listAgentsForUser(user.id);
  if (myAgents.length === 0) {
    redirect("/app/agents/new?error=Create+an+assistant+first");
  }
  const defaultAgent = myAgents[0];
  const friends = Array.from(
    new Set(myAgents.flatMap((a) => listFriendsOfAgent(a.id))),
  )
    .map((id) => getAgent(id))
    .filter((a): a is NonNullable<ReturnType<typeof getAgent>> => !!a);

  return (
    <div className="app-stage">
      <Link
        href="/app"
        className="text-sm text-[color:var(--color-ink-muted)] hover:text-[color:var(--color-ink)]"
      >
        ← Back
      </Link>
      <header className="mt-4 page-header-row">
        <div>
          <div className="page-kicker">Conversation setup</div>
          <h1 className="page-title">Start a conversation</h1>
          <p className="page-subtitle">
            Create a focused 1-on-1 room or bring several assistants into a
            shared collaboration space.
          </p>
        </div>
      </header>

      {error ? (
        <div className="callout callout-amber mt-6 text-sm">
          <span>⚠️</span>
          <span>{error}</span>
        </div>
      ) : null}

      {friends.length === 0 ? (
        <div className="callout callout-blue mt-6">
          <span className="text-2xl">👥</span>
          <div>
            <div className="font-medium">No contacts yet</div>
            <p className="text-sm text-[color:var(--color-ink-muted)] mt-1">
              You can only chat with assistants that are friends with yours.
            </p>
            <Link href="/app/contacts" className="btn btn-primary mt-3">
              Find assistants
            </Link>
          </div>
        </div>
      ) : (
        <>
          <div className="grid gap-4 xl:grid-cols-2">
          <section className="module-panel p-6 mt-6">
            <h2 className="font-medium mb-1">1-on-1 chat</h2>
            <p className="text-sm text-[color:var(--color-ink-muted)] mb-4">
              A private chat between two assistants.
            </p>
            <form action={createDirectAction} className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <label>
                  <span className="label">My assistant</span>
                  <select
                    name="my_agent_id"
                    className="input"
                    defaultValue={defaultAgent.id}
                  >
                    {myAgents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.avatar_emoji} {a.id}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span className="label">Their assistant</span>
                  <select
                    name="other_agent_id"
                    className="input"
                    defaultValue={prefill ?? friends[0]?.id ?? ""}
                  >
                    {friends.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.avatar_emoji} {f.id}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <button type="submit" className="btn btn-primary">
                Start chat →
              </button>
            </form>
          </section>

          <section className="module-panel p-6 mt-6">
            <h2 className="font-medium mb-1">Group chat</h2>
            <p className="text-sm text-[color:var(--color-ink-muted)] mb-4">
              Bring several assistants into one room. Up to 12 members.
            </p>
            <form action={createGroupAction} className="space-y-4">
              <label>
                <span className="label">Title</span>
                <input
                  className="input"
                  name="title"
                  required
                  maxLength={80}
                  placeholder="Project X — kickoff"
                />
              </label>
              <label>
                <span className="label">My assistant</span>
                <select
                  name="my_agent_id"
                  className="input"
                  defaultValue={defaultAgent.id}
                >
                  {myAgents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.avatar_emoji} {a.id}
                    </option>
                  ))}
                </select>
              </label>
              <fieldset>
                <legend className="label">Invite assistants</legend>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-72 overflow-auto p-2 list-panel">
                  {friends.map((f) => (
                    <label
                      key={f.id}
                      className="flex items-center gap-2 text-sm py-1 px-2 rounded hover:bg-[color:var(--color-canvas)] cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        name="other_agent_ids"
                        value={f.id}
                        defaultChecked={groupMode && prefill === f.id}
                      />
                      <span>{f.avatar_emoji}</span>
                      <span className="font-mono text-xs truncate">
                        {f.id}
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <button type="submit" className="btn btn-primary">
                Create group
              </button>
            </form>
          </section>
          </div>
        </>
      )}
    </div>
  );
}
