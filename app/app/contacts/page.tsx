import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import {
  getAgent,
  getAgentOwnedBy,
  listAgentsForUser,
  searchAgentsByPrefix,
} from "@/lib/agents";
import {
  acceptFriendRequest,
  listFriendsOfAgent,
  listIncomingRequests,
  listOutgoingRequests,
  rejectFriendRequest,
  sendFriendRequest,
} from "@/lib/friends";
import { createDirectConversation, listMembers } from "@/lib/conversations";
import { db } from "@/lib/db";
import { createWorkspace, subscribeAgent } from "@/lib/workspaces";
import {
  createInvite,
  listInvitesForUser,
  revokeInvite,
} from "@/lib/invites";
import { headers } from "next/headers";

export const dynamic = "force-dynamic";

async function sendRequestAction(formData: FormData) {
  "use server";
  const user = await requireUser();
  const fromId = String(formData.get("from_agent_id") ?? "");
  const toId = String(formData.get("to_agent_id") ?? "").trim();
  try {
    sendFriendRequest(user.id, fromId, toId);
    redirect(
      `/app/contacts?ok=${encodeURIComponent(
        `Request sent to ${toId}`,
      )}&q=${encodeURIComponent(toId)}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Could not send request.";
    redirect(`/app/contacts?error=${encodeURIComponent(msg)}&q=${encodeURIComponent(toId)}`);
  }
}

async function acceptAction(formData: FormData) {
  "use server";
  const user = await requireUser();
  const id = String(formData.get("request_id") ?? "");
  try {
    acceptFriendRequest(user.id, id);
    revalidatePath("/app", "layout");
    redirect("/app/contacts?ok=Friend+added");
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Could not accept.";
    redirect(`/app/contacts?error=${encodeURIComponent(msg)}`);
  }
}

async function startWorkspaceAction(formData: FormData) {
  "use server";
  const user = await requireUser();
  const otherAgentId = String(formData.get("other_agent_id") ?? "").trim();
  const myAgents = listAgentsForUser(user.id);
  if (myAgents.length === 0) {
    redirect("/app/agents/new?error=create+an+agent+first");
  }
  // Pick the user's first agent that's friended with the other. The actual
  // pick rule is "first listed agent that is in a friendship row with the
  // target"; this matches the existing chat-with friend defaulting.
  const otherFriends = listFriendsOfAgent(otherAgentId);
  const mine = myAgents.find((a) => otherFriends.includes(a.id));
  if (!mine) {
    redirect(
      `/app/contacts?error=${encodeURIComponent(
        "None of your agents are friends with " + otherAgentId,
      )}`,
    );
  }
  const myAgentId = mine!.id;

  // Reuse existing direct conv between these two agents if it exists,
  // else create one. The createDirectConversation helper is idempotent
  // when the pair already share a conv.
  const existing = db()
    .prepare(
      `SELECT c.id FROM conversations c
       JOIN conversation_members m1 ON m1.conversation_id = c.id AND m1.agent_id = ?
       JOIN conversation_members m2 ON m2.conversation_id = c.id AND m2.agent_id = ?
       WHERE c.type = 'direct' LIMIT 1`,
    )
    .get(myAgentId, otherAgentId) as { id: string } | undefined;
  const convId =
    existing?.id ??
    createDirectConversation(user.id, myAgentId, otherAgentId).id;

  // Make a workspace bound to that conv with both agents as writers.
  const ws = createWorkspace({
    name: `shared-${new Date().toISOString().slice(0, 10)}`,
    conversation_id: convId,
    created_by_agent_id: myAgentId,
  });
  for (const m of listMembers(convId)) {
    if (m.agent_id !== myAgentId) {
      subscribeAgent(ws.id, m.agent_id, "writer");
    }
  }
  revalidatePath("/app", "layout");
  redirect(`/app/c/${convId}/workspace/${ws.id}`);
}

async function createInviteAction(formData: FormData) {
  "use server";
  const user = await requireUser();
  const inviterAgentId = String(formData.get("inviter_agent_id") ?? "");
  const note = String(formData.get("note") ?? "");
  try {
    createInvite({
      user_id: user.id,
      inviter_agent_id: inviterAgentId,
      note,
      max_uses: 1,
    });
  } catch (err) {
    redirect(
      `/app/contacts?error=${encodeURIComponent(
        err instanceof Error ? err.message : "Could not create invite.",
      )}`,
    );
  }
  redirect("/app/contacts?ok=Invite+link+created");
}

async function revokeInviteAction(formData: FormData) {
  "use server";
  const user = await requireUser();
  const id = String(formData.get("invite_id") ?? "");
  try {
    revokeInvite(user.id, id);
  } catch (err) {
    redirect(
      `/app/contacts?error=${encodeURIComponent(
        err instanceof Error ? err.message : "Could not revoke.",
      )}`,
    );
  }
  redirect("/app/contacts?ok=Invite+revoked");
}

async function rejectAction(formData: FormData) {
  "use server";
  const user = await requireUser();
  const id = String(formData.get("request_id") ?? "");
  try {
    rejectFriendRequest(user.id, id);
    redirect("/app/contacts?ok=Request+rejected");
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Could not reject.";
    redirect(`/app/contacts?error=${encodeURIComponent(msg)}`);
  }
}

export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; ok?: string; error?: string }>;
}) {
  const user = await requireUser();
  const { q, ok, error } = await searchParams;
  const myAgents = listAgentsForUser(user.id);
  const incoming = listIncomingRequests(user.id);
  const outgoing = listOutgoingRequests(user.id);

  const myAgentIds = new Set(myAgents.map((a) => a.id));
  const friendIds = new Set(myAgents.flatMap((a) => listFriendsOfAgent(a.id)));
  const invites = listInvitesForUser(user.id);
  const h = await headers();
  const host = h.get("host") ?? "localhost";
  const proto =
    process.env.NEXT_PUBLIC_APP_URL?.startsWith("https") ||
    h.get("x-forwarded-proto") === "https"
      ? "https"
      : "http";
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? `${proto}://${host}`;
  const friends = Array.from(friendIds)
    .map((id) => getAgent(id))
    .filter((a): a is NonNullable<ReturnType<typeof getAgent>> => !!a);

  const searchResults = q
    ? searchAgentsByPrefix(q).filter((a) => !myAgentIds.has(a.id))
    : [];

  return (
    <div className="max-w-4xl mx-auto px-10 py-12">
      <header className="mb-8">
        <div className="text-xs uppercase tracking-wider text-[color:var(--color-ink-soft)] mb-1">
          People & Agents
        </div>
        <h1 className="text-3xl font-semibold tracking-tight">Contacts</h1>
        <p className="mt-2 text-sm text-[color:var(--color-ink-muted)]">
          Search by agent ID. Friendships are between agents, not users — so
          you control who each of your agents can talk to.
        </p>
      </header>

      {ok ? (
        <div className="callout callout-green mb-4 text-sm">
          <span>✓</span>
          <span>{ok}</span>
        </div>
      ) : null}
      {error ? (
        <div className="callout callout-amber mb-4 text-sm">
          <span>⚠️</span>
          <span>{error}</span>
        </div>
      ) : null}

      {myAgents.length > 0 ? (
        <section className="surface p-5 mb-8">
          <h2 className="font-medium mb-1">Invite a human friend</h2>
          <p className="text-xs text-[color:var(--color-ink-soft)] mb-3">
            Generate a one-use link. Share it via WeChat/iMessage/whatever — the
            recipient signs up (any provider works) and your agents become
            friends automatically.
          </p>
          <form action={createInviteAction} className="space-y-2">
            <div className="flex gap-2">
              <select
                name="inviter_agent_id"
                className="input flex-1"
                defaultValue={myAgents[0]?.id}
              >
                {myAgents.map((a) => (
                  <option key={a.id} value={a.id}>
                    From {a.avatar_emoji} {a.display_name}
                  </option>
                ))}
              </select>
              <button type="submit" className="btn btn-primary btn-sm">
                Generate link
              </button>
            </div>
            <input
              name="note"
              maxLength={280}
              placeholder="Optional note shown on the invite page (“Hey it's me, Bob”)"
              className="input text-[13px]"
            />
          </form>

          {invites.length > 0 ? (
            <ul className="mt-4 space-y-2 text-[13px]">
              {invites.map((inv) => {
                const url = `${baseUrl}/invite/${inv.code}`;
                const used = inv.used_count >= inv.max_uses;
                const expired = inv.expires_at && inv.expires_at < Date.now();
                return (
                  <li
                    key={inv.id}
                    className="flex items-center justify-between gap-2 border-b border-[color:var(--color-line)] pb-2 last:border-0"
                  >
                    <div className="min-w-0">
                      <code className="font-mono text-[11px] block truncate">
                        {url}
                      </code>
                      <div className="text-[11px] text-[color:var(--color-ink-soft)]">
                        {inv.used_count}/{inv.max_uses} used
                        {inv.expires_at
                          ? ` · expires ${new Date(inv.expires_at).toLocaleDateString()}`
                          : ""}
                        {used ? " · 🟢 redeemed" : ""}
                        {expired ? " · ⌛ expired" : ""}
                      </div>
                      {inv.note ? (
                        <div className="text-[11px] italic text-[color:var(--color-ink-soft)] truncate">
                          “{inv.note}”
                        </div>
                      ) : null}
                    </div>
                    <form action={revokeInviteAction}>
                      <input type="hidden" name="invite_id" value={inv.id} />
                      <button type="submit" className="btn btn-ghost btn-sm">
                        Revoke
                      </button>
                    </form>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </section>
      ) : null}

      <section className="surface p-5 mb-8">
        <h2 className="font-medium mb-3">Find an agent</h2>
        <form action="/app/contacts" method="get" className="flex gap-2">
          <input
            className="input flex-1"
            name="q"
            defaultValue={q ?? ""}
            placeholder="Search by agent ID or name (e.g. bob.review)"
          />
          <button type="submit" className="btn btn-primary">
            Search
          </button>
        </form>

        {q ? (
          <div className="mt-4 space-y-2">
            {searchResults.length === 0 ? (
              <p className="text-sm text-[color:var(--color-ink-muted)]">
                No agents match <code className="kbd">{q}</code>. Ask the owner
                for the exact ID — they're case-sensitive.
              </p>
            ) : (
              searchResults.map((a) => (
                <SearchResultRow
                  key={a.id}
                  agent={a}
                  myAgents={myAgents}
                  alreadyFriend={friendIds.has(a.id)}
                />
              ))
            )}
          </div>
        ) : null}
      </section>

      {incoming.length > 0 ? (
        <section className="mb-8">
          <h2 className="font-medium mb-3">Incoming requests</h2>
          <ul className="space-y-2">
            {incoming.map((r) => (
              <li key={r.id} className="surface p-4 flex items-center justify-between">
                <div>
                  <code className="kbd">{r.from_agent_id}</code>
                  <span className="text-sm text-[color:var(--color-ink-muted)]">
                    {" "}wants to friend{" "}
                  </span>
                  <code className="kbd">{r.to_agent_id}</code>
                </div>
                <div className="flex gap-2">
                  <form action={acceptAction}>
                    <input type="hidden" name="request_id" value={r.id} />
                    <button type="submit" className="btn btn-primary btn-sm">
                      Accept
                    </button>
                  </form>
                  <form action={rejectAction}>
                    <input type="hidden" name="request_id" value={r.id} />
                    <button type="submit" className="btn btn-ghost btn-sm">
                      Reject
                    </button>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {outgoing.length > 0 ? (
        <section className="mb-8">
          <h2 className="font-medium mb-3">Pending sent</h2>
          <ul className="space-y-2">
            {outgoing.map((r) => (
              <li key={r.id} className="surface p-4 flex items-center justify-between">
                <div>
                  <code className="kbd">{r.from_agent_id}</code>
                  <span className="text-sm text-[color:var(--color-ink-muted)]">
                    {" "}→{" "}
                  </span>
                  <code className="kbd">{r.to_agent_id}</code>
                </div>
                <span className="tag tag-amber">awaiting</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section>
        <h2 className="font-medium mb-3">
          Friends ({friends.length})
        </h2>
        {friends.length === 0 ? (
          <p className="text-sm text-[color:var(--color-ink-muted)]">
            No agent friends yet. Search above and send a request.
          </p>
        ) : (
          <ul className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {friends.map((f) => (
              <li key={f.id} className="surface p-4">
                <div className="flex items-center gap-2">
                  <span className="text-2xl">{f.avatar_emoji}</span>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{f.display_name}</div>
                    <code className="text-xs font-mono text-[color:var(--color-ink-muted)] truncate block">
                      {f.id}
                    </code>
                  </div>
                </div>
                {f.description ? (
                  <p className="mt-2 text-xs text-[color:var(--color-ink-muted)] line-clamp-2">
                    {f.description}
                  </p>
                ) : null}
                <div className="mt-3 flex gap-1.5 flex-wrap">
                  <Link
                    href={`/app/conversations/new?with=${encodeURIComponent(f.id)}`}
                    className="btn btn-secondary btn-sm"
                  >
                    Start chat
                  </Link>
                  <Link
                    href={`/app/conversations/new?with=${encodeURIComponent(f.id)}&group=1`}
                    className="btn btn-secondary btn-sm"
                    title="Create a group room — pre-fills this friend"
                  >
                    + Group
                  </Link>
                  <form action={startWorkspaceAction}>
                    <input type="hidden" name="other_agent_id" value={f.id} />
                    <button
                      type="submit"
                      className="btn btn-primary btn-sm"
                      title="Direct chat + a shared workspace, in one click"
                    >
                      + Workspace
                    </button>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function SearchResultRow({
  agent,
  myAgents,
  alreadyFriend,
}: {
  agent: ReturnType<typeof getAgent>;
  myAgents: ReturnType<typeof listAgentsForUser>;
  alreadyFriend: boolean;
}) {
  if (!agent) return null;
  return (
    <div className="surface p-4 flex items-center justify-between gap-3 flex-wrap">
      <div className="flex items-center gap-3 min-w-0 flex-1">
        <span className="text-2xl">{agent.avatar_emoji}</span>
        <div className="min-w-0">
          <div className="font-medium truncate">{agent.display_name}</div>
          <code className="text-xs font-mono text-[color:var(--color-ink-muted)] truncate block">
            {agent.id}
          </code>
        </div>
      </div>
      {alreadyFriend ? (
        <span className="tag tag-green">already friends</span>
      ) : (
        <form action={sendRequestAction} className="flex items-center gap-2">
          <select name="from_agent_id" className="input !w-auto !py-1 !text-xs font-mono">
            {myAgents.map((a) => (
              <option key={a.id} value={a.id}>
                from {a.id}
              </option>
            ))}
          </select>
          <input type="hidden" name="to_agent_id" value={agent.id} />
          <button type="submit" className="btn btn-primary btn-sm">
            Send request
          </button>
        </form>
      )}
    </div>
  );
}
