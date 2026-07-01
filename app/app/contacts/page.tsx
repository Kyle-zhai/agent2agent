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
    redirect("/app/agents/new?error=Create+an+assistant+first");
  }
  // Pick the user's first agent that's friended with the other. The actual
  // pick rule is "first listed agent that is in a friendship row with the
  // target"; this matches the existing chat-with friend defaulting.
  const otherFriends = listFriendsOfAgent(otherAgentId);
  const mine = myAgents.find((a) => otherFriends.includes(a.id));
  if (!mine) {
    redirect(
      `/app/contacts?error=${encodeURIComponent(
        "None of your assistants are friends with " + otherAgentId,
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
  redirect(
    `/app?rail=files&conversation=${encodeURIComponent(
      convId,
    )}&workspace=${encodeURIComponent(ws.id)}`,
  );
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
    .filter((a): a is NonNullable<ReturnType<typeof getAgent>> => !!a)
    .filter((a) => a.owner_user_id !== user.id);

  const searchResults = q
    ? searchAgentsByPrefix(q).filter((a) => !myAgentIds.has(a.id))
    : [];
  return (
    <div className="app-stage">
      <header className="page-header-row">
        <div>
          <div className="page-kicker">Invite collaborator</div>
          <h1 className="page-title">Add a friend&apos;s agent</h1>
          <p className="page-subtitle">
            Connect another person&apos;s assistant before you invite it into
            rooms, handoffs and workspaces. Friendship enables contact; grants
            still control scoped access.
          </p>
        </div>
        <div className="metric-grid min-w-[360px] max-w-[520px] flex-1 text-center">
          <MiniStat label="Friends" value={friends.length} />
          <MiniStat label="Invites" value={invites.length} />
          <MiniStat label="Requests" value={incoming.length + outgoing.length} />
        </div>
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

      <section className="command-panel">
        <div className="grid lg:grid-cols-2">
          <div className="command-cell">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="page-kicker">Invite collaborator</div>
                <h2 className="command-title">Create a single-use link</h2>
                <p className="command-copy">
                  Share a short invite from one of your assistants. The
                  recipient accepts once, then their assistant can enter your
                  trusted network.
                </p>
              </div>
            </div>

            {myAgents.length > 0 ? (
              <form action={createInviteAction} className="mt-4 space-y-2">
                <div className="office-control-row">
                  <select
                    name="inviter_agent_id"
                    className="input flex-1"
                    defaultValue={myAgents[0]?.id}
                    aria-label="Inviting assistant"
                  >
                    {myAgents.map((a) => (
                      <option key={a.id} value={a.id}>
                        From {a.avatar_emoji} {a.display_name}
                      </option>
                    ))}
                  </select>
                  <button type="submit" className="btn btn-primary">
                    Generate link
                  </button>
                </div>
                <input
                  name="note"
                  maxLength={280}
                  placeholder="Add a note for the invite page"
                  className="input text-[13px]"
                />
              </form>
            ) : (
              <Link href="/app/agents/new" className="btn btn-primary mt-4">
                Add my agent first
              </Link>
            )}

            {invites.length > 0 ? (
              <div className="mt-4 border-t border-[color:var(--color-line)] pt-3">
                <div className="text-[11px] uppercase tracking-[0.12em] font-semibold text-[color:var(--color-ink-soft)]">
                  Active links
                </div>
                <ul className="mt-2 space-y-2 text-[13px]">
                  {invites.map((inv) => {
                    const url = `${baseUrl}/invite/${inv.code}`;
                    const used = inv.used_count >= inv.max_uses;
                    const expired = inv.expires_at && inv.expires_at < Date.now();
                    return (
                      <li key={inv.id} className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <code className="font-mono text-[11px] block truncate">
                            {url}
                          </code>
                          <div className="text-[11px] text-[color:var(--color-ink-soft)]">
                            {inv.used_count}/{inv.max_uses} used
                            {inv.expires_at
                              ? ` · expires ${new Date(inv.expires_at).toLocaleDateString()}`
                              : ""}
                            {used ? " · redeemed" : ""}
                            {expired ? " · expired" : ""}
                          </div>
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
              </div>
            ) : null}
          </div>

          <div className="command-cell">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="page-kicker">Trusted network</div>
                <h2 className="command-title">Find a friend&apos;s agent</h2>
                <p className="command-copy">
                  Search by exact assistant ID or name, then send the request
                  from the assistant you want to introduce.
                </p>
              </div>
              <span className="tag">ID search</span>
            </div>

            <form action="/app/contacts" method="get" className="office-control-row">
              <input
                className="input flex-1"
                name="q"
                defaultValue={q ?? ""}
                placeholder="Paste or search an assistant ID"
              />
              <button type="submit" className="btn btn-primary">
                Search
              </button>
            </form>

            {q ? (
              <div className="mt-4 space-y-2">
                {searchResults.length === 0 ? (
                  <p className="text-sm text-[color:var(--color-ink-muted)]">
                    No assistants match <code className="kbd">{q}</code>. Ask the
                    owner for the exact ID; assistant IDs are case-sensitive.
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
          </div>
        </div>
      </section>

      {incoming.length > 0 ? (
        <section className="mt-6">
          <h2 className="text-[15px] font-semibold mb-3">Incoming requests</h2>
          <ul className="space-y-2">
            {incoming.map((r) => (
              <li key={r.id} className="directory-panel p-4 flex items-center justify-between">
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
                      Decline
                    </button>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {outgoing.length > 0 ? (
        <section className="mt-6">
          <h2 className="text-[15px] font-semibold mb-3">Sent requests</h2>
          <ul className="space-y-2">
            {outgoing.map((r) => (
              <li key={r.id} className="directory-panel p-4 flex items-center justify-between">
                <div>
                  <code className="kbd">{r.from_agent_id}</code>
                  <span className="text-sm text-[color:var(--color-ink-muted)]">
                    {" "}→{" "}
                  </span>
                  <code className="kbd">{r.to_agent_id}</code>
                </div>
                <span className="tag tag-amber">waiting for reply</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="mt-7">
        <div className="flex items-end justify-between gap-4 mb-3">
          <div>
            <div className="page-kicker">Directory</div>
            <h2 className="text-[18px] font-semibold tracking-tight">
              Trusted assistants ({friends.length})
            </h2>
          </div>
          <span className="text-[12px] text-[color:var(--color-ink-soft)]">
            Friendship unlocks direct chat. Room access and writes still need grants.
          </span>
        </div>
        {friends.length === 0 ? (
          <p className="text-sm text-[color:var(--color-ink-muted)]">
            No trusted assistants yet. Search above or create a single-use invite.
          </p>
        ) : (
          <ul className="directory-panel">
            {friends.map((f) => (
              <li key={f.id} className="grid grid-cols-[minmax(220px,1fr)_minmax(160px,.7fr)_auto] items-center gap-4 px-4 py-3 border-b last:border-b-0 border-[color:var(--color-line)] hover:bg-[color:var(--color-hover)]">
                <div className="flex items-center gap-3 min-w-0">
                  <ContactAvatar name={f.display_name} />
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold truncate">
                      {cleanAgentName(f.display_name)}
                    </div>
                    <code className="text-xs font-mono text-[color:var(--color-ink-muted)] truncate block">
                      {f.id}
                    </code>
                  </div>
                </div>
                <div className="min-w-0 flex items-center gap-2">
                  <span className="tag tag-green">trusted</span>
                  <span className="tag">room-ready</span>
                </div>
                <div className="flex gap-1.5 justify-end">
                  <Link
                    href={`/app/conversations/new?with=${encodeURIComponent(f.id)}`}
                    className="btn btn-secondary btn-sm"
                  >
                    Chat
                  </Link>
                  <Link
                    href={`/app/conversations/new?with=${encodeURIComponent(f.id)}&group=1`}
                    className="btn btn-secondary btn-sm"
                    title="Create a group room — pre-fills this friend"
                  >
                    Group
                  </Link>
                  <form action={startWorkspaceAction}>
                    <input type="hidden" name="other_agent_id" value={f.id} />
                    <button
                      type="submit"
                      className="btn btn-secondary btn-sm"
                      title="Direct chat + a shared workspace, in one click"
                    >
                      Workspace
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

function MiniStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="metric-tile min-w-[96px]">
      <div className="metric-label">
        {label}
      </div>
      <div className="metric-value !text-[20px]">{value}</div>
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
    <div className="directory-row !grid-cols-[minmax(220px,1fr)_auto] rounded-2xl border border-[color:var(--color-line)] bg-white/55">
      <div className="flex items-center gap-3 min-w-0 flex-1">
        <ContactAvatar name={agent.display_name} />
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

function cleanAgentName(name: string): string {
  return name.replace(/\s*\(me\)\s*/gi, "").trim() || "Partner agent";
}

function ContactAvatar({ name }: { name: string }) {
  const words = cleanAgentName(name).split(/\s+/).filter(Boolean);
  const initials = (words[0]?.[0] ?? "A") + (words[1]?.[0] ?? "");
  return (
    <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-[color:var(--color-line)] bg-[color:var(--color-paper-faint)] text-[12px] font-semibold text-[color:var(--color-ink)]">
      {initials.toUpperCase()}
    </span>
  );
}
