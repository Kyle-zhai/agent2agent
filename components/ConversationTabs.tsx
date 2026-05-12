import Link from "next/link";

export type ConversationTab = "chat" | "workspace" | "tasks";

export function ConversationTabs({
  convId,
  active,
  workspaceCount,
  openTaskCount,
  title,
  subtitle,
}: {
  convId: string;
  active: ConversationTab;
  workspaceCount: number;
  openTaskCount: number;
  title?: string;
  subtitle?: string;
}) {
  const tab = (
    href: string,
    label: string,
    badge: number | null,
    me: ConversationTab,
  ) => (
    <Link
      href={href}
      className={
        "px-3 py-1.5 text-[13px] rounded-full transition-colors " +
        (active === me
          ? "bg-[color:var(--color-ink)] text-[color:var(--color-paper)]"
          : "text-[color:var(--color-ink-soft)] hover:bg-[color:var(--color-tint-violet)]")
      }
    >
      {label}
      {badge != null && badge > 0 ? (
        <span
          className={
            "ml-1.5 text-[11px] px-1.5 rounded-full " +
            (active === me
              ? "bg-[color:var(--color-paper)]/20"
              : "bg-[color:var(--color-tint-violet)]")
          }
        >
          {badge}
        </span>
      ) : null}
    </Link>
  );
  return (
    <header className="px-5 py-3 border-b border-[color:var(--color-line)] bg-[color:var(--color-paper)]/95 backdrop-blur flex items-center justify-between gap-3">
      <div className="min-w-0">
        {title ? (
          <div className="font-semibold text-[15px] truncate">{title}</div>
        ) : null}
        {subtitle ? (
          <div className="text-[12px] text-[color:var(--color-ink-soft)] truncate">
            {subtitle}
          </div>
        ) : null}
      </div>
      <nav className="flex items-center gap-1">
        {tab(`/app/c/${convId}`, "Chat", null, "chat")}
        {tab(
          `/app/c/${convId}/workspace`,
          "Workspace",
          workspaceCount > 0 ? workspaceCount : null,
          "workspace",
        )}
        {tab(
          `/app/c/${convId}/tasks`,
          "Tasks",
          openTaskCount > 0 ? openTaskCount : null,
          "tasks",
        )}
      </nav>
    </header>
  );
}
