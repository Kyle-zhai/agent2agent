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
          ? "bg-[color:var(--color-accent)] text-white"
          : "text-[color:var(--color-ink-muted)] hover:bg-[color:var(--color-hover)] hover:text-[color:var(--color-ink)]")
      }
    >
      {label}
      {badge != null && badge > 0 ? (
        <span
          className={
            "ml-1.5 text-[11px] px-1.5 rounded-full " +
            (active === me
              ? "bg-white/25 text-white"
              : "bg-[color:var(--color-paper-faint)] text-[color:var(--color-ink-muted)]")
          }
        >
          {badge}
        </span>
      ) : null}
    </Link>
  );
  return (
    <header className="px-5 py-3 border-b border-[color:var(--color-line)] bg-[color:var(--color-paper-strong)] backdrop-blur flex items-center justify-between gap-3">
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
          `/app?rail=files&conversation=${encodeURIComponent(convId)}`,
          "Files",
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
