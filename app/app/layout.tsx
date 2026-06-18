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
      href: "/app",
      icon: "home",
      label: "Home",
      shortLabel: "Home",
      matchPrefix: "/app",
      exact: true,
    },
    {
      href: "/app/inbox",
      icon: "inbox",
      label: "Inbox",
      shortLabel: "Inbox",
      badge: inboxCount || undefined,
      matchPrefix: "/app/inbox",
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
      label: "My assistants",
      shortLabel: "Assistants",
      matchPrefix: "/app/agents",
    },
    {
      href: "/app/search",
      icon: "search",
      label: "Search",
      shortLabel: "Search",
      matchPrefix: "/app/search",
    },
    {
      href: "/app/settings",
      icon: "settings",
      label: "Settings",
      shortLabel: "Settings",
      matchPrefix: "/app/settings",
    },
  ];
  // Quiet the "unused variable" lint hint — `agents` was used previously
  // for an empty-state badge that we removed; keep the import path for
  // future re-use.
  void agents;

  return (
    // Anchor to the exact visible client area (`fixed inset-0`) so the shell
    // never causes page scroll. Inside it we CENTER a contained app frame with
    // breathing room on all four sides: on large screens the frame caps its
    // size and floats on the canvas backdrop with margins; on smaller screens
    // it fills the available space (minus padding). Tall non-chat pages scroll
    // inside <main>, never the page.
    // Mobile (<sm) tightens the gutters (px-2 pt-2 pb-3) so the rail + one
    // full-width column fit a 375px viewport; sm+ keeps the original frame.
    <div className="fixed inset-0 flex justify-center px-2 sm:px-6 lg:px-8 pt-2 sm:pt-4 pb-3 sm:pb-8 bg-[color:var(--color-canvas)] overflow-hidden">
      <NotificationsHook initialUnread={unreadTotal} />
      <UnreadSync count={unreadTotal} />
      {/* Wider frame (smaller side gutters), with the vertical padding biased
          toward the bottom (sm:pt-4 / sm:pb-8) so there's more breathing room
          below the app than above it. */}
      <div className="flex gap-2.5 w-full h-full max-w-[1840px]">
        <SidebarRail
          items={rail}
          avatarSrc={userAvatar ? "/api/v1/avatars/me" : null}
          userInitial={user.display_name.charAt(0).toUpperCase()}
          userName={user.display_name}
          userEmail={user.email}
          onLogout={logoutAction}
        />
        <SidebarPanel
          pinned={pinned}
          active={active}
          archived={archived}
          searchAction="/app/search"
        />
        <main className="flex-1 min-w-0 h-full overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}
