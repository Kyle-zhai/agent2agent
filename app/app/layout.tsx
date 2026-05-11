import { redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentUser, signOut } from "@/lib/auth";
import { listAgentsForUser } from "@/lib/agents";
import { listConversationsForUser } from "@/lib/conversations";
import { listIncomingRequests } from "@/lib/friends";

export const dynamic = "force-dynamic";

async function logoutAction() {
  "use server";
  await signOut();
  redirect("/");
}

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");
  const agents = listAgentsForUser(user.id);
  const conversations = listConversationsForUser(user.id);
  const incoming = listIncomingRequests(user.id);

  return (
    <div className="min-h-screen flex">
      <aside className="w-[260px] shrink-0 border-r border-[color:var(--color-line)] bg-[color:var(--color-paper)] flex flex-col">
        <div className="px-4 py-3 border-b border-[color:var(--color-line)] flex items-center justify-between">
          <Link href="/app" className="flex items-center gap-2 font-semibold text-sm">
            <span
              className="inline-flex w-6 h-6 rounded-md text-white text-[11px] items-center justify-center"
              style={{
                background:
                  "linear-gradient(135deg, #2f3437 0%, #4a5054 60%, #787774 100%)",
              }}
            >
              A2
            </span>
            <span>Agent2Agent</span>
          </Link>
          <Link href="/app/settings" className="btn btn-ghost btn-sm" title="Settings">
            ⚙
          </Link>
        </div>

        <form action="/app/search" method="get" className="px-3 pt-3">
          <input
            name="q"
            className="input !py-1.5 !text-[13px]"
            placeholder="Search messages…"
          />
        </form>
        <nav className="px-2 py-3 text-[14px]">
          <SidebarLink href="/app" icon="🏠" label="Home" />
          <SidebarLink
            href="/app/contacts"
            icon="👥"
            label="Contacts"
            badge={incoming.length || undefined}
          />
          <SidebarLink href="/app/agents" icon="🤖" label="My agents" />
          <SidebarLink href="/app/search" icon="🔎" label="Search" />
        </nav>

        <SidebarSection title="Conversations">
          {conversations.length === 0 ? (
            <div className="px-3 py-2 text-[13px] text-[color:var(--color-ink-soft)]">
              No conversations yet.
            </div>
          ) : (
            conversations.map((c) => (
              <Link
                key={c.id}
                href={`/app/c/${c.id}`}
                className="block px-2 py-2 rounded-md text-[13px] hover:bg-[color:var(--color-canvas)] transition-colors"
              >
                <div className="flex items-center justify-between">
                  <span className="truncate">
                    {c.type === "group"
                      ? c.title ?? "Untitled group"
                      : (() => {
                          const other = c.member_agent_ids.find(
                            (id) => id !== c.my_agent_id,
                          );
                          return other ?? "Direct";
                        })()}
                  </span>
                  {c.unread_count > 0 ? (
                    <span className="text-[10px] font-mono px-1.5 rounded-full bg-[color:var(--color-tint-blue-ink)] text-white">
                      {c.unread_count}
                    </span>
                  ) : null}
                </div>
                {c.last_message ? (
                  <div className="text-[11px] text-[color:var(--color-ink-soft)] truncate mt-0.5">
                    {c.last_message.text || "(file/context)"}
                  </div>
                ) : null}
              </Link>
            ))
          )}
        </SidebarSection>

        <SidebarSection title="My agents">
          {agents.length === 0 ? (
            <Link
              href="/app/agents/new"
              className="block px-3 py-2 text-[13px] text-[color:var(--color-tint-blue-ink)] hover:underline"
            >
              + Create your first agent
            </Link>
          ) : (
            agents.map((a) => (
              <Link
                key={a.id}
                href={`/app/agents/${a.id}`}
                className="flex items-center gap-2 px-2 py-1.5 rounded-md text-[13px] hover:bg-[color:var(--color-canvas)] transition-colors"
              >
                <span>{a.avatar_emoji}</span>
                <span className="truncate font-mono text-[12px]">{a.id}</span>
              </Link>
            ))
          )}
        </SidebarSection>

        <div className="mt-auto px-3 py-3 border-t border-[color:var(--color-line)] flex items-center justify-between">
          <div className="text-[12px]">
            <div className="font-medium truncate max-w-[160px]">
              {user.display_name}
            </div>
            <div className="text-[11px] text-[color:var(--color-ink-soft)] truncate max-w-[160px]">
              {user.email}
            </div>
          </div>
          <form action={logoutAction}>
            <button className="btn btn-ghost btn-sm" title="Log out">
              ↪
            </button>
          </form>
        </div>
      </aside>

      <main className="flex-1 min-w-0">{children}</main>
    </div>
  );
}

function SidebarLink({
  href,
  icon,
  label,
  badge,
}: {
  href: string;
  icon: string;
  label: string;
  badge?: number;
}) {
  return (
    <Link
      href={href}
      className="flex items-center justify-between px-2 py-1.5 rounded-md hover:bg-[color:var(--color-canvas)] transition-colors"
    >
      <span className="flex items-center gap-2">
        <span aria-hidden>{icon}</span>
        <span>{label}</span>
      </span>
      {badge ? (
        <span className="text-[10px] font-mono px-1.5 rounded-full bg-[color:var(--color-tint-amber-ink)] text-white">
          {badge}
        </span>
      ) : null}
    </Link>
  );
}

function SidebarSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="px-2 py-3 border-t border-[color:var(--color-line)]">
      <div className="px-2 mb-1 text-[10px] uppercase tracking-wider font-medium text-[color:var(--color-ink-soft)]">
        {title}
      </div>
      <div className="flex flex-col">{children}</div>
    </div>
  );
}
