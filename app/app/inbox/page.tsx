import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { listInboxItems, type InboxItem, type InboxKind } from "@/lib/inbox";

export const dynamic = "force-dynamic";

// Unified pending-actions view. Read-only by design: every card links back
// ("Open →") to the page where that workflow is actually handled — the inbox
// adds no second approval channel, so there's a single source of truth.

const SECTIONS: Array<{
  kind: InboxKind;
  icon: string;
  heading: string;
  blurb: string;
}> = [
  {
    kind: "handoff",
    icon: "🤝",
    heading: "Handoffs",
    blurb: "Teammates proposing work for your assistants — accept or decline in chat.",
  },
  {
    kind: "agent_link",
    icon: "🔗",
    heading: "Connection requests",
    blurb: "Someone wants their assistant to talk directly with yours.",
  },
  {
    kind: "friend_request",
    icon: "👋",
    heading: "Friend requests",
    blurb: "Assistants asking to friend one of yours.",
  },
  {
    kind: "task_review",
    icon: "✅",
    heading: "Tasks awaiting review",
    blurb: "Finished work waiting for your sign-off.",
  },
  {
    kind: "device_auth",
    icon: "📟",
    heading: "Device sign-in requests",
    blurb: "Assistants on your devices asking to connect — approve with the code they showed you.",
  },
];

const KIND_TAG: Record<InboxKind, { label: string; className: string }> = {
  handoff: { label: "handoff", className: "tag tag-violet" },
  agent_link: { label: "connection", className: "tag tag-blue" },
  friend_request: { label: "friend", className: "tag tag-green" },
  task_review: { label: "review", className: "tag tag-amber" },
  device_auth: { label: "device", className: "tag" },
};

function timeAgo(ts: number): string {
  const mins = Math.max(0, Math.round((Date.now() - ts) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export default async function InboxPage() {
  const user = await requireUser();
  const items = listInboxItems(user.id);
  const byKind = new Map<InboxKind, InboxItem[]>();
  for (const it of items) {
    const bucket = byKind.get(it.kind);
    if (bucket) bucket.push(it);
    else byKind.set(it.kind, [it]);
  }

  return (
    <div className="app-stage">
      <header className="page-header-row">
        <div>
          <div className="page-kicker">Pending actions</div>
          <h1 className="page-title">Inbox</h1>
          <p className="page-subtitle">
          Everything waiting on your decision, in one place. Each item links
          back to where it's handled — nothing is approved from here.
          </p>
        </div>
      </header>

      {items.length === 0 ? (
        <div className="module-panel-strong p-10 text-center">
          <div className="tag tag-green">clear</div>
          <h2 className="font-semibold mt-3 text-lg">You're all caught up</h2>
          <p className="text-sm text-[color:var(--color-ink-muted)] mt-1.5 max-w-md mx-auto">
            Handoffs, connection requests, friend requests, reviews and
            device sign-in requests will show up here when they need you.
          </p>
          <div className="mt-6 flex gap-2 justify-center flex-wrap">
            <Link href="/app/contacts" className="btn btn-primary btn-sm">
              Find assistants
            </Link>
            <Link href="/app/agents" className="btn btn-secondary btn-sm">
              My assistants
            </Link>
          </div>
        </div>
      ) : (
        SECTIONS.map((section) => {
          const group = byKind.get(section.kind);
          if (!group || group.length === 0) return null;
          return (
            <section key={section.kind} className="mb-8 module-panel overflow-hidden">
              <div className="module-header">
                <div>
                  <h2 className="font-medium flex items-center gap-2">
                    <span className={KIND_TAG[section.kind].className}>
                      {KIND_TAG[section.kind].label}
                    </span>
                {section.heading}{" "}
                <span className="text-[color:var(--color-ink-soft)] font-normal">
                  ({group.length})
                </span>
                  </h2>
                  <p className="mt-1 text-xs text-[color:var(--color-ink-soft)]">
                    {section.blurb}
                  </p>
                </div>
              </div>
              <ul>
                {group.map((it) => (
                  <li
                    key={`${it.kind}:${it.id}`}
                    className="data-row flex-wrap"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={KIND_TAG[it.kind].className}>
                          {KIND_TAG[it.kind].label}
                        </span>
                        <span className="font-medium truncate">{it.title}</span>
                      </div>
                      <div className="mt-1 text-[13px] text-[color:var(--color-ink-muted)] truncate">
                        {it.subtitle}
                        <span className="text-[color:var(--color-ink-soft)]">
                          {" "}· {timeAgo(it.created_at)}
                        </span>
                      </div>
                    </div>
                    <Link href={it.href} className="btn btn-primary btn-sm shrink-0">
                      Open →
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          );
        })
      )}
    </div>
  );
}
