"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

export type RailItem = {
  href: string;
  icon: string;
  /** Full label, used for accessibility/title. */
  label: string;
  /** Optional shorter label rendered under the icon (≤ ~8 chars looks best).
   *  Defaults to `label` when omitted. */
  shortLabel?: string;
  badge?: number;
  /** URL prefix that marks this rail item as active. Use "/app" exact
   *  (matched precisely) or a section prefix like "/app/contacts". */
  matchPrefix: string;
  /** When true, only exact-match URL counts (used for "/app" Home). */
  exact?: boolean;
};

/**
 * Narrow icon rail (60px) on the left of the app shell. Hermes-style:
 *   - section icons in a vertical strip
 *   - violet pill highlight on the active section
 *   - tooltip on hover (CSS-only)
 *   - bottom slot holds avatar + log-out menu
 *
 * Splitting this into a client component lets us use usePathname for the
 * active-state without polluting the server-rendered layout shell.
 */
export function SidebarRail({
  items,
  avatarSrc,
  userInitial,
  userName,
  userEmail,
  onLogout,
}: {
  items: RailItem[];
  avatarSrc: string | null;
  userInitial: string;
  userName: string;
  userEmail: string;
  onLogout: (formData: FormData) => Promise<void>;
}) {
  const pathname = usePathname() ?? "/app";
  const [menuOpen, setMenuOpen] = useState(false);

  // Sliding white "notch" indicator behind the active rail item (mirrors the
  // reference dashboard's active-nav motion). We measure the active item's
  // position and animate a single pill to it; CSS handles the slide.
  const listRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLAnchorElement | null>>([]);
  const [pill, setPill] = useState<{ top: number; height: number } | null>(
    null,
  );
  const activeIndex = items.findIndex((it) =>
    it.exact
      ? pathname === it.matchPrefix
      : pathname === it.matchPrefix || pathname.startsWith(it.matchPrefix + "/"),
  );

  useEffect(() => {
    const el = itemRefs.current[activeIndex];
    if (!el) {
      setPill(null);
      return;
    }
    setPill({ top: el.offsetTop, height: el.offsetHeight });
  }, [activeIndex, pathname, items.length]);

  return (
    <nav
      aria-label="Primary navigation"
      className="rail-nav shrink-0 w-[72px] h-full flex flex-col items-center py-3 gap-1 z-30 rounded-[26px] bg-[color:var(--color-rail)] shadow-[var(--shadow-float)]"
    >
      <Link
        href="/app"
        className="block w-10 h-10 rounded-[13px] flex items-center justify-center bg-white text-[color:var(--color-ink)] text-[12px] font-bold tracking-tight mb-3"
        style={{ boxShadow: "0 2px 8px -3px rgba(0, 0, 0, 0.45)" }}
        title="Agent2Agent"
        aria-label="Agent2Agent home"
      >
        A2
      </Link>

      <div
        ref={listRef}
        className="relative flex-1 flex flex-col items-center gap-1 w-full px-1.5"
      >
        {pill ? (
          <span
            aria-hidden
            className="rail-pill"
            style={{
              transform: `translate(-50%, ${pill.top}px)`,
              height: pill.height,
            }}
          />
        ) : null}
        {items.map((it, i) => {
          const active = i === activeIndex;
          return (
            <RailButton
              key={it.href}
              href={it.href}
              icon={it.icon}
              label={it.label}
              shortLabel={it.shortLabel ?? it.label}
              badge={it.badge}
              active={active}
              innerRef={(el) => {
                itemRefs.current[i] = el;
              }}
            />
          );
        })}
      </div>

      <div className="relative w-full flex justify-center mt-1">
        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          className="w-9 h-9 rounded-full overflow-hidden border border-white/20 hover:border-white/55 transition-colors"
          aria-label="Account menu"
          title={userName}
        >
          {avatarSrc ? (
            <img
              src={avatarSrc}
              alt=""
              className="w-full h-full object-cover"
            />
          ) : (
            <span className="block w-full h-full flex items-center justify-center text-[13px] font-medium text-[color:var(--color-ink)] bg-[color:var(--color-tint-violet)]">
              {userInitial}
            </span>
          )}
        </button>
        {menuOpen ? (
          <div
            onMouseLeave={() => setMenuOpen(false)}
            className="absolute left-full ml-2 bottom-0 w-56 surface shadow-[var(--shadow-pop)] z-50 py-2"
          >
            <div className="px-3 pb-2 border-b border-[color:var(--color-line)]">
              <div className="text-[13px] font-medium truncate text-[color:var(--color-ink)]">
                {userName}
              </div>
              <div className="text-[11px] text-[color:var(--color-ink-soft)] truncate">
                {userEmail}
              </div>
            </div>
            <Link
              href="/app/me"
              onClick={() => setMenuOpen(false)}
              className="block px-3 py-1.5 text-[13px] text-[color:var(--color-ink)] hover:bg-[color:var(--color-hover)] flex items-center gap-2"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <circle cx="12" cy="8" r="4" />
                <path d="M5.5 21a6.5 6.5 0 0 1 13 0" />
              </svg>
              <span>Profile</span>
            </Link>
            <Link
              href="/app/settings"
              onClick={() => setMenuOpen(false)}
              className="block px-3 py-1.5 text-[13px] text-[color:var(--color-ink)] hover:bg-[color:var(--color-hover)] flex items-center gap-2"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <line x1="4" y1="21" x2="4" y2="14" />
                <line x1="4" y1="10" x2="4" y2="3" />
                <line x1="12" y1="21" x2="12" y2="12" />
                <line x1="12" y1="8" x2="12" y2="3" />
                <line x1="20" y1="21" x2="20" y2="16" />
                <line x1="20" y1="12" x2="20" y2="3" />
                <line x1="2" y1="14" x2="6" y2="14" />
                <line x1="10" y1="8" x2="14" y2="8" />
                <line x1="18" y1="16" x2="22" y2="16" />
              </svg>
              <span>Settings</span>
            </Link>
            <form action={onLogout} className="border-t border-[color:var(--color-line)] mt-1 pt-1">
              <button
                type="submit"
                className="w-full text-left px-3 py-1.5 text-[13px] text-[color:var(--color-danger)] hover:bg-[color:var(--color-danger-tint)] flex items-center gap-2"
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                  <path d="m16 17 5-5-5-5" />
                  <path d="M21 12H9" />
                </svg>
                <span>Log out</span>
              </button>
            </form>
          </div>
        ) : null}
      </div>
    </nav>
  );
}

