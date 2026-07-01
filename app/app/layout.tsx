import { redirect } from "next/navigation";
import { getCurrentUser, signOut } from "@/lib/auth";
import { listAgentsForUser } from "@/lib/agents";
import { getConversationListBundles } from "@/lib/conversation-list";
import { listIncomingRequests } from "@/lib/friends";
import { countInboxItems } from "@/lib/inbox";
import { getUserAvatarPath } from "@/lib/users";
import { NotificationsHook } from "@/components/NotificationsHook";
import { UnreadSync } from "@/components/UnreadSync";
import { SidebarRail, type RailItem } from "@/components/SidebarRail";
import { SidebarPanel } from "@/components/SidebarPanel";
import { UniversalAgentRail } from "@/components/UniversalAgentRail";

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
  const incoming = listIncomingRequests(user.id);
  // Inbox badge = total pending items across all five sources (handoffs,
  // interconnects, friend requests, reviews, device approvals). Computed
  // server-side per request; RailButton hides the badge entirely at zero.
  const inboxCount = countInboxItems(user.id);

  const { pinned, active, archived, unreadTotal } = getConversationListBundles(
    user.id,
  );
  const userAvatar = getUserAvatarPath(user.id);

  const rail: RailItem[] = [
    {
      href: "/app/welcome",
      icon: "home",
      label: "Home",
      shortLabel: "Home",
      matchPrefix: "/app/welcome",
    },
    {
      href: "/app",
      icon: "workspace",
      label: "Workspace",
      shortLabel: "Workspace",
      matchPrefix: "/app",
      exact: true,
    },
    {
      href: "/app/contacts",
      icon: "contacts",
      label: "Contacts",
      shortLabel: "Contacts",
      badge: incoming.length || undefined,
      matchPrefix: "/app/contacts",
    },
    {
      href: "/app/agents",
      icon: "agents",
      label: "My agents",
      shortLabel: "Agents",
      matchPrefix: "/app/agents",
    },
    {
      href: "/app/inbox",
      icon: "inbox",
      label: "Inbox",
      shortLabel: "Inbox",
      badge: inboxCount || undefined,
      matchPrefix: "/app/inbox",
    },
  ];
  return (
    <div className="fixed inset-0 overflow-hidden bg-white">
      <NotificationsHook initialUnread={unreadTotal} />
      <UnreadSync count={unreadTotal} />
      <div className="flex h-full w-full">
        <SidebarRail
          items={rail}
          avatarSrc={userAvatar ? "/api/v1/avatars/me" : null}
          userInitial={user.display_name.charAt(0).toUpperCase()}
          userName={user.display_name}
          userEmail={user.email}
          onLogout={logoutAction}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <WorkspaceTopBar />
          <div className="flex min-h-0 flex-1">
            <SidebarPanel
              pinned={pinned}
              active={active}
              archived={archived}
              searchAction="/app/search"
            />
            <main className="min-w-0 flex-1 overflow-y-auto">{children}</main>
            <UniversalAgentRail
              agentCount={agents.length}
              inboxCount={inboxCount}
              roomCount={active.length + pinned.length + archived.length}
              requestCount={incoming.length}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function WorkspaceTopBar() {
  return (
    <header className="flex h-[72px] shrink-0 items-center border-b border-[color:var(--color-line)] bg-white px-5">
      <div className="flex items-center gap-2">
        <h1 className="text-[17px] font-semibold tracking-tight text-[color:var(--color-ink)]">
          Agent2Agent
        </h1>
        <svg className="text-[color:var(--color-tint-amber-ink)]" width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <path d="m12 2.8 2.7 5.6 6.2.9-4.5 4.3 1.1 6.1-5.5-2.9-5.5 2.9 1.1-6.1-4.5-4.3 6.2-.9L12 2.8Z" />
        </svg>
      </div>
    </header>
  );
}