function RailButton({
  href,
  icon,
  label,
  shortLabel,
  badge,
  active,
  innerRef,
}: {
  href: string;
  icon: string;
  label: string;
  shortLabel: string;
  badge?: number;
  active: boolean;
  innerRef?: (el: HTMLAnchorElement | null) => void;
}) {
  return (
    <Link
      ref={innerRef}
      href={href}
      title={label}
      aria-current={active ? "page" : undefined}
      className={
        "group relative z-10 w-[60px] py-2 rounded-2xl flex flex-col items-center justify-center gap-1 transition-[color,background-color] duration-[320ms] " +
        (active
          ? "text-[color:var(--color-ink)] font-semibold"
          : "text-[color:var(--color-rail-ink)] hover:bg-[color:var(--color-rail-soft)] hover:text-white")
      }
    >
      <RailIcon name={icon} />
      <span className="text-[10px] leading-tight text-center px-1 truncate w-full font-medium tracking-tight">
        {shortLabel}
      </span>
      {badge && badge > 0 ? (
        <span
          className="absolute top-1 right-2 min-w-[16px] h-[16px] px-1 rounded-full bg-[color:var(--color-danger)] text-white text-[9px] font-semibold flex items-center justify-center"
          aria-label={`${badge} unread`}
        >
          {badge > 99 ? "99+" : badge}
        </span>
      ) : null}
    </Link>
  );
}

/**
 * Monochrome line icons (Lucide-style, currentColor stroke) for the rail —
 * crisper and more "premium" than emoji, matching the Lark / Notion
 * minimalist aesthetic. 22px, 1.75 stroke, rounded joins.
 */
function RailIcon({ name }: { name: string }) {
  const common = {
    width: 22,
    height: 22,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.75,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  switch (name) {
    case "home":
      return (
        <svg {...common}>
          <path d="M3 9.5 12 3l9 6.5" />
          <path d="M5 9v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9" />
          <path d="M9 21v-7h6v7" />
        </svg>
      );
    case "collab":
      return (
        <svg {...common}>
          <path d="m22 2-7 20-4-9-9-4Z" />
          <path d="M22 2 11 13" />
        </svg>
      );
    case "inbox":
      return (
        <svg {...common}>
          <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
          <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
        </svg>
      );
    case "contacts":
      return (
        <svg {...common}>
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
      );
    case "agents":
      return (
        <svg {...common}>
          <rect x="4" y="9" width="16" height="11" rx="2.5" />
          <path d="M12 9V5.5" />
          <circle cx="12" cy="3.7" r="1.4" />
          <path d="M9.2 14h.01" />
          <path d="M14.8 14h.01" />
          <path d="M9.5 17.2h5" />
        </svg>
      );
    case "search":
      return (
        <svg {...common}>
          <circle cx="11" cy="11" r="7" />
          <path d="m21 21-4.3-4.3" />
        </svg>
      );
    case "settings":
      return (
        <svg {...common}>
          <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" />
        </svg>
      );
  }
}
